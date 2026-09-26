// =====================================================================
// main.js —— Electron 主进程入口
// 职责：
//   1. 创建并管理应用主窗口（BrowserWindow）
//   2. 处理渲染进程发来的 IPC 请求
//   3. 通过 child_process.exec 启动本地软件
//   4. 通过 shell.openPath 打开本地文件 / 文件夹
//   5. 通过 dialog.showOpenDialog 弹出系统文件选择对话框
//   6. 读写 data/ 目录下的 JSON 数据文件，实现持久化
// 说明：主进程只负责「系统层面」的操作，不参与任何界面渲染逻辑
// =====================================================================

const { app, BrowserWindow, ipcMain, dialog, shell, session, screen, Menu, net, Tray, nativeImage } = require('electron');
const { exec, fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// node-schedule：每日定时续火花（可选依赖，未安装时降级为仅手动触发）
let schedule;
try {
  schedule = require('node-schedule');
} catch (e) {
  console.warn('[续火花] node-schedule 未安装，定时任务不可用，仅支持手动触发。请运行: npm install node-schedule');
}

// ---------------------------------------------------------------------
// 常量定义
// ---------------------------------------------------------------------

// 用户数据存放目录：
//  - 开发模式：项目目录下 data/
//  - 打包后：程序所在目录下 data/（绿色便携，数据跟程序走）
//    🔴 不能写入 resources/app.asar 内部 —— asar 归档只读，写入会报 ENOENT；
//    portable 版以 PORTABLE_EXECUTABLE_DIR（真实 exe 所在目录）为准
const DATA_DIR = app.isPackaged
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe')), 'data')
  : path.join(__dirname, 'data');

// 所有 session 数据（cookie/localStorage/IndexedDB 等）重定向到 DATA_DIR 下的 user-data，
// 与配置文件放一起跟随程序目录，便于备份/迁移/清理。
// 必须在 app ready 之前、任何 session 创建前调用。
app.setPath('userData', path.join(DATA_DIR, 'user-data'));

// 打包后禁用 GPU 合成：消除全屏透明置顶窗口（坐标拾取器）在 DWM 合成时 GPU 进程崩溃
// 仅禁用合成层（保留 GPU 光栅化），主窗口 webview 文字/图片仍用 GPU 渲染，软件合成 60fps 无压力
// 开发版不受影响（DevTools/未最大化主窗口使合成区域小，不触发崩溃）
if (app.isPackaged) {
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

// 允许读写的数据文件白名单（防止渲染进程通过文件名参数访问任意文件）
const ALLOWED_FILES = ['apps.json', 'events.json', 'settings.json', 'sign-tasks.json', 'bg-run.json', 'netease-cookie.json', 'netease-data.json', 'fire-spark-config.json', 'fire-spark-messages.json'];

// 每个数据文件对应的默认值（文件不存在或损坏时使用）
const DEFAULT_VALUES = {
  'apps.json': [],
  'events.json': [],
  'settings.json': { theme: 'light' },
  'sign-tasks.json': [],
  // 「关闭后继续后台运行」独立文件（主进程持有，避免与渲染进程的 settings.json 互相覆盖）
  'bg-run.json': { enabled: false },
  // 网易云登录 cookie 持久化（扫码一次后下次免扫码）
  'netease-cookie.json': { cookie: '' },
  // 网易云用户信息 + 播放列表本地缓存（实现已登录用户秒开，避免每次进页面都走扫码/网络请求）
  'netease-data.json': {},
  // 抖音续火花配置（目标好友、DOM 选择器占位、定时时间）—— 选择器需手动填入实测值
  'fire-spark-config.json': {
    enabled: true,                    // 是否启用定时续火花
    targetFriend: '',                 // TODO: 填入要续火花的好友昵称
    scheduleTime: '00 01 * * *',      // node-schedule cron 表达式：每天 00:01
    chatUrl: 'https://www.douyin.com/', // 续火花加载的页面（私信/创作者平台）
    selectors: {
      // TODO: 以下选择器均为占位，需根据抖音网页版实际 DOM 填入后才能运行
      chatEntry: '',                  // 进入私信/聊天入口的选择器
      friendItem: '',                 // 定位目标好友会话的选择器
      inputBox: '',                   // 消息输入框选择器
      sendBtn: ''                     // 发送按钮选择器
    }
  },
  // 续火花随机文案库（内置默认，可在设置里追加自定义文案）
  'fire-spark-messages.json': [
    '在吗在吗',
    '今天也要加油哦',
    '冒个泡~',
    '续个火花',
    '滴滴滴',
    '记得想我'
  ]
};

// ---------------------------------------------------------------------
// 签到窗口管理（持久化 Cookie 实现免登录）
// ---------------------------------------------------------------------

/**
 * 签到专用 BrowserWindow 实例集合
 * key = taskId, value = { win: BrowserWindow, session: Session }
 *
 * 设计要点：
 *  - 每个签到任务一个独立窗口，共享同一个 session（cookie 持久化到磁盘）
 *  - 默认隐藏（skipTaskbar + hide），用户需要登录时通过「显示」按钮调出
 *  - 登录一次后 cookie 写入磁盘，下次启动直接可用
 */
const SIGN_WINDOWS = new Map();
// 签到专用 session（独立于主窗口 session，cookie 持久化存储）
let signSession = null;

function getSignSession() {
  if (!signSession) {
    signSession = session.fromPartition('persist:signin', { cache: true });
    // 允许抓取本地存储（LocalStorage），部分站点登录状态靠它而非 Cookie
    signSession.setPermissionRequestHandler((wc, permission, callback) => {
      const allowed = ['storage', 'cookie', 'webStorage'].includes(permission);
      callback(allowed);
    });
  }
  return signSession;
}

/**
 * 将输入统一转换为 BrowserWindow 可加载的 URL
 *
 * 为什么 .exe/.zip 不行？
 *   BrowserWindow 底层是 Chromium，它只认识 .html/.htm/.mhtml/.svg/.txt/.pdf 这类
 *   可以被浏览器渲染的文件。遇到 .exe/.zip/.rar 等二进制，Chromium 会判定为
 *   "要下载的文件"，于是弹出另存为对话框——这不是 bug，是 Chromium 的默认行为。
 *
 * 所以：
 *   - 想自动化点按钮 → 必须是可被 BrowserWindow 渲染的 HTML 文件 或 远程网址
 *   - 想启动 .exe 程序 → 用「首页的软件快捷启动」功能，或者我可以扩展成"启动程序型任务"
 *
 * @param {string} input 用户填的 URL 或文件路径
 * @returns {{ url: string, isLocal: boolean, error?: string }}
 */
function normalizeSignUrl(input) {
  if (!input || typeof input !== 'string') {
    return { url: '', isLocal: false, error: 'URL 不能为空' };
  }
  const trimmed = input.trim();

  // 情况 1：已经是标准协议，直接返回（远程网址、file:// 本地网页、data: 都 OK）
  if (/^(https?:|file:|app:|data:)/i.test(trimmed)) {
    return { url: trimmed, isLocal: /^file:/i.test(trimmed) };
  }

  // 情况 2：本地文件路径
  const isWinAbs = /^[a-zA-Z]:[\\/]/.test(trimmed);
  const looksLikeLocal = isWinAbs || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.includes('\\');

  if (looksLikeLocal) {
    let absPath = trimmed;
    if (isWinAbs) {
      absPath = trimmed.replace(/\//g, '\\');
    } else {
      absPath = path.resolve(__dirname, trimmed);
    }

    if (!fs.existsSync(absPath)) {
      return { url: '', isLocal: true, error: '本地文件不存在：' + absPath };
    }

    // 🔴 关键校验：只允许 Chromium 能渲染的文件类型
    const ext = path.extname(absPath).toLowerCase();
    const ALLOWED_WEB_EXTS = ['.html', '.htm', '.mhtml', '.svg', '.txt', '.pdf'];

    if (ALLOWED_WEB_EXTS.indexOf(ext) === -1) {
      // 把不被支持的扩展名列出来，给用户明确的方向
      return {
        url: '',
        isLocal: true,
        error: '文件类型不被支持（' + ext + '）。签到自动化需要可被浏览器渲染的 HTML 页面。' +
          '如果想启动 .exe 程序，请用首页的「软件快捷启动」功能，或把 .exe 包装成一个 HTML 壳。'
      };
    }

    // ✅ 通过校验，转成 file:/// 协议
    const fileUrl = require('url').pathToFileURL(absPath).href;
    return { url: fileUrl, isLocal: true };
  }

  // 情况 3：看起来既不像网址也不像路径
  return {
    url: '',
    isLocal: false,
    error: '无法识别的 URL 或路径，请填写 https:// 网址 或 本地 HTML 文件路径（如 d:\\pages\\signin.html）'
  };
}

/**
 * 创建（或复用）一个签到专用 BrowserWindow
 * @param {string} taskId   签到任务 ID
 * @param {string} url      目标 URL 或本地文件路径
 * @returns {BrowserWindow}
 */
function getOrCreateSignWindow(taskId, url) {
  if (SIGN_WINDOWS.has(taskId)) return SIGN_WINDOWS.get(taskId).win;

  const normalized = normalizeSignUrl(url);
  if (normalized.error) {
    throw new Error(normalized.error);
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,                 // 默认隐藏
    skipTaskbar: true,           // 任务栏不显示
    autoHideMenuBar: true,
    title: '签到窗口',
    webPreferences: {
      session: getSignSession(), // 独立持久化 session
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.on('closed', () => {
    SIGN_WINDOWS.delete(taskId);
  });

  // 加载（远程网页 or 本地 HTML 文件，自动识别）
  win.loadURL(normalized.url);

  SIGN_WINDOWS.set(taskId, { win });
  return win;
}

// ---------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------

/**
 * 确保 data/ 目录存在（应用首次运行时自动创建，不存在则递归创建）
 */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * 打包版首次运行的数据初始化：
 * 把打包时经 extraResources 带入的 resources/data 复制到程序目录 data/，
 * 实现「开箱即用」（exe 旁 data 已有同名文件则以用户数据优先，不覆盖）
 */
function initDataDir() {
  ensureDataDir();
  if (!app.isPackaged) return;
  const bundledDir = path.join(process.resourcesPath, 'data');
  if (!fs.existsSync(bundledDir)) return;
  ALLOWED_FILES.forEach((name) => {
    const target = path.join(DATA_DIR, name);
    const source = path.join(bundledDir, name);
    if (!fs.existsSync(target) && fs.existsSync(source)) {
      try {
        fs.copyFileSync(source, target);
      } catch (e) {
        console.error('初始化数据文件失败：', name, e);
      }
    }
  });
}

/**
 * 根据文件名返回完整的数据文件路径，并做白名单校验
 * @param {string} filename 数据文件名（例如 apps.json）
 * @returns {string} 文件的绝对路径
 */
function getDataPath(filename) {
  if (!ALLOWED_FILES.includes(filename)) {
    throw new Error('不允许访问的数据文件：' + filename);
  }
  return path.join(DATA_DIR, filename);
}

/**
 * 读取 JSON 数据文件（带容错处理）
 * @param {string} filename 数据文件名
 * @returns {*} 解析后的数据；文件不存在 / 损坏时返回默认值
 */
function readData(filename) {
  const filePath = getDataPath(filename);
  const fallback = DEFAULT_VALUES[filename];
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // 用默认值的类型做基本校验
    if (Array.isArray(fallback) && !Array.isArray(parsed)) {
      return fallback;
    }
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback) &&
      (parsed === null || typeof parsed !== 'object')) {
      return fallback;
    }
    return parsed;
  } catch (err) {
    console.error('读取数据文件失败：', err);
    return fallback;
  }
}

/**
 * 把数据写入 JSON 文件（同步写入，保证数据可靠落盘）
 * @param {string} filename 数据文件名
 * @param {*} data 要写入的数据
 */
function writeData(filename, data) {
  ensureDataDir();
  const filePath = getDataPath(filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------
// 窗口创建
// ---------------------------------------------------------------------

// 主窗口引用（托盘恢复窗口使用）
let mainWindow = null;
// 「关闭后继续后台运行」状态（与 data/bg-run.json 同步，close 拦截据此判断）
let backgroundRun = false;
// 是否正在真正退出（before-quit 置 true，放行 close 事件）
let quitting = false;
// 系统托盘实例
let tray = null;
// 本次运行期间是否已提示过「最小化到托盘」（避免每次关闭都打扰）
let bgNoticeShown = false;

/**
 * 显示并聚焦主窗口（托盘点击 / 菜单恢复使用）
 */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * 创建系统托盘
 * 说明：「关闭后继续后台运行」时窗口被隐藏，托盘是用户找回窗口 / 退出的入口。
 *       图标取应用 exe 关联图标（打包后即应用图标，开发模式为 Electron 图标）。
 */
function createTray() {
  app.getFileIcon(process.execPath, { size: 'small' })
    .catch(() => null)
    .then((img) => {
      tray = new Tray(img && !img.isEmpty() ? img : nativeImage.createEmpty());
      tray.setToolTip('教公台-阡稻工作室');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '显示主面板', click: showMainWindow },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            quitting = true;   // 放行 close 拦截，真正退出
            app.quit();
          }
        }
      ]));
      // Windows 左键单击托盘图标：恢复主面板
      tray.on('click', showMainWindow);
    });
}

