// =====================================================================
// renderer.js —— 渲染进程主控制器
// 职责：
//   1. 定义全局 Store（共享数据 + 数据读写 + 变更通知）
//   2. 定义全局 UI 工具（Toast、模态框、右键菜单、DOM / SVG 图标辅助）
//   3. 定义日期工具 DateUtil
//   4. 处理侧边栏导航切换与主题切换
//   5. 应用启动时加载数据并初始化各功能模块
// 说明：
//   本文件最后加载（位于各 modules/*.js 之后），负责把它们串联起来；
//   各模块通过 window.Store / window.UI / window.DateUtil 访问共享能力。
// =====================================================================

// ---------------------------------------------------------------------
// 内置默认软件列表（已按要求清除，如需恢复取消下方注释即可）
// 这些是 Windows 系统自带程序，path 直接用命令名即可
// ---------------------------------------------------------------------
const DEFAULT_APPS = [
  // { id: 'builtin-notepad', type: 'app', name: '记事本', icon: '', path: 'notepad.exe', isBuiltin: true },
  // { id: 'builtin-calc',    type: 'app', name: '计算器', icon: '', path: 'calc.exe',    isBuiltin: true },
  // { id: 'builtin-mspaint', type: 'app', name: '画图',   icon: '', path: 'mspaint.exe', isBuiltin: true },
  // { id: 'builtin-cmd',     type: 'app', name: '命令提示符', icon: '', path: 'cmd.exe', isBuiltin: true }
];

// ---------------------------------------------------------------------
// 日期工具：统一使用本地时区的 YYYY-MM-DD 字符串，方便比较与排序
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Store —— 共享数据仓库
// 职责：持有全部用户数据，负责与主进程交互完成加载与保存，
//       并在数据变更后通知所有注册的模块刷新界面。
// ---------------------------------------------------------------------
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
    this.apps = (await window.workbench.readData('apps.json')) || [];
    this.events = (await window.workbench.readData('events.json')) || [];
    this.settings = (await window.workbench.readData('settings.json')) || { theme: 'system' };
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

// ---------------------------------------------------------------------
// UI —— 界面工具（Toast、模态框、右键菜单、DOM / SVG 图标辅助）
// ---------------------------------------------------------------------
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
      modalEl.classList.remove('settings-modal');
      if (modalClass) modalEl.classList.add(modalClass);
    }
    document.getElementById('modal-overlay').hidden = false;
  },

  /** 关闭模态框 */
  closeModal() {
    const modalEl = document.querySelector('.modal');
    if (modalEl) modalEl.classList.remove('settings-modal');
    document.getElementById('modal-overlay').hidden = true;
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

// ---------------------------------------------------------------------
// 主题切换
// ---------------------------------------------------------------------

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
  document.body.dataset.theme = resolveTheme(mode);
  Store.settings.theme = mode;
  Store.saveSettings();
}

// 系统明暗变化时，若当前为"跟随系统"则自动切换
_sysDarkMq.addEventListener('change', () => {
  if ((Store.settings.theme || 'system') === 'system') {
    document.body.dataset.theme = resolveTheme('system');
  }
});

// ---------------------------------------------------------------------
// 侧边栏导航切换
// ---------------------------------------------------------------------

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
  // 内嵌 webview（抖音/千问）懒加载：首次切到该页才真正加载对应网站，
  // 避免应用启动时就请求外部站点；同时注入协议拦截 preload。
  if (pageName === 'douyin' || pageName === 'qwen') {
    const wv = document.getElementById('webview-' + pageName);
    if (wv && !wv.getAttribute('src')) {
      wv.setAttribute('preload', webviewPreloadUrl());
      wv.setAttribute('src', wv.dataset.src || '');
    }
  }
}

/**
 * 计算 webview 需要的协议拦截 preload 绝对路径（file:// 指向 block-external-protocol-preload.js）
 * 开发/打包后 index.html 均位于应用根目录，从当前页面 URL 目录推导
 */
function webviewPreloadUrl() {
  const url = new URL(window.location.href);
  const dir = url.pathname.substring(0, url.pathname.lastIndexOf('/'));
  return 'file://' + encodeURI(dir) + '/block-external-protocol-preload.js';
}

