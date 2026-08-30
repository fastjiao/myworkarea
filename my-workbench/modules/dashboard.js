// =====================================================================
// modules/dashboard.js —— 首页仪表盘模块
// 职责：工作台门户页，展示欢迎语、快捷统计、今日签到状态、各模块入口
// 说明：通过 window.Store / window.UI / window.switchPage 访问共享能力。
// =====================================================================

window.Dashboard = {
  // -------------------------------------------------------------------
  init() {
    Store.onChange(() => this.render());
    this.render();
  },

  // -------------------------------------------------------------------
  render() {
    const page = document.getElementById('page-dashboard');
    page.innerHTML = '';
    page.appendChild(this._buildWelcome());
    page.appendChild(this._buildStats());
    page.appendChild(this._buildSignStatus());
    page.appendChild(this._buildEntries());
  },

  // -------------------------------------------------------------------
  // 欢迎区：按时段问候 + 当前日期
  // -------------------------------------------------------------------
  _buildWelcome() {
    const sec = UI.el('div', 'section dashboard-welcome');
    sec.appendChild(UI.el('div', 'dashboard-hello', this._greeting()));
    sec.appendChild(UI.el('div', 'dashboard-sub', this._dateStr()));
    return sec;
  },

  /** 按当前小时返回问候语 */
  _greeting() {
    const hr = new Date().getHours();
    if (hr < 6) return '夜深了，注意休息';
    if (hr < 12) return '早上好，开始新的一天';
    if (hr < 14) return '中午好';
    if (hr < 18) return '下午好';
    return '晚上好';
  },

  /** 返回形如「2026年8月30日 周日」的日期串 */
  _dateStr() {
    const d = new Date();
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + week;
  },

  // -------------------------------------------------------------------
  // 快捷统计：软件 / 文件夹·文件 / 网页 / 今日事件
  // -------------------------------------------------------------------
  _buildStats() {
    const sec = UI.el('div', 'section');
    const title = UI.el('div', 'section-title');
    title.appendChild(UI.el('span', '', '快捷统计'));
    sec.appendChild(title);

    const stats = [
      { icon: 'app',      label: '软件',         value: Store.appShortcuts().length,  page: 'home' },
      { icon: 'folder',   label: '文件/文件夹',  value: Store.fileShortcuts().length, page: 'home' },
      { icon: 'external', label: '网页',         value: Store.webShortcuts().length,  page: 'home' },
      { icon: 'calendar', label: '今日事件',     value: Store.todayEvents().length,   page: 'calendar' }
    ];

    const grid = UI.el('div', 'dashboard-stats');
    stats.forEach((s) => grid.appendChild(this._buildStatCard(s)));
    sec.appendChild(grid);
    return sec;
  },

  _buildStatCard(s) {
    const card = UI.el('div', 'dashboard-stat-card');
    card.addEventListener('click', () => window.switchPage(s.page));
    const ic = UI.el('div', 'dashboard-stat-icon');
    ic.innerHTML = window.svgIcon(s.icon, 22);
    card.appendChild(ic);
    card.appendChild(UI.el('div', 'dashboard-stat-value', String(s.value)));
    card.appendChild(UI.el('div', 'dashboard-stat-label', s.label));
    return card;
  },

  // -------------------------------------------------------------------
  // 今日签到状态：已签 / 共 / 待签，附「前往签到」按钮
  // -------------------------------------------------------------------
  _buildSignStatus() {
    const tasks = (window.Sign && Array.isArray(window.Sign._tasks)) ? window.Sign._tasks : [];
    const today = DateUtil.today();
    const done = tasks.filter((t) => t.lastSignDate === today).length;
    const total = tasks.length;
    const pending = total - done;

    const sec = UI.el('div', 'section');
    const title = UI.el('div', 'section-title');
    title.appendChild(UI.el('span', '', '今日签到'));
    sec.appendChild(title);

    const bar = UI.el('div', 'dashboard-sign-bar');
    const info = UI.el('div', 'dashboard-sign-info');
    info.appendChild(UI.el('span', 'dashboard-sign-done', '已签 ' + done));
    info.appendChild(UI.el('span', 'dashboard-sign-sep', '/'));
    info.appendChild(UI.el('span', '', '共 ' + total));
    if (pending > 0) info.appendChild(UI.el('span', 'dashboard-sign-pending', '待签 ' + pending));
    bar.appendChild(info);

    const goBtn = UI.el('button', 'btn btn-primary btn-sm', '前往签到');
    goBtn.addEventListener('click', () => window.switchPage('sign'));
    bar.appendChild(goBtn);
    sec.appendChild(bar);
    return sec;
  },

  // -------------------------------------------------------------------
  // 各模块快捷入口（点击跳转对应页）
  // -------------------------------------------------------------------
  _buildEntries() {
    const sec = UI.el('div', 'section');
    const title = UI.el('div', 'section-title');
    title.appendChild(UI.el('span', '', '快捷入口'));
    sec.appendChild(title);

    const entries = [
      { icon: 'app',      title: '快捷启动', desc: '软件、文件、网页快捷方式', page: 'home' },
      { icon: 'flag',     title: '一键签到', desc: '网页 / 桌面任务自动签到', page: 'sign' },
      { icon: 'calendar', title: '日历',     desc: '查看与管理日程事件',     page: 'calendar' },
      { icon: 'compass',  title: '技能发现', desc: '探索可用技能',           page: 'skill-finder' },
      { icon: 'search',   title: '全部技能', desc: '浏览全部技能列表',       page: 'skills' }
    ];

    const grid = UI.el('div', 'dashboard-entries');
    entries.forEach((e) => grid.appendChild(this._buildEntryCard(e)));
    sec.appendChild(grid);
    return sec;
  },

  _buildEntryCard(e) {
    const card = UI.el('div', 'dashboard-entry');
    card.addEventListener('click', () => window.switchPage(e.page));
    const ic = UI.el('div', 'dashboard-entry-icon');
    ic.innerHTML = window.svgIcon(e.icon, 26);
    card.appendChild(ic);
    const body = UI.el('div', 'dashboard-entry-body');
    body.appendChild(UI.el('div', 'dashboard-entry-title', e.title));
    body.appendChild(UI.el('div', 'dashboard-entry-desc', e.desc));
    card.appendChild(body);
    return card;
  }
};