/**
 * 创建主窗口，并设置安全参数：
 *   contextIsolation: true —— 开启上下文隔离，渲染进程无法直接访问 Node
 *   nodeIntegration: false —— 关闭 Node 集成，防止远程代码获得系统权限
 *   preload                   —— 通过 contextBridge 安全暴露 API
 */
function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    title: '教公台-阡稻工作室',
    backgroundColor: '#f0f2f5',
webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });

  // 🔴 「关闭后继续后台运行」：开启时拦截窗口关闭 → 隐藏到托盘
  win.on('close', (e) => {
    if (backgroundRun && !quitting) {
      e.preventDefault();
      win.hide();
      // 首次隐藏时通过渲染进程 Toast 提示（避免用户误以为应用闪退）
      if (!bgNoticeShown && win.webContents && !win.webContents.isDestroyed()) {
        bgNoticeShown = true;
        win.webContents.send('bg-notice', '已最小化到系统托盘，可从托盘恢复或退出');
      }
    }
  });

  mainWindow = win;
  win.loadFile('index.html');
}

// ---------------------------------------------------------------------
// 抖音 / 千问 / 续火花 窗口与后台自动化
// ---------------------------------------------------------------------

// 抖音主窗口、千问窗口、续火花隐藏窗口引用
let douyinWindow = null;
let qwenWindow = null;
let fireSparkWindow = null;
// 续火花定时任务句柄
let fireSparkJob = null;
// 续火花独立 session（persist:fire-session，cookie 持久化隔离登录态）
let fireSparkSession = null;

/**
 * 获取续火花专用 session（独立 partition 持久化 cookie/localStorage）
 * 与主窗口、签到窗口的 session 完全隔离，互不影响
 */
function getFireSparkSession() {
  if (!fireSparkSession) {
    fireSparkSession = session.fromPartition('persist:fire-session', { cache: true });
    fireSparkSession.setPermissionRequestHandler((wc, permission, callback) => {
      const allowed = ['storage', 'cookie', 'webStorage', 'media'].includes(permission);
      callback(allowed);
    });
  }
  return fireSparkSession;
}

/**
 * 拦截非标准协议链接（如 bytedance://），阻止系统弹出"找不到应用"对话框
 * 抖音登录/滑动时会尝试唤起 PC 客户端（bytedance:// 协议），未装客户端时系统弹窗打扰用户
 * 主进程的 will-navigate 等事件对外部协议可能不触发（外部协议不走导航流程，直接交给系统），
 * 因此在渲染层注入 JS 直接拦截 <a> 点击 / window.open / location 赋值，在 Chromium 处理前阻止
 * @param {BrowserWindow} win
 */

// 记录需要拦截外部协议唤起的 webContents ID，供 session permission handler 精确匹配
const blockedWcIds = new Set();

/**
 * 拦截非标准协议链接（如 bytedance://），阻止系统弹出"找不到应用"对话框
 * 抖音登录/滑动时会尝试唤起 PC 客户端（bytedance:// 协议），未装客户端时系统弹窗打扰用户
 * 主进程的 will-navigate 等事件对外部协议可能不触发（外部协议不走导航流程，直接交给系统），
 * 因此在渲染层注入 JS 直接拦截 <a> 点击 / window.open / location 赋值，在 Chromium 处理前阻止。
 * 参数为 WebContents（BrowserWindow 传 .webContents，webview 直接传其 webContents）。
 * @param {WebContents} contents
 */
