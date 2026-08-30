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

const { app, BrowserWindow, ipcMain, dialog, shell, session, screen, Menu } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------
// 常量定义
// ---------------------------------------------------------------------

// 用户数据存放目录（相对于主进程文件所在目录，即项目目录下的 data/）
const DATA_DIR = path.join(__dirname, 'data');

// 允许读写的数据文件白名单（防止渲染进程通过文件名参数访问任意文件）
const ALLOWED_FILES = ['apps.json', 'events.json', 'skills.json', 'settings.json', 'sign-tasks.json'];

// 每个数据文件对应的默认值（文件不存在或损坏时使用）
const DEFAULT_VALUES = {
  'apps.json': [],
  'events.json': [],
  'skills.json': [],
  'settings.json': { theme: 'light' },
  'sign-tasks.json': []
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
    title: 'jiao公台',
    backgroundColor: '#f0f2f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('index.html');
}

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
 * 选择本地图片作为快捷方式图标：弹出对话框 → 读取并转 data URL
 * @returns {Promise<{canceled: boolean, path?: string, success?: boolean, dataUrl?: string, message?: string}>}
 */
ipcMain.handle('select-image', async (event) => {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const result = await dialog.showOpenDialog(win, {
    title: '选择图标图片',
    properties: ['openFile'],
    filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'bmp', 'svg'] }]
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }
  const filePath = result.filePaths[0];
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

/**
 * 读取某个数据文件的内容
 */
