// =====================================================================
// modules/sign.js —— 一键签到模块（HTTP 接口签到）
// 原理：抓取登录态 Cookie → 由主进程代理向签到接口发 HTTP 请求，
//       按「HTTP 状态码」或「响应 JSON 字段」判定签到结果。
//       不依赖浏览器 / 按钮选择器（Glados 式），稳定快速跨域无忧。
// =====================================================================

window.Sign = {
  _tasks: [],
  _running: {},

  // -------------------------------------------------------------------
  async init() {
    try {
      const saved = await window.workbench.loadSignTasks();
      // 移除旧版桌面任务（本次仅保留网页 HTTP 接口签到）
      this._tasks = Array.isArray(saved) ? saved.filter((t) => t && t.taskType !== 'desktop') : [];
    } catch (e) {
      this._tasks = [];
    }
    Store.onChange(() => this.render());
    this.render();
  },

  // -------------------------------------------------------------------
  async _persist() {
    await window.workbench.saveSignTasks(this._tasks);
  },

  // -------------------------------------------------------------------
  render() {
    const page = document.getElementById('page-sign');
    page.innerHTML = '';

    const section = UI.el('div', 'section');

    const title = UI.el('div', 'section-title');
    title.appendChild(UI.el('span', '', '一键签到'));
    const addBtn = UI.el('button', 'btn btn-primary btn-sm');
    addBtn.appendChild(UI.icon('plus', 14));
    addBtn.appendChild(UI.el('span', '', '添加任务'));
    addBtn.addEventListener('click', () => this._openAddModal());
    title.appendChild(addBtn);
    section.appendChild(title);

    section.appendChild(UI.el('div', 'sf-desc',
      '基于 HTTP 接口的网页签到：登录目标网站后抓取 Cookie，填入即可定时向签到接口发送请求自动签到'
    ));

    if (this._tasks.length > 0) {
      const bar = UI.el('div', 'sign-action-bar');
      const batchBtn = UI.el('button', 'btn btn-primary sign-batch-btn');
      batchBtn.appendChild(UI.icon('play', 14));
      batchBtn.appendChild(UI.el('span', '', '一键全签到'));
      batchBtn.addEventListener('click', () => this._signAll());
      bar.appendChild(batchBtn);
      section.appendChild(bar);
    }

    const grid = UI.el('div', 'skill-grid');
    if (this._tasks.length === 0) {
      grid.appendChild(UI.el('div', 'empty-tip', '暂无签到任务，点击「添加任务」开始'));
    } else {
      this._tasks.forEach((task) => grid.appendChild(this._buildTaskCard(task)));
    }
    section.appendChild(grid);

    page.appendChild(section);
  },

  // -------------------------------------------------------------------
  _buildTaskCard(task) {
    const card = UI.el('div', 'skill-card sign-card');

    const head = UI.el('div', 'skill-card-head');
    head.appendChild(UI.el('div', 'skill-name', task.name));

    const typeLabel = UI.el('span', 'sign-type-badge sign-type-web', '网页');
    head.appendChild(typeLabel);

    if (this._running[task.id]) {
      head.appendChild(UI.el('span', 'skill-level sign-status-running', '签到中'));
    } else if (task.lastSignDate === DateUtil.today()) {
      head.appendChild(UI.el('span', 'skill-level sign-status-done', '今日已签'));
    } else {
      head.appendChild(UI.el('span', 'skill-level', '待签到'));
    }
    card.appendChild(head);

    // 请求方法 + 接口地址
    const urlLine = UI.el('div', 'sign-url-line');
    const method = (task.method || 'GET').toUpperCase();
    urlLine.appendChild(UI.el('span', 'sign-method-badge sign-method-' + method.toLowerCase(), method));
    urlLine.appendChild(UI.el('span', 'sign-url-text', task.url || ''));
    card.appendChild(urlLine);

    if (task.lastSignDate) {
      card.appendChild(UI.el('div', 'sign-meta', '上次签到：' + task.lastSignDate));
    }

    if (this._running[task.id]?.message) {
      const msg = this._running[task.id];
      const el = UI.el('div', 'sign-result ' + (msg.success ? 'ok' : 'fail'));
      el.textContent = (msg.success ? '✓ ' : '✗ ') + msg.message;
      card.appendChild(el);
    }

    const actions = UI.el('div', 'skill-actions');

    const signBtn = UI.el('button', 'btn btn-primary btn-sm');
    signBtn.textContent = '签到';
    signBtn.disabled = !!this._running[task.id];
    signBtn.addEventListener('click', () => this._doSign(task));
    actions.appendChild(signBtn);

    const editBtn = UI.el('button', 'btn btn-ghost btn-sm');
    editBtn.textContent = '编辑';
    editBtn.addEventListener('click', () => this._openEditModal(task));
    actions.appendChild(editBtn);

    const delBtn = UI.el('button', 'btn btn-ghost btn-sm sign-del');
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => this._removeTask(task));
    actions.appendChild(delBtn);

    card.appendChild(actions);
    return card;
  },

  // -------------------------------------------------------------------
  async _doSign(task) {
    if (this._running[task.id]) return;
    this._running[task.id] = { success: false, message: '' };
    this.render();

    UI.setToast(`正在签到「${task.name}」...`, 'info');

    try {
      const res = await window.workbench.executeHttpSign({
        url: task.url,
        method: task.method || 'GET',
        cookie: task.cookie || '',
        extraHeaders: task.extraHeaders || '',
        body: task.body || ''
      });

      const verdict = this._judge(task, res);
      this._running[task.id] = { success: verdict.success, message: verdict.message };

      if (verdict.success) {
        task.lastSignDate = DateUtil.today();
        await this._persist();
        UI.setToast(`「${task.name}」签到成功！`, 'success');
      } else {
        UI.setToast(`「${task.name}」签到失败：${verdict.message}`, 'error');
      }
    } catch (err) {
      this._running[task.id] = { success: false, message: '异常：' + err.message };
      UI.setToast('签到异常：' + err.message, 'error');
    }

    this.render();
  },

  /**
   * 判定签到结果
   * @param {object} task 任务配置
   * @param {{ok: boolean, statusCode?: number, body?: string, error?: string}} res 主进程返回
   * @returns {{success: boolean, message: string}}
   */
  _judge(task, res) {
    if (!res || !res.ok) {
      return { success: false, message: (res && res.error) || '请求失败' };
    }
    // JSON 字段判定：响应 JSON 的某个字段值 == 期望值（如 code == 0）
    if (task.successType === 'json') {
      try {
        const data = JSON.parse(res.body);
        const field = task.successField || 'code';
        const val = this._digPath(data, field);
        if (String(val) === String(task.successValue ?? '')) {
          return { success: true, message: '签到成功（' + field + '=' + val + '）' };
        }
        return { success: false, message: '判定失败：' + field + '=' + (val ?? '空') + '，期望 ' + task.successValue };
      } catch (e) {
        return { success: false, message: '响应非 JSON：' + String(res.body).slice(0, 80) };
      }
    }
    // 状态码判定：HTTP 状态码 == 期望值（默认 200）
    const expect = parseInt(task.successStatus ?? 200, 10);
    if (res.statusCode === expect) {
      return { success: true, message: '签到成功（HTTP ' + res.statusCode + '）' };
    }
    return { success: false, message: 'HTTP ' + res.statusCode + '：' + String(res.body).slice(0, 80) };
  },

  /** 取 JSON 嵌套字段（点路径，如 data.code） */
  _digPath(obj, path) {
    try {
      return String(path).split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
    } catch (e) {
      return undefined;
    }
  },

  // -------------------------------------------------------------------
  async _signAll() {
    for (const task of this._tasks) {
      await this._doSign(task);
      await new Promise(r => setTimeout(r, 500));
    }
    UI.setToast('全部签到任务执行完毕', 'success');
  },

  // -------------------------------------------------------------------
  async _removeTask(task) {
    if (!confirm(`确定删除签到任务「${task.name}」吗？`)) return;
    this._tasks = this._tasks.filter(t => t.id !== task.id);
    await this._persist();
    this.render();
  },

  // -------------------------------------------------------------------
  _openAddModal() { this._openFormModal(null); },
  _openEditModal(task) { this._openFormModal(task); },

  _openFormModal(task) {
    const editing = !!task;
    const form = UI.el('form', '');

    // 所有输入控件引用统一声明在函数顶层作用域，
    // 避免块级作用域导致 submit / 切换处理器访问不到
    let methodSelect, cookieInput, bodyInput, headerInput;
    let ruleSelect, statusInput, fieldInput, valueInput;
    let bodyItem, statusRow, fieldItem;

    // ---- 任务名称 ----
    const nameItem = UI.el('div', 'form-item');
    nameItem.appendChild(UI.el('label', '', '任务名称'));
    const nameInput = UI.el('input', '');
    nameInput.placeholder = '例如：GLaDOS 签到 / 掘金签到';
    nameInput.value = task?.name || '';
    nameItem.appendChild(nameInput);
    form.appendChild(nameItem);

    // ---- 签到接口 URL ----
    const urlItem = UI.el('div', 'form-item');
    urlItem.appendChild(UI.el('label', '', '签到接口 URL'));
    const urlInput = UI.el('input', '');
    urlInput.placeholder = 'https://example.com/api/user/checkin';
    urlInput.value = task?.url || '';
    urlItem.appendChild(urlInput);
    form.appendChild(urlItem);

    // ---- 请求方法 ----
    const methodItem = UI.el('div', 'form-item');
    methodItem.appendChild(UI.el('label', '', '请求方法'));
    methodSelect = document.createElement('select');
    ['POST', 'GET'].forEach((m) => {
      const o = UI.el('option', '', m);
      o.value = m;
      methodSelect.appendChild(o);
    });
    methodSelect.value = task?.method || 'POST';
    methodItem.appendChild(methodSelect);
    form.appendChild(methodItem);

    // ---- Cookie ----
    const cookieItem = UI.el('div', 'form-item');
    cookieItem.appendChild(UI.el('label', '', 'Cookie（登录态，核心）'));
    cookieInput = UI.el('textarea', 'sign-textarea');
    cookieInput.placeholder = 'koa:sess=...; koa:sess.sig=...; 其他键=值...';
    cookieInput.value = task?.cookie || '';
    cookieItem.appendChild(cookieInput);
    cookieItem.appendChild(UI.el('div', 'sf-api-note',
      '登录目标网站后按 F12 → Network，点任意请求，复制 Request Headers 里的 Cookie'
    ));
    form.appendChild(cookieItem);

    // ---- 请求体（POST） ----
    bodyItem = UI.el('div', 'form-item');
    bodyItem.appendChild(UI.el('label', '', '请求体（POST 时填写）'));
    bodyInput = UI.el('textarea', 'sign-textarea');
    bodyInput.placeholder = '{"token":"example.com"}   或   key1=value1&key2=value2';
    bodyInput.value = task?.body || '';
    bodyItem.appendChild(bodyInput);
    form.appendChild(bodyItem);

    // ---- 额外请求头 ----
    const headerItem = UI.el('div', 'form-item');
    headerItem.appendChild(UI.el('label', '', '额外请求头（可选，每行 Key: Value）'));
    headerInput = UI.el('textarea', 'sign-textarea');
    headerInput.placeholder = 'authorization: Bearer xxx\nx-csrf-token: abc123';
    headerInput.value = task?.extraHeaders || '';
    headerItem.appendChild(headerInput);
    form.appendChild(headerItem);

    // ---- 成功判定方式 ----
    const ruleItem = UI.el('div', 'form-item');
    ruleItem.appendChild(UI.el('label', '', '成功判定方式'));
    ruleSelect = document.createElement('select');
    const optStatus = UI.el('option', '', 'HTTP 状态码匹配（默认 200）');
    optStatus.value = 'status';
    const optJson = UI.el('option', '', '响应 JSON 字段匹配（如 code=0）');
    optJson.value = 'json';
    ruleSelect.appendChild(optStatus);
    ruleSelect.appendChild(optJson);
    ruleSelect.value = task?.successType || 'status';
    ruleItem.appendChild(ruleSelect);
    form.appendChild(ruleItem);

    // ---- 期望状态码（status 判定） ----
    statusRow = UI.el('div', 'form-item');
    statusRow.appendChild(UI.el('label', '', '期望状态码'));
    statusInput = UI.el('input', '');
    statusInput.type = 'number';
    statusInput.value = task?.successStatus ?? 200;
    statusRow.appendChild(statusInput);
    form.appendChild(statusRow);

    // ---- JSON 字段判定 ----
    fieldItem = UI.el('div', 'form-item');
    fieldItem.appendChild(UI.el('label', '', '判定字段 + 期望值'));
    const fieldRow = UI.el('div', 'sign-rule-row');
    fieldInput = UI.el('input', '');
    fieldInput.placeholder = '字段，如 code';
    fieldInput.value = task?.successField || 'code';
    valueInput = UI.el('input', '');
    valueInput.placeholder = '期望值，如 0';
    valueInput.value = task?.successValue ?? '0';
    fieldRow.appendChild(fieldInput);
    fieldRow.appendChild(valueInput);
    fieldItem.appendChild(fieldRow);
    form.appendChild(fieldItem);

    // 切换显隐：POST 才显示请求体；json 判定才显示字段配置
    const applyRule = () => {
      const isJson = ruleSelect.value === 'json';
      statusRow.style.display = isJson ? 'none' : '';
      fieldItem.style.display = isJson ? '' : 'none';
      bodyItem.style.display = methodSelect.value === 'POST' ? '' : 'none';
    };
    methodSelect.addEventListener('change', applyRule);
    ruleSelect.addEventListener('change', applyRule);
    applyRule();

    // ---- 按钮 ----
    const actions = UI.el('div', 'form-actions');
    const cancelBtn = UI.el('button', 'btn btn-ghost', '取消');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => UI.closeModal());
    const saveBtn = UI.el('button', 'btn btn-primary', editing ? '保存' : '添加');
    saveBtn.type = 'submit';
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    form.appendChild(actions);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      const url = urlInput.value.trim();
      if (!name) { UI.setToast('请填写任务名称', 'error'); return; }
      if (!url) { UI.setToast('请填写签到接口 URL', 'error'); return; }
      if (!/^https?:\/\//i.test(url)) { UI.setToast('URL 需以 http:// 或 https:// 开头', 'error'); return; }
      const cookie = cookieInput.value.trim();
      if (!cookie) { UI.setToast('请填写 Cookie', 'error'); return; }

      const data = {
        taskType: 'web',
        name,
        url,
        method: methodSelect.value,
        cookie,
        extraHeaders: headerInput.value.trim(),
        body: bodyInput.value.trim(),
        successType: ruleSelect.value,
        successStatus: parseInt(statusInput.value, 10) || 200,
        successField: fieldInput.value.trim() || 'code',
        successValue: valueInput.value.trim()
      };

      if (editing) {
        Object.assign(task, data);
      } else {
        this._tasks.push({ id: 'sign-' + Date.now(), ...data, lastSignDate: null });
      }

      await this._persist();
      UI.closeModal();
      this.render();
      UI.setToast(editing ? '已保存' : '已添加', 'success');
    });

    UI.openModal(editing ? '编辑签到任务' : '添加签到任务', form);
    nameInput.focus();
  }
};