function blockExternalProtocols(contents) {
  const wc = contents;
  blockedWcIds.add(wc.id);
  wc.on('destroyed', () => blockedWcIds.delete(wc.id));
  // 允许的标准协议白名单
  const allowed = ['http:', 'https:', 'file:', 'data:', 'about:', 'blob:', 'chrome-extension:'];
  const isExternal = (url) => {
    try {
      const u = new URL(url);
      return !allowed.includes(u.protocol);
    } catch (e) {
      return false;
    }
  };
  // 兜底：主进程事件拦截（部分场景外部协议可能走导航流程）
  wc.on('will-navigate', (e, url) => {
    if (isExternal(url)) { console.log('[拦截外部协议] will-navigate:', url); e.preventDefault(); }
  });
  wc.on('will-redirect', (e, url) => {
    if (isExternal(url)) { console.log('[拦截外部协议] will-redirect:', url); e.preventDefault(); }
  });
  wc.on('will-frame-navigate', (e, details) => {
    const url = (details && details.url) || '';
    if (isExternal(url)) { console.log('[拦截外部协议] will-frame-navigate:', url); e.preventDefault(); }
  });
  wc.setWindowOpenHandler((details) => {
    if (isExternal(details.url)) {
      console.log('[拦截外部协议] window.open:', details.url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  // 核心：session 级 permission handler 拦截 openExternal 权限。
  // 外部协议（bytedance:// 等）不走导航流程，Chromium 直接请求 openExternal 权限并弹
  // "是否打开此链接"确认框。在此静默拒绝（callback(false)），确认框不再出现。
  const ses = wc.session;
  ses.setPermissionRequestHandler((requestWc, permission, callback) => {
    if (permission === 'openExternal' && blockedWcIds.has(requestWc.id)) {
      return callback(false);
    }
    if (ses === fireSparkSession) {
      return callback(['storage', 'cookie', 'webStorage', 'media'].includes(permission));
    }
    callback(true);
  });
  ses.setPermissionCheckHandler((requestWc, permission) => {
    if (permission === 'openExternal' && blockedWcIds.has(requestWc.id)) {
      return false;
    }
    return true;
  });
  // 渲染层拦截由 preload（block-external-protocol-preload.js）在页面脚本前注入，
  // 覆盖 <a> 点击 / window.open / location / 动态 iframe，此处主进程事件仅作兜底
}

// 主窗口内嵌的 <webview>（抖音/千问页面）创建的 webContents 同样挂上外部协议拦截，
// 否则 webview 内的 bytedance:// 等协议仍会触发 Chromium 确认弹窗
app.on('web-contents-created', (event, contents) => {
  if (contents.getType() === 'webview') {
    blockExternalProtocols(contents);
  }
});

/**
 * 打开抖音独立全屏窗口（浏览抖音网页版，支持手动刷视频/看直播/聊天）
 * 复用已有窗口，避免重复打开
 */
function createDouyinWindow() {
  if (douyinWindow && !douyinWindow.isDestroyed()) {
    douyinWindow.show();
    douyinWindow.focus();
    return;
  }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  douyinWindow = new BrowserWindow({
    width,
    height,
    title: '抖音',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'block-external-protocol-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  blockExternalProtocols(douyinWindow.webContents);
  douyinWindow.loadURL('https://www.douyin.com/');
  douyinWindow.on('closed', () => { douyinWindow = null; });
}

/**
 * 打开通义千问独立窗口（网页嵌套模式，桌面 UA 保证网页版功能正常）
 * 使用独立 partition 持久化千问登录态
 */
function createQwenWindow() {
  if (qwenWindow && !qwenWindow.isDestroyed()) {
    qwenWindow.show();
    qwenWindow.focus();
    return;
  }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  qwenWindow = new BrowserWindow({
    width: Math.min(width, 1280),
    height: Math.min(height, 860),
    title: '通义千问',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'block-external-protocol-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:qwen-session'
    }
  });
  // 设置常见桌面浏览器 UA，避免千问网页版识别为异常环境
  qwenWindow.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  blockExternalProtocols(qwenWindow.webContents);
  qwenWindow.loadURL('https://chat.qwen.ai/');
  qwenWindow.on('closed', () => { qwenWindow = null; });
}

/**
 * 创建（或复用）续火花隐藏窗口
 * show: false + skipTaskbar: true，后台静默运行，绝不抢焦点/触发鼠标移动
 */
function getOrCreateFireSparkWindow() {
  if (fireSparkWindow && !fireSparkWindow.isDestroyed()) return fireSparkWindow;
  fireSparkWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,            // 隐藏窗口，后台自动化
    skipTaskbar: true,      // 任务栏不显示
    autoHideMenuBar: true,
    title: '续火花',
    webPreferences: {
      session: getFireSparkSession(),  // 独立持久化 session
      preload: path.join(__dirname, 'block-external-protocol-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  blockExternalProtocols(fireSparkWindow.webContents);
  fireSparkWindow.on('closed', () => { fireSparkWindow = null; });
  return fireSparkWindow;
}

/**
 * 执行一次续火花自动化（在隐藏窗口中静默完成）
 * 流程：加载页面 -> 定位好友 -> 输入随机文案 -> 点击发送
 * 🔴 DOM 选择器为占位，需在 data/fire-spark-config.json 填入实测选择器后才能生效
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function runFireSpark() {
  const config = readData('fire-spark-config.json');
  if (!config || !config.targetFriend) {
    return { success: false, message: '未配置目标好友，请在设置中填写要续火花的好友昵称' };
  }
  const messages = readData('fire-spark-messages.json');
  if (!Array.isArray(messages) || messages.length === 0) {
    return { success: false, message: '文案库为空，请先添加续火花文案' };
  }

  const win = getOrCreateFireSparkWindow();
  try {
    // 1. 加载续火花页面（私信/创作者平台）
    await win.loadURL(config.chatUrl || 'https://www.douyin.com/');
    // 等待页面加载（TODO：实际需根据网络情况调整等待策略/监听 did-finish-load）
    await new Promise((r) => setTimeout(r, 5000));

    const selectors = config.selectors || {};
    // 随机抽取一条文案（防止被判定为机器人）
    const randomMsg = messages[Math.floor(Math.random() * messages.length)];

    // 2. 在隐藏窗口中执行自动化脚本（executeJavaScript，不触发鼠标移动、不抢焦点）
    //    🔴 以下选择器均为占位，需填入抖音网页版实测 DOM 选择器
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        const sel = ${JSON.stringify(selectors)};
        const friend = ${JSON.stringify(config.targetFriend)};
        const msg = ${JSON.stringify(randomMsg)};
        // TODO: 定位聊天入口并点击（选择器：sel.chatEntry）
        // TODO: 定位目标好友会话并点击（选择器：sel.friendItem，匹配文字 friend）
        // TODO: 在输入框填入随机文案（选择器：sel.inputBox）
        // TODO: 点击发送按钮（选择器：sel.sendBtn）
        // 占位返回：选择器未配置时提示用户补全
        if (!sel.chatEntry || !sel.inputBox || !sel.sendBtn) {
          return { ok: false, reason: 'DOM 选择器未配置，请在设置中填入实测选择器' };
        }
        return { ok: true, sent: msg, friend: friend };
      })();
    `);

    if (result && result.ok) {
      return { success: true, message: '已发送「' + result.sent + '」给 ' + result.friend };
    }
    return { success: false, message: (result && result.reason) || '续火花执行失败' };
  } catch (err) {
    return { success: false, message: '续火花异常：' + err.message };
  }
}

/**
 * 启动续火花每日定时任务（node-schedule cron）
 * 配置读取自 data/fire-spark-config.json 的 scheduleTime（默认每天 00:01）
 * 配置变更或应用启动时调用
 */
function scheduleFireSpark() {
  if (!schedule) {
    console.warn('[续火花] node-schedule 未安装，定时任务未启动');
    return;
  }
  // 取消已有任务
  if (fireSparkJob) {
    fireSparkJob.cancel();
    fireSparkJob = null;
  }
  const config = readData('fire-spark-config.json');
  if (!config || !config.enabled) return;
  const cron = config.scheduleTime || '00 01 * * *';
  try {
    fireSparkJob = schedule.scheduleJob(cron, async () => {
      console.log('[续火花] 定时任务触发', new Date().toLocaleString());
      const r = await runFireSpark();
      console.log('[续火花] 结果：', r.message);
    });
    console.log('[续火花] 定时任务已启动，cron =', cron);
  } catch (e) {
    console.error('[续火花] 定时任务启动失败：', e.message);
  }
}

// ---------------------------------------------------------------------
// 抖音 / 千问 / 续火花 IPC 通信
// ---------------------------------------------------------------------

// 打开抖音独立全屏窗口
ipcMain.handle('open-douyin', () => {
  createDouyinWindow();
  return { success: true };
});

// 打开通义千问独立窗口
ipcMain.handle('open-qwen', () => {
  createQwenWindow();
  return { success: true };
});

// 手动触发一次续火花
ipcMain.handle('fire-spark:run', async () => runFireSpark());

// 显示续火花隐藏窗口（首次手动登录抖音，cookie 持久化到 persist:fire-session）
ipcMain.handle('fire-spark:show-login', async () => {
  const win = getOrCreateFireSparkWindow();
  const config = readData('fire-spark-config.json');
  await win.loadURL(config.chatUrl || 'https://www.douyin.com/');
  win.show();
  win.focus();
  return { success: true };
});

// 隐藏续火花窗口
ipcMain.handle('fire-spark:hide-login', async () => {
  if (fireSparkWindow && !fireSparkWindow.isDestroyed()) {
    fireSparkWindow.hide();
  }
  return { success: true };
});

// 读取续火花配置
ipcMain.handle('fire-spark:get-config', async () => readData('fire-spark-config.json'));

// 保存续火花配置（保存后重启定时任务使新配置生效）
ipcMain.handle('fire-spark:save-config', async (event, config) => {
  writeData('fire-spark-config.json', config);
  scheduleFireSpark();
  return { success: true };
});

// 读取文案库
ipcMain.handle('fire-spark:get-messages', async () => readData('fire-spark-messages.json'));

// 保存文案库
ipcMain.handle('fire-spark:save-messages', async (event, messages) => {
  writeData('fire-spark-messages.json', messages);
  return { success: true };
});

// ---------------------------------------------------------------------
// IPC 通信处理
// ---------------------------------------------------------------------

/**
 * 启动本地软件
 * 通过 exec 执行 `start "" "路径"`：
 *   - start 让目标进程启动后立即返回，避免主进程阻塞等待软件关闭
 *   - 双引号包裹路径，正确处理 Windows 下路径含空格的情况
 */
ipcMain.handle('launch-app', async (event, exePath) => {
  // 参数校验：路径不能为空
  if (!exePath || typeof exePath !== 'string' || exePath.trim() === '') {
    return { success: false, message: '软件路径不能为空' };
  }

  const trimmedPath = exePath.trim();

  // 若路径看起来像一个真实文件路径（包含路径分隔符），预检文件是否存在，
  // 以便给出更友好的错误提示（内置软件如 notepad.exe 是命令名，不做此预检）
  const looksLikeFullPath = /[\\/]/.test(trimmedPath);
  if (looksLikeFullPath && !fs.existsSync(trimmedPath)) {
    return { success: false, message: `找不到文件：${trimmedPath}` };
  }

  // 用双引号包裹路径，避免路径含空格或特殊字符时被 shell 截断
  const command = `start "" "${trimmedPath}"`;

  return new Promise((resolve) => {
    // windowsHide: true 避免闪现黑色命令行窗口
    exec(command, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        // 解析错误信息，尽量给用户有意义的提示
        const reason = stderr || error.message || '未知错误';
        resolve({ success: false, message: `启动失败：${reason}` });
      } else {
        resolve({ success: true, message: '启动成功' });
      }
    });
  });
});

/**
 * 打开本地文件或文件夹
 * shell.openPath 会用系统默认程序打开目标：
 *   - 文件：交给「双击该文件」时对应的默认应用打开
 *   - 文件夹：交给系统文件资源管理器打开
 * 返回值为空字符串表示成功，否则返回错误描述
 */
ipcMain.handle('open-path', async (event, targetPath) => {
  if (!targetPath || typeof targetPath !== 'string' || targetPath.trim() === '') {
    return { success: false, message: '路径不能为空' };
  }
  const trimmedPath = targetPath.trim();
  // 打开前预检路径是否存在，给出友好提示
  if (!fs.existsSync(trimmedPath)) {
    return { success: false, message: `找不到路径：${trimmedPath}` };
  }
  try {
    const errorMessage = await shell.openPath(trimmedPath);
    if (errorMessage) {
      return { success: false, message: `打开失败：${errorMessage}` };
    }
    return { success: true, message: '打开成功' };
  } catch (err) {
    return { success: false, message: `打开失败：${err.message}` };
  }
});

/**
 * 弹出系统文件选择对话框，让用户选择文件或文件夹
 * 说明：Windows/Linux 上打开对话框不能同时既选文件又选目录，
 *       同时设置 openFile + openDirectory 会被系统退化为「目录选择器」，
 *       导致无法选择具体文件。因此这里根据 kind 参数二选一：
 *       - kind = 'folder' → 只允许选文件夹（openDirectory）
 *       - 其它情况        → 只允许选文件（openFile）
 * @param {string} kind 选择类型：'folder' 选文件夹，否则选文件
 */
ipcMain.handle('select-path', async (event, kind) => {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const isFolder = kind === 'folder';
  const result = await dialog.showOpenDialog(win, {
    title: isFolder ? '选择文件夹' : '选择文件',
    properties: isFolder ? ['openDirectory'] : ['openFile']
  });
  // 用户取消选择
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }
  return { canceled: false, path: result.filePaths[0] };
});

/**
 * 把本地图片文件读成 data URL（用于自定义快捷方式图标）
 * @param {string} filePath 图片文件路径
 * @returns {{success: boolean, dataUrl?: string, message?: string}}
 */
function readImageDataUrl(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  const MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp',
    '.bmp': 'image/bmp', '.svg': 'image/svg+xml'
  };
  if (!MIME[ext]) {
    return { success: false, message: '仅支持图片文件（png/jpg/gif/ico/webp/bmp/svg）' };
  }
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length > 2 * 1024 * 1024) {
      return { success: false, message: '图片过大（限 2MB）' };
    }
    return { success: true, dataUrl: `data:${MIME[ext]};base64,${buf.toString('base64')}` };
  } catch (err) {
    return { success: false, message: '读取图片失败：' + err.message };
  }
}

/**
 * 选择本地图片或从可执行文件提取图标，作为快捷方式图标
 * - 图片文件（png/jpg/ico 等）：读取并转 data URL
 * - 可执行文件（.exe/.dll/.lnk）：用 app.getFileIcon 提取其图标转 data URL
 *   （.lnk 先解析目标路径/自定义图标路径，类似 Windows 更改快捷方式图标）
 * @returns {Promise<{canceled: boolean, path?: string, success?: boolean, dataUrl?: string, message?: string}>}
 */
ipcMain.handle('select-image', async (event) => {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const result = await dialog.showOpenDialog(win, {
    title: '选择图标',
    properties: ['openFile'],
    filters: [
      { name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'bmp', 'svg'] },
      { name: '可执行文件（提取图标）', extensions: ['exe', 'dll', 'lnk'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }
  const filePath = result.filePaths[0];
  const ext = path.extname(filePath).toLowerCase();
  // 从可执行文件 / .lnk 提取图标（类似 Windows 更改图标）
  if (ext === '.exe' || ext === '.dll' || ext === '.lnk') {
    try {
      let iconSource = filePath;
      // .lnk：优先用其自定义图标路径，否则解析目标路径
      if (ext === '.lnk') {
        const shortcut = shell.readShortcutLink(filePath);
        iconSource = (shortcut.icon && fs.existsSync(shortcut.icon)) ? shortcut.icon : shortcut.target;
      }
      if (!iconSource || !fs.existsSync(iconSource)) {
        return { canceled: false, path: filePath, success: false, message: '未找到可提取图标的文件' };
      }
      const img = await app.getFileIcon(iconSource, { size: 'large' });
      if (img && !img.isEmpty()) {
        return { canceled: false, path: filePath, success: true, dataUrl: img.toDataURL() };
      }
      return { canceled: false, path: filePath, success: false, message: '未能从该文件提取到图标' };
    } catch (e) {
      return { canceled: false, path: filePath, success: false, message: '提取图标失败：' + e.message };
    }
  }
  // 普通图片文件：读取为 data URL
  const read = readImageDataUrl(filePath);
  return { canceled: false, path: filePath, ...read };
});

/**
 * 读取文件关联图标（用于首页快捷方式）
 * 说明：利用系统 shell 关联，Windows 下对 .exe 会提取其内嵌图标，
 *       实现「类似 Windows 更改快捷方式图标」的默认图标效果。
 *       对于纯命令名（如 notepad.exe），先用 where 解析为完整路径再读取。
 *       返回 PNG 的 data URL；读取失败或文件不存在时返回空字符串。
 * @param {string} filePath 文件完整路径（如 C:\App\app.exe）或命令名
 */
ipcMain.handle('get-file-icon', async (event, filePath) => {
  if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
    return '';
  }
  let p = filePath.trim();
  // 纯命令名（不含路径分隔符）：用 where 解析完整路径，提高图标读取成功率
  if (!/[\\/]/.test(p)) {
    p = await resolveCommandPath(p);
  }
  // .lnk 快捷方式：解析目标路径，获取目标 .exe 的图标（而非 .lnk 默认图标）
  if (/\.lnk$/i.test(p)) {
    try {
      const shortcut = shell.readShortcutLink(p);
      const iconSource = (shortcut.icon && fs.existsSync(shortcut.icon)) ? shortcut.icon : shortcut.target;
      if (iconSource && fs.existsSync(iconSource)) {
        const img = await app.getFileIcon(iconSource, { size: 'large' });
        if (img && !img.isEmpty()) return img.toDataURL();
      }
    } catch (e) {
      // 解析失败：回退到直接用 .lnk 路径
    }
  }
  try {
    const img = await app.getFileIcon(p, { size: 'large' });
    return img && !img.isEmpty() ? img.toDataURL() : '';
  } catch (err) {
    return '';
  }
});

/**
 * 用 where 把命令名解析为完整路径（找不到则返回原值）
 * @param {string} cmd 命令名
 * @returns {Promise<string>}
 */
function resolveCommandPath(cmd) {
  return new Promise((resolve) => {
    exec(`where "${cmd}"`, { windowsHide: true }, (error, stdout) => {
      if (error || !stdout) return resolve(cmd);
      const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      resolve(first || cmd);
    });
  });
}

// ======================== 扫描系统已安装软件 ========================
// 纯 Node.js 扫描开始菜单 .lnk + reg.exe 读注册表，不依赖 PowerShell
// （部分系统 PowerShell 被安全策略阻止，改用 Node fs + reg.exe 系统自带命令）

/**
 * 扫描开始菜单 .lnk 快捷方式（纯 Node.js fs 递归扫描，无外部依赖）
 * .lnk 文件名作为软件名，.lnk 完整路径作为启动路径
 * （start "" "xxx.lnk" 可正常启动目标程序，无需解析 TargetPath）
 * @returns {Array<{name: string, path: string}>}
 */
function scanStartMenuShortcuts() {
  const dirs = [
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.AppData || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  ];
  const results = [];
  const scanDir = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk')) {
        const name = entry.name.slice(0, -4);
        results.push({ name, path: fullPath });
      }
    }
  };
  dirs.forEach(scanDir);
  return results;
}

/**
 * 扫描卸载注册表项（用 reg.exe 系统自带命令，非 PowerShell）
 * 从 DisplayIcon 解析出 .exe 路径作为补充
 * 读取 HKLM / HKLM WOW6432Node / HKCU 三个 Uninstall 根项
 * @returns {Promise<Array<{name: string, path: string}>>}
 */