ipcMain.handle('data:read', async (event, filename) => {
  return readData(filename);
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
// AI 技能发现器 —— 抓取固定网站 + AI 分析
// 数据源：https://www.cocoloop.cn/、https://threeui.com/browse、
//         https://www.zcool.com.cn/、https://www.reactbits.dev/get-started/index
// ---------------------------------------------------------------------

// 固定数据源列表
const SOURCE_URLS = [
  { url: 'https://www.cocoloop.cn/', name: 'Cocoloop' },
  { url: 'https://threeui.com/browse', name: 'Three UI' },
  { url: 'https://www.zcool.com.cn/', name: '站酷 (Zcool)' },
  { url: 'https://www.reactbits.dev/get-started/index', name: 'React Bits' },
  { url: 'https://github.com/', name: 'GitHub' }
];

let WebFetcher;
async function getWebFetcher() {
  if (!WebFetcher) {
    const mod = await (async () => {
      try {
        return require('duckduckgo-websearch');
      } catch {
        return import('duckduckgo-websearch');
      }
    })();
    WebFetcher = mod.WebFetcher || mod.default?.WebFetcher;
  }
  return WebFetcher;
}

/**
 * 调用 OpenAI 兼容 API 进行 AI 分析
 * 将抓取到的网页内容发送给 AI，让 AI 提取出有价值的技能
 */
async function analyzeWithAI(pageContents, tags, apiConfig) {
  const { apiKey, apiEndpoint, model } = apiConfig;
  if (!apiKey) return null;

  const { default: OpenAI } = require('openai');
  const openai = new OpenAI({
    apiKey,
    baseURL: apiEndpoint || undefined
  });

  // 构建网页内容文本（截取前 3000 字符/每页，避免 token 超限）
  const contentBlock = pageContents.map((p, i) =>
    `【来源 ${i + 1}】${p.name} (${p.url})\n内容摘要：${p.content.substring(0, 3000)}`
  ).join('\n\n---\n\n');

  const prompt = `你是一个资深技术猎头。请从以下网页内容中，提取出与用户关注领域相关的、有价值的"硬技能"。

用户关注领域：${tags.join('、')}

要求：
1. 只提取实操性强的技能（新兴工具、框架、库、方法论等），忽略纯新闻或广告
2. 每个技能需包含：
   - name: 技能名称（中文）
   - category: 分类（必须从以下选择: 开发, 设计, 产品, 数据）
   - description: 一句话描述（中文，20字以内）
   - level: 推荐熟练度（精通/熟练/熟悉/了解）
   - source_url: 来源链接（从下方网页内容中选取最相关的链接）
   - reason: AI 推荐理由（中文，30字以内，说明为什么值得学）
3. 返回 JSON 数组格式，不要包含任何其他文字

网页内容：
${contentBlock}`;

  const response = await openai.chat.completions.create({
    model: model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: '你是一个技术猎头，只返回 JSON 数组，不包含任何其他文字。' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' }
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return null;

  try {
    const parsed = JSON.parse(content);
    return parsed.skills || parsed.data || parsed.results || parsed;
  } catch {
    return null;
  }
}

/**
 * 处理技能搜索请求
 * 1. 抓取固定网站的页面内容
 * 2. 用 AI 分析提取技能
 * 3. 返回结构化数据
 */
ipcMain.handle('skill-finder:search', async (event, { tags, apiConfig }) => {
  try {
    if (!tags || !Array.isArray(tags) || tags.length === 0) {
      return { success: false, message: '请至少输入一个标签' };
    }

    // 1. 获取 WebFetcher 实例
    const Fetcher = await getWebFetcher();
    if (!Fetcher) {
      return { success: false, message: '页面抓取模块加载失败' };
    }
    const fetcher = new Fetcher();

    // 2. 遍历抓取每个固定网站的内容
    const pageContents = [];
    const errors = [];

    for (const source of SOURCE_URLS) {
      try {
        const content = await fetcher.fetchAndParse(source.url, 5000);
        if (content && content.trim().length > 50) {
          pageContents.push({
            url: source.url,
            name: source.name,
            content: content.trim()
          });
        }
      } catch (e) {
        errors.push(`${source.name}: ${e.message}`);
        console.error('抓取失败:', source.url, e.message);
      }
    }

    if (pageContents.length === 0) {
      const errorDetail = errors.length > 0
        ? '全部网站抓取失败：' + errors.join('；')
        : '未能从数据源获取到有效内容';
      return { success: false, message: errorDetail };
    }

    // 3. AI 分析
    let skills = [];
    if (apiConfig && apiConfig.apiKey) {
      try {
        const aiResult = await analyzeWithAI(pageContents, tags, apiConfig);
        if (Array.isArray(aiResult) && aiResult.length > 0) {
          skills = aiResult;
        }
      } catch (e) {
        console.error('AI 分析失败:', e.message);
      }
    }

    // 4. AI 不可用时，退回基础处理（按来源分割段落作为技能条目）
    if (skills.length === 0) {
      for (const page of pageContents) {
        const segments = page.content.split(/\n{2,}/).filter(s => s.trim().length > 20);
        const chunks = segments.slice(0, 3);
        chunks.forEach((chunk) => {
          const firstLine = chunk.replace(/[#*【】\n]/g, '').trim().substring(0, 40);
          skills.push({
            name: firstLine || page.name,
            category: '开发',
            description: chunk.replace(/[#*【】\n]/g, '').trim().substring(0, 50) + '…',
            level: '熟悉',
            source_url: page.url,
            reason: '来自 ' + page.name
          });
        });
      }
    }

    return {
      success: true,
      data: skills,
      sources: SOURCE_URLS.map(s => s.url),
      fetchErrors: errors.length > 0 ? errors : undefined
    };
  } catch (err) {
    console.error('技能搜索失败:', err);
    return { success: false, message: '搜索失败：' + err.message };
  }
});

/**
 * 根据标签猜测分类
 */
function guessCategory(tags) {
  const categoryMap = {
    '开发': ['前端', '后端', '开发', 'JavaScript', 'TypeScript', 'React', 'Vue', 'Node', 'Python', 'Java', 'Go', 'Rust', 'CSS', 'HTML', 'Electron', 'Tauri', '编程', '代码', '框架', '工程化'],
    '设计': ['设计', 'UI', 'UX', '界面', '视觉', '交互', 'Figma', 'Sketch', '原型', '配色', '排版', '动效', '插画', '品牌'],
    '产品': ['产品', 'PM', '需求', '用户', '市场', '运营', '增长', '策略', '规划', '商业', '项目', '管理'],
    '数据': ['数据', '分析', 'SQL', 'Python', 'AI', '机器学习', '深度学习', '大数据', '统计', '可视化', '算法']
  };

  for (const tag of tags) {
    for (const [cat, keywords] of Object.entries(categoryMap)) {
      if (keywords.some(k => tag.toLowerCase().includes(k.toLowerCase()))) {
        return cat;
      }
    }
  }
  return '开发';
}

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
    win.webContents.once('did-finish-load', () => {
      win.show();
      win.focus();
    });
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
              message: 'jiao公台',
              detail: '个人工作台桌面应用 v2.0.0'
            });
          }
        }
      ]
    }
  ];
  return Menu.buildFromTemplate(template);
}

app.whenReady().then(() => {
  ensureDataDir();
  Menu.setApplicationMenu(buildChineseMenu());
  createWindow();

  // macOS 上点击 Dock 图标且没有窗口时，重新创建窗口（其他平台不触发）
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 所有窗口都关闭时退出应用（Windows / Linux 惯例；macOS 例外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});