// =====================================================================
// modules/home.js —— 首页模块
// 职责：
//   1. 渲染首页：软件快捷启动区、文件/文件夹区（自动换行排列，无滚动条）
//   2. 提供「添加软件」「添加文件/文件夹」入口与表单
//   3. 点击卡片触发启动软件或打开文件/文件夹
//   4. 支持快捷方式拖拽排序（按住拖动，落点出现白色指示条）
//   5. 支持右键「修改 / 删除」自定义快捷方式（内置软件不可修改/删除）
// 说明：本模块通过 window.Store / window.UI / window.DateUtil 访问共享能力。
// =====================================================================

// 字母图标色板（读取不到 .exe 图标时，按名称哈希取色生成首字母图标）
const LETTER_COLORS = ['#5F86FF', '#0ea5e9', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#ec4899', '#14b8a6'];

window.Home = {
  // -------------------------------------------------------------------
  init() {
    Store.onChange(() => this.render());
    this.render();
    // 启动时后台自动扫描系统已安装软件，新发现的自动添加到快捷启动
    this._autoScanSystemApps();
  },

  /**
   * 自动扫描系统已安装软件并添加到快捷启动
   * 后台静默执行：扫描 → 与现有列表去重 → 新发现的自动添加 → Toast 提示
   * 失败时静默忽略，不影响应用正常使用
   */
  async _autoScanSystemApps() {
    // 仅首次启动时自动扫描系统软件，此后不再自动识别（标志持久化于 settings.json）
    if (Store.settings && Store.settings.autoScanDone) return;
    try {
      const res = await window.workbench.scanInstalledApps();
      if (!res || !res.success || !res.apps || res.apps.length === 0) return;
      // 与现有快捷启动列表对比，按 exe 路径去重
      const existingPaths = new Set(Store.appShortcuts().map((a) => (a.path || '').toLowerCase()));
      const newApps = res.apps.filter((a) => !existingPaths.has(a.path.toLowerCase()));
      if (newApps.length === 0) return;
      // 批量添加新发现的软件
      const ts = Date.now();
      const newItems = newApps.map((a, i) => ({
        id: 'shortcut-' + ts + '-' + i,
        type: 'app',
        name: a.name,
        iconType: 'auto',
        icon: '',
        path: a.path
      }));
      Store.apps.push(...newItems);
      const saved = await Store.saveApps();
      if (saved && saved.success === false) {
        // 保存失败：回滚
        newItems.forEach((item) => {
          const idx = Store.apps.indexOf(item);
          if (idx >= 0) Store.apps.splice(idx, 1);
        });
        return;
      }
      Store.notify();
      UI.setToast('已自动添加 ' + newItems.length + ' 个系统软件', 'success', 4000);
    } catch (e) {
      // 静默失败，不影响正常使用
    } finally {
      // 无论扫描结果如何，均标记已完成首次自动识别，此后不再自动扫描
      Store.settings = Store.settings || {};
      Store.settings.autoScanDone = true;
      Store.saveSettings();
    }
  },

  // -------------------------------------------------------------------
  render() {
    const page = document.getElementById('page-home');
    page.innerHTML = '';
    page.appendChild(this._buildAppSection());
    page.appendChild(this._buildFileSection());
    page.appendChild(this._buildWebSection());
  },

  // -------------------------------------------------------------------
  // 软件快捷启动区（紧凑 + 横向滚动）
  // -------------------------------------------------------------------
  _buildAppSection() {
    const section = UI.el('div', 'section');

    const title = UI.el('div', 'section-title');
    title.appendChild(UI.el('span', '', '软件快捷启动'));
    const addBtn = UI.el('button', 'btn btn-primary btn-sm');
    addBtn.appendChild(UI.icon('plus', 14));
    addBtn.appendChild(UI.el('span', '', '添加软件'));
    addBtn.addEventListener('click', () => this._openAddModal('app'));
    title.appendChild(addBtn);

    // 扫描系统已安装软件（读取开始菜单 + 注册表，勾选后批量添加）
    const scanBtn = UI.el('button', 'btn btn-ghost btn-sm');
    scanBtn.appendChild(UI.icon('search', 14));
    scanBtn.appendChild(UI.el('span', '', '扫描系统软件'));
    scanBtn.addEventListener('click', () => this._openScanModal());
    title.appendChild(scanBtn);

    // 管理软件（弹窗批量删除不想要的快捷方式）
    const manageBtn = UI.el('button', 'btn btn-ghost btn-sm');
    manageBtn.appendChild(UI.icon('trash', 14));
    manageBtn.appendChild(UI.el('span', '', '管理软件'));
    manageBtn.addEventListener('click', () => this._openManageModal());
    title.appendChild(manageBtn);

    const strip = UI.el('div', 'shortcut-strip');
    const apps = Store.appShortcuts();
    if (apps.length === 0) {
      strip.appendChild(UI.el('div', 'empty-tip', '暂无软件，点击「添加软件」试试'));
    } else {
      apps.forEach((app) => strip.appendChild(this._buildShortcutCard(app)));
    }

    section.appendChild(title);
    section.appendChild(strip);
    this._enableDrag(strip, 'app');
    return section;
  },

  // -------------------------------------------------------------------
  // 文件 / 文件夹区（紧凑 + 横向滚动）
  // -------------------------------------------------------------------
  _buildFileSection() {
    const section = UI.el('div', 'section');

    const title = UI.el('div', 'section-title');
    title.appendChild(UI.el('span', '', '文件与文件夹'));
    const addBtn = UI.el('button', 'btn btn-primary btn-sm');
    addBtn.appendChild(UI.icon('plus', 14));
    addBtn.appendChild(UI.el('span', '', '添加文件/文件夹'));
    addBtn.addEventListener('click', () => this._openAddModal('file'));
    title.appendChild(addBtn);

    const strip = UI.el('div', 'shortcut-strip');
    const files = Store.fileShortcuts();
    if (files.length === 0) {
      strip.appendChild(UI.el('div', 'empty-tip', '暂无文件快捷方式，点击「添加文件/文件夹」试试'));
    } else {
      files.forEach((item) => strip.appendChild(this._buildShortcutCard(item)));
    }

    section.appendChild(title);
    section.appendChild(strip);
    this._enableDrag(strip, 'file');
    return section;
  },

  // -------------------------------------------------------------------
  // 网页快捷方式区（存放 / 添加网页链接）
  // -------------------------------------------------------------------
  _buildWebSection() {
    const section = UI.el('div', 'section');

    const title = UI.el('div', 'section-title');
    title.appendChild(UI.el('span', '', '网页快捷方式'));
    // 搜索框 + 搜索按钮（输入回车或点击按钮跳转浏览器搜索）
    const searchBox = UI.el('div', 'web-search-box');
    const searchInput = UI.el('input', 'web-search-input');
    searchInput.type = 'text';
    searchInput.placeholder = '搜索…';
    const doSearch = () => {
      const q = searchInput.value.trim();
      if (!q) return;
      window.workbench.openUrl('https://www.baidu.com/s?wd=' + encodeURIComponent(q));
    };
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    const searchBtn = UI.el('button', 'web-search-btn');
    searchBtn.innerHTML = window.svgIcon('search-bold', 18);
    searchBtn.title = '搜索';
    searchBtn.addEventListener('click', doSearch);
    searchBox.appendChild(searchInput);
    searchBox.appendChild(searchBtn);
    title.appendChild(searchBox);
    const addBtn = UI.el('button', 'btn btn-primary btn-sm');
    addBtn.appendChild(UI.icon('plus', 14));
    addBtn.appendChild(UI.el('span', '', '添加网页'));
    addBtn.addEventListener('click', () => this._openAddModal('web'));
    title.appendChild(addBtn);

    const strip = UI.el('div', 'shortcut-strip');
    const webs = Store.webShortcuts();
    if (webs.length === 0) {
      strip.appendChild(UI.el('div', 'empty-tip', '暂无网页快捷方式，点击「添加网页」试试'));
    } else {
      webs.forEach((item) => strip.appendChild(this._buildShortcutCard(item)));
    }

    section.appendChild(title);
    section.appendChild(strip);
    this._enableDrag(strip, 'web');
    return section;
  },

  // -------------------------------------------------------------------
  // 单个快捷方式卡片
  // -------------------------------------------------------------------
  _buildShortcutCard(item) {
    const card = UI.el('div', 'shortcut-card');
    // 记录 id，供拖拽排序定位使用
    card.dataset.id = item.id;
    // 自定义项可按住拖动排序，内置项禁用拖拽
    card.draggable = !item.isBuiltin;
    card.addEventListener('dragstart', (e) => this._onDragStart(e, item));
    card.addEventListener('dragend', () => this._clearDrag());

    // 文件类型标签（文件夹 / 网页用图标即可区分，不显示文字标签）
    if (item.type === 'file') {
      card.appendChild(UI.el('span', 'shortcut-tag ' + item.type, '文件'));
    }

    // 删除角标（仅自定义项显示）
    if (!item.isBuiltin) {
      const badge = UI.el('span', 'card-badge', '');
      badge.innerHTML = window.svgIcon('close', 10);
      badge.title = '删除此快捷方式';
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        this._removeShortcut(item);
      });
      card.appendChild(badge);
    }

    // 图标：有用户自定义 emoji 则用文本，否则用默认 SVG 图标
    card.appendChild(this._buildIcon(item));
    card.appendChild(UI.el('div', 'shortcut-name', item.name));

    card.addEventListener('click', () => this._activate(item));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      UI.showShortcutMenu(e.clientX, e.clientY, {
        editable: !item.isBuiltin,
        removable: !item.isBuiltin,
        onOpen: () => this._activate(item),
        onEdit: () => this._openEditModal(item),
        onProperty: () => this._openPropertyModal(item),
        onRemove: () => this._removeShortcut(item)
      });
    });

    return card;
  },

  /**
   * 返回条目当前图标来源（兼容旧数据：无 iconType 但有 icon 视为 emoji）
   * @param {object} item 快捷方式数据
   * @returns {'auto'|'emoji'|'letter'|'image'}
   */
  _iconTypeOf(item) {
    if (item.iconType) return item.iconType;
    return item.icon ? 'emoji' : 'auto';
  },

  /**
   * 构建卡片图标（按图标来源渲染）
   * 来源：图片 > emoji > 首字母 > 自动（app 读 exe，其它用默认 SVG）
   */
  _buildIcon(item) {
    const el = UI.el('div', 'shortcut-icon');
    const t = this._iconTypeOf(item);

    if (t === 'image' && item.icon) {
      // 自定义图片图标
      const img = document.createElement('img');
      img.className = 'shortcut-icon-img';
      img.src = item.icon;
      img.alt = item.name;
      img.draggable = false;
      el.appendChild(img);
    } else if (t === 'emoji' && item.icon) {
      el.textContent = item.icon;                 // 用户的 emoji 图标
    } else if (t === 'letter') {
      el.appendChild(this._makeLetterIcon(item)); // 首字母彩色图标
    } else if (item.type === 'app') {
      // 自动：软件类读 .exe 图标，失败用首字母图标兜底
      this._loadExeIcon(el, item);
    } else if (item.type === 'web') {
      // 自动：网页快捷方式默认加载网站 Favicon，失败保留默认外链图标
      this._loadWebFavicon(el, item);
    } else {
      // 自动：文件 / 文件夹给默认 SVG 图标
      el.innerHTML = window.svgIcon(this._defaultIconName(item), 22);
    }
    return el;
  },

  /** 返回条目对应的默认图标名 */
  _defaultIconName(item) {
    if (item.type === 'app') return 'app';
    if (item.type === 'folder') return 'folder-fill';
    if (item.type === 'web') return 'external';
    return 'file';
  },

  /**
   * 异步读取软件图标并填充到卡片
   * 说明：先用「首字母彩色图标」占位，读取成功后替换为 .exe 真实图标；
   *       读取失败则保留首字母图标，保证每个快捷方式都有可辨识的图标。
   * @param {HTMLElement} el 图标容器
   * @param {object} item 快捷方式数据
   */
  async _loadExeIcon(el, item) {
    this._setLetterIcon(el, item);                      // 首字母占位
    try {
      const dataUrl = await this._getFileIconCached(item.path);
      if (!dataUrl) return;                             // 读取失败：保留首字母图标
      el.innerHTML = '';
      const img = document.createElement('img');
      img.className = 'shortcut-icon-img';
      img.src = dataUrl;
      img.alt = item.name;
      img.draggable = false;
      el.appendChild(img);
    } catch (e) {
      // 读取失败：保留首字母图标
    }
  },

  /**
   * 读取文件图标（带内存缓存，避免重复 IPC 请求与图标闪烁）
   * @param {string} filePath 文件路径
   * @returns {Promise<string>} 图标 data URL，失败返回空字符串
   */
  _getFileIconCached(filePath) {
    if (!this._iconCache) this._iconCache = new Map();
    if (this._iconCache.has(filePath)) {
      return Promise.resolve(this._iconCache.get(filePath));
    }
    return window.workbench.getFileIcon(filePath).then((dataUrl) => {
      if (dataUrl) this._iconCache.set(filePath, dataUrl);
      return dataUrl;
    });
  },

  /**
   * 异步加载网页快捷方式的网站 Favicon
   * 说明：先用默认外链 SVG 图标占位，下载成功后再替换为真实图标；
   *       下载失败（无 favicon / 网络异常）保留占位图标，保证 UI 不空白。
   * @param {HTMLElement} el 图标容器
   * @param {object} item 快捷方式数据
   */
  async _loadWebFavicon(el, item) {
    el.innerHTML = window.svgIcon('external', 22);       // 占位图标
    try {
      const dataUrl = await this._getWebFaviconCached(item.path);
      if (!dataUrl) return;                              // 失败：保留占位图标
      el.innerHTML = '';
      const img = document.createElement('img');
      img.className = 'shortcut-icon-img';
      img.src = dataUrl;
      img.alt = item.name;
      img.draggable = false;
      el.appendChild(img);
    } catch (e) {
      // 失败：保留占位图标
    }
  },

  /**
   * 读取网页 favicon（带内存缓存，避免重复 IPC 请求与图标闪烁）
   * @param {string} url 目标网址
   * @returns {Promise<string>} favicon 的 data URL，失败返回空字符串
   */
  _getWebFaviconCached(url) {
    if (!this._faviconCache) this._faviconCache = new Map();
    if (this._faviconCache.has(url)) {
      return Promise.resolve(this._faviconCache.get(url));
    }
    return window.workbench.getWebFavicon(url).then((dataUrl) => {
      if (dataUrl) this._faviconCache.set(url, dataUrl);
      return dataUrl;
    });
  },

  /**
   * 生成「首字母彩色图标」作为兜底
   * @param {HTMLElement} el 图标容器
   * @param {object} item 快捷方式数据
   */
  _setLetterIcon(el, item) {
    el.innerHTML = '';
    el.appendChild(this._makeLetterIcon(item));
  },

  /** 生成首字母彩色图标元素 */
  _makeLetterIcon(item) {
    const raw = (item.name || '').trim();
    const ch = (raw.charAt(0) || '?').toUpperCase();
    const color = LETTER_COLORS[this._hashName(raw) % LETTER_COLORS.length];
    const badge = UI.el('span', 'shortcut-letter-icon');
    badge.textContent = ch;
    badge.style.background = color;
    return badge;
  },

  /** 字符串哈希（用于给首字母图标稳定取色） */
  _hashName(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) >>> 0;
    }
    return h;
  },

  // -------------------------------------------------------------------
  // 拖拽排序（按住拖动 + 落点白色指示条）
  // -------------------------------------------------------------------

  // 拖拽临时状态：_drag 记录被拖项，_dropIndicator 为落点白条，_dropIndex 为插入位置
  _drag: null,
  _dropIndicator: null,
  _dropIndex: -1,

  /**
   * 为某个快捷方式容器绑定拖放事件
   * @param {HTMLElement} strip 快捷方式容器
   * @param {'app'|'file'} type 区域类型（用于区分软件区 / 文件区）
   */
  _enableDrag(strip, type) {
    strip.addEventListener('dragover', (e) => {
      if (!this._drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this._showIndicator(strip, this._drag.item, e.clientX, e.clientY);
    });

    strip.addEventListener('drop', (e) => {
      if (!this._drag) return;
      e.preventDefault();
      this._applyDrop(strip, type);
      this._clearDrag();
    });

    strip.addEventListener('dragleave', (e) => {
      // 仅当鼠标真正离开容器时移除指示条（排除移入子元素时冒泡触发）
      if (!strip.contains(e.relatedTarget)) this._removeIndicator();
    });
  },

  /** 拖拽开始：记录被拖项 */
  _onDragStart(e, item) {
    this._drag = { item };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.id);
    // 异步加类，避免影响浏览器生成的拖拽快照
    setTimeout(() => {
      if (e.target) e.target.classList.add('dragging');
    }, 0);
  },

  /**
   * 拖拽中：在鼠标即将落点显示白色半透明指示条
   * @param {HTMLElement} strip 容器
   * @param {object} dragItem 被拖项
   * @param {number} clientX 鼠标横坐标
   * @param {number} clientY 鼠标纵坐标
   */
  _showIndicator(strip, dragItem, clientX, clientY) {
    if (!this._dropIndicator) {
      this._dropIndicator = UI.el('div', 'drop-indicator');
    }
    const indicator = this._dropIndicator;

    // 排除被拖卡片本身，按剩余卡片计算插入位置
    const cards = Array.from(strip.querySelectorAll('.shortcut-card'))
      .filter((c) => c.dataset.id !== dragItem.id);

    let insertIndex = cards.length;
    if (cards.length > 0) {
      // 找距离鼠标最近的卡片
      let nearest = cards[0];
      let minDist = Infinity;
      cards.forEach((c) => {
        const r = c.getBoundingClientRect();
        const dx = clientX - (r.left + r.width / 2);
        const dy = clientY - (r.top + r.height / 2);
        const d = dx * dx + dy * dy;
        if (d < minDist) {
          minDist = d;
          nearest = c;
        }
      });
      const nr = nearest.getBoundingClientRect();
      const after = clientX > nr.left + nr.width / 2;
      insertIndex = cards.indexOf(nearest) + (after ? 1 : 0);
    }
    this._dropIndex = insertIndex;

    // 把白条插到对应位置（insertIndex 的卡片之前；越界则追加到末尾）
    strip.insertBefore(indicator, cards[insertIndex] || null);
  },

  /** 拖拽结束：清理指示条与拖拽态 */
  _clearDrag() {
    this._removeIndicator();
    const dragging = document.querySelector('.shortcut-card.dragging');
    if (dragging) dragging.classList.remove('dragging');
    this._drag = null;
    this._dropIndex = -1;
  },

  /** 移除落点指示条 */
  _removeIndicator() {
    if (this._dropIndicator) {
      this._dropIndicator.remove();
      this._dropIndicator = null;
    }
  },

  /** 返回指定区域当前的展示列表 */
  _sectionItems(type) {
    if (type === 'app') return Store.appShortcuts();
    if (type === 'web') return Store.webShortcuts();
    return Store.fileShortcuts();
  },

  /**
   * 落下：把被拖项移动到落点位置并持久化
   * @param {HTMLElement} strip 容器
   * @param {'app'|'file'} type 区域类型
   */
  _applyDrop(strip, type) {
    const item = this._drag && this._drag.item;
    if (!item) return;

    const items = this._sectionItems(type);
    const fromIndex = items.findIndex((i) => i.id === item.id);
    if (fromIndex < 0) return;

    // 先移除；_dropIndex 是基于「移除后」的列表计算的插入位置
    const moved = items.splice(fromIndex, 1)[0];
    const insertIndex = typeof this._dropIndex === 'number'
      ? Math.max(0, Math.min(this._dropIndex, items.length))
      : items.length;
    items.splice(insertIndex, 0, moved);

    this._persistOrder(items);
  },

  /**
   * 把本区新顺序写回 Store.apps（保持其它区域元素相对位置不变）
   * @param {Array} newItems 本区重排后的元素列表
   */
  async _persistOrder(newItems) {
    const ids = newItems.map((i) => i.id);
    const idSet = new Set(ids);
    const byId = new Map(newItems.map((i) => [i.id, i]));
    let p = 0;
    Store.apps = Store.apps.map((a) => {
      if (idSet.has(a.id)) return byId.get(ids[p++]);
      return a;
    });
    const saved = await Store.saveApps();
    if (saved && saved.success === false) {
      UI.setToast('排序保存失败：' + saved.message, 'error');
    }
    Store.notify();
  },

  // -------------------------------------------------------------------
  // 动作：启动 / 打开
  // -------------------------------------------------------------------
  async _activate(item) {
    if (item.type === 'app') {
      UI.setToast('正在启动「' + item.name + '」…', 'info');
      const result = await window.workbench.launchApp(item.path);
      if (result.success) UI.setToast('「' + item.name + '」启动成功', 'success');
      else UI.setToast('「' + item.name + '」启动失败：' + result.message, 'error');
    } else if (item.type === 'web') {
      // 网页快捷方式：交给系统默认浏览器
      UI.setToast('正在打开「' + item.name + '」…', 'info');
      const result = await window.workbench.openUrl(item.path);
      if (result.success) UI.setToast('「' + item.name + '」已打开', 'success');
      else UI.setToast('「' + item.name + '」打开失败：' + result.message, 'error');
    } else {
      UI.setToast('正在打开「' + item.name + '」…', 'info');
      const result = await window.workbench.openPath(item.path);
      if (result.success) UI.setToast('「' + item.name + '」打开成功', 'success');
      else UI.setToast('「' + item.name + '」打开失败：' + result.message, 'error');
    }
  },

  // -------------------------------------------------------------------
  // 动作：删除快捷方式
  // -------------------------------------------------------------------
  async _removeShortcut(item) {
    if (item.isBuiltin) {
      UI.setToast('内置软件不支持删除', 'error');
      return;
    }
    Store.apps = Store.apps.filter((a) => a.id !== item.id);
    const saved = await Store.saveApps();
    if (saved && saved.success === false) {
      return UI.setToast('删除失败：' + saved.message, 'error');
    }
    Store.notify();
    UI.setToast('已删除「' + item.name + '」', 'success');
  },

  // -------------------------------------------------------------------
  // 扫描系统已安装软件：读取开始菜单 + 注册表，勾选后批量添加
  // -------------------------------------------------------------------
  async _openScanModal() {
    // 先弹出 loading 模态框
    const loadingWrap = UI.el('div', 'scan-loading');
    loadingWrap.appendChild(UI.icon('loading', 24));
    loadingWrap.appendChild(UI.el('div', '', '正在扫描系统已安装软件，请稍候…'));
    UI.openModal('扫描系统软件', loadingWrap, 'scan-modal');

    // 调用主进程扫描
    const res = await window.workbench.scanInstalledApps();
    if (!res || !res.success) {
      UI.closeModal();
      UI.setToast(res && res.message ? '扫描失败：' + res.message : '扫描失败', 'error');
      return;
    }
    const allApps = res.apps || [];
    if (allApps.length === 0) {
      UI.closeModal();
      UI.setToast('未扫描到任何已安装软件', 'error');
      return;
    }

    // 已添加的软件路径集合（用于灰显已存在的项）
    const existingPaths = new Set(Store.appShortcuts().map((a) => (a.path || '').toLowerCase()));
    // 待添加的选中集合
    const selected = new Set();

    // 构建模态框内容
    const wrap = UI.el('div', 'scan-wrap');

    // 顶部工具栏：搜索框 + 全选/反选
    const toolbar = UI.el('div', 'scan-toolbar');
    const searchInput = UI.el('input', 'scan-search');
    searchInput.type = 'text';
    searchInput.placeholder = '搜索软件名称…';
    toolbar.appendChild(searchInput);
    const selectAllBtn = UI.el('button', 'btn btn-ghost btn-sm', '全选');
    selectAllBtn.type = 'button';
    const invertBtn = UI.el('button', 'btn btn-ghost btn-sm', '反选');
    invertBtn.type = 'button';
    toolbar.appendChild(selectAllBtn);
    toolbar.appendChild(invertBtn);
    wrap.appendChild(toolbar);

    // 列表容器
    const list = UI.el('div', 'scan-list');
    wrap.appendChild(list);

    // 底部操作栏
    const actions = UI.el('div', 'form-actions scan-actions');
    const countLabel = UI.el('span', 'scan-count', '已选 0 个');
    const cancelBtn = UI.el('button', 'btn btn-ghost', '取消');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => UI.closeModal());
    const addBtn = UI.el('button', 'btn btn-primary', '添加已选');
    addBtn.type = 'button';
    actions.appendChild(countLabel);
    actions.appendChild(cancelBtn);
    actions.appendChild(addBtn);
    wrap.appendChild(actions);

    // 渲染列表项
    const renderList = (filter) => {
      list.innerHTML = '';
      const lower = filter ? filter.toLowerCase() : '';
      const filtered = lower
        ? allApps.filter((a) => a.name.toLowerCase().includes(lower))
        : allApps;
      if (filtered.length === 0) {
        list.appendChild(UI.el('div', 'empty-tip', '没有匹配的软件'));
        return;
      }
      filtered.forEach((app) => {
        const key = app.path.toLowerCase();
        const exists = existingPaths.has(key);
        const row = UI.el('div', 'scan-row' + (exists ? ' scan-row-disabled' : ''));
        row.dataset.key = key;

        // 勾选框
        const cb = UI.el('input', 'scan-checkbox');
        cb.type = 'checkbox';
        cb.disabled = exists;
        if (selected.has(key)) cb.checked = true;
        if (!exists) {
          cb.addEventListener('change', () => {
            if (cb.checked) selected.add(key); else selected.delete(key);
            updateCount();
          });
        }
        row.appendChild(cb);

        // 首字母彩色图标占位（不抓 .exe 图标，添加后由现有机制懒加载）
        const iconWrap = UI.el('div', 'scan-icon');
        iconWrap.appendChild(this._makeLetterIcon({ name: app.name }));
        row.appendChild(iconWrap);

        // 名称 + 路径
        const info = UI.el('div', 'scan-info');
        info.appendChild(UI.el('div', 'scan-name', app.name));
        info.appendChild(UI.el('div', 'scan-path', app.path));
        row.appendChild(info);

        // 已添加标记
        if (exists) {
          row.appendChild(UI.el('span', 'scan-exists', '已添加'));
        }

        list.appendChild(row);
      });
    };

    // 更新已选计数
    const updateCount = () => {
      countLabel.textContent = '已选 ' + selected.size + ' 个';
    };

    // 搜索实时过滤
    searchInput.addEventListener('input', () => renderList(searchInput.value.trim()));

    // 全选（仅选当前过滤结果中未禁用的）
    selectAllBtn.addEventListener('click', () => {
      const lower = searchInput.value.trim().toLowerCase();
      allApps.forEach((app) => {
        const key = app.path.toLowerCase();
        if (existingPaths.has(key)) return;
        if (lower && !app.name.toLowerCase().includes(lower)) return;
        selected.add(key);
      });
      renderList(searchInput.value.trim());
      updateCount();
    });

    // 反选（仅对当前过滤结果中未禁用的）
    invertBtn.addEventListener('click', () => {
      const lower = searchInput.value.trim().toLowerCase();
      allApps.forEach((app) => {
        const key = app.path.toLowerCase();
        if (existingPaths.has(key)) return;
        if (lower && !app.name.toLowerCase().includes(lower)) return;
        if (selected.has(key)) selected.delete(key); else selected.add(key);
      });
      renderList(searchInput.value.trim());
      updateCount();
    });

    // 添加已选：批量 push 到 Store.apps 并保存
    addBtn.addEventListener('click', async () => {
      if (selected.size === 0) {
        UI.setToast('请先勾选要添加的软件', 'error');
        return;
      }
      const toAdd = allApps.filter((a) => selected.has(a.path.toLowerCase()));
      const ts = Date.now();
      const newItems = toAdd.map((a, i) => ({
        id: 'shortcut-' + ts + '-' + i,
        type: 'app',
        name: a.name,
        iconType: 'auto',
        icon: '',
        path: a.path
      }));
      Store.apps.push(...newItems);
      const saved = await Store.saveApps();
      if (saved && saved.success === false) {
        // 保存失败：回滚
        newItems.forEach((item) => {
          const idx = Store.apps.indexOf(item);
          if (idx >= 0) Store.apps.splice(idx, 1);
        });
        return UI.setToast('添加失败：' + saved.message, 'error');
      }
      UI.closeModal();
      Store.notify();
      UI.setToast('已添加 ' + newItems.length + ' 个软件', 'success');
    });

    // 首次渲染并打开模态框
    renderList('');
    updateCount();
    UI.openModal('扫描系统软件（共 ' + allApps.length + ' 个）', wrap, 'scan-modal');
    searchInput.focus();
  },

  // -------------------------------------------------------------------
  // 管理软件：批量删除已有快捷方式 + 添加扫描未识别的文件快捷方式
  // 复用 scan-modal 样式；数据源为 Store 中所有快捷方式（内置项禁删）
  // -------------------------------------------------------------------
  _openManageModal() {
    // 汇总所有快捷方式（软件 + 文件/文件夹 + 网页）
    const allItems = [
      ...Store.appShortcuts(),
      ...Store.fileShortcuts(),
      ...Store.webShortcuts()
    ];
    if (allItems.length === 0) {
      UI.setToast('暂无快捷方式可管理', 'error');
      return;
    }

    // 待删除的选中 id 集合
    const selected = new Set();

    // 构建模态框内容（复用 scan-wrap 系列样式）
    const wrap = UI.el('div', 'scan-wrap');

    // 顶部工具栏：搜索框 + 类型筛选 + 全选/反选
    const toolbar = UI.el('div', 'scan-toolbar');
    const searchInput = UI.el('input', 'scan-search');
    searchInput.type = 'text';
    searchInput.placeholder = '搜索名称…';
    toolbar.appendChild(searchInput);

    // 类型筛选下拉框
    const typeSelect = UI.el('select', 'scan-filter');
    [
      { value: 'all', label: '全部' },
      { value: 'app', label: '软件' },
      { value: 'file', label: '文件' },
      { value: 'folder', label: '文件夹' },
      { value: 'web', label: '网页' }
    ].forEach((opt) => {
      const o = UI.el('option', '', opt.label);
      o.value = opt.value;
      typeSelect.appendChild(o);
    });
    toolbar.appendChild(typeSelect);

    const selectAllBtn = UI.el('button', 'btn btn-ghost btn-sm', '全选');
    selectAllBtn.type = 'button';
    const invertBtn = UI.el('button', 'btn btn-ghost btn-sm', '反选');
    invertBtn.type = 'button';
    toolbar.appendChild(selectAllBtn);
    toolbar.appendChild(invertBtn);
    wrap.appendChild(toolbar);

    // 列表容器
    const list = UI.el('div', 'scan-list');
    wrap.appendChild(list);

    // 底部操作栏
    const actions = UI.el('div', 'form-actions scan-actions');
    const countLabel = UI.el('span', 'scan-count', '已选 0 个');
    const addFileBtn = UI.el('button', 'btn btn-ghost', '添加文件快捷方式');
    addFileBtn.type = 'button';
    const closeBtn = UI.el('button', 'btn btn-ghost', '关闭');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => UI.closeModal());
    const deleteBtn = UI.el('button', 'btn btn-primary', '删除已选');
    deleteBtn.type = 'button';
    actions.appendChild(countLabel);
    actions.appendChild(addFileBtn);
    actions.appendChild(closeBtn);
    actions.appendChild(deleteBtn);
    wrap.appendChild(actions);

    // 类型显示文字映射
    const typeText = (t) =>
      t === 'app' ? '软件' : t === 'file' ? '文件' : t === 'folder' ? '文件夹' : '网页';

    // 渲染列表（按搜索关键字 + 类型筛选过滤）
    const renderList = () => {
      const kw = searchInput.value.trim().toLowerCase();
      const tf = typeSelect.value;
      list.innerHTML = '';
      const filtered = allItems.filter((item) => {
        if (tf !== 'all' && item.type !== tf) return false;
        if (kw && !item.name.toLowerCase().includes(kw)) return false;
        return true;
      });
      if (filtered.length === 0) {
        list.appendChild(UI.el('div', 'empty-tip', '没有匹配的快捷方式'));
        return;
      }
      filtered.forEach((item) => {
        const disabled = !!item.isBuiltin;
        const row = UI.el('div', 'scan-row' + (disabled ? ' scan-row-disabled' : ''));
        row.dataset.id = item.id;

        // 勾选框（内置项禁用）
        const cb = UI.el('input', 'scan-checkbox');
        cb.type = 'checkbox';
        cb.disabled = disabled;
        if (selected.has(item.id)) cb.checked = true;
        if (!disabled) {
          cb.addEventListener('change', () => {
            if (cb.checked) selected.add(item.id); else selected.delete(item.id);
            updateCount();
          });
        }
        row.appendChild(cb);

        // 首字母彩色图标占位
        const iconWrap = UI.el('div', 'scan-icon');
        iconWrap.appendChild(this._makeLetterIcon({ name: item.name }));
        row.appendChild(iconWrap);

        // 名称 + 路径
        const info = UI.el('div', 'scan-info');
        info.appendChild(UI.el('div', 'scan-name', item.name + (disabled ? '（内置）' : '')));
        info.appendChild(UI.el('div', 'scan-path', item.path));
        row.appendChild(info);

        // 类型徽章
        row.appendChild(UI.el('span', 'scan-exists', typeText(item.type)));
        list.appendChild(row);
      });
    };

    // 更新已选计数
    const updateCount = () => {
      countLabel.textContent = '已选 ' + selected.size + ' 个';
    };

    // 搜索 / 筛选实时刷新
    searchInput.addEventListener('input', () => renderList());
    typeSelect.addEventListener('change', () => renderList());

    // 全选（仅当前过滤结果中可选项）
    selectAllBtn.addEventListener('click', () => {
      const kw = searchInput.value.trim().toLowerCase();
      const tf = typeSelect.value;
      allItems.forEach((item) => {
        if (item.isBuiltin) return;
        if (tf !== 'all' && item.type !== tf) return;
        if (kw && !item.name.toLowerCase().includes(kw)) return;
        selected.add(item.id);
      });
      renderList();
      updateCount();
    });

    // 反选（仅对当前过滤结果中可选项）
    invertBtn.addEventListener('click', () => {
      const kw = searchInput.value.trim().toLowerCase();
      const tf = typeSelect.value;
      allItems.forEach((item) => {
        if (item.isBuiltin) return;
        if (tf !== 'all' && item.type !== tf) return;
        if (kw && !item.name.toLowerCase().includes(kw)) return;
        if (selected.has(item.id)) selected.delete(item.id); else selected.add(item.id);
      });
      renderList();
      updateCount();
    });

    // 删除已选：二次确认后批量删除
    deleteBtn.addEventListener('click', async () => {
      if (selected.size === 0) {
        UI.setToast('请先勾选要删除的快捷方式', 'error');
        return;
      }
      if (!confirm('确定删除选中的 ' + selected.size + ' 个快捷方式吗？')) return;
      const ids = new Set(selected);
      Store.apps = Store.apps.filter((a) => !ids.has(a.id));
      const saved = await Store.saveApps();
      if (saved && saved.success === false) {
        return UI.setToast('删除失败：' + saved.message, 'error');
      }
      UI.closeModal();
      Store.notify();
      UI.setToast('已删除 ' + ids.size + ' 个快捷方式', 'success');
    });

    // 添加文件快捷方式：调用系统文件对话框选择任意文件，按扩展名判定类型
    addFileBtn.addEventListener('click', async () => {
      const res = await window.workbench.selectPath('file');
      if (res.canceled || !res.path) return;
      const filePath = res.path;
      const ext = filePath.split('.').pop().toLowerCase();
      const isApp = ['exe', 'lnk', 'bat', 'cmd', 'msi'].includes(ext);
      const base = filePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      const name = isApp ? base.replace(/\.(exe|lnk|bat|cmd|msi)$/i, '') : base;
      const item = {
        id: 'shortcut-' + Date.now(),
        type: isApp ? 'app' : 'file',
        name,
        iconType: 'auto',
        icon: '',
        path: filePath
      };
      Store.apps.push(item);
      const saved = await Store.saveApps();
      if (saved && saved.success === false) {
        Store.apps.pop();
        return UI.setToast('添加失败：' + saved.message, 'error');
      }
      // 刷新管理弹窗列表，保留当前选中状态
      allItems.push(item);
      renderList();
      UI.setToast('已添加「' + name + '」', 'success');
    });

    // 首次渲染并打开模态框
    renderList();
    updateCount();
    UI.openModal('管理软件（共 ' + allItems.length + ' 个）', wrap, 'scan-modal');
    searchInput.focus();
  },

  // -------------------------------------------------------------------
  // 添加 / 修改快捷方式模态框（软件 / 文件 / 文件夹 / 网页）
  // 传入 editItem 则进入「修改」模式：预填数据并在提交时更新原条目
  // -------------------------------------------------------------------
  _openAddModal(type, editItem) {
    const editing = !!editItem;
    const form = UI.el('form', '');

    // 类型选择
    const typeItem = UI.el('div', 'form-item');
    typeItem.appendChild(UI.el('label', '', '类型'));
    const typeSelect = UI.el('select', '');
    [
      { value: 'app', label: '软件（启动 .exe）' },
      { value: 'file', label: '文件' },
      { value: 'folder', label: '文件夹' },
      { value: 'web', label: '网页（打开链接）' }
    ].forEach((opt) => {
      const o = UI.el('option', '', opt.label);
      o.value = opt.value;
      typeSelect.appendChild(o);
    });
    typeSelect.value = type;
    typeItem.appendChild(typeSelect);
    form.appendChild(typeItem);

    // 名称
    const nameItem = UI.el('div', 'form-item');
    nameItem.appendChild(UI.el('label', '', '名称'));
    const nameInput = UI.el('input', '');
    nameInput.placeholder = '例如：Visual Studio Code';
    nameItem.appendChild(nameInput);
    form.appendChild(nameItem);

    // 图标来源（自动 / Emoji / 首字母 / 自定义图片）
    const iconItem = UI.el('div', 'form-item');
    iconItem.appendChild(UI.el('label', '', '图标'));
    const iconTypeSelect = UI.el('select', '');
    [
      { value: 'auto', label: '自动（跟随类型）' },
      { value: 'emoji', label: 'Emoji 表情' },
      { value: 'letter', label: '首字母' },
      { value: 'image', label: '自定义图标' }
    ].forEach((opt) => {
      const o = UI.el('option', '', opt.label);
      o.value = opt.value;
      iconTypeSelect.appendChild(o);
    });
    iconTypeSelect.value = 'auto';
    iconItem.appendChild(iconTypeSelect);

    // Emoji 输入框（来源为 emoji 时显示）
    const iconInput = UI.el('input', '');
    iconInput.placeholder = '例如：🎯';
    iconInput.maxLength = 4;
    iconInput.style.display = 'none';
    iconItem.appendChild(iconInput);

    // 自定义图片选择 + 预览（来源为 image 时显示）
    const imageWrap = UI.el('div', 'icon-image-wrap');
    imageWrap.style.display = 'none';
    const pickImgBtn = UI.el('button', 'btn btn-ghost btn-sm', '选择图标…');
    pickImgBtn.type = 'button';
    const imagePreview = UI.el('span', 'icon-image-preview');
    imageWrap.appendChild(pickImgBtn);
    imageWrap.appendChild(imagePreview);
    iconItem.appendChild(imageWrap);
    form.appendChild(iconItem);

    // 当前选中的图片 data URL
    let imageDataUrl = '';

    // 选择图片并预览
    pickImgBtn.addEventListener('click', async () => {
      const res = await window.workbench.selectImage();
      if (res.canceled) return;
      if (res.success && res.dataUrl) {
        imageDataUrl = res.dataUrl;
        imagePreview.innerHTML = '';
        const img = document.createElement('img');
        img.src = res.dataUrl;
        img.alt = '';
        imagePreview.appendChild(img);
      } else {
        UI.setToast(res.message || '选择图片失败', 'error');
      }
    });

    // 根据图标来源切换输入控件
    const updateIconUI = () => {
      const v = iconTypeSelect.value;
      iconInput.style.display = v === 'emoji' ? '' : 'none';
      imageWrap.style.display = v === 'image' ? '' : 'none';
    };
    iconTypeSelect.addEventListener('change', updateIconUI);

    // 路径 / 网址 + 浏览按钮
    const pathItem = UI.el('div', 'form-item');
    const pathLabel = UI.el('label', '', '路径');
    pathItem.appendChild(pathLabel);
    const pathRow = UI.el('div', 'path-row');
    const pathInput = UI.el('input', '');
    const browseBtn = UI.el('button', 'btn btn-ghost', '浏览…');
    browseBtn.type = 'button';
    browseBtn.addEventListener('click', async () => {
      const kind = typeSelect.value === 'folder' ? 'folder' : 'file';
      const res = await window.workbench.selectPath(kind);
      if (!res.canceled && res.path) {
        pathInput.value = res.path;
        if (!nameInput.value.trim()) {
          const base = res.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
          nameInput.value = base || '';
        }
      }
    });
    pathRow.appendChild(pathInput);
    pathRow.appendChild(browseBtn);
    pathItem.appendChild(pathRow);
    form.appendChild(pathItem);

    // 根据类型刷新：标签、占位符、浏览按钮显隐
    const updateTypeUI = () => {
      const v = typeSelect.value;
      pathLabel.textContent = v === 'web' ? '网址' : '路径';
      if (v === 'web') {
        pathInput.placeholder = '例如：https://example.com';
        browseBtn.style.display = 'none';
      } else {
        browseBtn.style.display = '';
        if (v === 'app') pathInput.placeholder = '例如：C:\\Program Files\\App\\app.exe';
        else if (v === 'folder') pathInput.placeholder = '例如：C:\\Users\\文档';
        else pathInput.placeholder = '例如：C:\\Users\\文档\\文件';
      }
    };

    // 修改模式：预填已有数据
    if (editing) {
      typeSelect.value = editItem.type;
      nameInput.value = editItem.name || '';
      pathInput.value = editItem.path || '';
      // 图标来源预填（兼容旧数据：无 iconType 时按 _iconTypeOf 推断）
      const it = this._iconTypeOf(editItem);
      iconTypeSelect.value = it;
      if (it === 'emoji') {
        iconInput.value = editItem.icon || '';
      } else if (it === 'image' && editItem.icon) {
        imageDataUrl = editItem.icon;
        imagePreview.innerHTML = '';
        const img = document.createElement('img');
        img.src = editItem.icon;
        img.alt = '';
        imagePreview.appendChild(img);
      }
    }
    updateTypeUI();
    updateIconUI();

    // 底部按钮
    const actions = UI.el('div', 'form-actions');
    const cancelBtn = UI.el('button', 'btn btn-ghost', '取消');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => UI.closeModal());
    const submitBtn = UI.el('button', 'btn btn-primary', '确定');
    submitBtn.type = 'submit';
    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    form.appendChild(actions);

    // 切换类型时更新标签 / 占位符 / 浏览按钮
    typeSelect.addEventListener('change', updateTypeUI);

    // 提交
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      const pathVal = pathInput.value.trim();
      if (!name || !pathVal) {
        UI.setToast('请填写名称和路径', 'error');
        return;
      }

      // 按图标来源计算 iconType 与 icon（未填值时降级为 auto）
      let iconType = iconTypeSelect.value;
      let icon = '';
      if (iconType === 'emoji') {
        icon = iconInput.value.trim();
        if (!icon) iconType = 'auto';
      } else if (iconType === 'image') {
        icon = imageDataUrl;
        if (!icon) iconType = 'auto';
      }

      // 修改模式：更新原条目
      if (editing) {
        const prev = Object.assign({}, editItem);
        Object.assign(editItem, { type: typeSelect.value, name, iconType, icon, path: pathVal });
        const saved = await Store.saveApps();
        if (saved && saved.success === false) {
          Object.assign(editItem, prev);
          return UI.setToast('修改失败：' + saved.message, 'error');
        }
        UI.closeModal();
        Store.notify();
        UI.setToast('已修改「' + name + '」', 'success');
        return;
      }

      const item = {
        id: 'shortcut-' + Date.now(),
        type: typeSelect.value,
        name,
        iconType,
        icon,
        path: pathVal
      };
      Store.apps.push(item);
      const saved = await Store.saveApps();
      if (saved && saved.success === false) {
        Store.apps.pop();
        return UI.setToast('添加失败：' + saved.message, 'error');
      }
      UI.closeModal();
      Store.notify();
      UI.setToast('已添加「' + name + '」', 'success');
    });

    UI.openModal(editing ? '修改快捷方式' : '添加快捷方式', form);
    nameInput.focus();
  },

  /** 右键「修改」入口：复用添加弹窗，进入编辑模式 */
  _openEditModal(item) {
    this._openAddModal(item.type, item);
  },

  /**
   * 右键「属性」：展示 Windows 风格属性面板
   * 参考 Windows 文件属性对话框的「常规」标签页布局：
   *   顶部图标 + 名称 + 类型，下方属性名值列表，底部「确定」按钮
   * @param {object} item 快捷方式数据
   */
  _openPropertyModal(item) {
    const TYPE_LABEL = {
      app: '应用程序',
      file: '文件',
      folder: '文件夹',
      web: '网页快捷方式'
    };
    const typeLabel = TYPE_LABEL[item.type] || '快捷方式';

    const panel = UI.el('div', 'property-panel');

    // 顶部：图标 + 名称 + 类型（按图标来源渲染）
    const header = UI.el('div', 'property-header');
    const icon = UI.el('div', 'property-icon');
    const it = this._iconTypeOf(item);
    if (it === 'image' && item.icon) {
      const img = document.createElement('img');
      img.src = item.icon;
      img.alt = item.name;
      icon.appendChild(img);
    } else if (it === 'emoji' && item.icon) {
      icon.textContent = item.icon;
    } else if (it === 'letter') {
      icon.appendChild(this._makeLetterIcon(item));
    } else if (item.type === 'app') {
      // 自动 + 软件：读 .exe 图标，失败用首字母兜底
      this._loadExeIcon(icon, item);
    } else {
      icon.innerHTML = window.svgIcon(this._defaultIconName(item), 32);
    }
    header.appendChild(icon);
    const titleWrap = UI.el('div', 'property-title-wrap');
    titleWrap.appendChild(UI.el('div', 'property-name', item.name));
    titleWrap.appendChild(UI.el('div', 'property-type', typeLabel));
    header.appendChild(titleWrap);
    panel.appendChild(header);

    panel.appendChild(UI.el('div', 'property-divider'));

    // 属性名值列表（Windows 常规标签风格）
    const dir = this._dirOf(item.path, item.type);
    const iconKind = this._iconTypeOf(item);
    const iconDesc = iconKind === 'image' ? '自定义图片'
      : iconKind === 'letter' ? '首字母图标'
      : iconKind === 'emoji' ? (item.icon || '（默认图标）')
      : '自动（跟随类型）';
    const rows = [
      { k: '名称', v: item.name },
      { k: '类型', v: typeLabel },
      { k: '目标', v: item.path || '—' },
      { k: '位置', v: dir || '—' },
      { k: '图标', v: iconDesc }
    ];
    const list = UI.el('div', 'property-list');
    rows.forEach((row) => {
      const r = UI.el('div', 'property-row');
      r.appendChild(UI.el('span', 'property-key', row.k));
      r.appendChild(UI.el('span', 'property-value', row.v));
      list.appendChild(r);
    });
    panel.appendChild(list);

    // 底部按钮
    const actions = UI.el('div', 'form-actions');
    const okBtn = UI.el('button', 'btn btn-primary', '确定');
    okBtn.addEventListener('click', () => UI.closeModal());
    actions.appendChild(okBtn);
    panel.appendChild(actions);

    UI.openModal('属性', panel);
  },

  /**
   * 计算条目所在目录（软件/文件/文件夹取父目录；网页或命令名返回空）
   * @param {string} p 路径或网址
   * @param {string} type 条目类型
   */
  _dirOf(p, type) {
    if (!p || type === 'web') return '';
    if (!/[\\/]/.test(p)) return '';
    const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return idx >= 0 ? p.slice(0, idx) : '';
  }
};