async function scanUninstallRegistry() {
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ];
  const results = [];
  for (const key of keys) {
    const out = await new Promise((resolve) => {
      exec('reg query "' + key + '" /s', { windowsHide: true, maxBuffer: 10 * 1024 * 1024, encoding: 'buffer' }, (error, stdout) => {
        if (error || !Buffer.isBuffer(stdout)) return resolve('');
        try {
          resolve(new TextDecoder('gbk').decode(stdout));
        } catch (e) {
          resolve(stdout.toString('utf8'));
        }
      });
    });
    if (!out) continue;
    const lines = out.split(/\r?\n/);
    let name = '';
    let icon = '';
    const flush = () => {
      if (name && icon) {
        const iconPath = icon.split(',')[0].replace(/^"|"$/g, '').trim();
        if (iconPath && /\.exe$/i.test(iconPath)) {
          results.push({ name, path: iconPath });
        }
      }
      name = '';
      icon = '';
    };
    for (const line of lines) {
      if (/^HKEY_/i.test(line)) {
        flush();
      } else if (line.trim()) {
        const m = line.match(/^\s+(\S+)\s+REG_\S+\s+(.*)$/);
        if (m) {
          if (m[1] === 'DisplayName') name = m[2].trim();
          else if (m[1] === 'DisplayIcon') icon = m[2].trim();
        }
      }
    }
    flush();
  }
  return results;
}

// 过滤规则：排除卸载/帮助等无用项，排除系统目录下的程序
const SCAN_EXCLUDE_NAMES = /卸载|uninstall|remove|setup|help|readme|documentation|更新|update|installer/i;
const SCAN_EXCLUDE_PATHS = /^[cC]:\\Windows\\(System32|SysWOW64)\\/i;

/**
 * 过滤并合并去重扫描结果
 * 规则：只保留 .exe 和 .lnk；排除名称含卸载/帮助等；排除 System32 下；按路径去重；按名称排序
 * @param {Array} startMenuApps 开始菜单扫描结果
 * @param {Array} registryApps 注册表扫描结果
 * @returns {Array<{name: string, path: string}>}
 */
function mergeAndDedupScanResults(startMenuApps, registryApps) {
  const seen = new Set();
  const result = [];
  const add = (item) => {
    if (!item || !item.name || !item.path) return;
    const name = String(item.name).trim();
    const p = String(item.path).trim();
    if (!name || !p) return;
    if (!/\.exe$/i.test(p) && !/\.lnk$/i.test(p)) return;
    if (SCAN_EXCLUDE_NAMES.test(name)) return;
    if (SCAN_EXCLUDE_PATHS.test(p)) return;
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ name, path: p });
  };
  startMenuApps.forEach(add);
  registryApps.forEach(add);
  return result.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/**
 * 扫描系统已安装软件（开始菜单 + 卸载注册表，合并去重）
 * IPC 通道：scan-installed-apps
 * @returns {Promise<{success: boolean, apps: Array<{name: string, path: string}>, message?: string}>}
 */
ipcMain.handle('scan-installed-apps', async () => {
  try {
    const startMenuApps = scanStartMenuShortcuts();
    const registryApps = await scanUninstallRegistry();
    const merged = mergeAndDedupScanResults(startMenuApps, registryApps);
    return { success: true, apps: merged };
  } catch (err) {
    return { success: false, message: err.message || '扫描失败', apps: [] };
  }
});

/**
 * 读取某个数据文件的内容
 */
ipcMain.handle('data:read', async (event, filename) => {
  return readData(filename);
});

// ======================== 网易云音乐 API 代理 ========================
// 渲染进程受同源策略限制，无法直接 fetch localhost:3000；
// 由主进程用 Node http 模块代理请求，既规避跨域，又无需关闭 webSecurity。
// 说明：本应用只做前端 UI 与接口封装，NeteaseCloudMusicApi 服务需自行启动。
const NETEASE_API_HOST = 'localhost';
const NETEASE_API_PORT = 3000;

/**
 * 代理请求网易云音乐 API
 * @param {{ apiPath: string, query?: object, cookie?: string }} arg
 * @returns {Promise<{success: boolean, status?: number, body?: string, setCookie?: string[], message?: string}>}
 */
ipcMain.handle('netease:fetch', async (event, { apiPath, query, cookie }) => {
  return new Promise((resolve) => {
    // 拼接查询字符串（自动编码中文/特殊字符）
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    const options = {
      hostname: NETEASE_API_HOST,
      port: NETEASE_API_PORT,
      path: apiPath + qs,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Electron Netease Panel)' }
    };
    // 登录后的后续请求需携带 Cookie
    if (cookie) options.headers['Cookie'] = cookie;

    const req = http.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        // 回传 set-cookie，便于渲染进程拼接 Cookie
        const setCookie = res.headers['set-cookie'] || [];
        resolve({ success: true, status: res.statusCode, body, setCookie });
      });
    });
    req.on('error', (err) => {
      // 服务未启动 / 连接拒绝等
      resolve({ success: false, message: err.message });
    });
    req.end();
  });
});

// 网易云 API 子进程引用（由 netease:start-api fork，应用退出时需清理）
let neteaseApiProc = null;
// 子进程就绪 Promise：fork 后立即创建，resolve 时表示已 listen（或失败/超时）。
// 预热 fork 与 ipc handler 共享，避免「已 fork 但未 listen」竞态导致渲染进程拿到 ECONNREFUSED。
let neteaseApiWhenReady = null;

/**
 * 探测本地 API 端口是否已有服务在响应（复用已有实例，避免重复 fork）
 * @param {number} port 端口号
 * @returns {Promise<boolean>} true 表示服务存活
 */
function checkApiAlive(port) {
  return new Promise((resolve) => {
    // 本地 127.0.0.1 响应很快，400ms 足够；缩短无服务时的空等
    const req = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'GET', timeout: 400 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * fork 并等待网易云 API 子进程就绪（统一供预热与 ipc handler 调用）
 * 同时设置 neteaseApiProc 与 neteaseApiWhenReady。
 * @returns {Promise<{running?: boolean, port?: number, failed?: boolean, reason?: string}>}
 */
function spawnNeteaseApi() {
  neteaseApiWhenReady = new Promise((resolve) => {
    const hostPath = path.join(__dirname, 'netease-api-host.js');
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let proc;
    try {
      proc = fork(hostPath, [], { silent: true });
    } catch (e) {
      return done({ failed: true, reason: '启动子进程失败：' + e.message });
    }
    neteaseApiProc = proc;
    // 子进程回报启动结果
    proc.on('message', (msg) => {
      if (msg && msg.ok) done({ running: true, port: msg.port || NETEASE_API_PORT });
      else done({ failed: true, reason: (msg && msg.error) || 'API 服务启动失败' });
    });
    // 子进程退出：若尚未 settled 且非 0，视为失败（多为包未安装）
    proc.on('exit', (code) => {
      if (neteaseApiProc === proc) neteaseApiProc = null;
      if (!settled && code !== 0) {
        done({ failed: true, reason: '子进程异常退出（code=' + code + '），可能未安装 NeteaseCloudMusicApi，请在 my-workbench 目录运行 npm install NeteaseCloudMusicApi' });
      }
    });
    proc.on('error', (err) => done({ failed: true, reason: err.message }));
    // 启动超时兜底
    setTimeout(() => done({ failed: true, reason: 'API 服务启动超时' }), 15000);
  });
  return neteaseApiWhenReady;
}

/**
 * 自动启动 NeteaseCloudMusicApi 子进程（fork netease-api-host.js）
 * @returns {Promise<{running?: boolean, port?: number, failed?: boolean, reason?: string}>}
 */
ipcMain.handle('netease:start-api', async () => {
  // 已有进程：等待其就绪结果（已就绪则立即返回，spawning 中则等待，避免竞态）
  if (neteaseApiProc && !neteaseApiProc.killed && neteaseApiWhenReady) {
    const result = await neteaseApiWhenReady;
    // 失败且进程已退出：重试一次
    if (result.failed && (!neteaseApiProc || neteaseApiProc.killed)) {
      return spawnNeteaseApi();
    }
    return result;
  }
  // 端口探测：若 3000 已有服务在响应（外部启动 / 上次残留），直接复用
  if (await checkApiAlive(NETEASE_API_PORT)) {
    neteaseApiWhenReady = Promise.resolve({ running: true, port: NETEASE_API_PORT });
    return { running: true, port: NETEASE_API_PORT };
  }
  return spawnNeteaseApi();
});

/**
 * 停止网易云 API 子进程
 */
ipcMain.handle('netease:stop-api', async () => {
  if (neteaseApiProc && !neteaseApiProc.killed) {
    neteaseApiProc.kill();
    neteaseApiProc = null;
    return { stopped: true };
  }
  return { stopped: false };
});

/**
 * 打开外部网页链接（交给系统默认浏览器）
 * 说明：自动补齐 http/https 前缀；用于首页「网页快捷方式」。
 * @param {string} url 目标网址
 */
ipcMain.handle('open-url', async (event, url) => {
  if (!url || typeof url !== 'string' || url.trim() === '') {
    return { success: false, message: '链接不能为空' };
  }
  let target = url.trim();
  if (!/^https?:\/\//i.test(target)) {
    target = 'https://' + target;
  }
  try {
    await shell.openExternal(target);
    return { success: true, message: '已打开链接' };
  } catch (err) {
    return { success: false, message: `打开失败：${err.message}` };
  }
});

// 抖音外壳截图保存：接收 data URL，解码为 PNG 写入 data/screenshots/，并打开所在文件夹
ipcMain.handle('douyin:save-screenshot', async (event, dataUrl) => {
  try {
    if (!dataUrl || typeof dataUrl !== 'string') {
      return { success: false, message: '截图数据为空' };
    }
    const m = /^data:image\/png;base64,(.*)$/.exec(dataUrl);
    if (!m) return { success: false, message: '截图格式无效' };
    const buf = Buffer.from(m[1], 'base64');
    const shotDir = path.join(DATA_DIR, 'screenshots');
    if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const filename = `douyin-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
    const filePath = path.join(shotDir, filename);
    fs.writeFileSync(filePath, buf);
    // 在文件管理器中定位并选中该文件，方便用户查看
    shell.showItemInFolder(filePath);
    return { success: true, filename: filename };
  } catch (err) {
    return { success: false, message: `保存失败：${err.message}` };
  }
});

// 检测系统 Edge / Chrome 可执行文件路径（结果缓存，避免每次点击重复磁盘检测）
const _browserExeCache = {};
function findBrowserExe(name) {
  if (name in _browserExeCache) return _browserExeCache[name];
  const os = require('os');
  const candidates = name === 'edge' ? [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ] : [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe')
  ];
  let found = null;
  for (const p of candidates) {
    try { if (fs.existsSync(p)) { found = p; break; } } catch (e) {}
  }
  _browserExeCache[name] = found;
  return found;
}

// 浏览器启动器：用系统 Edge / Chrome / 默认浏览器打开指定 URL
ipcMain.handle('browser:open-in', async (event, { browser, url }) => {
  try {
    if (!url || typeof url !== 'string') return { success: false, message: '网址为空' };
    let exe = null, name = '默认浏览器';
    if (browser === 'edge') {
      exe = findBrowserExe('edge');
      name = 'Edge';
    } else if (browser === 'chrome') {
      exe = findBrowserExe('chrome');
      name = 'Chrome';
    }
    if (exe) {
      // detached + unref：让浏览器独立于本进程运行，本应用退出不影响它
      const child = require('child_process').spawn(exe, [url], { detached: true, stdio: 'ignore' });
      child.on('error', (e) => console.error('[browser:open-in] spawn 失败:', exe, e.message));
      child.unref();
      return { success: true, name };
    }
    // 未指定浏览器或未找到 Edge/Chrome，回退系统默认浏览器
    await shell.openExternal(url);
    return { success: true, name: '默认浏览器' };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

/**
 * 获取网页快捷方式的默认图标（网站 Favicon）
 * 说明：渲染进程的 CSP 限制 img-src 只能加载本地 / data:，因此由主进程
 *       通过 net 模块下载 favicon 并转成 data URL 返回，规避跨域与 CSP 问题。
 * @param {string} url 用户填写的网址
 * @returns {Promise<string>} favicon 的 data URL；失败返回空字符串
 */
ipcMain.handle('get-web-favicon', async (event, url) => {
  if (!url || typeof url !== 'string' || url.trim() === '') {
    return '';
  }
  return fetchFaviconDataUrl(url.trim());
});

/**
 * 下载网站 Favicon 并转为 data URL
 * 策略：请求站点根目录 /favicon.ico；如需更高命中率，可追加 Google favicon
 *       服务作为候选（国内环境可能不可达，默认关闭）。
 * @param {string} rawUrl 用户填写的网址
 * @returns {Promise<string>} favicon 的 data URL；失败返回空字符串
 */
function fetchFaviconDataUrl(rawUrl) {
  return new Promise((resolve) => {
    // 归一化 URL 提取主机名
    let host;
    try {
      const input = /^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl;
      host = new URL(input).hostname;
    } catch (e) {
      return resolve('');
    }

    const candidates = [
      `https://${host}/favicon.ico`
      // 备用候选（按需取消注释启用）：
      // `https://www.google.com/s2/favicons?domain=${host}&sz=64`
    ];

    let idx = 0;
    const tryNext = () => {
      if (idx >= candidates.length) return resolve('');
      request(candidates[idx++]);
    };

    const request = (targetUrl) => {
      let req;
      try {
        // redirect: 'follow' 自动跟随 301/302 重定向（如 favicon.ico → .png）
        req = net.request({ url: targetUrl, redirect: 'follow' });
      } catch (e) {
        return tryNext();
      }

      // 8 秒超时兜底，避免网络无响应时 Promise 永久挂起
      const timer = setTimeout(() => {
        try { req.abort(); } catch (e) { /* 忽略 */ }
      }, 8000);

      req.on('response', (res) => {
        const contentType = (res.headers['content-type'] || '').toLowerCase();

        // 非 200 或明确为 HTML（如 404 错误页）时，尝试下一个候选
        if (res.statusCode !== 200 || (contentType && contentType.includes('text/html'))) {
          res.on('data', () => {});
          res.on('end', () => { clearTimeout(timer); tryNext(); });
          return;
        }

        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            req.abort();            // 超过 1MB 视为异常
          } else {
            chunks.push(chunk);
          }
        });
        res.on('end', () => {
          clearTimeout(timer);
          if (size === 0 || size > 1024 * 1024) return tryNext();
          const buf = Buffer.concat(chunks);
          const mime = (contentType && contentType.split(';')[0].trim()) || 'image/x-icon';
          resolve(`data:${mime};base64,${buf.toString('base64')}`);
        });
      });
      req.on('error', () => { clearTimeout(timer); tryNext(); });
      req.end();
    };

    tryNext();
  });
}

