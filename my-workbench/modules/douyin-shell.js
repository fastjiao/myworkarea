// =====================================================================
// modules/douyin-shell.js —— 抖音 webview 自定义外壳/工具栏
// 职责：
//   在主窗口内嵌的抖音 <webview> 之上叠加一条自定义工具栏，
//   提供后退/前进/刷新/首页/地址栏/在浏览器中打开/截图/缩放/透明度等功能。
//   webview 本身保持原样（独立 webContents 嵌真实 douyin.com），
//   登录态与刷视频能力完全不受影响。
// 说明：
//   - 工具栏是渲染进程原生 DOM，与 webview 互不干扰；
//   - 想增删按钮，只需改本文件 buildToolbar() 内的按钮数组与 bindEvents()；
//   - 风格遵循浅色简约（白底软灰圆角），并兼容深色模式（.dark 覆盖）。
// =====================================================================

const DouyinShell = {
  _toolbar: null,
  _webview: null,
  _addrInput: null,
  _zoomFactor: 1,    // 当前缩放倍数，1 = 100%
  _zoomMin: 0.5,
  _zoomMax: 3,
  _zoomStep: 0.1,

  // 初始化：构建工具栏并绑定 webview 事件。在 renderer.js 启动时调用一次。
  init() {
    this._toolbar = document.getElementById('douyin-toolbar');
    this._webview = document.getElementById('webview-douyin');
    if (!this._toolbar || !this._webview) return;
    this._toolbar.innerHTML = '';
    this.buildToolbar();
    this.bindWebviewEvents();
  },

  // 构建工具栏 DOM。按钮分组：左（导航）/ 中（地址栏）/ 右（工具）。
  buildToolbar() {
    const bar = this._toolbar;

    // ---- 左侧：导航按钮组 ----
    const navGroup = UI.el('div', 'dy-nav-group');
    const btnBack = this._mkBtn('left', '后退', () => this._wvGoBack());
    const btnFwd = this._mkBtn('right', '前进', () => this._wvGoForward());
    const btnReload = this._mkBtn('reload', '刷新', () => this._wvReload(), true);
    const btnHome = this._mkBtn('home', '首页', () => this._wvGoHome());
    navGroup.append(btnBack, btnFwd, btnReload, btnHome);
    this._btnBack = btnBack;
    this._btnFwd = btnFwd;

    // ---- 中间：地址栏 ----
    const addrWrap = UI.el('div', 'dy-addr-wrap');
    const addrInput = UI.el('input', 'dy-addr-input');
    addrInput.type = 'text';
    addrInput.placeholder = '输入网址并回车跳转…';
    addrInput.spellcheck = false;
    addrInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._wvLoadUrl(addrInput.value.trim());
        addrInput.blur();
      }
    });
    // 聚焦时选中全部，便于快速覆盖输入
    addrInput.addEventListener('focus', () => addrInput.select());
    addrWrap.appendChild(addrInput);
    this._addrInput = addrInput;

    // ---- 右侧：工具按钮组 ----
    const toolGroup = UI.el('div', 'dy-tool-group');
    const btnExternal = this._mkBtn('external', '在浏览器中打开', () => this._openExternal());
    const btnShot = this._mkBtn('camera', '截图', () => this._screenshot(), true);
    const btnZoomOut = this._mkBtn('zoom-out', '缩小', () => this._zoom(-this._zoomStep));
    const btnZoomIn = this._mkBtn('zoom-in', '放大', () => this._zoom(this._zoomStep));
    const btnZoomReset = this._mkBtn('zoom-reset', '重置缩放', () => this._zoomReset(), true);
    // 透明度滑块
    const opacityWrap = UI.el('div', 'dy-opacity-wrap');
    opacityWrap.title = '页面透明度';
    const opacityLabel = UI.el('span', 'dy-opacity-label', '透');
    const opacitySlider = UI.el('input', 'dy-opacity-slider');
    opacitySlider.type = 'range';
    opacitySlider.min = '30';
    opacitySlider.max = '100';
    opacitySlider.value = '100';
    opacitySlider.step = '5';
    opacitySlider.addEventListener('input', () => {
      if (this._webview) this._webview.style.opacity = (parseInt(opacitySlider.value, 10) / 100);
    });
    opacityWrap.append(opacityLabel, opacitySlider);
    toolGroup.append(btnExternal, btnShot, btnZoomOut, btnZoomIn, btnZoomReset, opacityWrap);

    bar.append(navGroup, addrWrap, toolGroup);
  },

  // 创建单个图标按钮。iconName 为 ICONS 已有名时走 UI.icon，否则用本文件内联 SVG。
  _mkBtn(iconName, title, onClick, isSquareIcon) {
    const btn = UI.el('button', 'dy-btn');
    btn.title = title;
    btn.type = 'button';
    btn.appendChild(this._icon(iconName, 16));
    btn.addEventListener('click', onClick);
    return btn;
  },

  // 取图标：优先用项目 ICONS 库（left/right/home/external），没有的用内联 SVG。
  _icon(name, size) {
    const fallback = {
      reload: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
      camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
      'zoom-in': '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>',
      'zoom-out': '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>',
      'zoom-reset': '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>'
    };
    if (window.svgIcon && ICONS && ICONS[name]) {
      return UI.icon(name, size);
    }
    const span = document.createElement('span');
    span.className = 'icon';
    const path = fallback[name] || '';
    span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    return span;
  },

  // 绑定 webview 导航事件：更新地址栏、按钮可用态、加载指示。
  bindWebviewEvents() {
    const wv = this._webview;
    if (!wv) return;
    const updateAddr = (url) => {
      if (this._addrInput && document.activeElement !== this._addrInput) {
        this._addrInput.value = url || '';
      }
    };
    const updateNavState = () => {
      if (this._btnBack) this._btnBack.disabled = !wv.canGoBack();
      if (this._btnFwd) this._btnFwd.disabled = !wv.canGoForward();
    };
    // webview 事件需在 src 加载后才能监听；用 dom-ready 兜底首次更新
    wv.addEventListener('dom-ready', () => {
      updateAddr(wv.getURL());
      updateNavState();
    });
    wv.addEventListener('did-navigate', (e) => {
      updateAddr(e.url);
      updateNavState();
    });
    wv.addEventListener('did-navigate-in-page', (e) => {
      updateAddr(e.url);
      updateNavState();
    });
    wv.addEventListener('did-stop-loading', () => {
      updateAddr(wv.getURL());
      updateNavState();
    });
  },

  // ---- webview 操作封装 ----
  _wvGoBack() { const w = this._webview; if (w && w.canGoBack()) w.goBack(); },
  _wvGoForward() { const w = this._webview; if (w && w.canGoForward()) w.goForward(); },
  _wvReload() { if (this._webview) this._webview.reload(); },
  _wvGoHome() { this._wvLoadUrl('https://www.douyin.com/'); },
  _wvLoadUrl(input) {
    if (!this._webview || !input) return;
    let url = input.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    this._webview.loadURL(url);
  },

  // 在系统默认浏览器中打开当前页
  _openExternal() {
    const url = this._webview ? this._webview.getURL() : '';
    if (url && window.workbench && window.workbench.openUrl) {
      window.workbench.openUrl(url);
    } else {
      UI.toast('未获取到当前网址', 'error');
    }
  },

  // 截图：webview.capturePage → data URL → 主进程保存 PNG
  async _screenshot() {
    const wv = this._webview;
    if (!wv) return;
    try {
      const img = await wv.capturePage();
      const dataUrl = img.toDataURL();
      if (window.workbench && window.workbench.saveScreenshot) {
        const res = await window.workbench.saveScreenshot(dataUrl);
        if (res && res.success) {
          UI.toast('截图已保存：' + res.filename, 'success');
        } else {
          UI.toast('截图保存失败：' + (res && res.message), 'error');
        }
      } else {
        UI.toast('当前环境不支持截图保存', 'error');
      }
    } catch (err) {
      UI.toast('截图失败：' + err.message, 'error');
    }
  },

  // 缩放：delta 为增量（正放大 / 负缩小）
  _zoom(delta) {
    let f = this._zoomFactor + delta;
    f = Math.max(this._zoomMin, Math.min(this._zoomMax, f));
    f = Math.round(f * 100) / 100;
    this._zoomFactor = f;
    if (this._webview) this._webview.setZoomFactor(f);
    UI.toast('缩放 ' + Math.round(f * 100) + '%', 'info');
  },
  _zoomReset() {
    this._zoomFactor = 1;
    if (this._webview) this._webview.setZoomFactor(1);
    UI.toast('缩放已重置', 'info');
  }
};

window.DouyinShell = DouyinShell;
