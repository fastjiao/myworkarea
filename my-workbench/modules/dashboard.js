// modules/dashboard.js —— 首页仪表盘模块
// 职责：工作台门户页，展示欢迎语、签到提示、快捷统计、模块入口
// 设计：去卡片通栏沉浸式，签到提示融入问候区（未签/已签两态）
// 说明：通过 window.Store / window.UI / window.switchPage 访问共享能力。

window.Dashboard = {
  init() {
    Store.onChange(() => this.render());
    this.render();
  },

  render() {
    const page = document.getElementById('page-dashboard');
    page.innerHTML = '';
    page.appendChild(this._buildWelcome());
    page.appendChild(this._buildStats());
    page.appendChild(this._buildEntries());
  },

  // 欢迎区：按时段问候 + 当前日期 + 签到提示条（融入）
  _buildWelcome() {
    const sec = UI.el('div', 'section dashboard-welcome');
    sec.appendChild(UI.el('div', 'dashboard-hello', this._greeting()));
    sec.appendChild(UI.el('div', 'dashboard-sub', this._dateStr()));
    sec.appendChild(this._buildSignHint());
    return sec;
  },

  // 签到提示条：融入问候区下方，通栏非卡片
  // 三态：无任务（引导添加）/ 已签完（完成态）/ 待签（可点击跳签到页）
  _buildSignHint() {
    const tasks = (window.Sign && Array.isArray(window.Sign._tasks)) ? window.Sign._tasks : [];
    const today = DateUtil.today();
    const done = tasks.filter((t) => t.lastSignDate === today).length;
    const total = tasks.length;
    const pending = total - done;

    const hint = UI.el('div', 'dashboard-sign-hint');
    const ic = UI.el('span', 'dashboard-sign-hint-icon');

    if (total === 0) {
      hint.classList.add('is-empty');
      ic.innerHTML = window.svgIcon('flag', 16);
      hint.appendChild(ic);
      hint.appendChild(UI.el('span', '', '当前未添加签到任务'));
      hint.addEventListener('click', () => window.switchPage('sign'));
    } else {
      const text = '已签到 ' + done + '，未签到 ' + pending + '，总计 ' + total;
      if (pending === 0) {
        hint.classList.add('is-done');
        ic.innerHTML = window.svgIcon('check', 16);
      } else {
        hint.classList.add('is-pending');
        ic.innerHTML = window.svgIcon('flag', 16);
        hint.addEventListener('click', () => window.switchPage('sign'));
      }
      hint.appendChild(ic);
      hint.appendChild(UI.el('span', '', text));
    }
    return hint;
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

  // 快捷统计：通栏一行，竖线分隔各项，去卡片
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

    const bar = UI.el('div', 'dashboard-stats-bar');
    stats.forEach((s, i) => {
      if (i > 0) bar.appendChild(UI.el('span', 'dashboard-stats-sep'));
      const item = UI.el('div', 'dashboard-stat-item');
      item.addEventListener('click', () => window.switchPage(s.page));
      const ic = UI.el('span', 'dashboard-stat-icon');
      ic.innerHTML = window.svgIcon(s.icon, 18);
      item.appendChild(ic);
      item.appendChild(UI.el('span', 'dashboard-stat-value', String(s.value)));
      item.appendChild(UI.el('span', 'dashboard-stat-label', s.label));
      bar.appendChild(item);
    });
    sec.appendChild(bar);
    return sec;
  },

  // 快捷入口：通栏列表，每行一个，分隔线分隔，去卡片
  _buildEntries() {
    const sec = UI.el('div', 'section');
    const title = UI.el('div', 'section-title');
    title.appendChild(UI.el('span', '', '快捷入口'));
    sec.appendChild(title);

    const entries = [
      { icon: 'app',      title: '快捷启动', desc: '软件、文件、网页快捷方式', page: 'home' },
      { icon: 'flag',     title: '一键签到', desc: '网页 / 桌面任务自动签到', page: 'sign' },
      { icon: 'calendar', title: '日历',     desc: '查看与管理日程事件',     page: 'calendar' }
    ];

    const list = UI.el('div', 'dashboard-entry-list');
    entries.forEach((e) => list.appendChild(this._buildEntryRow(e)));
    sec.appendChild(list);
    return sec;
  },

  _buildEntryRow(e) {
    const row = UI.el('div', 'dashboard-entry-row');
    row.addEventListener('click', () => window.switchPage(e.page));
    const ic = UI.el('span', 'dashboard-entry-icon');
    ic.innerHTML = window.svgIcon(e.icon, 20);
    row.appendChild(ic);
    const body = UI.el('div', 'dashboard-entry-body');
    body.appendChild(UI.el('div', 'dashboard-entry-title', e.title));
    body.appendChild(UI.el('div', 'dashboard-entry-desc', e.desc));
    row.appendChild(body);
    const arrow = UI.el('span', 'dashboard-entry-arrow');
    arrow.innerHTML = window.svgIcon('right', 18);
    row.appendChild(arrow);
    return row;
  }
};