/**
 * 写入某个数据文件
 */
ipcMain.handle('data:write', async (event, filename, data) => {
  try {
    writeData(filename, data);
    return { success: true };
  } catch (err) {
    return { success: false, message: `保存失败：${err.message}` };
  }
});

// ---------------------------------------------------------------------
// 设置 —— 开机自启动
// 说明：通过系统注册表（Windows 的 Run 键 / macOS 的 LoginItem）实现，
//       状态由操作系统保存，无需写入 data/settings.json
// ---------------------------------------------------------------------

/**
 * 读取开机自启动状态
 * @returns {Promise<boolean>} true 表示已开启
 */
ipcMain.handle('settings:get-autostart', async () => {
  return app.getLoginItemSettings().openAtLogin;
});

/**
 * 设置开机自启动
 * 说明：portable 版运行时 process.execPath 指向临时解压目录，
 *       electron-builder 的 portable 会注入 PORTABLE_EXECUTABLE_FILE
 *       指向真实 exe 路径，优先使用它注册自启动。
 * @param {boolean} enabled true 开启 / false 关闭
 * @returns {Promise<boolean>} 设置后的实际状态
 */
ipcMain.handle('settings:set-autostart', async (event, enabled) => {
  const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    path: exePath,
    args: []
  });
  return app.getLoginItemSettings().openAtLogin;
});

/**
 * 读取「关闭后继续后台运行」状态
 * @returns {Promise<boolean>} true 表示已开启
 */
ipcMain.handle('settings:get-background', async () => {
  return backgroundRun;
});

/**
 * 设置「关闭后继续后台运行」
 * 说明：持久化到 data/bg-run.json 独立文件（主进程持有），
 *       避免与渲染进程 Store 保存的 settings.json 相互覆盖字段。
 * @param {boolean} enabled true 开启 / false 关闭
 * @returns {Promise<{success: boolean, value?: boolean, message?: string}>}
 */
ipcMain.handle('settings:set-background', async (event, enabled) => {
  backgroundRun = !!enabled;
  try {
    writeData('bg-run.json', { enabled: backgroundRun });
    return { success: true, value: backgroundRun };
  } catch (err) {
    return { success: false, message: err.message, value: backgroundRun };
  }
});

// ---------------------------------------------------------------------
// 一键签到 IPC
// ---------------------------------------------------------------------

/**
 * 显示/隐藏签到专用 BrowserWindow（供用户手动登录一次，cookie 持久化）
 */
ipcMain.handle('sign:toggle-window', async (event, { taskId, url }) => {
  if (!taskId || !url) return { success: false, message: '缺少 taskId 或 url' };

  let win = SIGN_WINDOWS.get(taskId)?.win;

  if (!win) {
    // 新建窗口并加载 URL
    win = getOrCreateSignWindow(taskId, url);
    win.show();
    return { success: true, visible: true, message: '已打开签到窗口，请完成登录' };
  }

  // 窗口已存在，切换显示/隐藏
  if (win.isVisible()) {
    win.hide();
    return { success: true, visible: false, message: '已隐藏签到窗口' };
  } else {
    win.show();
    win.focus();
    return { success: true, visible: true, message: '已显示签到窗口' };
  }
});

/**
 * 执行签到自动化脚本（executeJavaScript 注入）
 *
 * 注入的脚本做三件事：
 *   1. 尝试用多种策略找到「签到按钮」（选择器 + 文本匹配）
 *   2. 模拟真实点击（dispatchEvent + click）
 *   3. 等待成功反馈（监听 DOM 变化 + 文本匹配 + 超时兜底）
 */
ipcMain.handle('sign:execute', async (event, { taskId, url, buttonSelector, successText }) => {
  try {
    if (!taskId) return { success: false, message: '缺少 taskId' };

    const entry = SIGN_WINDOWS.get(taskId);
    let win = entry?.win;

    // 如果窗口不存在，先创建并等页面加载
    if (!win) {
      if (!url) return { success: false, message: '窗口未打开且缺少 url' };
      win = getOrCreateSignWindow(taskId, url);
      await new Promise((resolve) => {
        const handler = () => { win.webContents.removeListener('did-finish-load', handler); resolve(); };
        win.webContents.on('did-finish-load', handler);
        // 5 秒兜底
        setTimeout(resolve, 5000);
      });
    }

    const wc = win.webContents;

    // 注入的自动化脚本（在页面内执行）
    const injectedScript = `(async () => {
      const result = { clicked: false, success: false, detail: '', error: '' };

      // ---- 步骤 1: 尝试找到签到按钮 ----
      const candidates = [];

      // 策略 A：自定义 selector（用户配置的）
      ${buttonSelector ? `
      try {
        const el = document.querySelector(${JSON.stringify(buttonSelector)});
        if (el) candidates.push({ el, score: 100, reason: '自定义 selector' });
      } catch(e) {}
      ` : ''}

      // 策略 B：常见 class / id
      const commonSelectors = [
        '.sign-btn', '.signin-btn', '.sign-in-btn', '.checkin-btn', '.check-in-btn',
        '.signBtn', '.checkInBtn', '.daily-sign', '.dailyCheckIn', '.daily-checkin',
        '#sign', '#signin', '#checkin', '#dailySign', '#dailyCheckIn',
        'button[class*="sign"]', 'button[class*="check"]', 'button[class*="签到"]',
        'a[class*="sign"]', 'a[class*="check"]', 'a[class*="签到"]'
      ];
      for (const sel of commonSelectors) {
        try {
          document.querySelectorAll(sel).forEach(el => {
            if (!candidates.find(c => c.el === el)) {
              candidates.push({ el, score: 70, reason: sel });
            }
          });
        } catch(e) {}
      }

      // 策略 C：文本内容匹配（中文 + 英文）
      const textKeywords = ['签到', '打卡', 'sign', 'Sign In', 'sign in', 'Check in', 'check-in', 'daily'];
      document.querySelectorAll('button, a, div[role="button"], span[role="button"]').forEach(el => {
        const text = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (textKeywords.some(kw => text.includes(kw.toLowerCase()))) {
          // 过滤掉导航栏、页脚的小按钮
          if (el.offsetParent !== null && el.offsetWidth > 30 && el.offsetHeight > 20) {
            candidates.push({ el, score: 85, reason: '文本匹配: ' + (el.innerText || el.textContent).trim().substring(0, 20) });
          }
        }
      });

      // 去重并选择最优候选
      const unique = candidates.filter((c, i, arr) => arr.findIndex(x => x.el === c.el) === i);
      if (unique.length === 0) {
        result.error = '未找到签到按钮，请检查选择器或手动登录';
        return result;
      }
      unique.sort((a, b) => b.score - a.score);
      const target = unique[0].el;

      // 如果是按钮/链接已禁用或已签到，跳过
      const disabled = target.disabled || target.hasAttribute('aria-disabled');
      const alreadySigned = /已签到|今日已签|signed|checked/i.test((target.innerText || target.textContent || ''));
      if (disabled || alreadySigned) {
        result.detail = '按钮已禁用或今日已签到：' + (target.innerText || target.textContent || '');
        result.success = true;
        result.clicked = false;
        return result;
      }

      // ---- 步骤 2: 模拟点击（双重保险） ----
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(r => setTimeout(r, 200));

      try {
        // 方式 1: 原生 click()
        target.click();
      } catch(e) {}
      try {
        // 方式 2: dispatchEvent（React/Vue 组件经常用这个）
        const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        target.dispatchEvent(evt);
      } catch(e) {}
      result.clicked = true;

      // ---- 步骤 3: 等待成功反馈（最多 8 秒） ----
      const successTexts = [
        ${successText ? JSON.stringify(successText) : ''},
        '签到成功', '签到完成', '今日已签到', '已签到', '打卡成功',
        '签到成功!', 'sign in success', 'check-in successful', 'checked in'
      ].filter(Boolean);

      const checkSuccess = () => {
        const pageText = document.body.innerText.toLowerCase();
        for (const t of successTexts) {
          if (pageText.includes(t.toLowerCase())) return t;
        }
        return null;
      };

      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 200));
        const hit = checkSuccess();
        if (hit) {
          result.success = true;
          result.detail = '成功匹配：' + hit;
          return result;
        }
      }

      // 超时但没出错，也算可能成功（有些站点无明确提示）
      result.detail = '已点击按钮，但未检测到明确的成功提示（超时）';
      result.success = false;
      return result;
    })();`;

    const pageReady = await wc.executeJavaScript(
      `document.readyState === 'complete' || document.readyState === 'interactive'`
    );
    if (!pageReady) {
      return { success: false, message: '页面尚未加载完成' };
    }

    const execResult = await wc.executeJavaScript(injectedScript);

    return {
      success: execResult.success,
      clicked: execResult.clicked,
      message: execResult.error || execResult.detail || '签到完成',
      raw: execResult
    };
  } catch (err) {
    return { success: false, message: '执行异常：' + err.message };
  }
});

/**
 * 获取当前签到窗口的 cookie 状态（用于判断是否已登录）
 */
ipcMain.handle('sign:get-cookies', async (event, { taskId }) => {
  const entry = SIGN_WINDOWS.get(taskId);
  if (!entry) return { success: false, message: '签到窗口未打开' };

  try {
    const cookies = await getSignSession().cookies.get({});
    return {
      success: true,
      count: cookies.length,
      domains: [...new Set(cookies.map(c => c.domain))]
    };
  } catch (err) {
    return { success: false, message: '获取 cookie 失败：' + err.message };
  }
});

/**
 * 新增 / 编辑 / 删除签到任务（持久化到 sign-tasks.json）
 */
ipcMain.handle('sign:save-tasks', async (event, tasks) => {
  try {
    writeData('sign-tasks.json', tasks);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('sign:load-tasks', async () => {
  return readData('sign-tasks.json');
});

// ---------------------------------------------------------------------
// 网页签到（HTTP 接口请求：Cookie + 直接请求签到接口）
// 用 Node 原生 http/https，不依赖浏览器，规避渲染进程跨域限制。
// ---------------------------------------------------------------------

/**
 * 通用 HTTP 请求（GET / POST，返回结构化结果）
 * @param {{ url: string, method?: string, headers?: object, body?: string, timeout?: number }} params
 * @returns {Promise<{statusCode?: number, body?: string, error?: string}>}
 */
function signHttpRequest({ url, method, headers, body, timeout }) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      resolve({ error: '无效的 URL：' + e.message });
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const methodUpper = (method || 'GET').toUpperCase();
    const reqHeaders = headers || {};

    const req = lib.request(parsed, {
      method: methodUpper,
      headers: reqHeaders,
      timeout: timeout || 15000
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });

    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', (err) => resolve({ error: err.message }));

    if (body && methodUpper !== 'GET') req.write(body);
    req.end();
  });
}

