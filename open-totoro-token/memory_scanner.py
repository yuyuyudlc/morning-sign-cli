# 本地进程内存扫描：从「龙猫体育锻炼」微信小程序进程里读出登录 token。
#
# 原理：微信小程序运行在独立的 WeChatAppEx.exe 进程里（一个小程序一个进程）。
# 这个进程登录后，token 以明文形式存在于它自己的内存中——小程序沙箱本身不提供
# 给用户查看的方式。这里用标准 Win32 调试 API（OpenProcess/ReadProcessMemory，
# 和调试器、Cheat Engine 一类工具用的是同一套）把它读出来，纯只读、不写内存、
# 不注入代码、不需要管理员权限（同一用户会话下能打开自己的进程即可）。

import ctypes
import subprocess
import sys
from ctypes import wintypes

# ── Win32 API 常量与函数签名 ─────────────────────────────────────────
PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TH32CS_SNAPPROCESS = 0x00000002
MEM_COMMIT = 0x1000
MEM_PRIVATE = 0x20000
MEM_MAPPED = 0x40000
MEM_IMAGE = 0x1000000
PAGE_GUARD = 0x100
_INVALID_HANDLE = ctypes.c_void_p(-1).value

CHUNK_SIZE = 1024 * 1024
CHUNK_OVERLAP = 4096      # 相邻块重叠：token 正好跨块边界时不重叠会被截断、两边都读不全而漏检
TOKEN_MIN_LEN = 80
MAX_REGION_SIZE = 512 * 1024 * 1024

kernel32 = ctypes.windll.kernel32
user32 = ctypes.windll.user32

OpenProcess = kernel32.OpenProcess
OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
OpenProcess.restype = wintypes.HANDLE
CloseHandle = kernel32.CloseHandle
CloseHandle.argtypes = [wintypes.HANDLE]
CloseHandle.restype = wintypes.BOOL
ReadProcessMemory = kernel32.ReadProcessMemory
ReadProcessMemory.argtypes = [
    wintypes.HANDLE, wintypes.LPCVOID, wintypes.LPVOID,
    ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)
]
ReadProcessMemory.restype = wintypes.BOOL
VirtualQueryEx = kernel32.VirtualQueryEx
VirtualQueryEx.argtypes = [
    wintypes.HANDLE, wintypes.LPCVOID, wintypes.LPVOID, ctypes.c_size_t
]
VirtualQueryEx.restype = ctypes.c_size_t
kernel32.QueryFullProcessImageNameW.argtypes = [
    wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE

_WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [_WNDENUMPROC, wintypes.LPARAM]
user32.EnumWindows.restype = wintypes.BOOL
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD


class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wintypes.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
    ]


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_wchar * 260),
    ]


kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
kernel32.Process32FirstW.restype = wintypes.BOOL
kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
kernel32.Process32NextW.restype = wintypes.BOOL


def _proc_name(pid):
    """返回 pid 的进程映像名（小写），失败返回空串。"""
    if not pid:
        return ""
    h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(260)
        size = wintypes.DWORD(260)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value.rsplit("\\", 1)[-1].lower()
    finally:
        CloseHandle(h)
    return ""


def _all_pids_by_name(name):
    """枚举所有进程映像名等于 name（不区分大小写）的 pid。"""
    target = name.lower()
    out = []
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == _INVALID_HANDLE:
        return out
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        if not kernel32.Process32FirstW(snap, ctypes.byref(entry)):
            return out
        while True:
            if entry.szExeFile.lower() == target:
                out.append(entry.th32ProcessID)
            if not kernel32.Process32NextW(snap, ctypes.byref(entry)):
                break
    finally:
        CloseHandle(snap)
    return out


def _find_candidate_pids():
    """列出可能承载「龙猫体育锻炼」小程序的 WeChatAppEx.exe 进程：窗口标题含"龙猫"的排在
    前面（通常就是它），其余 WeChatAppEx.exe 进程排在后面（小程序多进程架构下
    token 有时在没有可见窗口的兄弟进程里）。交给调用方逐个尝试取 token。
    """
    hit = set()

    def _cb(hwnd, _lparam):
        try:
            n = user32.GetWindowTextLengthW(hwnd)
            if n > 0:
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                if "龙猫" in buf.value:
                    pid = wintypes.DWORD()
                    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                    if pid.value and _proc_name(pid.value) == "wechatappex.exe":
                        hit.add(pid.value)
        except Exception:
            pass
        return True

    try:
        cb = _WNDENUMPROC(_cb)   # 持有引用直到 EnumWindows 返回，防回调被 GC 导致崩溃
        user32.EnumWindows(cb, 0)
    except Exception:
        pass

    return _order_candidates(hit, _all_pids_by_name("WeChatAppEx.exe"))


