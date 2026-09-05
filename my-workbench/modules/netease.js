// =====================================================================
// modules/netease.js —— 网易云音乐控制面板模块
// 职责：
//   1. 进入页面时自动拉起本地 NeteaseCloudMusicApi 服务（主进程 fork 子进程）
//   2. 扫码登录：获取二维码 → 轮询扫码状态 → 登录成功取 Cookie
//   3. 三态视图：未登录（二维码）/ 登录中（等待确认）/ 已登录（用户信息）
//   4. 已登录态内置 Web 播放器：拉取「我喜欢的音乐」→ /song/url 取地址 → <audio> 播放
//   5. 外部客户端控制：发送媒体键控制网易云 PC 客户端播放/上下曲，可关闭客户端
//   6. 通过主进程 IPC 代理访问 localhost:3000，规避同源策略，无需关闭 webSecurity
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

  // ===== 播放器状态 =====
  _playlist: [],        // 喜欢的歌曲列表 [{id, name, artist}]
  _currentIndex: -1,    // 当前播放索引
  _audio: null,         // HTMLAudioElement（独立挂载，不随 render 重建）
  _isPlaying: false,
  _currentTime: 0,
  _duration: 0,
  _loadingTrack: false, // 正在加载歌曲 URL

  // -------------------------------------------------------------------
  init() {
    Store.onChange(() => this.render());
  },

  // -------------------------------------------------------------------
  render() {
    const page = document.getElementById('page-netease');
    page.innerHTML = '';

    const section = UI.el('div', 'section');
    const title = UI.el('div', 'section-title');
    title.appendChild(UI.el('span', '', '网易云音乐'));
    section.appendChild(title);

    section.appendChild(UI.el('div', 'sf-desc',
      '进入页面将自动启动本地 NeteaseCloudMusicApi 服务（localhost:3000），扫码登录后可播放「我喜欢的音乐」并控制网易云 PC 客户端'
    ));

    const panel = UI.el('div', 'netease-panel');
    panel.appendChild(this._renderView());
    section.appendChild(panel);

    page.appendChild(section);

    if (!this._autoStarted) {
      this._autoStarted = true;
      this._ensureApi();
    }
  },

  _renderView() {
    if (this._phase === 'starting-api') return this._renderApiStarting();
    if (this._phase === 'api-failed') return this._renderApiFailed();
    if (this._error && this._state === 'logged-out' && !this._qrImg) return this._renderError();
    if (this._state === 'logged-in') return this._renderLoggedIn();
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

  // ===================== 未登录态（二维码） =====================
  _renderQr() {
    const box = UI.el('div', 'netease-qr-box');
    const card = UI.el('div', 'netease-card');
    card.appendChild(UI.el('div', 'netease-card-title', '扫码登录'));
    const qrWrap = UI.el('div', 'netease-qr-wrap');
    if (this._qrImg) {
      const img = UI.el('img', 'netease-qr-img');
      img.src = this._qrImg.startsWith('data:') ? this._qrImg : 'data:image/png;base64,' + this._qrImg;
      qrWrap.appendChild(img);
    } else {
      const placeholder = UI.el('div', 'netease-qr-placeholder');
      placeholder.appendChild(UI.icon('loading', 32));
      qrWrap.appendChild(placeholder);
    }
    card.appendChild(qrWrap);
    card.appendChild(UI.el('div', 'netease-tip', '请使用网易云音乐 APP 扫码登录'));
    const actions = UI.el('div', 'netease-actions');
    const refreshBtn = UI.el('button', 'btn btn-sm netease-btn', '刷新二维码');
    refreshBtn.addEventListener('click', () => this._startLogin());
    actions.appendChild(refreshBtn);
    card.appendChild(actions);
    box.appendChild(card);
    return box;
  },

  // ===================== 登录中态 =====================
  _renderLogging() {
    const box = UI.el('div', 'netease-qr-box');
    const card = UI.el('div', 'netease-card');
    card.appendChild(UI.el('div', 'netease-spinner'));
    card.appendChild(UI.el('div', 'netease-tip', '扫码成功，请在手机确认'));
    box.appendChild(card);
    return box;
  },

  // ===================== 已登录态：用户信息 + 播放器 + 外部控制 =====================
  _renderLoggedIn() {
    const box = UI.el('div', 'netease-qr-box');

    // ---- 卡片 1：用户信息 ----
    const infoCard = UI.el('div', 'netease-card');
    const u = this._user || {};
    const profile = u.profile || u.account || u;
    const avatarWrap = UI.el('div', 'netease-avatar-wrap');
    if (profile.avatarUrl) {
      const img = UI.el('img', 'netease-avatar');
      // http 升级 https：网易云 CDN 支持 https，规避 file:// 页面加载 http 资源不可靠的问题
      img.src = String(profile.avatarUrl).replace(/^http:\/\//i, 'https://');
      avatarWrap.appendChild(img);
    } else {
      avatarWrap.appendChild(UI.icon('music', 48));
    }
    infoCard.appendChild(avatarWrap);
    infoCard.appendChild(UI.el('div', 'netease-nickname', profile.nickname || '已登录用户'));
    const stat = UI.el('div', 'netease-stat');
    stat.appendChild(UI.el('span', 'netease-stat-num', String(this._likedListCount || 0)));
    stat.appendChild(UI.el('span', 'netease-stat-label', '我喜欢的音乐'));
    infoCard.appendChild(stat);
    const infoActions = UI.el('div', 'netease-actions');
    const refreshBtn = UI.el('button', 'btn btn-sm netease-btn', '刷新');
    refreshBtn.addEventListener('click', () => this._loadUserInfo());
    infoActions.appendChild(refreshBtn);
    const logoutBtn = UI.el('button', 'btn btn-sm netease-btn-danger', '退出登录');
    logoutBtn.addEventListener('click', () => this._logout());
    infoActions.appendChild(logoutBtn);
    infoCard.appendChild(infoActions);
    box.appendChild(infoCard);

    // ---- 卡片 2：Web 播放器 ----
    box.appendChild(this._renderPlayer());

    // ---- 卡片 3：外部客户端控制 ----
    box.appendChild(this._renderClientControl());

    return box;
  },

  // 播放器卡片
  _renderPlayer() {
    const card = UI.el('div', 'netease-card');
    card.appendChild(UI.el('div', 'netease-card-title', '播放器'));

    // 当前歌曲信息
    const now = UI.el('div', 'netease-now');
    const song = this._playlist[this._currentIndex];
    const nameEl = UI.el('div', 'netease-now-name', song ? song.name : (this._loadingTrack ? '加载中…' : '未播放'));
    nameEl.id = 'netease-now-name';
    const artEl = UI.el('div', 'netease-now-artist', song ? song.artist : '');
    artEl.id = 'netease-now-artist';
    now.appendChild(nameEl);
    now.appendChild(artEl);
    card.appendChild(now);

    // 进度条（轨道 + 填充，支持点击/拖动定位）
    const progress = UI.el('div', 'netease-progress');
    const track = UI.el('div', 'netease-progress-track');
    const fill = UI.el('div', 'netease-progress-fill');
    fill.id = 'netease-progress-fill';
    if (this._duration) fill.style.width = (this._currentTime / this._duration * 100) + '%';
    track.appendChild(fill);
    progress.appendChild(track);
    this._bindProgressDrag(progress);
    card.appendChild(progress);

    // 时间显示
    const time = UI.el('div', 'netease-time');
    const cur = UI.el('span', '', this._formatTime(this._currentTime));
    cur.id = 'netease-time-cur';
    const dur = UI.el('span', '', this._formatTime(this._duration));
    dur.id = 'netease-time-dur';
    time.appendChild(cur);
    time.appendChild(UI.el('span', '', ' / '));
    time.appendChild(dur);
    card.appendChild(time);

    // 控制按钮：上一曲 / 播放暂停 / 下一曲（SVG 图标，来源 t.md）/ 停止
    const ctrl = UI.el('div', 'netease-actions netease-player-ctrl');
    const prevBtn = UI.el('button', 'btn btn-sm netease-btn netease-icon-btn');
    prevBtn.title = '上一曲';
    prevBtn.innerHTML = window.svgIcon('prev-track', 15);
    prevBtn.addEventListener('click', () => this._prev());
    ctrl.appendChild(prevBtn);
    const playBtn = UI.el('button', 'btn btn-sm netease-btn netease-icon-btn netease-play-btn');
    playBtn.id = 'netease-play-btn';
    playBtn.title = this._isPlaying ? '暂停' : '播放';
    playBtn.innerHTML = window.svgIcon(this._isPlaying ? 'pause-track' : 'play-track', 16);
    playBtn.addEventListener('click', () => this._togglePlay());
    ctrl.appendChild(playBtn);
    const nextBtn = UI.el('button', 'btn btn-sm netease-btn netease-icon-btn');
    nextBtn.title = '下一曲';
    nextBtn.innerHTML = window.svgIcon('next-track', 15);
    nextBtn.addEventListener('click', () => this._next());
    ctrl.appendChild(nextBtn);
    const stopBtn = UI.el('button', 'btn btn-sm netease-btn', '停止');
    stopBtn.addEventListener('click', () => this._stop());
    ctrl.appendChild(stopBtn);
    card.appendChild(ctrl);

    // 加载列表按钮 / 播放列表
    if (this._playlist.length === 0) {
      const loadRow = UI.el('div', 'netease-actions');
      const loadBtn = UI.el('button', 'btn btn-sm netease-btn', '加载我喜欢列表');
      loadBtn.addEventListener('click', () => this._loadPlaylist());
      loadRow.appendChild(loadBtn);
      card.appendChild(loadRow);
    } else {
      const listTitle = UI.el('div', 'netease-tip', '我喜欢列表（前 ' + this._playlist.length + ' 首，点击播放）');
      card.appendChild(listTitle);
      const list = UI.el('div', 'netease-track-list');
      this._playlist.forEach((t, i) => {
        const item = UI.el('div', 'netease-track' + (i === this._currentIndex ? ' active' : ''));
        item.appendChild(UI.el('span', 'netease-track-name', t.name));
        item.appendChild(UI.el('span', 'netease-track-artist', t.artist));
        item.addEventListener('click', () => this._playIndex(i));
        list.appendChild(item);
      });
      card.appendChild(list);
    }
    return card;
  },

  // 外部客户端控制卡片
  _renderClientControl() {
    const card = UI.el('div', 'netease-card');
    card.appendChild(UI.el('div', 'netease-card-title', '控制网易云 PC 客户端'));
    card.appendChild(UI.el('div', 'netease-tip', '通过媒体键控制电脑上已运行的网易云音乐客户端'));

    const ctrl = UI.el('div', 'netease-actions netease-player-ctrl');
    const prevBtn = UI.el('button', 'btn btn-sm netease-btn', '上一首');
    prevBtn.addEventListener('click', () => this._mediaKey('prev'));
    ctrl.appendChild(prevBtn);
    const playBtn = UI.el('button', 'btn btn-sm netease-btn', '播放/暂停');
    playBtn.addEventListener('click', () => this._mediaKey('play-pause'));
    ctrl.appendChild(playBtn);
    const nextBtn = UI.el('button', 'btn btn-sm netease-btn', '下一首');
    nextBtn.addEventListener('click', () => this._mediaKey('next'));
    ctrl.appendChild(nextBtn);
    card.appendChild(ctrl);

    const closeRow = UI.el('div', 'netease-actions');
    const closeBtn = UI.el('button', 'btn btn-sm netease-btn-danger', '关闭客户端');
    closeBtn.addEventListener('click', () => this._killClient());
    closeRow.appendChild(closeBtn);
    card.appendChild(closeRow);
    return card;
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
  // 返回 true 表示恢复成功（已进入已登录态），false 表示需要扫码
  async _tryRestoreCookie() {
    try {
      const saved = await window.workbench.readData('netease-cookie.json');
      if (!saved || !saved.cookie) return false;
      this._cookie = saved.cookie;
      // 用 /login/status 验证 cookie 是否仍然有效
      const statusRes = await this._api('/login/status', { timestamp: Date.now() });
      const data = statusRes.data || statusRes;
      if (data && (data.account || (data.profile && data.profile.userId))) {
        // cookie 有效：直接加载用户信息进入已登录态
        await this._loadUserInfo();
        return true;
      }
      // cookie 已失效：清理本地存储
      this._cookie = '';
      await this._saveCookie(null);
    } catch (e) {
      this._cookie = '';
    }
    return false;
  },

  // 持久化 cookie 到 data/netease-cookie.json（传 null 清空）
  _saveCookie(cookie) {
    const data = cookie ? { cookie: cookie, savedAt: Date.now() } : { cookie: '' };
    return window.workbench.writeData('netease-cookie.json', data);
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
      const parts = res.setCookie.map((c) => c.split(';')[0]);
      this._cookie = (this._cookie ? this._cookie + '; ' : '') + parts.join('; ');
    }
    return json;
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
      if (userId) this._saveCookie(this._cookie);
      this._state = 'logged-in';
      this.render();
      // 登录后自动加载播放列表（前 100 首），不阻塞、失败静默
      this._loadPlaylist();
    } catch (err) {
      this._state = 'logged-in';
      this._likedListCount = 0;
      this.render();
      UI.setToast('用户信息加载失败：' + err.message, 'error');
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
    });
    audio.addEventListener('ended', () => { this._next(); });
    audio.addEventListener('play', () => { this._isPlaying = true; this._updatePlayBtn(); });
    audio.addEventListener('pause', () => { this._isPlaying = false; this._updatePlayBtn(); });
    // 加载失败（无版权/网络问题）：复位按钮状态
    audio.addEventListener('error', () => { this._isPlaying = false; this._updatePlayBtn(); });
    this._audio = audio;
    return audio;
  },

  // 加载「我喜欢的音乐」前 100 首到播放列表
  async _loadPlaylist() {
    const userId = (this._user && this._user.account && this._user.account.id)
      || (this._user && this._user.profile && this._user.profile.userId);
    if (!userId) { UI.setToast('未获取到用户信息', 'error'); return; }
    UI.setToast('正在加载我喜欢列表…', 'info');
    try {
      // 取喜欢歌单 id（第一个歌单）
      const plRes = await this._api('/user/playlist', { uid: userId, limit: 1, timestamp: Date.now() });
      const playlist = plRes.playlist || (plRes.data && plRes.data.playlist) || [];
      if (!Array.isArray(playlist) || playlist.length === 0) {
        UI.setToast('未找到喜欢歌单', 'error'); return;
      }
      const plId = playlist[0].id;
      // 拉前 100 首
      const tRes = await this._api('/playlist/track/all', { id: plId, limit: 100, offset: 0, timestamp: Date.now() });
      const songs = tRes.songs || (tRes.data && tRes.data.songs) || [];
      this._playlist = songs.map((s) => ({
        id: s.id,
        name: s.name,
        artist: (s.ar || s.artists || []).map((a) => a.name).join('/')
      }));
      this.render();
      UI.setToast('已加载 ' + this._playlist.length + ' 首歌', 'success');
    } catch (err) {
      UI.setToast('加载列表失败：' + err.message, 'error');
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
    } catch (err) {
      UI.setToast('播放失败：' + err.message, 'error');
    }
    this._loadingTrack = false;
    this._updatePlayerUi();
  },

  // 播放/暂停切换
  _togglePlay() {
    const audio = this._getAudio();
    if (!audio.src) {
      // 还没开始播：从第一首开始（列表为空则先加载）
      if (this._playlist.length === 0) {
        this._loadPlaylist().then(() => { if (this._playlist.length) this._playIndex(0); });
        return;
      }
      this._playIndex(0);
      return;
    }
    if (audio.paused) { audio.play(); } else { audio.pause(); }
  },

  _next() {
    if (this._currentIndex < this._playlist.length - 1) this._playIndex(this._currentIndex + 1);
  },

  _prev() {
    if (this._currentIndex > 0) this._playIndex(this._currentIndex - 1);
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
  },

  // 局部更新进度（避免重建 DOM 中断播放）
  _updateProgress() {
    const fill = document.getElementById('netease-progress-fill');
    const cur = document.getElementById('netease-time-cur');
    const dur = document.getElementById('netease-time-dur');
    if (fill && this._duration) fill.style.width = (this._currentTime / this._duration * 100) + '%';
    if (cur) cur.textContent = this._formatTime(this._currentTime);
    if (dur) dur.textContent = this._formatTime(this._duration);
  },

  // 局部更新当前歌曲信息
  _updatePlayerUi() {
    const nameEl = document.getElementById('netease-now-name');
    const artEl = document.getElementById('netease-now-artist');
    const song = this._playlist[this._currentIndex];
    if (nameEl) nameEl.textContent = song ? song.name : (this._loadingTrack ? '加载中…' : '未播放');
    if (artEl) artEl.textContent = song ? song.artist : '';
    this._updatePlayBtn();
  },

  _updatePlayBtn() {
    const btn = document.getElementById('netease-play-btn');
    if (btn) {
      btn.innerHTML = window.svgIcon(this._isPlaying ? 'pause-track' : 'play-track', 16);
      btn.title = this._isPlaying ? '暂停' : '播放';
    }
  },

  // 进度条拖动定位（pointer capture，支持点击与拖拽）
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

  // 秒 → mm:ss
  _formatTime(sec) {
    if (!sec || isNaN(sec)) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  },

  // -------------------------------------------------------------------
  // ===== 外部网易云 PC 客户端控制 =====

  // 发送媒体键（主进程 PowerShell 模拟）
  async _mediaKey(key) {
    try {
      const res = await window.workbench.neteaseMediaKey(key);
      if (!res || !res.success) {
        UI.setToast('发送媒体键失败：' + (res && res.message), 'error');
      }
    } catch (err) {
      UI.setToast('发送媒体键异常：' + err.message, 'error');
    }
  },

  // 关闭网易云 PC 客户端进程
  async _killClient() {
    try {
      const res = await window.workbench.neteaseKillClient();
      UI.setToast(res.message || (res.success ? '已关闭' : '关闭失败'), res.success ? 'success' : 'error');
    } catch (err) {
      UI.setToast('关闭异常：' + err.message, 'error');
    }
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
    this._cookie = '';
    this._user = null;
    this._likedListCount = 0;
    this._qrImg = '';
    this._qrKey = '';
    this._playlist = [];
    this._currentIndex = -1;
    this._phase = 'login';
    this._state = 'logged-out';
    this._startLogin();
    UI.setToast('已退出登录', 'info');
  }
};
