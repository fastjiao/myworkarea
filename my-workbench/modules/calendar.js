// =====================================================================
// modules/calendar.js —— 日历模块（含 Todo，取代原日历 + 待办两模块）
// 职责：
//   1. 日 / 周 / 月 三种视图切换与上/下切换
//   2. 日期格子显示当日事件（Todo）数量角标
//   3. 点击日期弹出「事件创建/编辑面板」：标题、时间、提醒、分类标签
//   4. 事件的增删改查与完成勾选
// 说明：事件数据存于 Store.events，字段见 Store；变更后调用 Store.notify()
//       让其它视图（如首页）同步刷新。
// =====================================================================

window.Calendar = {
  // 当前视图：'month' | 'week' | 'day'
  _view: 'month',
  // 当前游标日期（视图锚点）
  _cursor: null,
  // 当前选中日期（YYYY-MM-DD）
  _selectedDate: null,

  // -------------------------------------------------------------------
  init() {
    Store.onChange(() => this.render());
    const now = new Date();
    this._cursor = now;
    this._selectedDate = DateUtil.today();
    this.render();
  },

  // -------------------------------------------------------------------
  render() {
    const page = document.getElementById('page-calendar');
    page.innerHTML = '';

    const wrap = UI.el('div', 'calendar-wrap');
    wrap.appendChild(this._buildHeader());
    if (this._view === 'month') wrap.appendChild(this._buildMonth());
    else if (this._view === 'week') wrap.appendChild(this._buildWeek());
    else wrap.appendChild(this._buildDay());
    page.appendChild(wrap);
  },

  // -------------------------------------------------------------------
  // 顶部：上/下切换 + 标题 + 视图切换
  // -------------------------------------------------------------------
  _buildHeader() {
    const header = UI.el('div', 'calendar-header');

    const nav = UI.el('div', 'calendar-nav');
    const prevBtn = UI.el('button', 'btn btn-ghost btn-sm');
    prevBtn.appendChild(UI.icon('left', 14));
    prevBtn.addEventListener('click', () => this._shift(-1));

    const nextBtn = UI.el('button', 'btn btn-ghost btn-sm');
    nextBtn.appendChild(UI.icon('right', 14));
    nextBtn.addEventListener('click', () => this._shift(1));

    const title = UI.el('div', 'calendar-title', this._title());

    const viewSwitch = UI.el('div', 'view-switch');
    [['month', '月'], ['week', '周'], ['day', '日']].forEach(([v, label]) => {
      const b = UI.el('button', v === this._view ? 'active' : '', label);
      b.addEventListener('click', () => {
        this._view = v;
        this.render();
      });
      viewSwitch.appendChild(b);
    });

    nav.appendChild(prevBtn);
    nav.appendChild(title);
    nav.appendChild(nextBtn);
    header.appendChild(nav);
    header.appendChild(viewSwitch);
    return header;
  },

  /** 生成标题文字 */
  _title() {
    const c = this._cursor;
    if (this._view === 'month') return `${c.getFullYear()}年${c.getMonth() + 1}月`;
    if (this._view === 'week') {
      const s = this._weekStart();
      const e = new Date(s);
      e.setDate(s.getDate() + 6);
      return `${s.getMonth() + 1}月${s.getDate()}日 - ${e.getMonth() + 1}月${e.getDate()}日`;
    }
    return `${c.getFullYear()}年${c.getMonth() + 1}月${c.getDate()}日`;
  },

  /**
   * 按当前视图步进切换
   * @param {number} dir -1 向前，1 向后
   */
  _shift(dir) {
    const d = new Date(this._cursor);
    if (this._view === 'month') d.setMonth(d.getMonth() + dir);
    else if (this._view === 'week') d.setDate(d.getDate() + dir * 7);
    else d.setDate(d.getDate() + dir);
    this._cursor = d;
    this.render();
  },

  /** 返回本周起始（周日） */
  _weekStart() {
    const d = new Date(this._cursor);
    d.setDate(d.getDate() - d.getDay());
    return d;
  },

  // -------------------------------------------------------------------
  // 月视图
  // -------------------------------------------------------------------
  _buildMonth() {
    const grid = UI.el('div', 'calendar-grid');
    ['日', '一', '二', '三', '四', '五', '六'].forEach((w) => {
      grid.appendChild(UI.el('div', 'calendar-weekday', w));
    });
    this._monthCells().forEach((cell) => grid.appendChild(this._buildDayCell(cell)));
    return grid;
  },

  /** 计算当月要渲染的格子（含补位的前/后月） */
  _monthCells() {
    const year = this._cursor.getFullYear();
    const month = this._cursor.getMonth();
    const startWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const cells = [];
    for (let i = startWeekday; i >= 1; i--) {
      const d = new Date(year, month, -i);
      cells.push({ date: d, dateStr: DateUtil.format(d), inMonth: false });
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(year, month, day);
      cells.push({ date: d, dateStr: DateUtil.format(d), inMonth: true });
    }
    let next = 1;
    while (cells.length % 7 !== 0) {
      const d = new Date(year, month + 1, next);
      cells.push({ date: d, dateStr: DateUtil.format(d), inMonth: false });
      next++;
    }
    return cells;
  },

  /** 构建单个日期格子（含事件数量角标） */
  _buildDayCell(cell) {
    const day = UI.el('div', 'calendar-day');
    day.textContent = cell.date.getDate();
    if (!cell.inMonth) day.classList.add('other');
    if (DateUtil.isToday(cell.dateStr)) day.classList.add('today');
    if (cell.dateStr === this._selectedDate) day.classList.add('selected');

    const count = Store.eventsOf(cell.dateStr).length;
    if (count > 0) {
      day.appendChild(UI.el('span', 'day-badge', String(count)));
    }

    day.addEventListener('click', () => {
      this._selectedDate = cell.dateStr;
      this._cursor = cell.date;
      this.openDayPanel(cell.dateStr);
    });
    return day;
  },

  // -------------------------------------------------------------------
  // 周视图
  // -------------------------------------------------------------------
  _buildWeek() {
    const start = this._weekStart();
    const grid = UI.el('div', 'week-grid');
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const ds = DateUtil.format(d);

      const col = UI.el('div', 'week-col');
      if (DateUtil.isToday(ds)) col.classList.add('is-today');
      col.appendChild(UI.el('div', 'week-col-head', `${d.getMonth() + 1}/${d.getDate()} 周${'日一二三四五六'[d.getDay()]}`));

      Store.eventsOf(ds).forEach((ev) => {
        const e = UI.el('div', 'week-evt');
        if (ev.time) e.appendChild(UI.el('span', 't', ev.time));
        e.appendChild(document.createTextNode(ev.title));
        if (ev.done) e.style.textDecoration = 'line-through';
        col.appendChild(e);
      });

      col.addEventListener('click', () => this.openDayPanel(ds));
      grid.appendChild(col);
    }
    return grid;
  },

  // -------------------------------------------------------------------
  // 日视图
  // -------------------------------------------------------------------
  _buildDay() {
    const ds = DateUtil.format(this._cursor);
    const list = UI.el('div', 'day-list');
    const evts = Store.eventsOf(ds);
    if (evts.length === 0) {
      list.appendChild(UI.el('div', 'empty-tip', '这一天没有安排'));
      return list;
    }
    evts.forEach((ev) => list.appendChild(this._buildDayEvent(ev)));
    return list;
  },

  _buildDayEvent(ev) {
    const item = UI.el('div', 'day-evt');
    item.appendChild(UI.el('span', 'evt-time', ev.time || '全天'));
    if (ev.category) item.appendChild(this._categoryTag(ev.category));
    const title = UI.el('span', ev.done ? 'done' : '', ev.title);
    if (ev.done) title.style.textDecoration = 'line-through';
    item.appendChild(title);
    return item;
  },

  // -------------------------------------------------------------------
  // 分类标签（按分类名哈希取色）
  // -------------------------------------------------------------------
  _categoryTag(category) {
    let h = 0;
    for (let i = 0; i < category.length; i++) h = (h * 31 + category.charCodeAt(i)) >>> 0;
    return UI.el('span', 'tag c' + (h % 6), category);
  },

  // -------------------------------------------------------------------
  // 事件面板（模态框）：当日事件列表 + 新建 / 编辑表单
  // -------------------------------------------------------------------
  openDayPanel(dateStr) {
    this._selectedDate = dateStr;

    const container = UI.el('div', '');
    const listWrap = UI.el('div', 'event-list');

    // 编辑态：非空表示正在编辑的事件 id
    let editingId = null;

    // ---- 新建 / 编辑表单 ----
    const form = UI.el('form', '');

    const titleItem = UI.el('div', 'form-item');
    titleItem.appendChild(UI.el('label', '', '标题'));
    const titleInput = UI.el('input', '');
    titleInput.placeholder = '事件标题';
    titleItem.appendChild(titleInput);
    form.appendChild(titleItem);

    const row = UI.el('div', 'form-row');

    const timeItem = UI.el('div', 'form-item');
    timeItem.appendChild(UI.el('label', '', '时间'));
    const timeInput = UI.el('input', '');
    timeInput.type = 'time';
    timeItem.appendChild(timeInput);
    row.appendChild(timeItem);

    const remindItem = UI.el('div', 'form-item');
    remindItem.appendChild(UI.el('label', '', '提醒'));
    const remindSelect = UI.el('select', '');
    [['0', '无提醒'], ['10', '提前 10 分钟'], ['30', '提前 30 分钟'], ['60', '提前 1 小时']].forEach(([v, label]) => {
      const o = UI.el('option', '', label);
      o.value = v;
      remindSelect.appendChild(o);
    });
    remindItem.appendChild(remindSelect);
    row.appendChild(remindItem);

    form.appendChild(row);

    const catItem = UI.el('div', 'form-item');
    catItem.appendChild(UI.el('label', '', '分类标签'));
    const catInput = UI.el('input', '');
    catInput.placeholder = '例如：工作、学习、生活';
    catItem.appendChild(catInput);
    form.appendChild(catItem);

    const actions = UI.el('div', 'form-actions');
    const submitBtn = UI.el('button', 'btn btn-primary', '新建事件');
    submitBtn.type = 'submit';
    const cancelEditBtn = UI.el('button', 'btn btn-ghost', '取消编辑');
    cancelEditBtn.type = 'button';
    cancelEditBtn.style.display = 'none';
    cancelEditBtn.addEventListener('click', () => resetForm());
    actions.appendChild(cancelEditBtn);
    actions.appendChild(submitBtn);
    form.appendChild(actions);

    /** 重置表单为新建立态 */
    function resetForm() {
      editingId = null;
      titleInput.value = '';
      timeInput.value = '';
      remindSelect.value = '0';
      catInput.value = '';
      submitBtn.textContent = '新建事件';
      cancelEditBtn.style.display = 'none';
    }

    /** 回填表单进入编辑态 */
    function fillForm(ev) {
      editingId = ev.id;
      titleInput.value = ev.title;
      timeInput.value = ev.time || '';
      remindSelect.value = String(ev.reminder || '0');
      catInput.value = ev.category || '';
      submitBtn.textContent = '保存修改';
      cancelEditBtn.style.display = '';
    }

    // ---- 事件列表项 ----
    const buildEventItem = (ev) => {
      const item = UI.el('div', 'event-item' + (ev.done ? ' done' : ''));

      const cb = UI.el('input', 'event-checkbox');
      cb.type = 'checkbox';
      cb.checked = !!ev.done;
      cb.addEventListener('change', async () => {
        ev.done = cb.checked;
        await Store.saveEvents();
        Store.notify();
        renderList();
      });

      const info = UI.el('div', 'event-item-info');
      info.appendChild(UI.el('div', 'event-item-title', ev.title));
      const meta = UI.el('div', 'event-item-meta');
      if (ev.time) meta.appendChild(document.createTextNode(ev.time + ' '));
      if (ev.category) meta.appendChild(this._categoryTag(ev.category));
      if (ev.reminder && ev.reminder !== '0') meta.appendChild(document.createTextNode(' 提前' + ev.reminder + '分钟'));
      info.appendChild(meta);

      const act = UI.el('div', 'event-item-actions');
      const editBtn = UI.el('button', 'btn btn-ghost btn-sm');
      editBtn.appendChild(UI.icon('edit', 13));
      editBtn.title = '编辑';
      editBtn.addEventListener('click', () => fillForm(ev));
      const delBtn = UI.el('button', 'btn btn-ghost btn-sm text-danger');
      delBtn.appendChild(UI.icon('trash', 13));
      delBtn.title = '删除';
      delBtn.addEventListener('click', async () => {
        Store.events = Store.events.filter((x) => x.id !== ev.id);
        await Store.saveEvents();
        if (editingId === ev.id) resetForm();
        Store.notify();
        renderList();
      });
      act.appendChild(editBtn);
      act.appendChild(delBtn);

      item.appendChild(cb);
      item.appendChild(info);
      item.appendChild(act);
      return item;
    };

    /** 重建事件列表 */
    const renderList = () => {
      listWrap.innerHTML = '';
      const evts = Store.eventsOf(dateStr);
      if (evts.length === 0) {
        listWrap.appendChild(UI.el('div', 'empty-tip', '这一天还没有事件'));
      } else {
        evts.forEach((ev) => listWrap.appendChild(buildEventItem(ev)));
      }
    };

    // 表单提交：新建或更新事件
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = titleInput.value.trim();
      if (!title) {
        UI.setToast('请填写标题', 'error');
        return;
      }
      const data = {
        title,
        time: timeInput.value,
        reminder: remindSelect.value,
        category: catInput.value.trim()
      };

      if (editingId) {
        const ev = Store.events.find((x) => x.id === editingId);
        if (ev) Object.assign(ev, data);
      } else {
        Store.events.push({ id: 'evt-' + Date.now(), date: dateStr, done: false, ...data });
      }
      await Store.saveEvents();
      resetForm();
      renderList();
      Store.notify();
      UI.setToast('已保存', 'success');
    });

    container.appendChild(listWrap);
    container.appendChild(form);
    renderList();
    UI.openModal(`${dateStr} 的事项`, container);
    titleInput.focus();
  }
};