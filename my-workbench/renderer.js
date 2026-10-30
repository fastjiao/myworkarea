const DEFAULT_APPS = [
  // { id: 'builtin-notepad', type: 'app', name: '记事本', icon: '', path: 'notepad.exe', isBuiltin: true },
  // { id: 'builtin-calc',    type: 'app', name: '计算器', icon: '', path: 'calc.exe',    isBuiltin: true },
  // { id: 'builtin-mspaint', type: 'app', name: '画图',   icon: '', path: 'mspaint.exe', isBuiltin: true },
  // { id: 'builtin-cmd',     type: 'app', name: '命令提示符', icon: '', path: 'cmd.exe', isBuiltin: true }
];

// 日期工具：统一使用本地时区的 YYYY-MM-DD 字符串，方便比较与排序
const DateUtil = {
  /**
   * 把 Date 对象格式化为 YYYY-MM-DD（补齐两位）
   * @param {Date} d 日期对象
   * @returns {string} 形如 2026-08-29
   */
  format: (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  /** 获取今天的日期字符串 */
  today: () => DateUtil.format(new Date()),

  /** 判断某日期字符串是否等于今天 */
  isToday: (str) => !!str && str === DateUtil.today(),

  /** 判断某日期字符串是否已过期（早于今天） */
  isOverdue: (str) => !!str && str < DateUtil.today()
};

// Store —— 共享数据仓库
// 职责：持有全部用户数据，负责与主进程交互完成加载与保存，
//       并在数据变更后通知所有注册的模块刷新界面。
const Store = {
  // 用户自定义快捷方式（type 可为 'app' | 'file' | 'folder'）
  apps: [],
  // 日历事件 / 待办（统一为事件模型，含 done 字段表示完成态）
  events: [],
  // 应用设置（主题偏好等）
  settings: { theme: 'system' },

  // 变更监听器列表，各模块注册 render 函数到这里
  _listeners: [],

  /** 注册一个数据变更监听器（传入模块的 render 函数） */
  onChange(fn) {
    this._listeners.push(fn);
  },

  /** 通知所有监听器：数据已变更，请刷新界面 */
  notify() {
    this._listeners.forEach((fn) => fn());
  },

  /** 启动时一次性加载所有数据 */
  async load() {
    const [apps, events, settings] = await Promise.all([
      window.workbench.readData('apps.json'),
      window.workbench.readData('events.json'),
      window.workbench.readData('settings.json')
    ]);
    this.apps = apps || [];
    this.events = events || [];
    this.settings = settings || { theme: 'system' };
  },

  /** 保存快捷方式数据 */
  async saveApps() {
    return window.workbench.writeData('apps.json', this.apps);
  },

  /** 保存事件 / 待办数据 */
  async saveEvents() {
    return window.workbench.writeData('events.json', this.events);
  },

  /** 保存设置数据 */
  async saveSettings() {
    return window.workbench.writeData('settings.json', this.settings);
  },

  // -------- 快捷方式的便捷获取方法 --------

  /** 返回全部快捷方式（内置软件 + 用户自定义） */
  allShortcuts() {
    return [...DEFAULT_APPS, ...this.apps];
  },

  /** 返回「软件」类卡片（内置软件 + 用户自定义的 app） */
  appShortcuts() {
    return [...DEFAULT_APPS, ...this.apps.filter((a) => a.type === 'app')];
  },

  /** 返回「文件 / 文件夹」类卡片 */
  fileShortcuts() {
    return this.apps.filter((a) => a.type === 'file' || a.type === 'folder');
  },

  /** 返回「网页快捷方式」类卡片 */
  webShortcuts() {
    return this.apps.filter((a) => a.type === 'web');
  },

  // -------- 事件的便捷获取方法 --------

  /** 返回某日期的事件列表（按时间升序） */
  eventsOf(dateStr) {
    return this.events
      .filter((e) => e.date === dateStr)
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  },

  /** 返回今天的事件列表 */
  todayEvents() {
    return this.eventsOf(DateUtil.today());
  }
};

// UI —— 界面工具（Toast、模态框、右键菜单、DOM / SVG 图标辅助）
const UI = {
  // Toast 自动关闭计时器
  _toastTimer: null,

  /**
   * 快速创建 DOM 元素
   * @param {string} tag 标签名
   * @param {string} [className] class 名称（可选，用空格分隔多个）
   * @param {string} [text] 文本内容（用 textContent 赋值，防 XSS）
   * @returns {HTMLElement}
   */
  el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  },

  /**
   * 创建 SVG 图标元素
   * @param {string} name 图标名（来自 modules/icons.js 的 ICONS）
   * @param {number} [size] 图标尺寸
   * @param {string} [cls] 额外 class
   * @returns {HTMLElement} 含内联 SVG 的 span
   */
  icon(name, size = 18, cls) {
    const span = document.createElement('span');
    span.className = 'icon' + (cls ? ' ' + cls : '');
    span.innerHTML = window.svgIcon(name, size);
    return span;
  },

  /**
   * 显示自动消失的轻提示 Toast（居中偏上）
   * @param {string} text 提示文字
   * @param {'info'|'success'|'error'} type 状态类型（影响背景色）
   * @param {number} [duration] 显示时长（毫秒），默认 2500
   */
  setToast(text, type = 'info', duration = 2500) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.dataset.type = type;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), duration);
  },

  /**
   * 设置按钮 Loading 加载中态：前置转圈 + 文字切换 + 锁交互防重复提交
   * @param {HTMLButtonElement} btn 按钮元素
   * @param {boolean} loading 是否进入加载态
   * @param {string} [loadingText] 加载态文字（默认"处理中…"）
   */
  setBtnLoading(btn, loading, loadingText = '处理中…') {
    if (!btn) return;
    if (loading) {
      if (!btn.dataset.btnLoading) {
        btn.dataset.btnLoading = '1';
        btn.dataset.btnOriginHtml = btn.innerHTML;
      }
      btn.textContent = loadingText;
      btn.classList.add('is-loading');
      btn.disabled = true;
    } else {
      if (btn.dataset.btnLoading) {
        btn.innerHTML = btn.dataset.btnOriginHtml;
        delete btn.dataset.btnLoading;
        delete btn.dataset.btnOriginHtml;
      }
      btn.classList.remove('is-loading');
      btn.disabled = false;
    }
  },

  /**
   * 设置按钮 Disabled 禁用态：降饱和 + 透明度 45%
   * @param {HTMLButtonElement} btn 按钮元素
   * @param {boolean} disabled 是否禁用
   */
  setBtnDisabled(btn, disabled) {
    if (!btn) return;
    btn.disabled = disabled;
    if (disabled) btn.classList.add('is-disabled');
    else btn.classList.remove('is-disabled');
  },

  // ---------- 模态框 ----------

  /**
   * 打开通用模态框
   * @param {string} title 标题文字
   * @param {HTMLElement} content 要放入模态框内容区的元素（通常是表单）
   * @param {string} [modalClass] 附加到 .modal 上的额外类（如 'settings-modal' 加宽）
   */
  openModal(title, content, modalClass) {
    document.getElementById('modal-title').textContent = title;
    const body = document.getElementById('modal-body');
    body.innerHTML = '';
    body.appendChild(content);
    const modalEl = document.querySelector('.modal');
    if (modalEl) {
      // 清理所有已知的自定义模态框类，再按需添加新类
      modalEl.classList.remove('settings-modal', 'scan-modal');
      if (modalClass) modalEl.classList.add(modalClass);
    }
    document.getElementById('modal-overlay').classList.add('show');
  },

  /** 关闭模态框 */
  closeModal() {
    const modalEl = document.querySelector('.modal');
    if (modalEl) modalEl.classList.remove('settings-modal', 'scan-modal');
    document.getElementById('modal-overlay').classList.remove('show');
  },

  // ---------- 右键菜单（用于快捷方式：打开 / 删除） ----------

  // 右键菜单目标操作引用
  _contextMenuTarget: null,

  /**
   * 显示快捷方式右键菜单
   * @param {number} x 鼠标横坐标
   * @param {number} y 鼠标纵坐标
   * @param {{removable: boolean, onOpen: Function, onRemove: Function}} ops 操作配置
   */
  showShortcutMenu(x, y, ops) {
    this._contextMenuTarget = ops;
    document.getElementById('menu-edit').style.display = ops.editable ? 'block' : 'none';
    document.getElementById('menu-remove').style.display = ops.removable ? 'block' : 'none';
    document.getElementById('menu-property').style.display = 'block'; // 属性始终可用

    const menu = document.getElementById('context-menu');
    menu.hidden = false;

    // 菜单项数量：打开 + 属性(固定) + 修改(可选) + 删除(可选)，据此估算菜单高度
    const itemCount = 2 + (ops.editable ? 1 : 0) + (ops.removable ? 1 : 0);
    const menuWidth = 120;
    const menuHeight = itemCount * 40 + 2;
    menu.style.left = Math.min(x, window.innerWidth - menuWidth) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - menuHeight) + 'px';
  },

  /** 隐藏右键菜单 */
  hideContextMenu() {
    document.getElementById('context-menu').hidden = true;
    this._contextMenuTarget = null;
  }
};