// ---------------------------------------------------------------------
// 科技感背景：微光粒子 + 动态数据流（canvas）
// 说明：在 #fx-canvas 上绘制向上漂浮、水平漂移的蓝色粒子，模拟
//       「动态数据流 / 全息投影」氛围；粒子颜色在界面蓝 #5F86FF 与
//       科技浅蓝 #A9C2FF 之间过渡，并带呼吸闪烁效果。
// ---------------------------------------------------------------------
function initParticles() {
  const canvas = document.getElementById('fx-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // 尊重系统「减少动态效果」偏好：只绘制一帧静态粒子，不循环
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let particles = [];
  let rafId = null;

  // 粒子用色（RGB）：界面蓝 / 科技浅蓝 / 高光白点
  const COLORS = [
    [95, 134, 255],
    [169, 194, 255],
    [255, 255, 255]
  ];

  /** 根据窗口尺寸重设 canvas 并重新生成粒子 */
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    spawn();
  }

  /** 生成一批粒子（数量随屏幕面积自适应） */
  function spawn() {
    const count = Math.min(90, Math.round((width * height) / 18000));
    particles = [];
    for (let i = 0; i < count; i++) {
      particles.push(makeParticle(true));
    }
  }

  /**
   * 创建一个粒子
   * @param {boolean} anywhere true 表示随机分布全屏，false 表示从底部进入
   */
  function makeParticle(anywhere) {
    const c = COLORS[(Math.random() * COLORS.length) | 0];
    return {
      x: Math.random() * width,
      y: anywhere ? Math.random() * height : height + 10,
      r: 0.6 + Math.random() * 2.2,
      color: c,
      alpha: 0.15 + Math.random() * 0.6,
      // 数据流方向：整体向上，带轻微水平漂移
      vy: -(0.15 + Math.random() * 0.5),
      vx: (Math.random() - 0.5) * 0.25,
      twinkle: Math.random() * Math.PI * 2,
      twinkleSpeed: 0.02 + Math.random() * 0.05
    };
  }

  /** 逐帧绘制粒子 */
  function step() {
    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.twinkle += p.twinkleSpeed;

      // 移出顶部后从底部重新进入，形成持续上升的数据流
      if (p.y < -10) {
        particles[i] = makeParticle(false);
        continue;
      }
      // 水平越界兜底
      if (p.x < -10) p.x = width + 10;
      if (p.x > width + 10) p.x = -10;

      // 呼吸闪烁：透明度围绕基准值正弦起伏
      const tw = 0.6 + 0.4 * Math.sin(p.twinkle);
      const a = p.alpha * tw;
      const r = p.color[0];
      const g = p.color[1];
      const b = p.color[2];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
      ctx.fill();
    }
    rafId = requestAnimationFrame(step);
  }

  resize();
  window.addEventListener('resize', resize);

  if (!reduceMotion) {
    rafId = requestAnimationFrame(step);
  }
}

// ---------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------

/**
 * 初始化应用：
 *   1. 加载数据
 *   2. 填充 SVG 图标
 *   3. 应用主题
 *   4. 绑定全局事件（导航、主题、模态框、右键菜单）
 *   5. 初始化各功能模块
 *   6. 默认进入首页
 */
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

  // 4. 注册可切换的页面模块
  PAGE_MODULES.dashboard = window.Dashboard;
  PAGE_MODULES.home = window.Home;
  PAGE_MODULES.calendar = window.Calendar;
  PAGE_MODULES.sign = window.Sign;
  PAGE_MODULES.netease = window.Netease;

  // 5. 绑定导航点击（抖音/千问为内嵌 webview 虚拟页面，走 switchPage 切换）
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchPage(btn.dataset.page);
    });
  });

  // 5.1 侧边栏收起/展开切换（品牌右侧 svg 按钮，收起后主内容区自动扩大）
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const sidebarEl = document.querySelector('.sidebar');
  if (sidebarToggle && sidebarEl) {
    sidebarToggle.addEventListener('click', () => {
      sidebarEl.classList.toggle('collapsed');
      sidebarToggle.title = sidebarEl.classList.contains('collapsed') ? '展开侧边栏' : '收起侧边栏';
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

  // 11. 启动科技感背景粒子动画
  initParticles();
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