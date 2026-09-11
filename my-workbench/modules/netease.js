// =====================================================================
// modules/netease.js —— 网易云音乐控制面板模块
// 职责：
//   1. 进入页面时自动拉起本地 NeteaseCloudMusicApi 服务（主进程 fork 子进程）
//   2. 扫码登录：获取二维码 → 轮询扫码状态 → 登录成功取 Cookie（持久化到 data/）
//   3. 页面结构：顶部菜单栏（标题 + 「我喜欢的音乐」数量角标 + 迷你头像/昵称）
//                + 内容区（我喜欢列表）；未登录态显示居中扫码卡片
//   4. 全局底部播放条：登录后常驻应用底部（任意页面可见），含歌名/进度/控制
//   5. 通过主进程 IPC 代理访问 localhost:3000，规避同源策略，无需关闭 webSecurity
// =====================================================================

window.Netease = {
  // 顶层阶段：starting-api | login | api-failed
  _phase: 'starting-api',
  _apiFailReason: '',
  // 登录状态机：logged-out | logging | logged-in
  _state: 'logged-out',
  _qrImg: '',
  _qrKey: '',
  _qrTimer: null,
  _cookie: '',
  _user: null,
  _likedListCount: 0,
  _error: '',
  _autoStarted: false,
  _failCount: 0,           // _silentRefresh 连续确认失效的次数（达到阈值才清退，抗单次抖动）

  // ===== 登录标签页 =====
  _loginTab: 'qr',         // 'qr' | 'password' | 'captcha'
  _phoneInput: '',
  _passwordInput: '',
  _countryCode: '86',
  _captchaSent: false,
  _captchaInput: '',
  _captchaSending: false,
  _loginErrorMsg: '',

  // ===== 每日签到 =====
  _signinStatus: null,     // null | 'pending' | 'success' | 'already' | 'failed'
  _signinMsg: '',

  // ===== 打卡听歌 =====
  _dakaStatus: null,       // null | 'pending' | 'running' | 'success' | 'failed'
  _dakaProgress: 0,        // 已刷数量
  _dakaTarget: 300,        // 目标数量（用户自定义）
  _dakaLastDate: '',       // 上次打卡日期（YYYY-MM-DD），同一天不重复打卡
  _dakaMsg: '',

  // ===== 用户等级 =====
  _userLevel: null,        // { level, listenSongs, ... }

  // ===== 刷单曲播放次数 =====
  _listenSongId: '',
  _listenCount: 1,
  _listenStatus: null,     // null | 'pending' | 'running' | 'success' | 'failed'
  _listenProgress: 0,
  _listenMsg: '',

  // ===== 播放器状态 =====
  _playlist: [],        // 喜欢的歌曲列表 [{id, name, artist}]
  _currentIndex: -1,    // 当前播放索引
  _audio: null,         // HTMLAudioElement（独立挂载，不随 render 重建）
  _barEl: null,         // 全局底部播放条（常驻 DOM）
  _isPlaying: false,
  _currentTime: 0,
  _duration: 0,
  _loadingTrack: false, // 正在加载歌曲 URL
  _loopMode: 'list',    // 循环模式：off 关闭 | list 列表循环 | one 单曲循环
  _shuffle: false,      // 随机播放
  _playlistLoading: false,   // 列表加载中
  _playlistLoadError: false, // 列表加载失败（含超时）
  // ===== 分页 / 增量加载 =====
  _pageSize: 30,             // 每页拉取条数（首屏只渲染 30 行，滚动到底再加载）
  _playlistTotal: 0,         // 喜欢歌单总歌曲数（用于判断是否还有更多）
  _likedPlaylistId: null,    // 喜欢歌单 id（_silentRefresh 拿到后供 _loadPlaylist 复用，省一次请求）
  _loadingMore: false,       // 正在加载下一页

  // ===== 歌词状态 =====
  _lyrics: [],          // [{time: 秒数, text: 歌词}]
  _lyricEl: null,       // 歌词面板 DOM
  _lyricVisible: false, // 歌词面板是否可见
  _lyricCurrentIndex: -1, // 当前高亮歌词行索引
  _keyBound: false,       // 键盘监听是否已绑定

  // -------------------------------------------------------------------
  init() {
    // 仅在音乐页面激活时才响应 Store 变化重渲染，避免其他页面改 Store 触发无谓的 100 行 DOM 重建
    Store.onChange(() => {
      const page = document.getElementById('page-netease');
      if (page && page.classList.contains('active')) this.render();
    });
    // 空格键播放/暂停（只在音乐页面生效，排除输入框）
    if (!this._keyBound) {
      this._keyBound = true;
      document.addEventListener('keydown', (e) => {
        if (e.code !== 'Space') return;
        const activePage = document.querySelector('.page.active');
        if (!activePage || activePage.id !== 'page-netease') return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        this._togglePlay();
      });
    }
  },

  // -------------------------------------------------------------------
  // 页面渲染：顶部菜单栏 + 内容区（列表 / 扫码卡片）
  render() {
    const page = document.getElementById('page-netease');
    page.innerHTML = '';

    const section = UI.el('div', 'section');
    section.appendChild(this._renderTopbar());
    section.appendChild(this._renderView());
    page.appendChild(section);

    if (!this._autoStarted) {
      this._autoStarted = true;
      this._ensureApi();
    }

    // 同步全局底部播放条（登录后常驻，任意页面可见）
    this._syncGlobalBar();
  },

  // ===================== 顶部菜单栏（模仿网易云） =====================
  _renderTopbar() {
    const bar = UI.el('div', 'netease-topbar');
    const left = UI.el('div', 'netease-topbar-left');
    // 左侧：头像 + 用户名（带悬浮弹窗）
    if (this._state === 'logged-in') {
      const u = this._user || {};
      const profile = u.profile || u.account || u;
      const userWrap = UI.el('div', 'netease-user-wrap');
      const avWrap = UI.el('div', 'netease-mini-avatar-wrap');
      if (profile.avatarUrl) {
        const img = UI.el('img', 'netease-mini-avatar');
        // http 升级 https：规避 file:// 页面加载 http 资源不可靠的问题
        img.src = String(profile.avatarUrl).replace(/^http:\/\//i, 'https://');
        avWrap.appendChild(img);
      } else {
        avWrap.appendChild(UI.icon('music', 14));
      }
      userWrap.appendChild(avWrap);
      userWrap.appendChild(UI.el('span', 'netease-mini-name', profile.nickname || '已登录用户'));
      // 等级徽章
      if (this._userLevel && this._userLevel.level) {
        userWrap.appendChild(UI.el('span', 'netease-level-badge', 'Lv.' + this._userLevel.level));
      }
      // 悬浮弹窗：退出登录按钮，悬停 2 秒后自动关闭
      const popup = UI.el('div', 'netease-user-popup');
      const logoutBtn = UI.el('button', 'btn btn-sm netease-btn-danger netease-btn-text', '退出登录');
      logoutBtn.addEventListener('click', () => this._logout());
      popup.appendChild(logoutBtn);
      userWrap.appendChild(popup);
      let popupTimer = null;
      userWrap.addEventListener('mouseenter', () => {
        popup.classList.add('show');
        clearTimeout(popupTimer);
        popupTimer = setTimeout(() => popup.classList.remove('show'), 2000);
      });
      userWrap.addEventListener('mouseleave', () => {
        clearTimeout(popupTimer);
        popup.classList.remove('show');
      });
      left.appendChild(userWrap);
    } else {
      left.appendChild(UI.el('span', 'netease-mini-name', '未登录'));
    }
    bar.appendChild(left);
    // 右侧：签到 + 打卡按钮 + 我喜欢的音乐 + 数量角标
    const right = UI.el('div', 'netease-topbar-right');
    // 签到按钮
    const signinBtn = UI.el('button', 'btn btn-sm netease-btn netease-topbar-action');
    if (this._signinStatus === 'success' || this._signinStatus === 'already') {
      signinBtn.textContent = '已签到';
      signinBtn.disabled = true;
      signinBtn.classList.add('netease-btn-done');
    } else if (this._signinStatus === 'pending') {
      signinBtn.textContent = '签到中…';
      signinBtn.disabled = true;
    } else {
      signinBtn.textContent = '签到';
      signinBtn.addEventListener('click', () => this._dailySignin());
    }
    right.appendChild(signinBtn);
    // 打卡按钮
    const dakaBtn = UI.el('button', 'btn btn-sm netease-btn netease-topbar-action');
    if (this._dakaStatus === 'running') {
      dakaBtn.textContent = '打卡中 ' + this._dakaProgress + '/' + this._dakaTarget;
      dakaBtn.disabled = true;
    } else if (this._dakaStatus === 'success') {
      dakaBtn.textContent = '已打卡';
      dakaBtn.disabled = true;
      dakaBtn.classList.add('netease-btn-done');
    } else {
      dakaBtn.textContent = '打卡听歌';
      dakaBtn.addEventListener('click', () => this._daka());
    }
    right.appendChild(dakaBtn);
    const menu = UI.el('div', 'netease-topbar-menu active');
    menu.appendChild(UI.el('span', 'netease-topbar-menu-name', '我喜欢的音乐'));
    menu.appendChild(UI.el('span', 'netease-like-badge', String(this._likedListCount || 0)));
    right.appendChild(menu);
    bar.appendChild(right);
    return bar;
  },

  // 根据阶段/状态渲染内容区
  _renderView() {
    if (this._phase === 'starting-api') return this._renderApiStarting();
    if (this._phase === 'api-failed') return this._renderApiFailed();
    if (this._error && this._state === 'logged-out' && !this._qrImg) return this._renderError();
    if (this._state === 'logged-in') return this._renderList();
    if (this._state === 'logging') return this._renderLogging();
    return this._renderQr();
  },

  // ===================== API 启动中 =====================
  _renderApiStarting() {
    const box = UI.el('div', 'netease-qr-box');
    const card = UI.el('div', 'netease-card');
    card.appendChild(UI.el('div', 'netease-spinner'));
    card.appendChild(UI.el('div', 'netease-tip', '正在启动本地 API 服务…'));
    box.appendChild(card);
    return box;
  },

  // ===================== API 启动失败 =====================
  _renderApiFailed() {
    const box = UI.el('div', 'netease-qr-box');
    const card = UI.el('div', 'netease-card');
    card.appendChild(UI.el('div', 'netease-error-title', 'API 服务启动失败'));
    card.appendChild(UI.el('div', 'netease-tip', this._apiFailReason || '未知错误'));
    card.appendChild(UI.el('div', 'netease-tip', '请在项目目录 my-workbench 下执行：npm install NeteaseCloudMusicApi'));
    const actions = UI.el('div', 'netease-actions');
    const retryBtn = UI.el('button', 'btn btn-sm netease-btn', '重试');
    retryBtn.addEventListener('click', () => this._ensureApi());
    actions.appendChild(retryBtn);
    card.appendChild(actions);
    box.appendChild(card);
    return box;
  },

  // ===================== 未登录态（扫码/密码/验证码三标签页） =====================
  _renderQr() {
    const box = UI.el('div', 'netease-qr-box');
    const card = UI.el('div', 'netease-card netease-login-card');

    // 标签页切换栏
    const tabs = UI.el('div', 'netease-login-tabs');
    const tabQr = UI.el('button', 'netease-login-tab' + (this._loginTab === 'qr' ? ' active' : ''), '扫码登录');
    tabQr.addEventListener('click', () => { this._loginTab = 'qr'; this._loginErrorMsg = ''; this.render(); });
    const tabPwd = UI.el('button', 'netease-login-tab' + (this._loginTab === 'password' ? ' active' : ''), '密码登录');
    tabPwd.addEventListener('click', () => { this._loginTab = 'password'; this._loginErrorMsg = ''; this.render(); });
    const tabCaptcha = UI.el('button', 'netease-login-tab' + (this._loginTab === 'captcha' ? ' active' : ''), '验证码登录');
    tabCaptcha.addEventListener('click', () => { this._loginTab = 'captcha'; this._loginErrorMsg = ''; this.render(); });
    tabs.appendChild(tabQr);
    tabs.appendChild(tabPwd);
    tabs.appendChild(tabCaptcha);
    card.appendChild(tabs);

    // 错误提示
    if (this._loginErrorMsg) {
      card.appendChild(UI.el('div', 'netease-login-error', this._loginErrorMsg));
    }

    // 根据当前标签页渲染对应内容
    if (this._loginTab === 'qr') {
      card.appendChild(this._renderQrTab());
    } else if (this._loginTab === 'password') {
      card.appendChild(this._renderPasswordTab());
    } else if (this._loginTab === 'captcha') {
      card.appendChild(this._renderCaptchaTab());
    }

    box.appendChild(card);
    return box;
  },

  // 扫码登录标签页内容
  _renderQrTab() {
    const frag = UI.el('div', 'netease-qr-tab');
    const qrWrap = UI.el('div', 'netease-qr-wrap');
    if (this._qrImg) {
      const img = UI.el('img', 'netease-qr-img');
      img.src = this._qrImg.startsWith('data:') ? this._qrImg : 'data:image/png;base64,' + this._qrImg;
      qrWrap.appendChild(img);
    } else {
      const placeholder = UI.el('div', 'netease-qr-placeholder');
      placeholder.appendChild(UI.icon('loading', 36));
      qrWrap.appendChild(placeholder);
    }
    frag.appendChild(qrWrap);
    frag.appendChild(UI.el('div', 'netease-tip', '请使用网易云音乐 APP 扫码登录'));
    const actions = UI.el('div', 'netease-actions');
    const refreshBtn = UI.el('button', 'btn btn-sm netease-btn', '刷新二维码');
    refreshBtn.addEventListener('click', () => this._startLogin());
    actions.appendChild(refreshBtn);
    frag.appendChild(actions);
    return frag;
  },

  // 密码登录标签页内容
  _renderPasswordTab() {
    const frag = UI.el('div', 'netease-pwd-tab');
    // 手机号输入
    const phoneRow = UI.el('div', 'netease-form-row');
    phoneRow.appendChild(UI.el('label', 'netease-form-label', '手机号 / 邮箱'));
    const phoneInput = UI.el('input', 'netease-form-input');
    phoneInput.type = 'text';
    phoneInput.placeholder = '请输入手机号或邮箱';
    phoneInput.value = this._phoneInput;
    phoneInput.addEventListener('input', (e) => { this._phoneInput = e.target.value; });
    phoneRow.appendChild(phoneInput);
    frag.appendChild(phoneRow);
    // 密码输入
    const pwdRow = UI.el('div', 'netease-form-row');
    pwdRow.appendChild(UI.el('label', 'netease-form-label', '密码'));
    const pwdInput = UI.el('input', 'netease-form-input');
    pwdInput.type = 'password';
    pwdInput.placeholder = '请输入密码';
    pwdInput.value = this._passwordInput;
    pwdInput.addEventListener('input', (e) => { this._passwordInput = e.target.value; });
    pwdRow.appendChild(pwdInput);
    frag.appendChild(pwdRow);
    // 登录按钮
    const actions = UI.el('div', 'netease-actions');
    const loginBtn = UI.el('button', 'btn btn-sm netease-btn', '登录');
    loginBtn.addEventListener('click', () => this._loginByPassword());
    actions.appendChild(loginBtn);
    frag.appendChild(actions);
    return frag;
  },

  // 验证码登录标签页内容
  _renderCaptchaTab() {
    const frag = UI.el('div', 'netease-captcha-tab');
    // 手机号输入
    const phoneRow = UI.el('div', 'netease-form-row');
    phoneRow.appendChild(UI.el('label', 'netease-form-label', '手机号'));
    const phoneInput = UI.el('input', 'netease-form-input');
    phoneInput.type = 'text';
    phoneInput.placeholder = '请输入手机号';
    phoneInput.value = this._phoneInput;
    phoneInput.addEventListener('input', (e) => { this._phoneInput = e.target.value; });
    phoneRow.appendChild(phoneInput);
    frag.appendChild(phoneRow);
    // 验证码输入 + 发送按钮
    const captchaRow = UI.el('div', 'netease-form-row netease-captcha-row');
    captchaRow.appendChild(UI.el('label', 'netease-form-label', '验证码'));
    const captchaInput = UI.el('input', 'netease-form-input netease-captcha-input');
    captchaInput.type = 'text';
    captchaInput.placeholder = '请输入验证码';
    captchaInput.value = this._captchaInput;
    captchaInput.addEventListener('input', (e) => { this._captchaInput = e.target.value; });
    captchaRow.appendChild(captchaInput);
    const sendBtn = UI.el('button', 'btn btn-sm netease-btn netease-captcha-send');
    sendBtn.textContent = this._captchaSending ? '发送中…' : (this._captchaSent ? '已发送' : '发送验证码');
    sendBtn.disabled = this._captchaSending || this._captchaSent;
    sendBtn.addEventListener('click', () => this._sendCaptcha());
    captchaRow.appendChild(sendBtn);
    frag.appendChild(captchaRow);
    // 登录按钮
    const actions = UI.el('div', 'netease-actions');
    const loginBtn = UI.el('button', 'btn btn-sm netease-btn', '登录');
    loginBtn.addEventListener('click', () => this._loginByCaptcha());
    actions.appendChild(loginBtn);
    frag.appendChild(actions);
    return frag;
  },

  // ===================== 登录中态 =====================
  _renderLogging() {
    const box = UI.el('div', 'netease-qr-box');
    const card = UI.el('div', 'netease-card netease-login-card');
    card.appendChild(UI.el('div', 'netease-spinner'));
    card.appendChild(UI.el('div', 'netease-tip', '扫码成功，请在手机确认'));
    box.appendChild(card);
    return box;
  },

  // ===================== 已登录内容区：我喜欢列表 =====================
  _renderList() {
    const wrap = UI.el('div', 'netease-list-wrap');
    if (this._playlist.length === 0) {
      const card = UI.el('div', 'netease-card netease-list-empty');
      if (this._playlistLoadError) {
        // 加载失败：提示 + 重新加载按钮
        card.appendChild(UI.el('div', 'netease-card-title', '加载失败'));
        card.appendChild(UI.el('div', 'netease-tip', '请检查网络连接后点击下方按钮重新加载'));
        const row = UI.el('div', 'netease-actions');
        const retryBtn = UI.el('button', 'btn btn-sm netease-btn', '重新加载');
        retryBtn.addEventListener('click', () => this._loadPlaylist());
        row.appendChild(retryBtn);
        card.appendChild(row);
      } else {
        // 加载中（含初始态）：spinner + 提示
        card.appendChild(UI.el('div', 'netease-spinner'));
        card.appendChild(UI.el('div', 'netease-tip', '正在加载我喜欢列表…'));
      }
      wrap.appendChild(card);
      return wrap;
    }
    const list = UI.el('div', 'netease-track-list netease-track-list-page');
    // 表头
    const header = UI.el('div', 'netease-track-header');
    header.appendChild(UI.el('span', 'netease-th-idx', '#'));
    header.appendChild(UI.el('span', 'netease-th-title', '标题'));
    header.appendChild(UI.el('span', 'netease-th-album', '专辑'));
    header.appendChild(UI.el('span', 'netease-th-time', '时长'));
    list.appendChild(header);
    // 歌曲行（增量追加时复用 _createTrackRow，避免重复逻辑）
    this._playlist.forEach((t, i) => list.appendChild(this._createTrackRow(t, i)));
    // 滚动加载更多：哨兵元素 + 状态行 + IntersectionObserver
    const sentinel = UI.el('div', 'netease-load-more-sentinel');
    list.appendChild(sentinel);
    this._loadMoreSentinel = sentinel;
    this._loadMoreStatus = UI.el('div', 'netease-load-more-status');
    this._updateLoadMoreStatus();
    list.appendChild(this._loadMoreStatus);
    if (this._loadMoreIO) this._loadMoreIO.disconnect();
    // root: null 表示以浏览器视口为参照（列表本身 max-height:none 不滚动，滚动发生在外层 page）
    this._loadMoreIO = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) this._loadMorePlaylist();
    }, { root: null, rootMargin: '400px' });
    this._loadMoreIO.observe(sentinel);
    wrap.appendChild(list);

    // 工具卡片区域：打卡听歌设置 + 刷播放量
    wrap.appendChild(this._renderToolsCard());

    return wrap;
  },

  // ===================== 工具卡片：打卡设置 + 刷播放量 =====================
  _renderToolsCard() {
    const section = UI.el('div', 'netease-tools-section');

    // 打卡听歌设置卡片
    const dakaCard = UI.el('div', 'netease-card netease-tool-card');
    dakaCard.appendChild(UI.el('div', 'netease-card-title', '打卡听歌'));
    dakaCard.appendChild(UI.el('div', 'netease-tip', '模拟播放歌曲刷每日听歌量，每天上限300首'));
    // 目标数量输入
    const dakaRow = UI.el('div', 'netease-form-row netease-tool-row');
    dakaRow.appendChild(UI.el('label', 'netease-form-label', '目标数量'));
    const dakaInput = UI.el('input', 'netease-form-input netease-tool-input');
    dakaInput.type = 'number';
    dakaInput.min = '1';
    dakaInput.max = '300';
    dakaInput.value = String(this._dakaTarget);
    dakaInput.addEventListener('input', (e) => { this._dakaTarget = Math.min(300, Math.max(1, parseInt(e.target.value) || 300)); });
    dakaRow.appendChild(dakaInput);
    dakaCard.appendChild(dakaRow);
    // 打卡进度/状态
    if (this._dakaStatus === 'running') {
      const progress = UI.el('div', 'netease-progress-wrap');
      const bar = UI.el('div', 'netease-progress-bar');
      const fill = UI.el('div', 'netease-progress-fill');
      fill.style.width = (this._dakaProgress / this._dakaTarget * 100) + '%';
      bar.appendChild(fill);
      progress.appendChild(bar);
      progress.appendChild(UI.el('div', 'netease-progress-text', this._dakaProgress + ' / ' + this._dakaTarget));
      dakaCard.appendChild(progress);
    } else if (this._dakaStatus === 'success') {
      dakaCard.appendChild(UI.el('div', 'netease-tool-status success', this._dakaMsg || '打卡完成'));
    } else if (this._dakaStatus === 'failed') {
      dakaCard.appendChild(UI.el('div', 'netease-tool-status failed', this._dakaMsg || '打卡失败'));
    }
    // 打卡按钮
    const dakaActions = UI.el('div', 'netease-actions');
    const dakaBtn = UI.el('button', 'btn btn-sm netease-btn');
    dakaBtn.textContent = this._dakaStatus === 'running' ? '打卡中…' : '开始打卡';
    dakaBtn.disabled = this._dakaStatus === 'running';
    dakaBtn.addEventListener('click', () => this._daka());
    dakaActions.appendChild(dakaBtn);
    dakaCard.appendChild(dakaActions);
    section.appendChild(dakaCard);

    // 刷单曲播放次数卡片
    const listenCard = UI.el('div', 'netease-card netease-tool-card');
    listenCard.appendChild(UI.el('div', 'netease-card-title', '刷单曲播放次数'));
    listenCard.appendChild(UI.el('div', 'netease-tip', '输入歌曲ID和次数，模拟播放刷量'));
    // 歌曲ID输入
    const songIdRow = UI.el('div', 'netease-form-row netease-tool-row');
    songIdRow.appendChild(UI.el('label', 'netease-form-label', '歌曲ID'));
    const songIdInput = UI.el('input', 'netease-form-input netease-tool-input');
    songIdInput.type = 'text';
    songIdInput.placeholder = '请输入歌曲ID';
    songIdInput.value = this._listenSongId;
    songIdInput.addEventListener('input', (e) => { this._listenSongId = e.target.value; });
    songIdRow.appendChild(songIdInput);
    listenCard.appendChild(songIdRow);
    // 播放次数输入
    const countRow = UI.el('div', 'netease-form-row netease-tool-row');
    countRow.appendChild(UI.el('label', 'netease-form-label', '播放次数'));
    const countInput = UI.el('input', 'netease-form-input netease-tool-input');
    countInput.type = 'number';
    countInput.min = '1';
    countInput.max = '1000';
    countInput.value = String(this._listenCount);
    countInput.addEventListener('input', (e) => { this._listenCount = Math.min(1000, Math.max(1, parseInt(e.target.value) || 1)); });
    countRow.appendChild(countInput);
    listenCard.appendChild(countRow);
    // 刷播放进度/状态
    if (this._listenStatus === 'running') {
      const progress = UI.el('div', 'netease-progress-wrap');
      const bar = UI.el('div', 'netease-progress-bar');
      const fill = UI.el('div', 'netease-progress-fill');
      fill.style.width = (this._listenProgress / this._listenCount * 100) + '%';
      bar.appendChild(fill);
      progress.appendChild(bar);
      progress.appendChild(UI.el('div', 'netease-progress-text', this._listenProgress + ' / ' + this._listenCount));
      listenCard.appendChild(progress);
    } else if (this._listenStatus === 'success') {
      listenCard.appendChild(UI.el('div', 'netease-tool-status success', this._listenMsg || '刷播放完成'));
    } else if (this._listenStatus === 'failed') {
      listenCard.appendChild(UI.el('div', 'netease-tool-status failed', this._listenMsg || '刷播放失败'));
    }
    // 刷播放按钮
    const listenActions = UI.el('div', 'netease-actions');
    const listenBtn = UI.el('button', 'btn btn-sm netease-btn');
    listenBtn.textContent = this._listenStatus === 'running' ? '刷播放中…' : '开始刷播放';
    listenBtn.disabled = this._listenStatus === 'running';
    listenBtn.addEventListener('click', () => this._listenSong());
    listenActions.appendChild(listenBtn);
    listenCard.appendChild(listenActions);
    section.appendChild(listenCard);

    return section;
  },

  // 创建单首歌曲行（首屏渲染与滚动加载更多复用）
  _createTrackRow(t, i) {
    const isActive = i === this._currentIndex;
    const item = UI.el('div', 'netease-track' + (isActive ? ' active' : ''));
    const idxCell = UI.el('span', 'netease-track-idx', String(i + 1));
    const idxPlay = UI.el('span', 'netease-track-idx-play');
    idxPlay.innerHTML = isActive && this._isPlaying ? window.svgIcon('pause-track', 14) : window.svgIcon('play-track', 14);
    idxCell.appendChild(idxPlay);
    item.appendChild(idxCell);
    const titleCell = UI.el('div', 'netease-track-title-cell');
    titleCell.appendChild(UI.el('span', 'netease-track-name', t.name));
    if (t.artist) titleCell.appendChild(UI.el('span', 'netease-track-artist', t.artist));
    item.appendChild(titleCell);
    item.appendChild(UI.el('span', 'netease-track-album', t.album || ''));
    item.appendChild(UI.el('span', 'netease-track-time', this._formatTime(t.duration / 1000)));
    item.addEventListener('click', () => this._playIndex(i));
    return item;
  },

  // 更新底部「已加载 X / Y 首」状态行
  _updateLoadMoreStatus() {
    if (!this._loadMoreStatus) return;
    const total = this._playlistTotal || this._playlist.length;
    if (this._loadingMore) {
      this._loadMoreStatus.textContent = '加载更多中…';
    } else if (total > this._playlist.length) {
      this._loadMoreStatus.textContent = '已加载 ' + this._playlist.length + ' / ' + total + ' 首（滚动到底自动加载）';
    } else if (total > 0) {
      this._loadMoreStatus.textContent = '共 ' + total + ' 首';
    } else {
      this._loadMoreStatus.textContent = '';
    }
  },

  // 切歌时仅更新列表高亮，不重建整棵 DOM 树（100 行 → 2 行 class 切换）
  _updateTrackHighlight() {
    const list = document.querySelector('.netease-track-list-page');
    if (!list) return;
    const rows = list.querySelectorAll('.netease-track');
    rows.forEach((row, i) => {
      const active = i === this._currentIndex;
      row.classList.toggle('active', active);
      const idxPlay = row.querySelector('.netease-track-idx-play');
      if (idxPlay) {
        idxPlay.innerHTML = active && this._isPlaying ? window.svgIcon('pause-track', 14) : window.svgIcon('play-track', 14);
      }
    });
  },

  // ===================== 错误视图 =====================
  _renderError() {
    const box = UI.el('div', 'netease-qr-box');
    const card = UI.el('div', 'netease-card');
    card.appendChild(UI.el('div', 'netease-error-title', '无法连接 API 服务'));
    card.appendChild(UI.el('div', 'netease-tip', this._error));
    const actions = UI.el('div', 'netease-actions');
    const retryBtn = UI.el('button', 'btn btn-sm netease-btn', '重试');
    retryBtn.addEventListener('click', () => { this._error = ''; this._ensureApi(); });
    actions.appendChild(retryBtn);
    card.appendChild(actions);
    box.appendChild(card);
    return box;
  },

  // -------------------------------------------------------------------
  // 确保本地 API 服务已启动，再进入登录流程
  async _ensureApi() {
    this._phase = 'starting-api';
    this._error = '';
    this._apiFailReason = '';
    this.render();
    try {
      const res = await window.workbench.neteaseStartApi();
      if (res && res.running) {
        this._phase = 'login';
        // 优先尝试用本地持久化的 cookie 免扫码；无效再走扫码
        const restored = await this._tryRestoreCookie();
        if (!restored) this._startLogin();
      } else {
        this._phase = 'api-failed';
        this._apiFailReason = (res && res.reason) || '未知原因';
        this.render();
      }
    } catch (err) {
      this._phase = 'api-failed';
      this._apiFailReason = err.message || '未知错误';
      this.render();
    }
  },

  // -------------------------------------------------------------------
  // 尝试用本地持久化的 cookie 免扫码登录
  async _tryRestoreCookie() {
    try {
      const saved = await window.workbench.readData('netease-cookie.json');
      if (!saved || !saved.cookie) return false;
      this._cookie = saved.cookie;
      // 优先恢复本地持久化的用户数据（秒开，无需等 API）
      const local = await this._loadLocalData();
      if (local && local.user) {
        this._user = local.user;
        this._likedListCount = local.likedListCount || 0;
        if (Array.isArray(local.playlist)) this._playlist = local.playlist;
        if (local.userLevel) this._userLevel = local.userLevel;
        if (local.dakaLastDate) this._dakaLastDate = local.dakaLastDate;
        this._state = 'logged-in';
        this.render();
        // 后台静默验证 cookie 是否仍有效，有效则刷新用户信息；无效则清退
        this._silentRefresh();
        // 恢复登录态后加载等级（非阻塞）
        this._loadUserLevel();
        // 每天首次恢复登录态后自动打卡
        this._autoDaka();
        return true;
      }
      // 无本地数据，走在线验证
      const statusRes = await this._api('/login/status', { timestamp: Date.now() });
      const data = statusRes.data || statusRes;
      if (data && (data.account || (data.profile && data.profile.userId))) {
        await this._loadUserInfo();
        return true;
      }
      // 仅当网易云明确返回未登录（code 301）才清退；其他异常保留 cookie 等下次启动重试
      if (data && (data.code === 301 || (data.data && data.data.code === 301))) {
        this._cookie = '';
        await this._saveCookie(null);
      }
    } catch (e) {
      this._cookie = '';
    }
    return false;
  },

  // 后台静默刷新：验证 cookie 有效性并更新用户信息/喜欢数量（不阻塞 UI）
  async _silentRefresh() {
    try {
      const statusRes = await this._api('/login/status', { timestamp: Date.now() });
      const data = statusRes.data || statusRes;
      // 仅当网易云明确返回未登录（code 301）才判定失效；其他异常（网络波动、空响应等）保留本地数据等下次再验证
      const explicitlyLoggedOut = data && (data.code === 301 || (data.data && data.data.code === 301));
      const hasUser = data && (data.account || (data.profile && data.profile.userId));
      if (explicitlyLoggedOut && !hasUser) {
        // 连续 2 次确认失效才清退，抗单次抖动
        this._failCount = (this._failCount || 0) + 1;
        if (this._failCount < 2) return;
        this._failCount = 0;
        // cookie 已失效：清退
        this._cookie = '';
        await this._saveCookie(null);
        await this._clearLocalData();
        this._user = null;
        this._playlist = [];
        this._likedListCount = 0;
        this._state = 'logged-out';
        this._phase = 'login';
        this.render();
        this._startLogin();
        return;
      }
      // 有效或不确定：重置失败计数
      this._failCount = 0;
      // cookie 有效：刷新用户信息 + 喜欢数量
      this._user = (data.account || data.profile) ? data : (data.data || data);
      const userId = (this._user && this._user.account && this._user.account.id)
        || (this._user && this._user.profile && this._user.profile.userId);
      if (userId) {
        // 并行发起 likelist 与 user/playlist（无依赖关系）；后者结果缓存供 _loadPlaylist 复用，省一次请求
        const ts = Date.now();
        const likeP = this._api('/likelist', { uid: userId, timestamp: ts }).catch(() => null);
        const plP = this._api('/user/playlist', { uid: userId, limit: 1, timestamp: ts }).catch(() => null);
        const [likeRes, plRes] = await Promise.all([likeP, plP]);
        // 喜欢数量：优先 likelist.ids.length，fallback 到 user/playlist[0].trackCount
        let count = 0;
        if (likeRes) {
          const ids = likeRes.ids || (likeRes.data && likeRes.data.ids) || [];
          count = Array.isArray(ids) ? ids.length : 0;
        }
        if (plRes) {
          const playlist = plRes.playlist || (plRes.data && plRes.data.playlist) || [];
          if (Array.isArray(playlist) && playlist.length > 0) {
            if (count === 0) count = playlist[0].trackCount || 0;
            this._likedPlaylistId = playlist[0].id;
          }
        }
        this._likedListCount = count;
        this._saveLocalData();
        this.render();
        // 后台刷新播放列表
        this._loadPlaylist();
      }
    } catch (e) { /* 静默失败，保留本地数据 */ }
  },

  // 持久化 cookie 到 data/netease-cookie.json（传 null 清空）
  _saveCookie(cookie) {
    const data = cookie ? { cookie: cookie, savedAt: Date.now() } : { cookie: '' };
    return window.workbench.writeData('netease-cookie.json', data);
  },

  // 持久化用户数据到 data/netease-data.json（用户信息 + 播放列表 + 喜欢数量）
  _saveLocalData() {
    return window.workbench.writeData('netease-data.json', {
      user: this._user,
      playlist: this._playlist,
      likedListCount: this._likedListCount,
      userLevel: this._userLevel,
      dakaLastDate: this._dakaLastDate,
      savedAt: Date.now()
    });
  },

  // 读取本地持久化的用户数据
  _loadLocalData() {
    return window.workbench.readData('netease-data.json');
  },

  // 清空本地持久化的用户数据
  _clearLocalData() {
    return window.workbench.writeData('netease-data.json', {});
  },

  // -------------------------------------------------------------------
  // API 封装：经主进程 IPC 代理请求 localhost:3000
  async _api(apiPath, query, cookie) {
    const res = await window.workbench.neteaseFetch({ apiPath, query, cookie: cookie || this._cookie });
    if (!res.success) {
      throw new Error('无法连接 localhost:3000（' + (res.message || '连接失败') + '）');
    }
    let json;
    try {
      json = JSON.parse(res.body);
    } catch (e) {
      throw new Error('API 返回非 JSON：' + String(res.body).slice(0, 120));
    }
    if (res.setCookie && res.setCookie.length) {
      // 覆盖式合并：同键覆盖、异键保留，避免无限累加导致 cookie 串污染
      const mergeCookie = (oldStr, setCookieArr) => {
        const map = new Map();
        (oldStr || '').split(';').forEach((p) => {
          const kv = p.trim();
          if (kv) { const i = kv.indexOf('='); if (i > 0) map.set(kv.slice(0, i), kv.slice(i + 1)); }
        });
        setCookieArr.forEach((c) => {
          const kv = c.split(';')[0].trim();
          if (kv) { const i = kv.indexOf('='); if (i > 0) map.set(kv.slice(0, i), kv.slice(i + 1)); }
        });
        return Array.from(map, ([k, v]) => k + '=' + v).join('; ');
      };
      this._cookie = mergeCookie(this._cookie, res.setCookie);
    }
    return json;
  },

  // -------------------------------------------------------------------
  // 密码登录（手机号或邮箱）
  async _loginByPassword() {
    if (!this._phoneInput || !this._passwordInput) {
      this._loginErrorMsg = '请输入手机号/邮箱和密码';
      this.render();
      return;
    }
    this._loginErrorMsg = '';
    this._state = 'logging';
    this.render();
    try {
      const isEmail = this._phoneInput.includes('@');
      let res;
      if (isEmail) {
        res = await this._api('/login', { email: this._phoneInput, password: this._passwordInput, timestamp: Date.now() });
      } else {
        res = await this._api('/login/cellphone', { phone: this._phoneInput, password: this._passwordInput, countrycode: this._countryCode, timestamp: Date.now() });
      }
      const code = res.code;
      if (code === 200) {
        await this._loadUserInfo();
      } else {
        this._state = 'logged-out';
        this._loginErrorMsg = res.msg || res.message || '登录失败（code: ' + code + '）';
        this.render();
      }
    } catch (err) {
      this._state = 'logged-out';
      this._loginErrorMsg = err.message || '登录请求失败';
      this.render();
    }
  },

  // -------------------------------------------------------------------
  // 发送验证码
  async _sendCaptcha() {
    if (!this._phoneInput) {
      this._loginErrorMsg = '请先输入手机号';
      this.render();
      return;
    }
    this._captchaSending = true;
    this.render();
    try {
      const res = await this._api('/captcha/sent', { phone: this._phoneInput, ctcode: this._countryCode, timestamp: Date.now() });
      if (res.code === 200) {
        this._captchaSent = true;
        UI.setToast('验证码已发送', 'success');
      } else {
        this._loginErrorMsg = res.msg || res.message || '验证码发送失败';
      }
    } catch (err) {
      this._loginErrorMsg = err.message || '验证码发送请求失败';
    }
    this._captchaSending = false;
    this.render();
  },

  // -------------------------------------------------------------------
  // 验证码登录
  async _loginByCaptcha() {
    if (!this._phoneInput || !this._captchaInput) {
      this._loginErrorMsg = '请输入手机号和验证码';
      this.render();
      return;
    }
    this._loginErrorMsg = '';
    this._state = 'logging';
    this.render();
    try {
      const res = await this._api('/login/cellphone', {
        phone: this._phoneInput,
        captcha: this._captchaInput,
        countrycode: this._countryCode,
        timestamp: Date.now()
      });
      if (res.code === 200) {
        await this._loadUserInfo();
      } else {
        this._state = 'logged-out';
        this._loginErrorMsg = res.msg || res.message || '登录失败（code: ' + res.code + '）';
        this.render();
      }
    } catch (err) {
      this._state = 'logged-out';
      this._loginErrorMsg = err.message || '登录请求失败';
      this.render();
    }
  },

  // -------------------------------------------------------------------
  // 扫码登录流程
  async _startLogin() {
    this._stopPolling();
    this._state = 'logged-out';
    this._qrImg = '';
    this._error = '';
    this.render();
    try {
      const keyRes = await this._api('/login/qr/key', { timestamp: Date.now() });
      const unikey = keyRes.data && keyRes.data.unikey;
      if (!unikey) throw new Error('获取二维码 key 失败');
      this._qrKey = unikey;

      const createRes = await this._api('/login/qr/create', { key: unikey, qrimg: 'true', timestamp: Date.now() });
      const qrimg = createRes.data && createRes.data.qrimg;
      if (!qrimg) throw new Error('获取二维码图片失败');
      this._qrImg = qrimg;
      this.render();

      this._startPolling();
    } catch (err) {
      this._error = err.message || '未知错误';
      this._qrImg = '';
      this._state = 'logged-out';
      this.render();
    }
  },

  _startPolling() {
    const check = async () => {
      try {
        const res = await this._api('/login/qr/check', { key: this._qrKey, timestamp: Date.now() });
        const code = res.code;
        if (code === 800) {
          this._stopPolling();
          this._qrImg = '';
          this._error = '二维码已过期，请刷新';
          this.render();
        } else if (code === 802) {
          if (this._state !== 'logging') {
            this._state = 'logging';
            this.render();
          }
        } else if (code === 803) {
          this._stopPolling();
          // 优先使用 _api() 从 set-cookie 头拼接的完整 cookie；
          // 仅当没有拼到时才回退用 res.cookie，避免不完整 cookie 覆盖完整 cookie
          if (!this._cookie && res.cookie) this._cookie = res.cookie;
          console.log('[Netease] 登录成功，Cookie：', this._cookie);
          await this._loadUserInfo();
        }
      } catch (err) {
        // 轮询期间偶发波动，忽略
      }
    };
    check();
    this._qrTimer = setInterval(check, 1500);
  },

  _stopPolling() {
    if (this._qrTimer) {
      clearInterval(this._qrTimer);
      this._qrTimer = null;
    }
  },

  // -------------------------------------------------------------------
  // 登录成功后加载用户信息 + 喜欢数量 + 播放列表
  async _loadUserInfo() {
    try {
      const statusRes = await this._api('/login/status', { timestamp: Date.now() });
      this._user = (statusRes.data && (statusRes.data.account || statusRes.data.profile))
        ? statusRes.data
        : (statusRes.data || statusRes);

      const userId = (this._user && this._user.account && this._user.account.id)
        || (this._user && this._user.profile && this._user.profile.userId);
      if (userId) {
        // 喜欢数量：优先 /likelist，为空则 /user/playlist 第一个歌单 trackCount 兜底
        let count = 0;
        try {
          const likeRes = await this._api('/likelist', { uid: userId, timestamp: Date.now() });
          const ids = likeRes.ids || (likeRes.data && likeRes.data.ids) || [];
          count = Array.isArray(ids) ? ids.length : 0;
        } catch (e) { /* 忽略 */ }
        if (count === 0) {
          try {
            const plRes = await this._api('/user/playlist', { uid: userId, limit: 1, timestamp: Date.now() });
            const playlist = plRes.playlist || (plRes.data && plRes.data.playlist) || [];
            if (Array.isArray(playlist) && playlist.length > 0) {
              count = playlist[0].trackCount || 0;
            }
          } catch (e) { /* 忽略 */ }
        }
        this._likedListCount = count;
      }
      // cookie 有效（拿到 userId），持久化以便下次免扫码
      if (userId) {
        this._saveCookie(this._cookie);
        this._saveLocalData();
      }
      this._state = 'logged-in';
      this.render();
      // 登录后自动加载播放列表（前 100 首），20 秒超时，失败显示重试按钮
      this._loadPlaylist();
      // 加载用户等级信息（非阻塞，失败不影响主流程）
      this._loadUserLevel();
      // 每天首次登录自动打卡听歌（同一天不重复）
      this._autoDaka();
    } catch (err) {
      this._state = 'logged-in';
      this._likedListCount = 0;
      this.render();
      UI.setToast('用户信息加载失败：' + err.message, 'error');
    }
  },

  // -------------------------------------------------------------------
  // ===== 全局底部播放条（登录后常驻，任意页面可见） =====

  // 创建一次常驻底栏并挂到 body（不随页面 render 重建）
  _ensureGlobalBar() {
    if (this._barEl) return this._barEl;
    const bar = UI.el('div', 'netease-player-bar');
    bar.id = 'netease-player-bar';

    // 左：当前歌曲信息（歌名上 / 歌手下）
    const now = UI.el('div', 'netease-bar-now');
    const nameEl = UI.el('div', 'netease-bar-name', '未播放');
    nameEl.id = 'netease-bar-name';
    nameEl.title = '点击查看歌词';
    nameEl.style.cursor = 'pointer';
    nameEl.addEventListener('click', () => this._toggleLyricPanel());
    const artEl = UI.el('div', 'netease-bar-artist', '');
    artEl.id = 'netease-bar-artist';
    now.appendChild(nameEl);
    now.appendChild(artEl);
    bar.appendChild(now);

    // 中：时间 + 进度条（可点击/拖动） + 总时长
    const progress = UI.el('div', 'netease-bar-progress');
    const cur = UI.el('span', 'netease-bar-time', '00:00');
    cur.id = 'netease-bar-time-cur';
    const track = UI.el('div', 'netease-progress netease-bar-track-wrap');
    const trackInner = UI.el('div', 'netease-progress-track');
    const fill = UI.el('div', 'netease-progress-fill');
    fill.id = 'netease-progress-fill';
    trackInner.appendChild(fill);
    track.appendChild(trackInner);
    this._bindProgressDrag(track);
    const dur = UI.el('span', 'netease-bar-time', '00:00');
    dur.id = 'netease-bar-time-dur';
    progress.appendChild(cur);
    progress.appendChild(track);
    progress.appendChild(dur);
    bar.appendChild(progress);

    // 右：控制按钮（上一曲/播放暂停/下一曲/循环/随机）
    const ctrl = UI.el('div', 'netease-bar-ctrl');
    const prevBtn = UI.el('button', 'btn btn-sm netease-btn netease-icon-btn');
    prevBtn.title = '上一曲';
    prevBtn.innerHTML = window.svgIcon('prev-track', 14);
    prevBtn.addEventListener('click', () => this._prev());
    ctrl.appendChild(prevBtn);
    const playBtn = UI.el('button', 'btn btn-sm netease-btn netease-icon-btn netease-play-btn');
    playBtn.id = 'netease-play-btn';
    playBtn.title = '播放';
    playBtn.innerHTML = window.svgIcon('play-track', 15);
    playBtn.addEventListener('click', () => this._togglePlay());
    ctrl.appendChild(playBtn);
    const nextBtn = UI.el('button', 'btn btn-sm netease-btn netease-icon-btn');
    nextBtn.title = '下一曲';
    nextBtn.innerHTML = window.svgIcon('next-track', 14);
    nextBtn.addEventListener('click', () => this._next());
    ctrl.appendChild(nextBtn);
    // 播放模式按钮：列表循环 → 单曲循环 → 随机播放
    const modeBtn = UI.el('button', 'btn btn-sm netease-btn netease-icon-btn netease-toggle-btn active');
    modeBtn.id = 'netease-playmode-btn';
    modeBtn.title = '循环：列表';
    modeBtn.innerHTML = window.svgIcon('repeat', 14);
    modeBtn.addEventListener('click', () => this._togglePlayMode());
    ctrl.appendChild(modeBtn);
    bar.appendChild(ctrl);

    document.body.appendChild(bar);
    this._barEl = bar;
    return bar;
  },

  // 同步底栏可见性与内容（render 时调用）
  _syncGlobalBar() {
    const show = this._state === 'logged-in';
    const bar = this._ensureGlobalBar();
    bar.classList.toggle('show', show);
    // 给主内容区让出底部空间，避免播放条遮挡内容
    document.body.classList.toggle('netease-bar-active', show);
    if (show) {
      this._updatePlayerUi();
      this._updateProgress();
      this._updatePlayBtn();
      this._updatePlayModeBtn();
    }
  },

  // -------------------------------------------------------------------
  // ===== 播放器逻辑 =====

  // 懒创建 audio 元素，独立挂在 body，不随 render 重建
  _getAudio() {
    if (this._audio) return this._audio;
    const audio = new Audio();
    audio.addEventListener('timeupdate', () => {
      this._currentTime = audio.currentTime || 0;
      this._duration = audio.duration || 0;
      this._updateProgress();
      this._updateLyricHighlight();
    });
    audio.addEventListener('ended', () => { this._handleTrackEnd(); });
    audio.addEventListener('play', () => { this._isPlaying = true; this._updatePlayBtn(); });
    audio.addEventListener('pause', () => { this._isPlaying = false; this._updatePlayBtn(); });
    // 加载失败（无版权/网络问题）：复位按钮状态
    audio.addEventListener('error', () => { this._isPlaying = false; this._updatePlayBtn(); });
    this._audio = audio;
    return audio;
  },

  // 加载「我喜欢的音乐」首屏（_pageSize 首，默认 30）到播放列表；滚动到底时 _loadMorePlaylist 追加
  async _loadPlaylist() {
    const userId = (this._user && this._user.account && this._user.account.id)
      || (this._user && this._user.profile && this._user.profile.userId);
    if (!userId) { UI.setToast('未获取到用户信息', 'error'); return; }
    this._playlistLoading = true;
    this._playlistLoadError = false;
    this.render();
    try {
      const fetchFirst = (async () => {
        // 优先复用 _silentRefresh 已拿到的喜欢歌单 id，省一次 /user/playlist 请求
        let plId = this._likedPlaylistId;
        if (!plId) {
          const plRes = await this._api('/user/playlist', { uid: userId, limit: 1, timestamp: Date.now() });
          const playlist = plRes.playlist || (plRes.data && plRes.data.playlist) || [];
          if (!Array.isArray(playlist) || playlist.length === 0) {
            throw new Error('未找到喜欢歌单');
          }
          plId = playlist[0].id;
        }
        this._likedPlaylistId = plId;
        const tRes = await this._api('/playlist/track/all', { id: plId, limit: this._pageSize, offset: 0, timestamp: Date.now() });
        // 记算总数（用于判断是否还有更多 + 状态行展示）
        this._playlistTotal = (tRes.playlistTrackCount) || (tRes.data && tRes.data.playlistTrackCount) || 0;
        const songs = tRes.songs || (tRes.data && tRes.data.songs) || [];
        if (!this._playlistTotal) this._playlistTotal = songs.length;
        return this._mapSongs(songs);
      })();
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000));
      this._playlist = await Promise.race([fetchFirst, timeout]);
      this._playlistLoading = false;
      this._saveLocalData();
      this.render();
    } catch (err) {
      this._playlistLoading = false;
      this._playlistLoadError = true;
      this._playlist = [];
      this.render();
      if (err.message === 'timeout') {
        UI.setToast('加载失败：20 秒内未完成，请检查网络后重试', 'error');
      } else {
        UI.setToast('加载失败：' + err.message, 'error');
      }
    }
  },

  // 把 API 返回的 songs 映射为播放器内部结构
  _mapSongs(songs) {
    return songs.map((s) => ({
      id: s.id,
      name: s.name,
      artist: (s.ar || s.artists || []).map((a) => a.name).join('/'),
      album: (s.al && s.al.name) || '',
      duration: s.dt || 0,
      cover: (s.al && s.al.picUrl) ? String(s.al.picUrl).replace(/^http:\/\//i, 'https://') : ''
    }));
  },

  // 滚动到底时加载下一页并增量追加行（不全量 render，避免 100+ 行重排）
  async _loadMorePlaylist() {
    if (this._loadingMore || !this._likedPlaylistId) return;
    if (this._playlistTotal && this._playlist.length >= this._playlistTotal) return;
    this._loadingMore = true;
    this._updateLoadMoreStatus();
    try {
      const offset = this._playlist.length;
      const tRes = await this._api('/playlist/track/all', { id: this._likedPlaylistId, limit: this._pageSize, offset, timestamp: Date.now() });
      const songs = tRes.songs || (tRes.data && tRes.data.songs) || [];
      const more = this._mapSongs(songs);
      const startIndex = this._playlist.length;
      this._playlist = this._playlist.concat(more);
      this._loadingMore = false;
      // 增量追加行到哨兵之前
      const list = document.querySelector('.netease-track-list-page');
      if (list) {
        const sentinel = list.querySelector('.netease-load-more-sentinel');
        more.forEach((t, k) => {
          const row = this._createTrackRow(t, startIndex + k);
          if (sentinel) list.insertBefore(row, sentinel);
          else list.appendChild(row);
        });
      }
      this._updateLoadMoreStatus();
    } catch (e) {
      this._loadingMore = false;
      this._updateLoadMoreStatus();
      UI.setToast('加载更多失败：' + e.message, 'error');
    }
  },

  // 播放指定索引的歌曲
  async _playIndex(i) {
    if (i < 0 || i >= this._playlist.length) return;
    this._currentIndex = i;
    this._loadingTrack = true;
    this._updatePlayerUi();
    const song = this._playlist[i];
    try {
      const urlRes = await this._api('/song/url', { id: song.id, br: 320000, timestamp: Date.now() });
      const data = urlRes.data || urlRes;
      const url = data && data[0] && data[0].url;
      if (!url) {
        UI.setToast('「' + song.name + '」暂无播放地址（可能需要 VIP）', 'error');
        this._loadingTrack = false;
        this._updatePlayerUi();
        return;
      }
      const audio = this._getAudio();
      // http 升级 https：规避 mixed content / file:// 加载 http 资源不可靠
      audio.src = String(url).replace(/^http:\/\//i, 'https://');
      await audio.play();
      this._isPlaying = true;
      // 自动加载歌词（不自动显示面板）
      this._loadLyrics(song.id);
    } catch (err) {
      // AbortError: play() 被新 load 请求中断（快速切歌/自动连播），属正常情况，静默
      if (err.name !== 'AbortError' && !/interrupted by a new load request/.test(err.message)) {
        UI.setToast('播放失败：' + err.message, 'error');
      }
    }
    this._loadingTrack = false;
    this._updatePlayerUi();
    // 刷新列表高亮：仅切换两行 class，不重建整列表（audio 独立挂载，重建页面不影响播放）
    this._updateTrackHighlight();
  },

  // 播放/暂停切换
  _togglePlay() {
    const audio = this._getAudio();
    if (!audio.src) {
      if (this._playlist.length === 0) {
        this._loadPlaylist().then(() => { if (this._playlist.length) this._playIndex(0); });
        return;
      }
      this._playIndex(0);
      return;
    }
    if (audio.paused) { audio.play(); } else { audio.pause(); }
  },

  // 播放结束：按循环/随机模式决定下一动作
  _handleTrackEnd() {
    if (this._loopMode === 'one') {
      const audio = this._getAudio();
      audio.currentTime = 0;
      audio.play();
      return;
    }
    const list = this._getCurrentList();
    if (this._shuffle && list.length > 1) {
      let r;
      do { r = Math.floor(Math.random() * list.length); } while (r === this._currentIndex);
      this._playCurrent(r);
      return;
    }
    if (this._currentIndex >= list.length - 1) {
      // 列表循环：回到第一首；顺序播放：停止
      if (this._loopMode === 'list') this._playCurrent(0);
      return;
    }
    this._next();
  },

  // 播放模式切换：off(顺序) → list(列表循环) → one(单曲循环) → shuffle(随机) → off
  _togglePlayMode() {
    if (this._shuffle) {
      this._shuffle = false;
      this._loopMode = 'off';
    } else if (this._loopMode === 'off') {
      this._loopMode = 'list';
    } else if (this._loopMode === 'list') {
      this._loopMode = 'one';
    } else if (this._loopMode === 'one') {
      this._loopMode = 'list';
      this._shuffle = true;
    }
    this._updatePlayModeBtn();
  },

  // 兼容旧调用名
  _toggleLoop() { this._togglePlayMode(); },
  _toggleShuffle() { this._togglePlayMode(); },

  _next() {
    const list = this._getCurrentList();
    if (this._currentIndex < list.length - 1) this._playCurrent(this._currentIndex + 1);
  },

  _prev() {
    if (this._currentIndex > 0) this._playCurrent(this._currentIndex - 1);
  },

  _stop() {
    const audio = this._getAudio();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    this._currentIndex = -1;
    this._isPlaying = false;
    this._currentTime = 0;
    this._duration = 0;
    this._updatePlayerUi();
    this._updateProgress();
    this.render();
  },

  // 取当前播放歌曲
  _getCurrentSong() {
    return this._playlist[this._currentIndex];
  },

  // 取当前播放列表
  _getCurrentList() {
    return this._playlist;
  },

  // 播放指定索引
  _playCurrent(i) {
    return this._playIndex(i);
  },

  // 局部更新当前歌曲信息（全局底栏）
  _updatePlayerUi() {
    const song = this._getCurrentSong();
    const nameEl = document.getElementById('netease-bar-name');
    const artEl = document.getElementById('netease-bar-artist');
    if (nameEl) nameEl.textContent = song ? song.name : (this._loadingTrack ? '加载中…' : '未播放');
    if (artEl) artEl.textContent = song ? song.artist : '';
    this._updatePlayBtn();
    this._updateLyricHighlight();
  },

  // 局部更新进度（全局底栏）
  _updateProgress() {
    const fill = document.getElementById('netease-progress-fill');
    const cur = document.getElementById('netease-bar-time-cur');
    const dur = document.getElementById('netease-bar-time-dur');
    if (fill && this._duration) fill.style.width = (this._currentTime / this._duration * 100) + '%';
    if (cur) cur.textContent = this._formatTime(this._currentTime);
    if (dur) dur.textContent = this._formatTime(this._duration);
  },

  _updatePlayBtn() {
    const btn = document.getElementById('netease-play-btn');
    if (btn) {
      btn.innerHTML = window.svgIcon(this._isPlaying ? 'pause-track' : 'play-track', 15);
      btn.title = this._isPlaying ? '暂停' : '播放';
    }
  },

  // 同步播放模式按钮的图标/激活态/提示
  _updatePlayModeBtn() {
    const btn = document.getElementById('netease-playmode-btn');
    if (!btn) return;
    let icon, title, cls, one;
    if (this._shuffle) {
      icon = 'shuffle'; title = '随机播放';
      cls = 'btn btn-sm netease-btn netease-icon-btn netease-toggle-btn active';
      one = false;
    } else if (this._loopMode === 'one') {
      icon = 'repeat'; title = '单曲循环';
      cls = 'btn btn-sm netease-btn netease-icon-btn netease-toggle-btn active loop-one';
      one = true;
    } else if (this._loopMode === 'list') {
      icon = 'repeat'; title = '列表循环';
      cls = 'btn btn-sm netease-btn netease-icon-btn netease-toggle-btn active';
      one = false;
    } else {
      icon = 'repeat'; title = '顺序播放';
      cls = 'btn btn-sm netease-btn netease-icon-btn netease-toggle-btn';
      one = false;
    }
    btn.className = cls;
    btn.title = title;
    if (one) {
      btn.innerHTML = window.svgIcon('repeat', 14) + '<span class="netease-mode-badge">1</span>';
    } else {
      btn.innerHTML = window.svgIcon(icon, 14);
    }
  },

  // 兼容旧调用名
  _updateLoopShuffleBtn() { this._updatePlayModeBtn(); },

  // 进度条拖动定位（pointer capture，支持点击与拖拽；元素常驻只绑一次）
  _bindProgressDrag(progressEl) {
    const seek = (e) => {
      const rect = progressEl.getBoundingClientRect();
      if (!rect.width) return;
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const audio = this._getAudio();
      if (audio.duration) {
        audio.currentTime = ratio * audio.duration;
        this._currentTime = ratio * audio.duration;
        this._updateProgress();
      }
    };
    progressEl.addEventListener('pointerdown', (e) => {
      // 时长未就绪时不可拖
      if (!this._getAudio().duration) return;
      progressEl.setPointerCapture(e.pointerId);
      progressEl.classList.add('dragging');
      seek(e);
      const move = (ev) => seek(ev);
      const up = () => {
        progressEl.classList.remove('dragging');
        progressEl.removeEventListener('pointermove', move);
        progressEl.removeEventListener('pointerup', up);
        progressEl.removeEventListener('pointercancel', up);
      };
      progressEl.addEventListener('pointermove', move);
      progressEl.addEventListener('pointerup', up);
      progressEl.addEventListener('pointercancel', up);
    });
  },

  // -------------------------------------------------------------------
  // ===== 歌词功能 =====

  // 切换歌词面板显隐
  _toggleLyricPanel() {
    this._lyricVisible = !this._lyricVisible;
    const panel = this._ensureLyricPanel();
    panel.classList.toggle('show', this._lyricVisible);
    if (this._lyricVisible) {
      this._renderLyrics();
      this._updateLyricHighlight();
    }
  },

  // 创建歌词面板（挂到 document.body，固定定位居中半透明黑底）
  _ensureLyricPanel() {
    if (this._lyricEl) return this._lyricEl;
    const panel = UI.el('div', 'netease-lyric-panel');
    panel.id = 'netease-lyric-panel';
    const header = UI.el('div', 'netease-lyric-header');
    const title = UI.el('div', 'netease-lyric-title', '歌词');
    const closeBtn = UI.el('button', 'btn btn-sm netease-btn netease-btn-text netease-lyric-close', '关闭');
    closeBtn.addEventListener('click', () => {
      this._lyricVisible = false;
      panel.classList.remove('show');
    });
    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const list = UI.el('div', 'netease-lyric-list');
    list.id = 'netease-lyric-list';
    panel.appendChild(list);
    // 点击面板外部关闭
    panel.addEventListener('click', (e) => {
      if (e.target === panel) {
        this._lyricVisible = false;
        panel.classList.remove('show');
      }
    });
    document.body.appendChild(panel);
    this._lyricEl = panel;
    return panel;
  },

  // 获取并解析歌词
  async _loadLyrics(songId) {
    if (!songId) { this._lyrics = []; this._renderLyrics(); return; }
    try {
      const res = await this._api('/lyric', { id: songId, timestamp: Date.now() });
      const lrcText = (res && res.lrc && res.lrc.lyric) || (res && res.klyric && res.klyric.lyric) || '';
      this._lyrics = this._parseLrc(lrcText);
      if (this._lyricVisible) this._renderLyrics();
    } catch (err) {
      this._lyrics = [];
      if (this._lyricVisible) this._renderLyrics();
    }
  },

  // 解析 lrc 格式：[mm:ss.xx]文本 → [{time: 秒数, text: 歌词}]
  _parseLrc(text) {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    const re = /\[(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)\]/g;
    for (const line of lines) {
      const matches = [];
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(line)) !== null) {
        const min = parseInt(m[1], 10);
        const sec = parseFloat(m[2]);
        matches.push(min * 60 + sec);
      }
      const lyricText = line.replace(re, '').trim();
      if (matches.length === 0) continue;
      for (const t of matches) out.push({ time: t, text: lyricText });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  },

  // 渲染歌词到面板
  _renderLyrics() {
    const list = document.getElementById('netease-lyric-list');
    if (!list) return;
    list.innerHTML = '';
    if (this._lyrics.length === 0) {
      const empty = UI.el('div', 'netease-lyric-empty', '暂无歌词');
      list.appendChild(empty);
      return;
    }
    for (let i = 0; i < this._lyrics.length; i++) {
      const line = UI.el('div', 'netease-lyric-line', this._lyrics[i].text || '');
      line.dataset.index = String(i);
      list.appendChild(line);
    }
  },

  // 根据当前播放时间高亮当前歌词行
  _updateLyricHighlight() {
    if (!this._lyricVisible || this._lyrics.length === 0) return;
    const list = document.getElementById('netease-lyric-list');
    if (!list) return;
    const t = this._currentTime || 0;
    let idx = -1;
    for (let i = 0; i < this._lyrics.length; i++) {
      if (this._lyrics[i].time <= t) idx = i; else break;
    }
    if (idx === this._lyricCurrentIndex) return;
    this._lyricCurrentIndex = idx;
    const lines = list.children;
    for (let i = 0; i < lines.length; i++) {
      lines[i].classList.toggle('active', i === idx);
    }
    // 滚动到当前行
    if (idx >= 0 && lines[idx]) {
      const target = lines[idx];
      list.scrollTop = target.offsetTop - list.clientHeight / 2 + target.clientHeight / 2;
    }
  },

  // 秒 → mm:ss
  _formatTime(sec) {
    if (!sec || isNaN(sec)) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  },

  // -------------------------------------------------------------------
  // 每日签到
  async _dailySignin() {
    this._signinStatus = 'pending';
    this._signinMsg = '';
    this.render();
    try {
      const res = await this._api('/daily_signin', { type: 0, timestamp: Date.now() });
      if (res.code === 200) {
        this._signinStatus = 'success';
        this._signinMsg = '签到成功，积分 +' + (res.point || 0);
        UI.setToast('签到成功！', 'success');
      } else if (res.code === -2 || res.msg && res.msg.includes('重复')) {
        this._signinStatus = 'already';
        this._signinMsg = '今日已签到';
        UI.setToast('今日已签到', 'info');
      } else {
        this._signinStatus = 'failed';
        this._signinMsg = res.msg || res.message || '签到失败（code: ' + res.code + '）';
        UI.setToast('签到失败：' + this._signinMsg, 'error');
      }
    } catch (err) {
      this._signinStatus = 'failed';
      this._signinMsg = err.message || '签到请求失败';
      UI.setToast('签到失败：' + this._signinMsg, 'error');
    }
    this.render();
  },

  // -------------------------------------------------------------------
  // 打卡听歌（模拟播放指定数量的歌曲，刷每日听歌量）
  async _daka() {
    if (this._dakaStatus === 'running') return;
    this._dakaStatus = 'running';
    this._dakaProgress = 0;
    this._dakaMsg = '';
    this.render();
    try {
      // 1. 获取推荐歌单列表
      const personalizedRes = await this._api('/personalized', { limit: 50, timestamp: Date.now() });
      const playlists = personalizedRes.result || [];
      if (playlists.length === 0) {
        this._dakaStatus = 'failed';
        this._dakaMsg = '未获取到推荐歌单';
        this.render();
        return;
      }
      // 2. 从歌单中收集歌曲ID，直到达到目标数量
      const allSongIds = [];
      const shuffled = [...playlists].sort(() => Math.random() - 0.5);
      for (const pl of shuffled) {
        if (allSongIds.length >= this._dakaTarget) break;
        try {
          const detailRes = await this._api('/playlist/detail', { id: pl.id, n: 1000, timestamp: Date.now() });
          const trackIds = (detailRes.playlist && detailRes.playlist.trackIds) || [];
          for (const t of trackIds) {
            allSongIds.push(t.id);
            if (allSongIds.length >= this._dakaTarget) break;
          }
        } catch (e) { /* 忽略单个歌单失败 */ }
      }
      if (allSongIds.length === 0) {
        this._dakaStatus = 'failed';
        this._dakaMsg = '未获取到歌曲ID';
        this.render();
        return;
      }
      // 3. 分批提交播放日志（每批最多 50 首，避免请求体过大）
      const batchSize = 50;
      const targetIds = allSongIds.slice(0, this._dakaTarget);
      for (let i = 0; i < targetIds.length; i += batchSize) {
        const batch = targetIds.slice(i, i + batchSize);
        const logs = batch.map((songId) => ({
          action: 'play',
          json: { download: 0, end: 'playend', id: String(songId), sourceId: '', time: 240, type: 'song', wifi: 0 }
        }));
        try {
          await this._api('/weblog', { logs: JSON.stringify(logs), timestamp: Date.now() });
        } catch (e) { /* 忽略单批失败 */ }
        this._dakaProgress = Math.min(i + batchSize, targetIds.length);
        this.render();
      }
      this._dakaStatus = 'success';
      this._dakaMsg = '打卡完成，共刷 ' + this._dakaProgress + ' 首';
      this._dakaLastDate = DateUtil.today();
      UI.setToast('打卡完成！共刷 ' + this._dakaProgress + ' 首', 'success');
    } catch (err) {
      this._dakaStatus = 'failed';
      this._dakaMsg = err.message || '打卡失败';
      UI.setToast('打卡失败：' + this._dakaMsg, 'error');
    }
    this.render();
  },

  // -------------------------------------------------------------------
  // 自动打卡（每天首次登录时执行，同一天不重复）
  _autoDaka() {
    const today = DateUtil.today();
    if (this._dakaLastDate === today) return; // 同一天已打卡
    // 延迟 2 秒执行，避免与登录流程的其他请求竞争
    setTimeout(() => {
      if (this._state === 'logged-in' && this._dakaLastDate !== today) {
        this._daka();
      }
    }, 2000);
  },

  // -------------------------------------------------------------------
  // 刷单曲播放次数
  async _listenSong() {
    if (!this._listenSongId || this._listenCount < 1) {
      UI.setToast('请输入歌曲ID和播放次数', 'error');
      return;
    }
    if (this._listenStatus === 'running') return;
    this._listenStatus = 'running';
    this._listenProgress = 0;
    this._listenMsg = '';
    this.render();
    try {
      const batchSize = 50;
      const total = Math.min(this._listenCount, 1000); // 上限 1000 次
      for (let i = 0; i < total; i += batchSize) {
        const batchCount = Math.min(batchSize, total - i);
        const logs = [];
        for (let j = 0; j < batchCount; j++) {
          logs.push({
            action: 'play',
            json: { download: 0, end: 'playend', id: String(this._listenSongId), sourceId: '', time: 240, type: 'song', wifi: 0 }
          });
        }
        try {
          await this._api('/weblog', { logs: JSON.stringify(logs), timestamp: Date.now() });
        } catch (e) { /* 忽略单批失败 */ }
        this._listenProgress = Math.min(i + batchSize, total);
        this.render();
      }
      this._listenStatus = 'success';
      this._listenMsg = '刷播放完成，共 ' + this._listenProgress + ' 次';
      UI.setToast('刷播放完成！共 ' + this._listenProgress + ' 次', 'success');
    } catch (err) {
      this._listenStatus = 'failed';
      this._listenMsg = err.message || '刷播放失败';
      UI.setToast('刷播放失败：' + this._listenMsg, 'error');
    }
    this.render();
  },

  // -------------------------------------------------------------------
  // 加载用户等级信息
  async _loadUserLevel() {
    try {
      const userId = (this._user && this._user.account && this._user.account.id)
        || (this._user && this._user.profile && this._user.profile.userId);
      if (!userId) return;
      const res = await this._api('/user/level', { uid: userId, timestamp: Date.now() });
      if (res.code === 200 && res.data) {
        this._userLevel = res.data;
        this.render();
      }
    } catch (e) { /* 忽略等级加载失败 */ }
  },

  // -------------------------------------------------------------------
  // 退出登录
  async _logout() {
    this._stopPolling();
    this._stop();
    try {
      await this._api('/logout', { timestamp: Date.now() });
    } catch (e) { /* 忽略 */ }
    this._saveCookie(null);
    this._clearLocalData();
    this._cookie = '';
    this._user = null;
    this._likedListCount = 0;
    this._qrImg = '';
    this._qrKey = '';
    this._playlist = [];
    this._currentIndex = -1;
    this._phase = 'login';
    this._loginTab = 'qr';
    this._phoneInput = '';
    this._passwordInput = '';
    this._captchaSent = false;
    this._captchaInput = '';
    this._loginErrorMsg = '';
    this._signinStatus = null;
    this._dakaStatus = null;
    this._dakaProgress = 0;
    this._dakaLastDate = '';
    this._userLevel = null;
    this._listenSongId = '';
    this._listenCount = 1;
    this._listenStatus = null;
    this._listenProgress = 0;
    this._state = 'logged-out';
    this._startLogin();
    UI.setToast('已退出登录', 'info');
  }
};
