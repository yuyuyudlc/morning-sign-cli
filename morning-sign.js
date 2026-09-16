import {
  constants as cryptoConstants,
  createPublicKey,
  publicEncrypt,
} from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_PATH = dirname(fileURLToPath(import.meta.url));
const SCANNER_PATH = resolve(REPOSITORY_PATH, 'open-totoro-token', 'memory_scanner.py');

const PRIMARY_ORIGIN = process.env.SUNRUN_MINIPROGRAM_BASE_URL || 'https://wxxcx.xtotoro.com';
const FALLBACK_ORIGIN = process.env.SUNRUN_MINIPROGRAM_FALLBACK_BASE_URL || 'https://app.xtotoro.com';
const TASK_PATH = '/wxxcx/platform/mornSign/getMornSignPaper';
const SUBMIT_PATH = '/wxxcx/platform/mornSign/morningExercises';
const PUBLIC_KEY_DER = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC/dTvkr4EMAVX2Op39VYwufkOG1X6bDIXY8SPwOAujssdHuj/AbJKKAPAHYfNKFSt6IsPKNJcQRd94B1cc1Qb+AHOR+Zj4QnfGU7JLw0W2NrobGX3i6wBJCgxmvXqKDp+7fXs/r1zo76krrIj+bEEHKo3hPbLKaI1Xw9B1mFPUEQIDAQAB';
const PUBLIC_KEY = createPublicKey({
  key: Buffer.from(PUBLIC_KEY_DER, 'base64'),
  format: 'der',
  type: 'spki',
});

function usage() {
  console.log(`用法:
  node morning-sign.js                      # 全自动运行（启动小程序、从内存抓取 Token 并完成签到）
  node morning-sign.js --schedule [HH:MM]    # 每日定时守护模式（在设定时间自动打卡，默认 06:45）
  node morning-sign.js --token <Token>      # 手动指定 Token 签到
  node morning-sign.js --token <Token> --list-only          # 仅列出当前任务和点位
  node morning-sign.js --token <Token> --point-id <点位ID>   # 使用指定点位签到

前置要求:
  ⚠️ 自动抓取 Token 必须保持 Windows 电脑上已登录并打开 PC 版微信。

选项:
  --schedule, --cron [时间]  开启每日定时任务模式，如 --schedule 06:45
  --token <Token>            显式指定身份凭证 Token
  --point-id <点位ID>        指定签到点位 ID（默认使用第一个可用点位）
  --list-only                仅查询当前任务与点位列表，不提交签到
  --help, -h                 显示帮助信息`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--help' || name === '-h') args.help = true;
    else if (name === '--token') args.token = argv[++index];
    else if (name === '--list-only') args.listOnly = true;
    else if (name === '--point-id') args.pointId = argv[++index];
    else if (name === '--phone-info') args.phoneInfo = argv[++index];
    else if (name === '--schedule' || name === '--cron') {
      args.schedule = true;
      const nextArg = argv[index + 1];
      if (nextArg && /^\d{1,2}:\d{2}$/.test(nextArg)) {
        args.scheduleTime = argv[++index];
      }
    }
    else throw new Error(`未知参数: ${name}`);
  }
  return args;
}