/**
 * 执行一次 HTTP 接口签到（请求体按内容自动判定 Content-Type）
 */
ipcMain.handle('sign:execute-http', async (event, params) => {
  try {
    const { url, method, cookie, extraHeaders, body } = params || {};
    if (!url) return { ok: false, error: '缺少接口 URL' };

    const headers = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'accept': '*/*',
      'accept-language': 'zh-CN,zh;q=0.9'
    };
    if (cookie) headers['cookie'] = cookie;

    // 请求体：以 { 开头视为 JSON，否则视为表单
    if (body) {
      if (String(body).trim().startsWith('{')) {
        headers['content-type'] = 'application/json; charset=UTF-8';
      } else {
        headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      }
    }

    // 额外请求头（每行 "Key: Value"，可覆盖默认头如 user-agent）
    if (extraHeaders) {
      String(extraHeaders).split(/\r?\n/).forEach((line) => {
        const idx = line.indexOf(':');
        if (idx > 0) {
          const k = line.slice(0, idx).trim();
          const v = line.slice(idx + 1).trim();
          if (k) headers[k.toLowerCase()] = v;
        }
      });
    }

    const res = await signHttpRequest({ url, method, headers, body });
    if (res.error) return { ok: false, error: res.error };
    return { ok: true, statusCode: res.statusCode, body: res.body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * 打开签到登录窗口：加载接口同域首页，用户登录后 cookie 持久化到 sign session
 * @param {{ url: string }} params 签到接口 URL（取其域名定位登录页）
 */
ipcMain.handle('sign:open-login', async (event, { url }) => {
  try {
    const hostname = new URL(url).hostname;
    const loginUrl = 'https://' + hostname;
    const win = getOrCreateSignWindow('login-' + hostname, loginUrl);
    win.show();
    win.focus();
    return { success: true, loginUrl };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

/**
 * 抓取指定站点当前登录 cookie（用于一键登录后自动填写）
 * @param {{ url: string }} params 签到接口 URL（按域名过滤 cookie）
 */
ipcMain.handle('sign:fetch-cookie', async (event, { url }) => {
  try {
    const hostname = new URL(url).hostname;
    const all = await getSignSession().cookies.get({});
    const matched = all.filter((c) => {
      const d = String(c.domain).replace(/^\./, '');
      return hostname === d || hostname.endsWith('.' + d);
    });
    return {
      success: true,
      cookie: matched.map((c) => c.name + '=' + c.value).join('; '),
      count: matched.length
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// =====================================================================
// WPS 专用签到（RSA + AES 加密多步流程）
// 原理：① GET 获取 RSA 公钥 → ② AES 加密用户数据 → ③ RSA 加密 AES 密钥
//       → ④ POST 签到接口（带加密 token 头 + 加密请求体）
// =====================================================================

/**
 * 生成随机 AES 密钥（22 位随机小写字母+数字 + 10 位时间戳 = 32 位）
 * 与 Python 参考实现保持一致
 */
function _wpsGenerateAesKey(length = 32) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let randomPart = '';
  for (let i = 0; i < length - 10; i++) {
    randomPart += chars[Math.floor(Math.random() * chars.length)];
  }
  const timestampPart = String(Math.floor(Date.now() / 1000));
  return randomPart + timestampPart;
}

/**
 * AES-256-CBC 加密（与 Python pycryptodome 实现兼容）
 * - 密钥：UTF-8 编码后零填充到 32 字节
 * - IV：AES 密钥前 16 个字符的 UTF-8 编码
 * - 填充：PKCS7（Node.js crypto 默认）
 * 返回 Base64 编码的密文
 */
function _wpsAesEncrypt(plainText, aesKey) {
  const keyBuffer = Buffer.alloc(32, 0);
  Buffer.from(aesKey, 'utf-8').copy(keyBuffer);
  const iv = Buffer.from(aesKey.slice(0, 16), 'utf-8');
  const cipher = crypto.createCipheriv('aes-256-cbc', keyBuffer, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf-8'), cipher.final()]);
  return encrypted.toString('base64');
}

/**
 * RSA-PKCS1v15 加密
 * @param {string} plainText 待加密明文（AES 密钥）
 * @param {string} publicKeyPem PEM 格式的 RSA 公钥
 * 返回 Base64 编码的密文
 */
function _wpsRsaEncrypt(plainText, publicKeyPem) {
  const encrypted = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(plainText, 'utf-8')
  );
  return encrypted.toString('base64');
}

/**
 * 从 Cookie 字符串中提取 uid 字段值（WPS 用户 ID）
 */
function _wpsExtractUid(cookieStr) {
  const match = String(cookieStr).match(/(?:^|;\s*)uid=(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * WPS 签到完整流程
 * @param {string} cookie 完整的 WPS 登录 Cookie（需含 uid 字段）
 * @returns {{ok: boolean, message?: string, alreadySigned?: boolean}}
 */
async function wpsSignIn(cookie) {
  const baseHeaders = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    'origin': 'https://personal-act.wps.cn',
    'referer': 'https://personal-act.wps.cn/',
    'cookie': cookie || ''
  };

  // ① 提取 user_id
  const userId = _wpsExtractUid(cookie);
  if (!userId) {
    return { ok: false, message: 'Cookie 中未找到 uid 字段，请重新登录' };
  }

  // ② GET 获取 RSA 公钥
  const keyRes = await signHttpRequest({
    url: 'https://personal-bus.wps.cn/sign_in/v1/encrypt/key',
    method: 'GET',
    headers: baseHeaders
  });
  if (keyRes.error || keyRes.statusCode !== 200) {
    return { ok: false, message: '获取加密公钥失败：' + (keyRes.error || 'HTTP ' + keyRes.statusCode) };
  }
  let keyData;
  try {
    keyData = JSON.parse(keyRes.body);
  } catch (e) {
    return { ok: false, message: '公钥响应非 JSON' };
  }
  if (keyData.result !== 'ok' || !keyData.data) {
    return { ok: false, message: '公钥接口返回异常：' + (keyData.msg || '') };
  }
  const publicKeyPem = Buffer.from(keyData.data, 'base64').toString('utf-8');

  // ③ 生成 AES 密钥 + 加密用户数据 + RSA 加密 AES 密钥
  const aesKey = _wpsGenerateAesKey(32);
  const plainData = JSON.stringify({ user_id: userId, platform: 64 });
  const extra = _wpsAesEncrypt(plainData, aesKey);
  const token = _wpsRsaEncrypt(aesKey, publicKeyPem);

  // ④ POST 签到
  const signInRes = await signHttpRequest({
    url: 'https://personal-bus.wps.cn/sign_in/v1/sign_in',
    method: 'POST',
    headers: { ...baseHeaders, token },
    body: JSON.stringify({ encrypt: true, extra, pay_origin: 'pc_ucs_rwzx_sign' })
  });
  if (signInRes.error) {
    return { ok: false, message: '签到请求失败：' + signInRes.error };
  }
  if (signInRes.statusCode !== 200) {
    return { ok: false, message: 'HTTP ' + signInRes.statusCode };
  }

  let signInData;
  try {
    signInData = JSON.parse(signInRes.body);
  } catch (e) {
    return { ok: false, message: '签到响应非 JSON' };
  }

  if (signInData.result === 'ok') {
    return { ok: true, message: '签到成功' };
  }
  // 已签到
  if (signInData.msg === 'has sign') {
    return { ok: true, message: '今日已签到', alreadySigned: true };
  }
  // 未登录
  if (signInData.ext_msg === 'userNotLogin') {
    return { ok: false, message: '登录态已过期，请重新登录' };
  }
  return { ok: false, message: signInData.msg || '签到失败' };
}

/**
 * 执行 WPS 专用签到
 */
ipcMain.handle('sign:wps-sign', async (event, { cookie }) => {
  try {
    if (!cookie) return { ok: false, message: '缺少 Cookie，请先一键登录' };
    return await wpsSignIn(cookie);
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

/**
 * 抓取所有 .wps.cn 域名的 Cookie（WPS 签到需要跨子域 Cookie）
 */
ipcMain.handle('sign:fetch-cookie-wps', async () => {
  try {
    const all = await getSignSession().cookies.get({});
    const matched = all.filter((c) => {
      const d = String(c.domain).replace(/^\./, '');
      return d.endsWith('wps.cn');
    });
    return {
      success: true,
      cookie: matched.map((c) => c.name + '=' + c.value).join('; '),
      count: matched.length
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// ---------------------------------------------------------------------
// 桌面程序签到（PowerShell 自动化）
// ---------------------------------------------------------------------

/**
 * 执行 PowerShell 脚本并返回输出
 * 这里用 spawn 而不是 exec，因为要：
 *   1. 实时捕获 stdout/stderr
 *   2. 支持超时自动终止
 *   3. 返回结构化 { stdout, stderr, exitCode }
 *
 * 脚本能力：
 *   - SendKeys：向活动窗口发送按键（如 SendKeys('^s') 发送 Ctrl+S）
 *   - AppActivate：把目标程序窗口设为前台
 *   - [Mouse]::Click()：精确坐标点击（需 Add-Type user32.dll）
 *   - 任何 PowerShell 能做的事（UIAutomation COM、启动子进程等）
 */
function runPowerShell(psScript, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let tmpFile = null;
    try {
      // 写入临时 .ps1 文件（UTF-8 with BOM）
      // 为什么不用 -Command 直接传？
      //   1. 命令行传参经过 shell 引号转义，脚本里的引号/反斜杠容易被破坏
      //   2. Windows PowerShell 5.1 按 GBK 读无 BOM 文件，中文注释/字符串会乱码
      //   3. 命令行有长度限制，长脚本会被截断
      tmpFile = path.join(app.getPath('temp'), 'jiao-sign-' + Date.now() + '.ps1');
      // BOM: EF BB BF，让 PowerShell 5.1 正确识别为 UTF-8
      fs.writeFileSync(tmpFile, '﻿' + psScript, 'utf8');

      const ps = require('child_process').spawn('powershell', [
        '-NoProfile',              // 不加载 profile，加速启动
        '-NonInteractive',         // 非交互模式
        '-ExecutionPolicy', 'Bypass',  // 绕过执行策略限制
        '-File', tmpFile
      ]);

      let stdout = '';
      let stderr = '';

      ps.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
      ps.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

      const cleanup = () => {
        clearTimeout(timer);
        // 执行完删除临时脚本
        try { if (tmpFile) fs.unlinkSync(tmpFile); } catch (e) { }
      };

      const timer = setTimeout(() => {
        ps.kill('SIGKILL');
        cleanup();
        resolve({
          success: false,
          message: 'PowerShell 执行超时（' + (timeoutMs / 1000) + '秒）',
          stdout, stderr
        });
      }, timeoutMs);

      ps.on('error', (err) => {
        cleanup();
        resolve({ success: false, message: '无法启动 PowerShell：' + err.message, stdout, stderr });
      });

      ps.on('close', (code) => {
        cleanup();
        resolve({
          success: code === 0,
          message: code === 0
            ? '执行完成（exit 0）'
            : '脚本返回非零退出码: ' + code,
          exitCode: code,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        });
      });
    } catch (err) {
      try { if (tmpFile) fs.unlinkSync(tmpFile); } catch (e) { }
      resolve({ success: false, message: '启动异常：' + err.message });
    }
  });
}

/**
 * 启动外部 .exe 程序
 * @returns {{success: boolean, pid?: number, message?: string}}
 */
function launchExe(exePath, args = []) {
  return new Promise((resolve) => {
    try {
      const child = require('child_process').spawn(exePath, args, {
        detached: true,          // 脱离父进程，主进程退出不影响
        stdio: 'ignore',
        windowsHide: false       // 显示程序窗口
      });
      child.unref();             // 不等待子进程退出
      resolve({ success: true, pid: child.pid });
    } catch (err) {
      resolve({ success: false, message: err.message });
    }
  });
}

/**
 * 检测某个 exe 是否正在运行
 * 用系统自带 tasklist 查询，零依赖
 * @param {string} exeName 例如 "Hyperdown.exe"
 */
function isProcessRunning(exeName) {
  return new Promise((resolve) => {
    try {
      const child = require('child_process').spawn(
        'tasklist',
        ['/FI', 'IMAGENAME eq ' + exeName, '/NH', '/FO', 'CSV'],
        { windowsHide: true }
      );
      let data = '';
      child.stdout.on('data', (d) => { data += d.toString(); });
      child.on('error', () => resolve(false));
      child.on('close', () => {
        // 匹配到 "Hyperdown.exe" 字样说明在运行；"信息: 没有运行..." 则未运行
        resolve(data.toLowerCase().indexOf(exeName.toLowerCase()) !== -1);
      });
    } catch (err) {
      resolve(false);
    }
  });
}

/**
 * 生成「激活窗口」PowerShell 脚本
 * 通过进程名找到主窗口句柄：
 *   - ShowWindow(SW_RESTORE=9)：从最小化/托盘恢复
 *   - SetForegroundWindow：置顶为前台窗口（SendKeys 才能发对地方）
 */
function buildActivateScript(procName) {
  return [
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class WinApi {',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '}',
    '"@',
    '$p = Get-Process -Name "' + procName + '" -ErrorAction SilentlyContinue |',
    '  Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |',
    '  Select-Object -First 1',
    'if ($p) {',
    '  [WinApi]::ShowWindow($p.MainWindowHandle, 9) | Out-Null',
    '  [WinApi]::SetForegroundWindow($p.MainWindowHandle) | Out-Null',
    '  Write-Host "已激活窗口 PID=$($p.Id)"',
    '} else {',
    '  Write-Host "未找到主窗口句柄（程序可能还在启动或最小化到托盘）"',
    '}'
  ].join('\n');
}

/**
 * 生成「等待程序就绪」PowerShell 脚本
 *
 * 桌面程序没有 DOM 可以轮询，用三个 Windows 层面信号判断"完全打开"：
 *   1. 主窗口句柄出现（MainWindowHandle != 0）
 *      —— 程序从启动画面/托盘阶段进入真实主窗口
 *   2. 窗口矩形连续 2 次轮询不变（约 1 秒稳定）
 *      —— 开屏动画、窗口还原、布局加载已结束
 *   3. （可选）窗口标题包含指定关键词
 *      —— 最精准：标题通常在主界面数据加载完才定型
 * 同时过滤掉宽高 < 200px 的小窗口（启动 Splash 画面）。
 *
 * @param {string} procName 进程名（不带 .exe）
 * @param {string} titleKeyword 可选，窗口标题关键词
 * @param {number} timeoutMs 最长等待毫秒
 */
function buildWaitReadyScript(procName, titleKeyword = '', timeoutMs = 30000) {
  // PowerShell 里转义双引号：关键词中的 " 替换为 ""
  const safeTitle = String(titleKeyword || '').replace(/"/g, '""');
  return [
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class WaitWin {',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);',
    '  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    '}',
    '"@',
    '$procName = "' + procName + '"',
    '$titleKw = "' + safeTitle + '"',
    '$timeoutMs = ' + timeoutMs,
    '$start = Get-Date',
    '$lastRect = ""',
    '$stable = 0',
    '$ready = $false',
    '',
    'while (((Get-Date) - $start).TotalMilliseconds -lt $timeoutMs) {',
    '  $p = Get-Process -Name $procName -ErrorAction SilentlyContinue |',
    '    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |',
    '    Select-Object -First 1',
    '  if ($p) {',
    '    $r = New-Object WaitWin+RECT',
    '    [WaitWin]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null',
    '    $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top',
    '    $key = "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)"',
    '    # 标题关键词检查（未配置则跳过）',
    '    $titleOk = $true',
    '    if ($titleKw -ne "") { $titleOk = ($p.MainWindowTitle -like "*$titleKw*") }',
    '    # 过滤启动画面：宽高都要 > 200px',
    '    if ($titleOk -and $w -gt 200 -and $h -gt 200) {',
    '      if ($key -eq $lastRect) {',
    '        $stable++',
    '        if ($stable -ge 2) { $ready = $true; break }   # 连续 2 次（~1s）不变 = 稳定',
    '      } else {',
    '        $stable = 0',
    '        $lastRect = $key',
    '      }',
    '    }',
    '  }',
    '  Start-Sleep -Milliseconds 500',
    '}',
    '',
    '$elapsed = [int]((Get-Date) - $start).TotalMilliseconds',
    'if ($ready) {',
    '  Write-Host "READY after ${elapsed}ms title=$($p.MainWindowTitle)"',
    '  exit 0',
    '} else {',
    '  Write-Host "READY_TIMEOUT after ${elapsed}ms"',
    '  exit 1',
    '}'
  ].join('\n');
}

/**
 * 生成「关闭程序」PowerShell 脚本
 * Stop-Process 的 -Name 不带 .exe 后缀
 */
function buildCloseScript(procName) {
  return [
    '$procs = Get-Process -Name "' + procName + '" -ErrorAction SilentlyContinue',
    'if ($procs) {',
    '  $procs | Stop-Process -Force -ErrorAction SilentlyContinue',
    '  Write-Host "已关闭进程 ' + procName + '"',
    '} else {',
    '  Write-Host "进程不存在，无需关闭"',
    '}'
  ].join('\n');
}

/**
 * 桌面程序一键签到主入口
 *
 * 执行流程：
 *   1. 检测目标程序是否已在运行
 *      - 已运行（单实例软件重复启动会失败）→ 跳过启动，直接激活已有窗口
 *      - 未运行 → 启动 exe
 *   2. 等待程序就绪
 *      - waitMode='auto'：轮询主窗口句柄出现 + 窗口矩形稳定 + 可选标题关键词
 *      - waitMode='fixed'：固定等待 launchDelay 毫秒
 *   3. 激活窗口到前台（恢复最小化/托盘状态）
 *   4. 执行用户写的 PowerShell 自动化脚本
 *   5. （可选）执行校验脚本
 *   6. （可选）签到后自动关闭目标程序
 */
ipcMain.handle('sign:execute-desktop', async (event, {
  exePath,
  exeArgs = [],
  launchDelay = 3000,
  waitMode = 'auto',          // 'auto' = 智能等待窗口就绪；'fixed' = 固定延迟
  waitWindowTitle = '',       // 可选：窗口标题关键词（auto 模式下最精准）
  waitTimeout = 30000,        // 智能等待最长毫秒
  psScript = '',
  verifyScript = '',
  closeAfterSign = false
}) => {
  const results = [];
  let procName = '';
  let launchedFresh = false;

  // --- 步骤 1：检测进程状态，已运行则不重复启动 ---
  if (exePath) {
    if (!fs.existsSync(exePath)) {
      return { success: false, message: '可执行文件不存在：' + exePath };
    }
    const exeName = path.basename(exePath);              // Hyperdown.exe
    procName = exeName.replace(/\.exe$/i, '');            // Hyperdown

    const running = await isProcessRunning(exeName);
    if (running) {
      // 单实例软件（QQ/微信/编辑器等）二次 spawn 会立即退出，
      // 所以这里直接复用已有实例，稍后激活它的窗口
      results.push({
        step: 'launch',
        success: true,
        alreadyRunning: true,
        message: '程序已在后台运行，将激活现有窗口'
      });
    } else {
      const launchRes = await launchExe(exePath, exeArgs);
      results.push({ step: 'launch', ...launchRes });
      if (!launchRes.success) {
        return { success: false, message: '启动失败：' + launchRes.message, results };
      }
      launchedFresh = true;
    }

    // --- 步骤 2：等待程序就绪 ---
    // auto：轮询窗口句柄 + 窗口矩形稳定 + 可选标题匹配
    // fixed：固定等待 launchDelay 毫秒
    // 已在后台运行的实例也走一次 auto（通常 1~2 秒内就判定就绪）
    if (waitMode === 'auto') {
      const waitRes = await runPowerShell(
        buildWaitReadyScript(procName, waitWindowTitle, waitTimeout),
        waitTimeout + 10000
      );
      results.push({ step: 'wait', ...waitRes });
      if (waitRes.success) {
        // 解析等待耗时，例如 stdout: "READY after 4200ms title=..."
        const m = /READY after (\d+)ms/.exec(waitRes.stdout || '');
        waitRes.waitedMs = m ? parseInt(m[1]) : null;
      }
    } else if (launchedFresh && launchDelay > 0) {
      await new Promise(r => setTimeout(r, launchDelay));
      results.push({ step: 'wait', success: true, message: '固定等待 ' + launchDelay + 'ms' });
    }
  }

  // --- 步骤 3：激活窗口到前台（恢复最小化/托盘，保证 SendKeys 发送目标正确） ---
  if (procName) {
    const activateRes = await runPowerShell(buildActivateScript(procName), 10000);
    results.push({ step: 'activate', ...activateRes });
    await new Promise(r => setTimeout(r, 600));
  }

  // --- 步骤 4：执行用户自动化脚本 ---
  let psResult = null;
  if (psScript && psScript.trim()) {
    psResult = await runPowerShell(psScript);
    results.push({ step: 'automation', ...psResult });
  }

  // --- 步骤 5：执行校验脚本（可选） ---
  let verifyResult = null;
  if (verifyScript && verifyScript.trim()) {
    verifyResult = await runPowerShell(verifyScript, 15000);
    results.push({ step: 'verify', ...verifyResult });
  }

  // --- 步骤 6：签到后自动关闭目标程序 ---
  let closeResult = null;
  if (closeAfterSign && procName) {
    // 等待签到请求/界面反馈完成，再关闭
    await new Promise(r => setTimeout(r, 1500));
    closeResult = await runPowerShell(buildCloseScript(procName), 10000);
    results.push({ step: 'close', ...closeResult });
  }

  // --- 汇总结果 ---
  const success =
    (!psResult || psResult.success) &&
    (!verifyResult || verifyResult.success) &&
    (!closeResult || closeResult.success);

  const parts = [];
  const launched = results.find(r => r.step === 'launch');
  if (launched?.alreadyRunning) parts.push('已激活后台运行的程序');
  else if (exePath) parts.push('程序已启动');

  // 就绪等待结果（超时不算失败，仍尝试执行，但给出提示）
  const waitRes = results.find(r => r.step === 'wait');
  if (waitRes && waitMode === 'auto') {
    if (waitRes.success) {
      parts.push(waitRes.waitedMs != null
        ? '窗口已就绪（' + (waitRes.waitedMs / 1000).toFixed(1) + 's）'
        : '窗口已就绪');
    } else {
      parts.push('就绪检测超时，仍尝试执行');
    }
  }

  if (psScript) parts.push(psResult?.success ? '签到操作执行成功' : '脚本执行出错');
  else parts.push('未配置自动化脚本');
  if (closeResult) parts.push(closeResult.success ? '程序已自动关闭' : '关闭程序失败');

  let message = parts.join('，');
  if (!success && psResult && !psResult.success) {
    message = '脚本执行出错：' + (psResult.stderr || psResult.message || '未知错误');
  }

  return { success, message, results };
});

// ---------------------------------------------------------------------
// 坐标拾取器（全屏透明置顶窗口，鼠标点哪就抓哪个屏幕坐标）
// ---------------------------------------------------------------------

let pickerWindow = null;

/**
 * 创建全屏透明拾取窗口
 * 机制：
 *   1. 创建一个无边框、透明、置顶的全屏 BrowserWindow
 *   2. 加载 picker.html（十字线 + 实时坐标显示）
 *   3. 用户点击左键 → 渲染进程发 picker:confirm →
 *      主进程用 screen.getCursorScreenPoint() 取【物理鼠标位置】
 *      （比渲染层的 clientX 更准，天然适配多显示器）
 *   4. ESC / 右键 → picker:cancel
 */
function createPickerWindow() {
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.focus();
    return pickerWindow;
  }

  // 计算所有显示器组成的「虚拟屏幕」总区域
  // （多显示器时副屏可能在主屏左侧/上方，坐标为负，必须取并集）
  // 注意：不能用 fullscreen:true —— Windows 上 fullscreen + transparent
  // 组合会导致窗口只铺满主窗口大小而非整个屏幕。
  const displays = screen.getAllDisplays();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  displays.forEach(d => {
    minX = Math.min(minX, d.bounds.x);
    minY = Math.min(minY, d.bounds.y);
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
  });

  pickerWindow = new BrowserWindow({
    frame: false,
    transparent: true,
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    show: false,                 // 加载完成后再显示，避免闪烁
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // screen-saver 层级：盖过所有普通窗口（包括目标程序）
  pickerWindow.setAlwaysOnTop(true, 'screen-saver');
  pickerWindow.loadFile(path.join(__dirname, 'picker.html'));

  pickerWindow.on('closed', () => { pickerWindow = null; });

  return pickerWindow;
}

ipcMain.handle('sign:pick-coordinate', async () => {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('picker:confirm', onConfirm);
      ipcMain.removeListener('picker:cancel', onCancel);
      if (pickerWindow && !pickerWindow.isDestroyed()) {
        pickerWindow.close();
        pickerWindow = null;
      }
      resolve(result);
    };

    // 左键确认：坐标以主进程 screen API 为准（多显示器/DPI 更可靠）
    const onConfirm = () => {
      // getCursorScreenPoint 返回 DIP（与分辨率无关的逻辑坐标），
      // 而 PowerShell 里 SetProcessDPIAware() 后的 SetCursorPos
      // 使用【物理像素】，125%/150% 缩放屏下两者不一致，必须转换。
      const dip = screen.getCursorScreenPoint();
      const disp = screen.getDisplayNearestPoint(dip);
      const sf = (disp && disp.scaleFactor) || 1;
      finish({
        success: true,
        x: Math.round(dip.x * sf),   // 物理像素（写入 PowerShell 脚本）
        y: Math.round(dip.y * sf),
        dipX: dip.x, dipY: dip.y,   // DIP 坐标（调试参考）
        scaleFactor: sf
      });
    };
    const onCancel = () => {
      finish({ success: false, cancelled: true });
    };

    ipcMain.on('picker:confirm', onConfirm);
    ipcMain.on('picker:cancel', onCancel);

    const win = createPickerWindow();
    let shown = false;
    const forceShow = () => {
      if (shown) return;
      shown = true;
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
      }
    };
    win.webContents.once('did-finish-load', forceShow);
    // 加载失败兜底：preload/asar 加载异常时页面脚本未绑定，用户无法点击/ESC，
    // 直接按取消处理，避免透明置顶窗口"隐形盖屏"锁死整个桌面
    win.webContents.once('did-fail-load', (e, errorCode, errorDescription) => {
      console.error('[picker] 加载失败:', errorCode, errorDescription);
      finish({ success: false, cancelled: true });
    });
    // 超时兜底：3 秒内无论加载结果如何都强制 show，防止 did-finish-load 静默不触发
    setTimeout(forceShow, 3000);
    // 兜底：窗口被意外关闭（如 Alt+F4）时按取消处理
    win.on('closed', () => finish({ success: false, cancelled: true }));
  });
});

/**
 * 获取内置 PowerShell 脚本模板（给前端下拉选择用）
 */
ipcMain.handle('sign:ps-templates', async () => {
  return [
    {
      id: 'activate-sendkeys',
      name: '激活窗口 + 发送按键',
      desc: '先把目标程序窗口设为前台，再发送一个或多个按键（如 Alt+S）',
      script: [
        'Add-Type -AssemblyName System.Windows.Forms',
        '# 把引号里的窗口标题改成你程序的标题（窗口上显示的名字）',
        '$wshell = New-Object -ComObject WScript.Shell',
        '$wshell.AppActivate("窗口标题")  # ← 改成你的程序窗口标题',
        'Start-Sleep -Milliseconds 300',
        '# 发送按键：^ = Ctrl, ! = Alt, + = Shift, {ENTER} = 回车',
        '# 例如：发送 Alt+S 然后回车',
        '[System.Windows.Forms.SendKeys]::SendWait("!s")',
        'Start-Sleep -Milliseconds 200',
        '[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")',
        'Write-Host "按键已发送"'
      ].join('\n')
    },
    {
      id: 'coordinate-click',
      name: '精确坐标点击',
      desc: '用 user32.dll 在指定屏幕坐标点击（坐标用「拾取屏幕坐标」按钮抓取，含高 DPI 适配）',
      script: [
        '# === 高 DPI 适配：防止 125%/150% 缩放屏坐标偏移 ===',
        'Add-Type @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class Mouse {',
        '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
        '  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);',
        '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
        '}',
        '"@',
        '[Mouse]::SetProcessDPIAware() | Out-Null',
        '',
        '# === 可选：先激活目标程序窗口（把引号里改成窗口标题）===',
        '# $wshell = New-Object -ComObject WScript.Shell',
        '# $wshell.AppActivate("窗口标题")',
        '# Start-Sleep -Milliseconds 500',
        '',
        '# === 坐标：用表单里的「拾取屏幕坐标」按钮自动抓取（物理像素，已按缩放转换）===',
        '$x = 500; $y = 300',
        '[Mouse]::SetCursorPos($x, $y)',
        'Start-Sleep -Milliseconds 200',
        '[Mouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)  # 左键按下',
        '[Mouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # 左键抬起',
        'Write-Host "已点击 ($x, $y)"'
      ].join('\n')
    },
    {
      id: 'shortcut',
      name: '发送快捷键组合',
      desc: '直接发送快捷键，不关心窗口激活（适合窗口已经在前台的情况）',
      script: [
        'Add-Type -AssemblyName System.Windows.Forms',
        '# 把引号里改成你要发送的快捷键组合',
        '# 语法：^ = Ctrl, ! = Alt, + = Shift, # = Win',
        '# 示例：Ctrl+Alt+S  → "^!s"',
        '# 示例：Ctrl+N      → "^n"',
        '[System.Windows.Forms.SendKeys]::SendWait("^!s")',
        'Write-Host "快捷键已发送"'
      ].join('\n')
    }
  ];
});

// ---------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------

// 当 Electron 初始化完成后创建窗口，并确保数据目录存在
/**
 * 构建中文应用菜单（替换 Electron 默认的 File/Edit/View/Window 英文菜单）
 * label 用中文，role 保留原有功能与快捷键
 */
function buildChineseMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'delete', label: '删除' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'maximize', label: '最大化' },
        { role: 'close', label: '关闭窗口' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: '教公台-阡稻工作室',
              detail: '个人工作台桌面应用 v2.0.0'
            });
          }
        }
      ]
    }
  ];
  return Menu.buildFromTemplate(template);
}

// ---------------------------------------------------------------------
// 单实例锁 + 外部协议拦截（bytedance:// 等）
// 抖音网页触发 bytedance:// 唤起 PC 客户端时，Windows 没有直接拦截外部协议的事件，
// 官方推荐方式：把协议注册给本应用，触发时由 second-instance 接收并静默忽略，
// Chromium 见有处理程序就不再弹"没有应用可打开此链接"提示
// ---------------------------------------------------------------------

// 需要静默拦截的外部协议列表
const BLOCKED_PROTOCOLS = ['bytedance', 'snssdk', 'aweme'];

// 单实例锁：确保只运行一个实例，bytedance:// 触发时走 second-instance 而非新窗口
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  // 第二实例启动时（bytedance:// 触发），检查命令行参数，静默忽略外部协议调用
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    const hasBlocked = commandLine.some((arg) =>
      BLOCKED_PROTOCOLS.some((p) => arg.startsWith(p + '://'))
    );
    if (hasBlocked) return; // 静默忽略，不开新窗口
    showMainWindow();       // 非协议调用（双击图标），聚焦主窗口
  });
}

app.whenReady().then(() => {
  // 注册外部协议给本应用，使 bytedance:// 等不再弹"没有应用"提示
  // 注意：开发模式下 process.execPath 是 electron.exe，若不传 args，协议触发时
  // electron.exe 会把协议 URL 当作应用路径加载 → "Error launching app"。
  // 必须传 [__dirname] 让命令变为 electron.exe <appDir> <protocol-url>，
  // electron.exe 先加载 appDir，协议 URL 走 second-instance 静默忽略。
  // 打包后 process.execPath 是应用 exe，直接注册即可。
  if (!app.isPackaged) {
    // 清理旧版本（无 args）残留的注册表项，避免协议触发时仍走旧的错误命令
    BLOCKED_PROTOCOLS.forEach((p) => {
      try { app.removeAsDefaultProtocolClient(p); } catch (e) {}
    });
  }
  BLOCKED_PROTOCOLS.forEach((p) => {
    try {
      if (app.isPackaged) {
        app.setAsDefaultProtocolClient(p);
      } else {
        app.setAsDefaultProtocolClient(p, process.execPath, [path.join(__dirname)]);
      }
    } catch (e) { console.warn('注册协议失败:', p, e.message); }
  });
  initDataDir();

  // 必应国际版：默认 session 加请求拦截，尽量打开国际版而非中国版(cn.bing.com)
  // 1) 主框架导航到 cn.bing.com 时改写回国际版 URL（对抗中国 IP 的 302 重定向）
  // 2) bing.com 请求加 Accept-Language: en-US，影响地域判断
  // 说明：若 Bing 服务器无视 cc=US 仍强制重定向，Chromium 会在多次重定向后报错而非无限循环
  const BING_INTL_URL = 'https://www.bing.com/?setmkt=en-US&setlang=en-US&cc=US';
  const bingSession = session.defaultSession;
  // 把默认 session 的 User-Agent 改为纯 Chrome UA（去掉 Electron 字样），
  // 避免 Bing 等站点识别为自动化工具触发人机验证(CAPTCHA)
  const chromeVer = process.versions.chrome || '130.0.0.0';
  bingSession.setUserAgent(
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`
  );
  bingSession.webRequest.onBeforeRequest(
    { urls: ['https://cn.bing.com/*', 'http://cn.bing.com/*'] },
    (details, callback) => {
      if (details.resourceType === 'mainFrame') {
        // 保留原路径和查询参数（如搜索词 ?q=xxx），只把 cn.bing.com 换成 www.bing.com 并加国际版标记。
        // 避免粗暴改写回首页导致搜索词丢失、搜索后跳回首页。
        try {
          const u = new URL(details.url);
          u.hostname = 'www.bing.com';
          u.protocol = 'https:';
          u.searchParams.set('setmkt', 'en-US');
          u.searchParams.set('setlang', 'en-US');
          u.searchParams.set('cc', 'US');
          callback({ redirectURL: u.toString() });
        } catch (e) {
          callback({ redirectURL: BING_INTL_URL });
        }
        return;
      }
      callback({});
    }
  );
  bingSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://*.bing.com/*', 'http://*.bing.com/*'] },
    (details, callback) => {
      const headers = Object.assign({}, details.requestHeaders);
      headers['Accept-Language'] = 'en-US,en;q=0.9';
      callback({ requestHeaders: headers });
    }
  );

  // 读取「关闭后继续后台运行」持久化状态
  const bgConf = readData('bg-run.json');
  backgroundRun = !!(bgConf && bgConf.enabled);
  Menu.setApplicationMenu(buildChineseMenu());
  createWindow();
  createTray();

  // 启动抖音续火花每日定时任务（node-schedule，配置见 data/fire-spark-config.json）
  scheduleFireSpark();

  // 预热网易云 API：窗口创建后立即后台启动，用户切到网易云页面时已就绪
  // 使用 spawnNeteaseApi 统一入口，neteaseApiWhenReady 记录就绪 Promise，
  // ipc handler 会 await 它，避免「已 fork 但未 listen」竞态
  checkApiAlive(NETEASE_API_PORT).then((alive) => {
    if (alive) {
      neteaseApiWhenReady = Promise.resolve({ running: true, port: NETEASE_API_PORT });
    } else if (!neteaseApiProc || neteaseApiProc.killed) {
      spawnNeteaseApi();
    }
  });

  // macOS 上点击 Dock 图标且没有窗口时，重新创建窗口（其他平台不触发）
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 真正退出前放行 close 拦截（托盘退出 / 菜单退出 / 系统退出都会触发）
app.on('before-quit', () => {
  quitting = true;
  // 清理注册的外部协议（避免注册表残留）
  // 注册时传了 args，清理时也必须传相同 args 才能匹配注册表项
  BLOCKED_PROTOCOLS.forEach((p) => {
    try {
      if (app.isPackaged) {
        app.removeAsDefaultProtocolClient(p);
      } else {
        app.removeAsDefaultProtocolClient(p, process.execPath, [path.join(__dirname)]);
      }
    } catch (e) {}
  });
  // 清理网易云 API 子进程
  if (neteaseApiProc && !neteaseApiProc.killed) {
    neteaseApiProc.kill();
    neteaseApiProc = null;
  }
  // 清理续火花定时任务
  if (fireSparkJob) {
    fireSparkJob.cancel();
    fireSparkJob = null;
  }
});

// 所有窗口都关闭时退出应用（Windows / Linux 惯例；macOS 例外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});