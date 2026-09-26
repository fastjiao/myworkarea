// =====================================================================
// modules/browser.js —— 多标签浏览器（集成在主窗口内的通用浏览器）
// 职责：
//   把原"抖音"导航项升级为一个多标签浏览器：顶部标签栏 + 工具栏 + webview 区。
//   每个标签对应一个独立 <webview>，共享默认 session（cookie/登录态跨标签保留并持久化）。
//   默认新标签打开 Microsoft Bing；地址栏可输入任意网址跳转。
// 说明：
//   - webview 动态创建，挂 block-external-protocol-preload.js 拦截外部协议弹窗；
//   - 懒加载：init() 只搭骨架，activate() 首次切到该页时才创建首个标签，避免启动即请求网络；
//   - 想增删工具栏按钮，改 buildToolbar()；标签行为改 newTab/closeTab/switchTab。
// =====================================================================

const Browser = {
  _root: null,
  _tabbar: null,
  _toolbar: null,
  _views: null,
  _addrInput: null,
  _btnBack: null,
  _btnFwd: null,
  _tabs: [],          // { id, title, url, webview, tabEl, closeEl, titleEl }
  _activeId: null,
  _nextId: 1,
  _inited: false,
  _activated: false,
  _defaultUrl: 'https://www.bing.com/?setmkt=en-US&setlang=en-US&cc=US',
  _zoomFactor: 1,
  _zoomMin: 0.5,
  _zoomMax: 3,
  _zoomStep: 0.1,

  // 初始化骨架（构建标签栏 + 工具栏），不创建标签。在 renderer.js 启动时调用。
  init() {
    if (this._inited) return;
    this._tabbar = document.getElementById('browser-tabbar');
    this._toolbar = document.getElementById('browser-toolbar');
    this._views = document.getElementById('browser-views');
    if (!this._tabbar || !this._toolbar || !this._views) return;
    this.buildToolbar();
    this.buildNewTabBtn();
    this._inited = true;
  },

  // 首次切到浏览器页时激活：创建首个标签（懒加载）
  activate() {
    if (!this._inited) this.init();
    if (!this._activated) {
      this._activated = true;
      if (this._tabs.length === 0) this.newTab(this._defaultUrl);
    }
  },

  // ===================== 工具栏 =====================
  buildToolbar() {
    const bar = this._toolbar;
    bar.innerHTML = '';

    // 左侧：导航按钮
    const navGroup = UI.el('div', 'bw-nav-group');
    this._btnBack = this._mkBtn('left', '后退', () => this._wvAction((w) => w.canGoBack() && w.goBack()));
    this._btnFwd = this._mkBtn('right', '前进', () => this._wvAction((w) => w.canGoForward() && w.goForward()));
    const btnReload = this._mkBtn('reload', '刷新', () => this._wvAction((w) => w.reload()), true);
    const btnHome = this._mkBtn('home', '首页', () => this._wvLoadUrl(this._defaultUrl));
    navGroup.append(this._btnBack, this._btnFwd, btnReload, btnHome);

    // 中间：地址栏
    const addrWrap = UI.el('div', 'bw-addr-wrap');
    const addrInput = UI.el('input', 'bw-addr-input');
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
    addrInput.addEventListener('focus', () => addrInput.select());
    addrWrap.appendChild(addrInput);
    this._addrInput = addrInput;

    // 右侧：工具按钮
    const toolGroup = UI.el('div', 'bw-tool-group');
    const btnNewTab = this._mkBtn('plus', '新标签', () => this.newTab());
    const btnExternal = this._mkBtn('external', '在浏览器中打开', () => this._openExternal());
    const btnShot = this._mkBtn('camera', '截图', () => this._screenshot(), true);
    const btnZoomOut = this._mkBtn('zoom-out', '缩小', () => this._zoom(-this._zoomStep));
    const btnZoomIn = this._mkBtn('zoom-in', '放大', () => this._zoom(this._zoomStep));
    const btnZoomReset = this._mkBtn('zoom-reset', '重置缩放', () => this._zoomReset(), true);
    // 透明度
    const opacityWrap = UI.el('div', 'bw-opacity-wrap');
    opacityWrap.title = '页面透明度';
    const opacityLabel = UI.el('span', 'bw-opacity-label', '透');
    const opacitySlider = UI.el('input', 'bw-opacity-slider');
    opacitySlider.type = 'range';
    opacitySlider.min = '30';
    opacitySlider.max = '100';
    opacitySlider.value = '100';
    opacitySlider.step = '5';
    opacitySlider.addEventListener('input', () => {
      const wv = this._activeWebview();
      if (wv) wv.style.opacity = (parseInt(opacitySlider.value, 10) / 100);
    });
    opacityWrap.append(opacityLabel, opacitySlider);
    toolGroup.append(btnNewTab, btnExternal, btnShot, btnZoomOut, btnZoomIn, btnZoomReset, opacityWrap);

    bar.append(navGroup, addrWrap, toolGroup);
  },

  // 标签栏末尾的"新标签"按钮
  buildNewTabBtn() {
    const btn = UI.el('button', 'bw-newtab-btn');
    btn.type = 'button';
    btn.title = '新建标签';
    btn.appendChild(this._icon('plus', 14));
    btn.addEventListener('click', () => this.newTab());
    this._tabbar.appendChild(btn);
  },

  // ===================== 标签管理 =====================
  newTab(url) {
    url = (url && url.trim()) || this._defaultUrl;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const id = this._nextId++;

    // 创建 webview（先 append 再设 preload/src，确保属性生效）
    const wv = document.createElement('webview');
    wv.className = 'browser-webview';
    wv.style.display = 'none';
    this._views.appendChild(wv);
    wv.setAttribute('preload', webviewPreloadUrl());
    wv.setAttribute('src', url);

    // 创建标签元素（插在"新标签"按钮之前）
    const tab = UI.el('div', 'browser-tab');
    const titleEl = UI.el('span', 'bw-tab-title', '新标签');
    const closeEl = UI.el('button', 'bw-tab-close');
    closeEl.type = 'button';
    closeEl.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeEl.title = '关闭标签';
    tab.append(titleEl, closeEl);
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.bw-tab-close')) return;
      this.switchTab(id);
    });
    closeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeTab(id);
    });
    const newTabBtn = this._tabbar.querySelector('.bw-newtab-btn');
    if (newTabBtn) this._tabbar.insertBefore(tab, newTabBtn);
    else this._tabbar.appendChild(tab);

    const rec = { id, title: '新标签', url, webview: wv, tabEl: tab, titleEl, closeEl };
    this._tabs.push(rec);
    this.bindWebviewEvents(rec);
    this.switchTab(id);
  },

  closeTab(id) {
    const idx = this._tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const rec = this._tabs[idx];
    rec.webview.remove();
    rec.tabEl.remove();
    this._tabs.splice(idx, 1);
    if (this._tabs.length === 0) {
      // 关闭最后一个标签时新建默认标签（像 Chrome）
      this.newTab(this._defaultUrl);
      return;
    }
    if (this._activeId === id) {
      const next = this._tabs[Math.min(idx, this._tabs.length - 1)];
      this.switchTab(next.id);
    }
  },

  switchTab(id) {
    const rec = this._tabs.find((t) => t.id === id);
    if (!rec) return;
    this._activeId = id;
    this._tabs.forEach((t) => {
      const active = t.id === id;
      t.tabEl.classList.toggle('active', active);
      t.webview.style.display = active ? '' : 'none';
    });
    this._updateAddr(rec.url);
    this._updateNavState();
  },

  // ===================== webview 事件 =====================
  bindWebviewEvents(rec) {
    const wv = rec.webview;
    const setTitle = (title) => {
      rec.title = title || '新标签';
      if (rec.titleEl) rec.titleEl.textContent = rec.title;
    };
    const setUrl = (url) => {
      rec.url = url || '';
      if (this._activeId === rec.id) this._updateAddr(url);
    };
    wv.addEventListener('dom-ready', () => {
      setTitle(wv.getTitle());
      setUrl(wv.getURL());
      wv.setZoomFactor(this._zoomFactor);
      if (this._activeId === rec.id) this._updateNavState();
    });
    wv.addEventListener('page-title-updated', (e) => setTitle(e.title));
    wv.addEventListener('did-navigate', (e) => { setUrl(e.url); if (this._activeId === rec.id) this._updateNavState(); });
    wv.addEventListener('did-navigate-in-page', (e) => { setUrl(e.url); if (this._activeId === rec.id) this._updateNavState(); });
    wv.addEventListener('did-stop-loading', () => { setUrl(wv.getURL()); if (this._activeId === rec.id) this._updateNavState(); });
  },

  // ===================== 工具栏交互 =====================
  _activeRec() { return this._tabs.find((t) => t.id === this._activeId); },
  _activeWebview() { const r = this._activeRec(); return r ? r.webview : null; },
  _wvAction(fn) { const w = this._activeWebview(); if (w) fn(w); },

  _wvLoadUrl(input) {
    const w = this._activeWebview();
    if (!w || !input) return;
    const s = input.trim();
    let url;
    if (/^https?:\/\//i.test(s)) {
      // 已带协议头，直接用
      url = s;
    } else if (/^[^\s]+\.[^\s]+$/.test(s)) {
      // 形如 example.com / www.xxx.com（含点无空格）视为域名，补 https://
      url = 'https://' + s;
    } else {
      // 纯关键词（含空格或无点）走 Bing 国际版搜索，符合浏览器地址栏搜索语义
      url = 'https://www.bing.com/search?q=' + encodeURIComponent(s) + '&setmkt=en-US&setlang=en-US&cc=US';
    }
    w.loadURL(url);
  },

  _updateAddr(url) {
    if (this._addrInput && document.activeElement !== this._addrInput) {
      this._addrInput.value = url || '';
    }
  },

  _updateNavState() {
    const w = this._activeWebview();
    if (this._btnBack) this._btnBack.disabled = !w || !w.canGoBack();
    if (this._btnFwd) this._btnFwd.disabled = !w || !w.canGoForward();
  },

  _openExternal() {
    const r = this._activeRec();
    const url = r ? r.url : '';
    if (url && window.workbench && window.workbench.openUrl) {
      window.workbench.openUrl(url);
    } else {
      UI.toast('未获取到当前网址', 'error');
    }
  },

  async _screenshot() {
    const wv = this._activeWebview();
    if (!wv) return;
    try {
      const img = await wv.capturePage();
      const dataUrl = img.toDataURL();
      if (window.workbench && window.workbench.saveScreenshot) {
        const res = await window.workbench.saveScreenshot(dataUrl);
        if (res && res.success) UI.toast('截图已保存：' + res.filename, 'success');
        else UI.toast('截图保存失败：' + (res && res.message), 'error');
      } else {
        UI.toast('当前环境不支持截图保存', 'error');
      }
    } catch (err) {
      UI.toast('截图失败：' + err.message, 'error');
    }
  },

  _zoom(delta) {
    let f = Math.max(this._zoomMin, Math.min(this._zoomMax, this._zoomFactor + delta));
    f = Math.round(f * 100) / 100;
    this._zoomFactor = f;
    this._wvAction((w) => w.setZoomFactor(f));
    UI.toast('缩放 ' + Math.round(f * 100) + '%', 'info');
  },
  _zoomReset() {
    this._zoomFactor = 1;
    this._wvAction((w) => w.setZoomFactor(1));
    UI.toast('缩放已重置', 'info');
  },

  // ===================== 图标 =====================
  _mkBtn(iconName, title, onClick) {
    const btn = UI.el('button', 'bw-btn');
    btn.title = title;
    btn.type = 'button';
    btn.appendChild(this._icon(iconName, 16));
    btn.addEventListener('click', onClick);
    return btn;
  },

  _icon(name, size) {
    const fallback = {
      reload: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
      camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
      'zoom-in': '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>',
      'zoom-out': '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>',
      'zoom-reset': '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>'
    };
    if (typeof ICONS !== 'undefined' && ICONS[name]) return UI.icon(name, size);
    const span = document.createElement('span');
    span.className = 'icon';
    span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${fallback[name] || ''}</svg>`;
    return span;
  }
};

window.Browser = Browser;