// 主题切换

// 系统主题检测：matchMedia 反映 OS 明暗偏好
const _sysDarkMq = window.matchMedia('(prefers-color-scheme: dark)');

/**
 * 把主题模式解析为实际应用的明/暗
 * @param {'system'|'light'|'dark'} mode
 * @returns {'light'|'dark'}
 */
function resolveTheme(mode) {
  if (mode === 'system') return _sysDarkMq.matches ? 'dark' : 'light';
  return mode === 'dark' ? 'dark' : 'light';
}

/**
 * 应用主题到 <body data-theme="...">，并持久化到 settings.json
 * @param {'system'|'light'|'dark'} theme 主题模式
 */
function applyTheme(theme) {
  const mode = theme || 'system';
  const resolved = resolveTheme(mode);
  document.body.dataset.theme = resolved;
  Store.settings.theme = mode;
  Store.saveSettings();
  // 同步系统标题栏按钮（最小/最大/关闭）配色，避免暗色主题下按钮区突兀
  if (window.workbench && window.workbench.setTitlebarTheme) {
    window.workbench.setTitlebarTheme(resolved);
  }
}

// 系统明暗变化时，若当前为"跟随系统"则自动切换
_sysDarkMq.addEventListener('change', () => {
  if ((Store.settings.theme || 'system') === 'system') {
    const resolved = resolveTheme('system');
    document.body.dataset.theme = resolved;
    if (window.workbench && window.workbench.setTitlebarTheme) {
      window.workbench.setTitlebarTheme(resolved);
    }
  }
});

