# 龙猫体育早操自动签到 (morning-sign-cli)

基于 Node.js 20+ 的龙猫体育微信小程序早操自动签到工具。零外置 npm 依赖，支持从进程内存自动抓取 Token 校验、RSA PKCS#1 v1.5 分块加密及每日守护打卡。

> ⚠️ **使用前提**：请确保 Windows 电脑上**已登录并打开 PC 版微信**（脚本需启动小程序并从微信进程内存中扫描捕获登录凭证 Token）。

---

## ✨ 核心特性

- **零外置 npm 依赖**：纯 Node.js 原生 ES Module 实现 (`fetch`, `crypto`, `child_process`)。
- **免手动输入 Token**：自动启动微信小程序并从 Windows 微信进程内存中扫描获取有效 Token。
- **自动反查学生学号**：调用学生信息接口自动填充 `snCode`，配置文件无须保存学号或密码。
- **支持每日定时守护模式**：内置精准时区推算（`Asia/Shanghai`），挂在后台即可每日定时自动完成打卡。
- **高可用容灾架构**：内置主备双接口域名自动容灾重试机制。

---

## 🚀 快速开始

### 1. 确认前置条件

1. **已登录 PC 版微信**（保持后台运行即可）。
2. 已在微信中搜索打开过一次“龙猫体育锻炼”小程序并创建桌面快捷方式。

---

### 2. 初始化配置

复制 `.env.example` 生成 `.env` 配置文件：

```powershell
copy .env.example .env
```

编辑 `.env` 填入龙猫体育小程序快捷方式的绝对路径：

```dotenv
# 微信龙猫体育锻炼小程序快捷方式绝对路径 (.lnk)
MORNING_SIGN_SHORTCUT=C:\path\to\龙猫体育锻炼.lnk

# 每日自动打卡时间（默认 06:45）
MORNING_SIGN_TIME=06:45
```

---

### 3. 使用方法

#### ⏰ 选项 A：每日自动定时打卡（守护进程模式）

启动守护进程后保持控制台打开，程序会在每日设定时间自动开启小程序并完成打卡：

```powershell
node morning-sign.js --schedule
# 或指定打卡时间
node morning-sign.js --schedule 06:50
# 或使用 npm 命令
npm run schedule
```

#### ⚡ 选项 B：立即一键自动打卡

不需要任何参数，自动完成启动小程序 ➔ 内存抓 Token ➔ 校验身份 ➔ 首个点位打卡的完整流程：

```powershell
node morning-sign.js
# 或
npm run task
```

#### 🛠️ 选项 C：高级用法

```powershell
# 手动传入 Token 签到
node morning-sign.js --token "你的Token"

# 仅查询当前早操任务与可用点位列表
node morning-sign.js --token "你的Token" --list-only

# 指定点位 ID 签到
node morning-sign.js --token "你的Token" --point-id "点位ID"
```

---

## 📁 项目目录

```
morning-sign-cli/
├── morning-sign.js         # 统一入口脚本（包含核心签到逻辑、加密算法与定时守护）
├── open-totoro-token/      # Windows 微信进程 Token 内存扫描器 (Python Submodule)
│   ├── memory_scanner.py
│   └── LICENSE
├── .env.example            # 本地配置文件模板
├── .gitignore              # Git 忽略配置
├── package.json            # 项目清单及 npm scripts 命令
└── README.md               # 项目使用说明文档
```

---

## 📜 鸣谢与开源协议 (Acknowledgements & License)

本项目遵循 MIT 许可证。内存 Token 扫描模块使用了子模块 [open-totoro-token](open-totoro-token/):
- **组件**：[open-totoro-token](open-totoro-token/) (Python 内存扫描工具)
- **作者**：Copyright (c) 2026 [SSSSSea6](https://github.com/SSSSSea6)
- **协议**：MIT License（详见 [open-totoro-token/LICENSE](open-totoro-token/LICENSE)）
