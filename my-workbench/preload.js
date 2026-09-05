// =====================================================================
// preload.js —— 预加载脚本（安全桥接层）
// 职责：
//   在隔离的上下文中，通过 contextBridge 向渲染进程暴露一组「白名单」API，
//   渲染进程只能通过这些 API 调用主进程，无法直接触碰 Node / Electron 能力。
// =====================================================================

const { contextBridge, ipcRenderer } = require('electron');

// 暴露到渲染进程 window.workbench 对象上的安全 API
contextBridge.exposeInMainWorld('workbench', {
  /**
   * 启动本地软件
   * @param {string} exePath 软件的可执行文件路径或命令名
   * @returns {Promise<{success: boolean, message: string}>} 启动结果
   */
  launchApp: (exePath) => ipcRenderer.invoke('launch-app', exePath),

  /**
   * 打开本地文件或文件夹（交给系统默认程序处理）
   * @param {string} targetPath 文件 / 文件夹路径
   * @returns {Promise<{success: boolean, message: string}>} 打开结果
   */
  openPath: (targetPath) => ipcRenderer.invoke('open-path', targetPath),

  /**
   * 打开外部网页链接（交给系统默认浏览器）
   * @param {string} url 目标网址
   * @returns {Promise<{success: boolean, message: string}>} 打开结果
   */
  openUrl: (url) => ipcRenderer.invoke('open-url', url),

  /**
   * 弹出系统文件选择对话框，让用户选择文件或文件夹
   * @param {'file'|'folder'} kind 选择类型：'folder' 选文件夹，其它选文件
   * @returns {Promise<{canceled: boolean, path?: string}>} 选择结果
   */
  selectPath: (kind) => ipcRenderer.invoke('select-path', kind),

  /**
   * 选择本地图片作为快捷方式图标（弹出对话框并转成 data URL）
   * @returns {Promise<{canceled: boolean, path?: string, success?: boolean, dataUrl?: string, message?: string}>}
   */
  selectImage: () => ipcRenderer.invoke('select-image'),

  /**
   * 读取文件关联图标（默认用于 .exe 软件图标）
   * @param {string} filePath 文件完整路径
   * @returns {Promise<string>} PNG 图标的 data URL，失败时为空字符串
   */
  getFileIcon: (filePath) => ipcRenderer.invoke('get-file-icon', filePath),

  /**
   * 获取网页快捷方式的默认图标（网站 Favicon）
   * @param {string} url 目标网址
   * @returns {Promise<string>} favicon 的 data URL，失败时为空字符串
   */
  getWebFavicon: (url) => ipcRenderer.invoke('get-web-favicon', url),

  // ======================== 设置 ========================

  /**
   * 读取开机自启动状态
   * @returns {Promise<boolean>} true 表示已开启
   */
  getAutoStart: () => ipcRenderer.invoke('settings:get-autostart'),

  /**
   * 设置开机自启动
   * @param {boolean} enabled true 开启 / false 关闭
   * @returns {Promise<boolean>} 设置后的实际状态
   */
  setAutoStart: (enabled) => ipcRenderer.invoke('settings:set-autostart', enabled),

  /**
   * 读取「关闭后继续后台运行」状态
   * @returns {Promise<boolean>} true 表示已开启
   */
  getBackgroundRun: () => ipcRenderer.invoke('settings:get-background'),

  /**
   * 设置「关闭后继续后台运行」
   * @param {boolean} enabled true 开启 / false 关闭
   * @returns {Promise<{success: boolean, value?: boolean, message?: string}>}
   */
  setBackgroundRun: (enabled) => ipcRenderer.invoke('settings:set-background', enabled),

  /**
   * 订阅主进程后台运行提示（如「已最小化到系统托盘」）
   * @param {(message: string) => void} callback 收到提示时回调
   */
  onBackgroundNotice: (callback) => ipcRenderer.on('bg-notice', (event, message) => callback(message)),

  /**
   * 读取某个数据文件的内容
   * @param {string} filename 数据文件名（如 'apps.json'）
   * @returns {Promise<*>} 文件解析后的数据
   */
  readData: (filename) => ipcRenderer.invoke('data:read', filename),

  /**
   * 写入某个数据文件
   * @param {string} filename 数据文件名
   * @param {*} data 要写入的数据
   * @returns {Promise<{success: boolean, message?: string}>} 写入结果
   */
  writeData: (filename, data) => ipcRenderer.invoke('data:write', filename, data),

  // ======================== AI 技能发现器 ========================

  /**
   * 搜索技能
   * @param {{tags: string[], apiConfig: {apiKey?: string, apiEndpoint?: string, model?: string}}} params
   * @returns {Promise<{success: boolean, data?: Array, message?: string}>}
   */
  searchSkills: (params) => ipcRenderer.invoke('skill-finder:search', params),

  // ======================== 一键签到 ========================

  /**
   * 显示/隐藏签到专用 BrowserWindow（用户手动登录一次，cookie 持久化）
   * @param {{ taskId: string, url: string }} params
   * @returns {Promise<{success: boolean, visible?: boolean, message?: string}>}
   */
  toggleSignWindow: (params) => ipcRenderer.invoke('sign:toggle-window', params),

  /**
   * 执行签到自动化脚本（executeJavaScript 注入）
   * @param {{ taskId: string, url?: string, buttonSelector?: string, successText?: string }} params
   * @returns {Promise<{success: boolean, clicked?: boolean, message?: string, raw?: any}>}
   */
  executeSign: (params) => ipcRenderer.invoke('sign:execute', params),

  /**
   * 获取签到窗口的 cookie 状态
   * @param {{ taskId: string }} params
   * @returns {Promise<{success: boolean, count?: number, domains?: string[], message?: string}>}
   */
  getSignCookies: (params) => ipcRenderer.invoke('sign:get-cookies', params),

  /** 保存签到任务列表 */
  saveSignTasks: (tasks) => ipcRenderer.invoke('sign:save-tasks', tasks),
  /** 加载签到任务列表 */
  loadSignTasks: () => ipcRenderer.invoke('sign:load-tasks'),

  // ======================== 网易云音乐 ========================

  /**
   * 代理请求网易云音乐 API（localhost:3000），由主进程发起，规避渲染进程跨域限制
   * @param {{ apiPath: string, query?: object, cookie?: string }} params
   * @returns {Promise<{success: boolean, status?: number, body?: string, setCookie?: string[], message?: string}>}
   */
  neteaseFetch: (params) => ipcRenderer.invoke('netease:fetch', params),

  /** 自动启动网易云 API 子进程（主进程 fork netease-api-host.js） */
  neteaseStartApi: () => ipcRenderer.invoke('netease:start-api'),
  /** 停止网易云 API 子进程 */
  neteaseStopApi: () => ipcRenderer.invoke('netease:stop-api'),

  // ======================== 桌面程序签到（PowerShell 自动化） ========================

  /**
   * 桌面程序一键签到：启动 exe → 等待加载 → 执行 PowerShell 自动化脚本
   * @param {{
   *   exePath: string,                // 可执行文件完整路径
   *   exeArgs?: string[],              // 启动参数
   *   launchDelay?: number,            // 启动后等待毫秒数（默认 3000）
   *   psScript?: string,              // 自动化 PowerShell 脚本
   *   verifyScript?: string           // 校验脚本（可选）
   * }} params
   * @returns {Promise<{success: boolean, message: string, results?: Array}>}
   */
  executeDesktopSign: (params) => ipcRenderer.invoke('sign:execute-desktop', params),

  /**
   * 获取内置 PowerShell 脚本模板
   * @returns {Promise<Array<{id: string, name: string, desc: string, script: string}>>}
   */
  getPsTemplates: () => ipcRenderer.invoke('sign:ps-templates'),

  // ======================== 坐标拾取器（桌面签到辅助） ========================

  /**
   * 启动全屏坐标拾取：用户在屏幕任意位置点击左键返回坐标，ESC/右键取消
   * @returns {Promise<{success: boolean, x?: number, y?: number, cancelled?: boolean}>}
   */
  pickCoordinate: () => ipcRenderer.invoke('sign:pick-coordinate'),
  /** 【拾取器页面内部用】左键确认 */
  _pickerConfirm: () => ipcRenderer.send('picker:confirm'),
  /** 【拾取器页面内部用】取消拾取 */
  _pickerCancel: () => ipcRenderer.send('picker:cancel')
});