// 侧边栏导航切换

// 页面名 → 对应模块对象
const PAGE_MODULES = {};

/**
 * 切换到指定页面：更新导航高亮、显示对应 section、刷新该模块内容
 * @param {string} pageName 页面名（home / calendar / sign / netease）
 */
function switchPage(pageName) {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.page === pageName);
  });
  document.querySelectorAll('.page').forEach((page) => {
    page.classList.toggle('active', page.id === 'page-' + pageName);
  });
  // 时钟只在首页（dashboard）显示，其他页面隐藏
  const clock = document.getElementById('clock-widget');
  if (clock) clock.style.display = (pageName === 'dashboard') ? '' : 'none';
  // 网易云播放底栏只在「音乐」(netease) 页面显示，其他页面隐藏
  const neteaseBar = document.getElementById('netease-player-bar');
  if (neteaseBar) neteaseBar.style.display = (pageName === 'netease') ? '' : 'none';
  // 网易云顶栏组件只在「音乐」页面显示（嵌入标题栏内部，不增加高度）
  const neteaseTitlebarContent = document.getElementById('netease-titlebar-content');
  if (neteaseTitlebarContent) neteaseTitlebarContent.hidden = (pageName !== 'netease');
  document.body.classList.toggle('netease-bar-active', pageName === 'netease' && neteaseBar && neteaseBar.classList.contains('show'));
  // 歌词面板只在「音乐」页面显示，切换其他页面时自动关闭
  if (pageName !== 'netease' && window.Netease && window.Netease._lyricVisible) {
    window.Netease._lyricVisible = false;
    const lyricPanel = document.getElementById('netease-lyric-panel');
    if (lyricPanel) lyricPanel.classList.remove('show');
  }
  const mod = PAGE_MODULES[pageName];
  if (mod && typeof mod.render === 'function') {
    mod.render();
  }
}


// 初始化

/**
 * 初始化应用：
 *   1. 加载数据
 *   2. 填充 SVG 图标
 *   3. 应用主题
 *   4. 绑定全局事件（导航、主题、模态框、右键菜单）
 *   5. 初始化各功能模块
 *   6. 默认进入首页
 */
// 标题栏窗口控制：系统原生按钮 + 最大化状态同步
// titleBarStyle:'hidden' + titleBarOverlay 后，最小/最大/关闭按钮由系统绘制，
// 拖拽/Aero Snap/双击最大化/Win+方向键全部由系统接管，渲染进程无需手动实现。
// 此处仅同步最大化状态以切换 body.maximized（调整 padding/圆角）。
function initWindowControls() {
  // 同步初始最大化状态（启动时可能已是最大化）
  window.workbench.windowIsMaximized().then((isMax) => {
    document.body.classList.toggle('maximized', !!isMax);
  });

  // 监听主进程最大化/还原事件，切换 body.maximized 以调整 padding/圆角
  window.workbench.onWindowMaximizeState((isMax) => {
    document.body.classList.toggle('maximized', !!isMax);
  });
}