def _order_candidates(window_pids, all_wechatappex_pids):
    """合并去重：window_pids（标题匹配到的）在前，其余 WeChatAppEx.exe 进程在后
    ——小程序多进程架构下 token 有时在没有可见窗口的兄弟进程里，只看标题匹配会漏掉它。
    """
    ordered = list(window_pids)
    seen = set(window_pids)
    for pid in all_wechatappex_pids:
        if pid not in seen:
            ordered.append(pid)
            seen.add(pid)
    return ordered


def extract_tokens_from_pid(pid):
    """扫描指定进程内存，返回其中出现过的所有 WXXCX token（去重，原始出现顺序）。"""
    handle = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
    if not handle:
        return []

    tokens = []
    seen = set()
    mbi = MEMORY_BASIC_INFORMATION()
    mbi_size = ctypes.sizeof(mbi)
    address = 0

    try:
        while address < 0x7FFFFFFFFFFF:
            ret = VirtualQueryEx(handle, ctypes.c_void_p(address), ctypes.byref(mbi), mbi_size)
            if ret == 0:
                break
            if (mbi.State == MEM_COMMIT and mbi.RegionSize > 0 and
                    mbi.RegionSize <= MAX_REGION_SIZE and
                    mbi.Type in (MEM_PRIVATE, MEM_MAPPED, MEM_IMAGE) and
                    mbi.Protect & PAGE_GUARD == 0):
                region_addr = mbi.BaseAddress
                region_size = mbi.RegionSize
                offset = 0
                while offset < region_size:
                    read_size = min(CHUNK_SIZE, region_size - offset)
                    try:
                        buffer = ctypes.create_string_buffer(read_size)
                        bytes_read = ctypes.c_size_t(0)
                        if ReadProcessMemory(handle, region_addr + offset, buffer,
                                             read_size, ctypes.byref(bytes_read)):
                            data = buffer.raw[:bytes_read.value]
                            idx = 0
                            while True:
                                idx = data.find(b"WXXCX", idx)
                                if idx == -1:
                                    break
                                end = idx + 5
                                while end < len(data) and (
                                        48 <= data[end] <= 57 or
                                        65 <= data[end] <= 90 or
                                        97 <= data[end] <= 122 or
                                        data[end] in (43, 47, 61)  # + / =
                                ):
                                    end += 1
                                t = data[idx:end].decode("ascii")
                                if len(t) >= TOKEN_MIN_LEN and t not in seen:
                                    seen.add(t)
                                    tokens.append(t)
                                idx = end
                    except Exception:
                        pass
                    if offset + read_size >= region_size:
                        break  # 已到区域末尾
                    offset += read_size - CHUNK_OVERLAP
            address += mbi.RegionSize
    finally:
        CloseHandle(handle)

    return tokens


def extract_token():
    """扫描本机的龙猫体育锻炼小程序进程，取出登录 token；返回 {"ok", "token", "error"}。"""
    pids = _find_candidate_pids()
    if not pids:
        return {"ok": False, "token": None,
                "error": "未找到龙猫体育锻炼小程序进程，请先在微信中打开并登录龙猫体育锻炼小程序。"}

    for pid in pids:
        tokens = extract_tokens_from_pid(pid)
        if tokens:
            return {"ok": True, "token": tokens[0], "error": None}

    return {"ok": False, "token": None,
            "error": "未读取到登录信息，请确认已在小程序内登录后重试。"}


def _copy_to_clipboard(text):
    """尽力把 text 写进系统剪贴板，用 Windows 自带的 clip.exe，不引入第三方依赖。
    失败（不支持/被拦截等）静默返回 False——token 已经打印在终端里了，复制只是
    锦上添花，不能因为这一步失败就让整个工具报错退出。"""
    try:
        subprocess.run(["clip"], input=text.encode("ascii"), check=True)
        return True
    except Exception:
        return False


def main():
    sys.stdout.reconfigure(encoding="utf-8")

    print("正在扫描本机的龙猫体育锻炼小程序进程...")
    result = extract_token()

    if not result["ok"]:
        print(f"\n[失败] {result['error']}")
        return 1

    token = result["token"]
    print("\nToken:")
    print(token)
    if _copy_to_clipboard(token):
        print("\n已复制到剪贴板，可以直接粘贴使用。")
    else:
        print("\n（自动复制失败，请手动选中上面这行复制。）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