async function loadEnvFile() {
  let content;
  try {
    content = await readFile(resolve(REPOSITORY_PATH, '.env'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  return content.split(/\r?\n/).reduce((values, line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[2].startsWith('#')) return values;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    return values;
  }, {});
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function splitUtf8(value, maxBytes) {
  const chunks = [];
  let chunk = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (chunk && bytes + characterBytes > maxBytes) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += character;
    bytes += characterBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function encryptLong(value) {
  const encrypted = splitUtf8(String(value), 117).map(chunk => publicEncrypt({
    key: PUBLIC_KEY,
    padding: cryptoConstants.RSA_PKCS1_PADDING,
  }, Buffer.from(chunk, 'utf8')));
  return Buffer.concat(encrypted).toString('base64');
}

function shanghaiNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second}`;
}

function origins() {
  return [...new Set([PRIMARY_ORIGIN, FALLBACK_ORIGIN])].map(value => {
    const origin = new URL(value);
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) {
      throw new Error('接口地址必须是无路径、无凭据的 HTTPS origin');
    }
    return origin;
  });
}

async function post(path, body, token) {
  let lastError;
  for (const origin of origins()) {
    try {
      const response = await fetch(new URL(path, origin), {
        method: 'POST',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`无法连接早操接口: ${lastError?.message || 'unknown error'}`);
}

async function getStudentInfo(token) {
  let lastError;
  for (const origin of origins()) {
    try {
      const response = await fetch(new URL('/wxxcx/platform/serverlist/GetStudentInfoByToken', origin), {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          Authorization: `Bearer ${token}`,
        },
      });
      if (response.status === 401 || response.status === 403) throw new Error('Token 无效或已过期');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (String(result?.code ?? '') !== '0') throw new Error(result?.message || result?.msg || 'Token 验证失败');
      const profile = result?.obj || {};
      const stuNumber = String(profile.snCode || profile.stuNumber || '').trim();
      if (!stuNumber) throw new Error('学生信息中没有学号');
      return {
        stuNumber,
        stuName: String(profile.studentName || profile.name || '').trim(),
        schoolName: String(profile.schoolName || '').trim(),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`获取学生信息失败: ${lastError?.message || 'unknown error'}`);
}

function normalizeTask(result) {
  return {
    signType: String(result?.signType ?? '0'),
    startDate: String(result?.startDate || ''),
    endDate: String(result?.endDate || ''),
    startTime: String(result?.startTime || ''),
    endTime: String(result?.endTime || ''),
    dayNeedSignCount: String(result?.dayNeedSignCount || '0'),
    dayCompSignCount: String(result?.dayCompSignCount || '0'),
    signPointList: (Array.isArray(result?.signPointList) ? result.signPointList : []).map(point => ({
      taskId: String(point?.taskId || ''),
      pointId: String(point?.pointId || ''),
      pointName: String(point?.pointName || '未命名点位'),
      latitude: String(point?.latitude || ''),
      longitude: String(point?.longitude || ''),
      qrCode: String(point?.qrCode || ''),
    })),
  };
}

async function getTask(token, stuNumber) {
  const result = await post(TASK_PATH, { stuNumber, token }, token);
  if (String(result?.status ?? '') !== '00') {
    throw new Error(result?.message || result?.msg || '获取早操任务失败');
  }
  return normalizeTask(result);
}

async function submit(token, stuNumber, pointId, phoneInfo = '') {
  const task = await getTask(token, stuNumber);
  const point = task.signPointList.find(item => item.pointId === pointId);
  if (!point) throw new Error('点位不在当前任务中');
  if (!point.taskId || !point.latitude || !point.longitude || !point.qrCode) {
    throw new Error('当前点位资料不完整，无法提交');
  }
  const payload = {
    taskId: point.taskId,
    iLocalSubmit: '0',
    signDate: shanghaiNow(),
    stuNumber,
    token,
    phoneNumber: '',
    qrCode: point.qrCode,
    headImage: '',
    baseStation: '',
    longitude: point.longitude,
    latitude: point.latitude,
    phoneInfo: phoneInfo || 'Totoro/CLI',
    mac: '',
    pointId: point.pointId,
    appVersion: '1.0.0',
    signType: task.signType,
  };
  const result = await post(SUBMIT_PATH, {
    encryptParams: encryptLong(JSON.stringify(payload)),
  }, token);
  const accepted = String(result?.code ?? '') === '0';
  return {
    accepted,
    status: String(result?.status ?? ''),
    code: String(result?.code ?? ''),
    message: String(result?.message || result?.msg || (accepted ? '打卡成功' : '早操签到失败')),
    submittedAt: payload.signDate,
    pointId: point.pointId,
    pointName: point.pointName,
  };
}

function runAndCapture(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { windowsHide: true });
    const stdout = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.once('error', rejectRun);
    child.once('close', code => resolveRun({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
    }));
  });
}

function launchMiniProgram(shortcutPath) {
  if (process.platform !== 'win32') {
    throw new Error('启动 .lnk 小程序快捷方式仅支持 Windows 系统');
  }
  return new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn('explorer.exe', [shortcutPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', rejectLaunch);
    child.once('spawn', () => {
      child.unref();
      resolveLaunch();
    });
  });
}

async function extractTokenFromMemory() {
  const tokenAttempts = 6;
  const retryDelayMs = 3000;
  for (let attempt = 1; attempt <= tokenAttempts; attempt += 1) {
    const result = await runAndCapture('python', [SCANNER_PATH]);
    const match = result.stdout.match(/(?:^|\r?\n)\s*(WXXCX[A-Za-z0-9+/=]{75,})\s*(?:\r?\n|$)/);
    if (result.code === 0 && match?.[1]) return match[1];
    if (attempt < tokenAttempts) await delay(retryDelayMs);
  }
  throw new Error('未能从微信内存中抓取到 Token，请确认已在 Windows 微信中打开『龙猫体育锻炼』小程序并完成登录。');
}

async function acquireTokenAutomatic() {
  await access(SCANNER_PATH, fsConstants.R_OK);
  const envValues = await loadEnvFile();
  const shortcutPath = String(envValues.MORNING_SIGN_SHORTCUT || process.env.MORNING_SIGN_SHORTCUT || '').trim();
  if (!shortcutPath) {
    throw new Error('未发现显式 --token，且缺少 .env 中的 MORNING_SIGN_SHORTCUT 配置。请先参考 .env.example 创建 .env。');
  }
  await access(shortcutPath, fsConstants.R_OK);
  await launchMiniProgram(shortcutPath);
  return await extractTokenFromMemory();
}

function getNextScheduleDelay(targetTimeStr = '06:45') {
  const match = targetTimeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`无效的时间格式 "${targetTimeStr}"，正确格式如 "06:45"`);
  const targetHour = parseInt(match[1], 10);
  const targetMinute = parseInt(match[2], 10);

  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const fields = Object.fromEntries(parts.map(p => [p.type, p.value]));

  const year = parseInt(fields.year, 10);
  const month = parseInt(fields.month, 10) - 1;
  const day = parseInt(fields.day, 10);
  const hour = parseInt(fields.hour, 10);
  const minute = parseInt(fields.minute, 10);
  const second = parseInt(fields.second, 10);

  let targetDate = new Date(Date.UTC(year, month, day, targetHour, targetMinute, 0));
  if (hour > targetHour || (hour === targetHour && minute >= targetMinute)) {
    targetDate.setUTCDate(targetDate.getUTCDate() + 1);
  }

  const currentShanghaiMs = Date.UTC(year, month, day, hour, minute, second);
  const delayMs = targetDate.getTime() - currentShanghaiMs;

  const nextTimeString = `${targetDate.getUTCFullYear()}-${String(targetDate.getUTCMonth() + 1).padStart(2, '0')}-${String(targetDate.getUTCDate()).padStart(2, '0')} ${String(targetHour).padStart(2, '0')}:${String(targetMinute).padStart(2, '0')}:00`;

  return { delayMs, nextTimeString };
}

async function executeSignFlow(args) {
  let token = String(args.token || '').trim();
  if (!token) {
    console.log('[1/3] 未传入 Token，启动小程序并自动从内存提取...');
    token = await acquireTokenAutomatic();
    console.log('[2/3] 成功抓取 Token！');
  } else {
    console.log('[1/2] 使用传入的 Token...');
  }

  const profile = await getStudentInfo(token);
  const { stuNumber, stuName } = profile;
  console.log(`[身份校验] 学生: ${stuName} (${stuNumber})`);

  if (args.listOnly) {
    if (args.pointId) throw new Error('--list-only 不能与 --point-id 同时使用');
    const task = await getTask(token, stuNumber);
    console.log(JSON.stringify({
      student: profile,
      task: {
        startDate: task.startDate,
        endDate: task.endDate,
        startTime: task.startTime,
        endTime: task.endTime,
        dayNeedSignCount: task.dayNeedSignCount,
        dayCompSignCount: task.dayCompSignCount,
      },
      points: task.signPointList.map(point => ({
        taskId: point.taskId,
        pointId: point.pointId,
        pointName: point.pointName,
      })),
    }, null, 2));
    return true;
  }

  let pointId = String(args.pointId || '').trim();
  if (!pointId) {
    const task = await getTask(token, stuNumber);
    const firstPoint = task.signPointList[0];
    if (!firstPoint?.pointId) throw new Error('当前早操任务没有可用点位');
    pointId = firstPoint.pointId;
  }

  console.log(`[3/3] 提交签到点位 (ID: ${pointId})...`);
  const result = await submit(token, stuNumber, pointId, args.phoneInfo);
  console.log('----------------------------------------');
  console.log(JSON.stringify(result, null, 2));
  console.log('----------------------------------------');
  return result.accepted;
}

async function startScheduleMode(args) {
  const envValues = await loadEnvFile();
  const scheduleTime = args.scheduleTime || envValues.MORNING_SIGN_TIME || process.env.MORNING_SIGN_TIME || '06:45';

  const scheduleLoop = async () => {
    const { delayMs, nextTimeString } = getNextScheduleDelay(scheduleTime);
    const delayHours = (delayMs / (1000 * 60 * 60)).toFixed(2);
    console.log(`\n⏰ [定时任务就绪] 每日目标时间: ${scheduleTime}`);
    console.log(`📅 下次打卡时间: ${nextTimeString} (Asia/Shanghai，约 ${delayHours} 小时后)`);
    console.log('💡 保持此控制台打开，程序将在设定时间自动执行打卡...\n');

    setTimeout(async () => {
      console.log(`\n[${shanghaiNow()}] ⏰ 定时触发早操打卡任务...`);
      try {
        await executeSignFlow(args);
      } catch (error) {
        console.error(`❌ 定时打卡失败: ${error.message}`);
      }
      // 安排下一次循环
      scheduleLoop();
    }, delayMs);
  };

  await scheduleLoop();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  if (args.schedule) {
    await startScheduleMode(args);
  } else {
    try {
      const success = await executeSignFlow(args);
      process.exitCode = success ? 0 : 2;
    } catch (error) {
      console.error(`❌ 签到失败: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

main();