async function init() {
  // 1. 加载数据
  try {
    await Store.load();
  } catch (err) {
    UI.setToast('读取数据失败：' + err.message, 'error');
  }

  // 2. 填充导航与按钮的 SVG 图标
  document.querySelectorAll('.nav-icon').forEach((el) => {
    el.innerHTML = window.svgIcon(el.dataset.icon, 18);
  });
  // 填充侧边栏收起/展开按钮的两个 svg 图标（t.md：收起向左 / 展开向右）
  document.querySelectorAll('.sidebar-toggle-icon').forEach((el) => {
    el.innerHTML = window.svgIcon(el.dataset.icon, 16);
  });
  document.getElementById('modal-close').innerHTML = window.svgIcon('close', 18);

  // 3. 应用主题
  applyTheme(Store.settings.theme || 'system');

  // 3.5 自定义标题栏窗口控制：绑定三按钮 + 同步最大化状态
  initWindowControls();

  // 4. 注册可切换的页面模块
  PAGE_MODULES.dashboard = window.Dashboard;
  PAGE_MODULES.home = window.Home;
  PAGE_MODULES.calendar = window.Calendar;
  PAGE_MODULES.sign = window.Sign;
  PAGE_MODULES.netease = window.Netease;

  // 5. 绑定导航点击
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchPage(btn.dataset.page);
    });
  });

  // 5.1 侧边栏收起/展开切换（品牌右侧 svg 按钮，收起后主内容区自动扩大）
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const sidebarEl = document.querySelector('.sidebar');
  if (sidebarToggle && sidebarEl) {
    const titlebarEl = document.querySelector('.titlebar');
    sidebarToggle.addEventListener('click', () => {
      sidebarEl.classList.toggle('collapsed');
      const collapsed = sidebarEl.classList.contains('collapsed');
      sidebarToggle.title = collapsed ? '展开侧边栏' : '收起侧边栏';
      // 同步标题栏 left：收起时跟随侧边栏变窄（64px），展开时回 210px
      if (titlebarEl) titlebarEl.style.left = collapsed ? '64px' : '210px';
      const neteaseBarEl = document.getElementById('netease-player-bar');
      if (neteaseBarEl) neteaseBarEl.style.left = collapsed ? '64px' : '210px';
    });
  }

  // 6. 主题切换已移入设置弹窗（通用→明暗模式），此处无需绑定

  // 7. 绑定模态框关闭（右上角 ×、点击遮罩、Esc 键）
  document.getElementById('modal-close').addEventListener('click', UI.closeModal);
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') UI.closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      UI.closeModal();
      UI.hideContextMenu();
    }
  });

  // 8. 绑定右键菜单项
  document.getElementById('menu-open').addEventListener('click', () => {
    const ops = UI._contextMenuTarget;
    UI.hideContextMenu();
    if (ops && ops.onOpen) ops.onOpen();
  });
  document.getElementById('menu-edit').addEventListener('click', () => {
    const ops = UI._contextMenuTarget;
    UI.hideContextMenu();
    if (ops && ops.onEdit) ops.onEdit();
  });
  document.getElementById('menu-property').addEventListener('click', () => {
    const ops = UI._contextMenuTarget;
    UI.hideContextMenu();
    if (ops && ops.onProperty) ops.onProperty();
  });
  document.getElementById('menu-remove').addEventListener('click', () => {
    const ops = UI._contextMenuTarget;
    UI.hideContextMenu();
    if (ops && ops.onRemove) ops.onRemove();
  });
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('context-menu');
    if (!menu.hidden && !menu.contains(e.target)) {
      UI.hideContextMenu();
    }
  });

  // 9. 初始化各功能模块
  [window.Dashboard, window.Home, window.Calendar, window.Sign, window.Netease].forEach((mod) => {
    if (mod && typeof mod.init === 'function') mod.init();
  });

  // 9.1 初始化右上角时钟组件（全局悬浮，不属于页面级模块）
  if (window.ClockWidget && typeof window.ClockWidget.init === 'function') {
    window.ClockWidget.init();
  }

  // 9.2 初始化设置弹窗（侧边栏齿轮入口 + 开机自启动开关）
  if (window.SettingsWidget && typeof window.SettingsWidget.init === 'function') {
    window.SettingsWidget.init();
  }

  // 10. 默认进入首页（仪表盘）
  switchPage('dashboard');
}

// 把共享对象挂到全局，供模块和页面脚本访问
window.Store = Store;
window.UI = UI;
window.DateUtil = DateUtil;
window.DEFAULT_APPS = DEFAULT_APPS;

window.switchPage = switchPage;

// 等待 DOM 就绪后启动
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}