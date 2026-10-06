// =====================================================================
// modules/sign.js —— 一键签到模块（HTTP 接口签到）
// 原理：一键登录抓取 Cookie → 由主进程代理向签到接口发 HTTP 请求，
//       按「HTTP 状态码」或「响应 JSON 字段」判定签到结果。
//       面向普通用户：登录即可用，技术参数收进「高级设置」折叠区。
// =====================================================================

window.Sign = {
  _tasks: [],
  _running: {},
  _results: {},

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
      '网页自动签到：一键登录后，程序会自动向签到接口发送请求完成签到'
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

    const typeBadge = task.taskType === 'wps' ? 'WPS' : (task.taskType === 'uia' ? 'UIA' : (task.taskType === 'workbuddy' ? 'API' : '网页'));
    const typeClass = task.taskType === 'wps' ? 'sign-type-wps' : (task.taskType === 'uia' ? 'sign-type-uia' : (task.taskType === 'workbuddy' ? 'sign-type-wps' : 'sign-type-web'));
    const typeLabel = UI.el('span', 'sign-type-badge ' + typeClass, typeBadge);
    head.appendChild(typeLabel);

    if (this._running[task.id]) {
      head.appendChild(UI.el('span', 'skill-level sign-status-running', '签到中'));
    } else if (task.lastSignDate === DateUtil.today()) {
      head.appendChild(UI.el('span', 'skill-level sign-status-done', '今日已签'));
    } else {
      head.appendChild(UI.el('span', 'skill-level', '待签到'));
    }
    card.appendChild(head);

    // 请求方法 + 接口地址（WPS/UIA 专用任务不显示 URL）
    if (task.taskType === 'uia') {
      card.appendChild(UI.el('div', 'sign-meta', '桌面应用签到（UIA 自动触发，不碰鼠标）'));
    } else if (task.taskType === 'workbuddy') {
      card.appendChild(UI.el('div', 'sign-meta', 'API 签到（从进程内存提取 token，自动领取积分）'));
    } else if (task.taskType !== 'wps') {
      const urlLine = UI.el('div', 'sign-url-line');
      const method = (task.method || 'GET').toUpperCase();
      urlLine.appendChild(UI.el('span', 'sign-method-badge sign-method-' + method.toLowerCase(), method));
      urlLine.appendChild(UI.el('span', 'sign-url-text', task.url || ''));
      card.appendChild(urlLine);
    } else {
      card.appendChild(UI.el('div', 'sign-meta', 'WPS 每日签到（自动加密）'));
    }

    if (task.lastSignDate) {
      card.appendChild(UI.el('div', 'sign-meta', '上次签到：' + task.lastSignDate));
    }

    if (this._results[task.id]) {
      const msg = this._results[task.id];
      const el = UI.el('div', 'sign-result ' + (msg.success ? 'ok' : 'fail'));
      el.textContent = (msg.success ? '✓ ' : '✗ ') + msg.message;
      card.appendChild(el);
    }

    const actions = UI.el('div', 'skill-actions');

    const signBtn = UI.el('button', 'btn btn-primary btn-sm');
    const wbSignedToday = task.taskType === 'workbuddy' && task.lastSignDate === DateUtil.today();
    signBtn.textContent = wbSignedToday ? '已签·重验' : '签到';
    signBtn.disabled = !!this._running[task.id];
    signBtn.addEventListener('click', () => this._doSign(task));
    actions.appendChild(signBtn);

    if (task.taskType === 'workbuddy') {
      const calBtn = UI.el('button', 'btn btn-ghost btn-sm');
      calBtn.textContent = '校准';
      calBtn.addEventListener('click', () => this._calibrateWorkbuddy(task));
      actions.appendChild(calBtn);
    }

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
    // 今日已签到（lastSignDate 持久化于 data/sign-tasks.json）：不重复请求
    if (task.lastSignDate === DateUtil.today()) {
      if (task.taskType === 'workbuddy') {
        const re = await window.workbench.workbuddyStatus({ procName: task.procName || 'WorkBuddy' });
        if (re && re.ok && re.todayCheckedIn) {
          UI.setToast(`「${task.name}」服务端已记录今日已签，无需重复`, 'success');
          task.lastSignDate = DateUtil.today();
          await this._persist();
          return;
        }
        UI.setToast(`「${task.name}」本地标记已签但服务端未签，重新执行签到`, 'info');
        task.lastSignDate = '';
        await this._persist();
      } else {
        UI.setToast(`「${task.name}」今日已签到，无需重复签到`, 'info');
        return;
      }
    }
    this._running[task.id] = { success: false, message: '' };
    this.render();

    UI.setToast(`正在签到「${task.name}」...`, 'info');

    let verdict;
    try {
      // UI Automation 桌面应用签到（不碰鼠标，程序化 Invoke 按钮）
      if (task.taskType === 'uia') {
        const uiaParams = {
          exePath: task.exePath || '',
          procName: task.procName || '',
          exeArgs: task.exeArgs || [],
          forceRelaunch: task.forceRelaunch || false,
          waitMode: task.waitMode || 'auto',
          closeAfterSign: task.closeAfterSign || false,
          btnKeywords: task.btnKeywords || '',
          doneKeywords: task.doneKeywords || '',
          successKeywords: task.successKeywords || '',
          navName: task.navName || ''
        };
        const _uiaFallback = async () => {
          const res = await window.workbench.executeUiaSign(uiaParams);
          return { success: res.success, message: res.message || (res.success ? '签到成功' : '签到失败') };
        };
        if ((task.procName || '').toLowerCase() === 'hyperdown' && window.workbench.executeHyperdownCdpSign) {
          try {
            const cdpRes = await window.workbench.executeHyperdownCdpSign({ exePath: task.exePath || '' });
            if (cdpRes.success) {
              verdict = { success: true, message: cdpRes.message || '签到成功' };
            } else {
              verdict = await _uiaFallback();
            }
          } catch (e) {
            verdict = await _uiaFallback();
          }
        } else {
          verdict = await _uiaFallback();
        }
      } else if (task.taskType === 'wps') {
        const res = await window.workbench.executeWpsSign({ cookie: task.cookie || '' });
        verdict = {
          success: res.ok,
          message: res.message || (res.ok ? '签到成功' : '签到失败')
        };
      } else if (task.taskType === 'workbuddy') {
        const res = await window.workbench.executeWorkbuddySign({ procName: task.procName || 'WorkBuddy' });
        verdict = {
          success: res.ok,
          message: res.message || (res.ok ? '签到成功' : '签到失败')
        };
      } else {
        // 通用 HTTP 接口签到
        const res = await window.workbench.executeHttpSign({
          url: task.url,
          method: task.method || 'GET',
          cookie: task.cookie || '',
          extraHeaders: task.extraHeaders || '',
          body: task.body || ''
        });
        verdict = this._judge(task, res);
      }

      if (verdict.success) {
        task.lastSignDate = DateUtil.today();
        await this._persist();
        UI.setToast(`「${task.name}」${verdict.message}`, 'success');
      } else {
        UI.setToast(`「${task.name}」签到失败：${verdict.message}`, 'error');
      }
    } catch (err) {
      verdict = { success: false, message: '异常：' + err.message };
      UI.setToast('签到异常：' + err.message, 'error');
    }

    // 签到结束：移除"签到中"状态，结果转入 _results 展示（15 秒后自动清除）
    delete this._running[task.id];
    this._results[task.id] = verdict;
    setTimeout(() => {
      if (this._results[task.id]) {
        delete this._results[task.id];
        this.render();
      }
    }, 15000);

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
    // 跳过今日已签的任务（lastSignDate 持久化记录）
    const today = DateUtil.today();
    const pending = this._tasks.filter((t) => t.lastSignDate !== today);
    if (pending.length === 0) {
      UI.setToast('所有任务今日均已签到', 'info');
      return;
    }
    for (const task of pending) {
      await this._doSign(task);
      await new Promise(r => setTimeout(r, 500));
    }
    UI.setToast('全部签到任务执行完毕', 'success');
  },

  // -------------------------------------------------------------------
  async _calibrateWorkbuddy(task) {
    if (this._running[task.id]) return;
    UI.setToast(`正在校准「${task.name}」状态...`, 'info');
    try {
      const re = await window.workbench.workbuddyStatus({ procName: task.procName || 'WorkBuddy' });
      if (!re || !re.ok) {
        UI.setToast(`校准失败：${(re && re.error) || '查询失败'}`, 'error');
        return;
      }
      if (re.todayCheckedIn) {
        task.lastSignDate = DateUtil.today();
        await this._persist();
        UI.setToast(`校准完成：服务端已记录今日已签${re.streakDays != null ? '（连续' + re.streakDays + '天）' : ''}`, 'success');
      } else {
        task.lastSignDate = '';
        await this._persist();
        UI.setToast('校准完成：服务端记录今日未签到，已清除本地假成功标记', 'info');
      }
      this.render();
    } catch (e) {
      UI.setToast('校准异常：' + e.message, 'error');
    }
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
    const isWps = task?.taskType === 'wps';
    const form = UI.el('form', '');

    // 所有输入控件引用统一声明在函数顶层作用域，避免块级作用域访问不到
    let urlInput, cookieInput, loginBtn, cookieStatus;
    let methodSelect, bodyInput, headerInput;
    let ruleSelect, statusInput, fieldInput, valueInput;
    let bodyItem, statusRow, fieldItem;
    let urlItem, advanced;
    let exePathInput, procNameInput, closeAfterCheckbox, uiaItem;
    let btnKwInput, doneKwInput, successKwInput, navNameInput;

    // ---- 站点模板选择 ----
    const tplItem = UI.el('div', 'form-item');
    tplItem.appendChild(UI.el('label', '', '站点类型'));
    const templateSelect = document.createElement('select');
    const optCustom = UI.el('option', '', '自定义（通用 HTTP 接口）');
    optCustom.value = 'custom';
    const optWps = UI.el('option', '', 'WPS 每日签到');
    optWps.value = 'wps';
    const optUia = UI.el('option', '', '桌面应用（UIA 自动签到，不碰鼠标）');
    optUia.value = 'uia';
    templateSelect.appendChild(optCustom);
    templateSelect.appendChild(optWps);
    templateSelect.appendChild(optUia);
    templateSelect.value = isWps ? 'wps' : (task?.taskType === 'uia' ? 'uia' : 'custom');
    tplItem.appendChild(templateSelect);
    tplItem.appendChild(UI.el('div', 'sf-api-note', '选「桌面应用」通过 Windows UIA 程序化触发签到按钮，不碰鼠标；选「WPS」只需登录即可；选「自定义」需手动填写接口地址。'));
    form.appendChild(tplItem);

    // ---- 任务名称 ----
    const nameItem = UI.el('div', 'form-item');
    nameItem.appendChild(UI.el('label', '', '任务名称'));
    const nameInput = UI.el('input', '');
    nameInput.placeholder = '例如：GLaDOS 签到 / 掘金签到';
    nameInput.value = task?.name || '';
    nameItem.appendChild(nameInput);
    form.appendChild(nameItem);

    // ---- 签到接口地址（自定义模式才显示） ----
    urlItem = UI.el('div', 'form-item');
    urlItem.appendChild(UI.el('label', '', '签到接口地址'));
    urlInput = UI.el('input', '');
    urlInput.placeholder = 'https://example.com/api/user/checkin';
    urlInput.value = task?.url || '';
    urlItem.appendChild(urlInput);
    urlItem.appendChild(UI.el('div', 'sf-api-note', '就是点「签到」时后台请求的那个网址，一般和网站域名相同。'));
    form.appendChild(urlItem);

    // ---- 桌面应用路径（UIA 模式才显示） ----
    uiaItem = UI.el('div', 'form-item');
    uiaItem.appendChild(UI.el('label', '', '目标程序路径'));
    const exeRow = UI.el('div', 'sign-cookie-row');
    exePathInput = UI.el('input', '');
    exePathInput.placeholder = 'D:\\DDL\\Hyperdown\\Hyperdown.exe';
    exePathInput.value = task?.exePath || '';
    exePathInput.style.flex = '1';
    const browseBtn = UI.el('button', 'btn btn-ghost', '浏览…');
    browseBtn.type = 'button';
    browseBtn.addEventListener('click', async () => {
      const res = await window.workbench.selectPath('file');
      if (res && !res.canceled && res.path) exePathInput.value = res.path;
    });
    exeRow.appendChild(exePathInput);
    exeRow.appendChild(browseBtn);
    uiaItem.appendChild(exeRow);
    uiaItem.appendChild(UI.el('div', 'sf-api-note', '签到时若程序未运行会自动启动，已运行则直接触发签到按钮。'));

    const procItem = UI.el('div', 'form-item');
    procItem.appendChild(UI.el('label', '', '进程名（可选，不填自动从路径推导）'));
    procNameInput = UI.el('input', '');
    procNameInput.placeholder = 'Hyperdown';
    procNameInput.value = task?.procName || '';
    procItem.appendChild(procNameInput);
    uiaItem.appendChild(procItem);

    const closeItem = UI.el('div', 'form-item');
    const closeLabel = UI.el('label', '');
    closeAfterCheckbox = UI.el('input', '');
    closeAfterCheckbox.type = 'checkbox';
    closeAfterCheckbox.checked = task?.closeAfterSign || false;
    closeAfterCheckbox.style.marginRight = '6px';
    closeLabel.appendChild(closeAfterCheckbox);
    closeLabel.appendChild(document.createTextNode('签到后自动关闭目标程序'));
    closeItem.appendChild(closeLabel);
    uiaItem.appendChild(closeItem);

    // UIA 按钮匹配参数（高级，一般自动检测已预置）
    const uiaAdv = document.createElement('details');
    uiaAdv.className = 'sign-advanced';
    const uiaAdvSummary = document.createElement('summary');
    uiaAdvSummary.textContent = '按钮匹配设置（高级，一般不用改）';
    uiaAdv.appendChild(uiaAdvSummary);

    const btnKwItem = UI.el('div', 'form-item');
    btnKwItem.appendChild(UI.el('label', '', '按钮关键词（管道分隔，默认 签到|打卡）'));
    btnKwInput = UI.el('input', '');
    btnKwInput.placeholder = '签到|打卡';
    btnKwInput.value = task?.btnKeywords || '';
    btnKwItem.appendChild(btnKwInput);
    uiaAdv.appendChild(btnKwItem);

    const doneKwItem = UI.el('div', 'form-item');
    doneKwItem.appendChild(UI.el('label', '', '已完成关键词（管道分隔，默认 已签）'));
    doneKwInput = UI.el('input', '');
    doneKwInput.placeholder = '已签';
    doneKwInput.value = task?.doneKeywords || '';
    doneKwItem.appendChild(doneKwInput);
    uiaAdv.appendChild(doneKwItem);

    const successKwItem = UI.el('div', 'form-item');
    successKwItem.appendChild(UI.el('label', '', '成功关键词（管道分隔）'));
    successKwInput = UI.el('input', '');
    successKwInput.placeholder = '签到成功|今日已签|已签到|领取成功|已领取';
    successKwInput.value = task?.successKeywords || '';
    successKwItem.appendChild(successKwInput);
    uiaAdv.appendChild(successKwItem);

    const navNameItem = UI.el('div', 'form-item');
    navNameItem.appendChild(UI.el('label', '', '导航按钮名（空表示不需要导航）'));
    navNameInput = UI.el('input', '');
    navNameInput.placeholder = '首页';
    navNameInput.value = task?.navName ?? '首页';
    navNameItem.appendChild(navNameInput);
    uiaAdv.appendChild(navNameItem);

    uiaItem.appendChild(uiaAdv);

    form.appendChild(uiaItem);

    // ---- 登录状态（一键登录） ----
    const cookieItem = UI.el('div', 'form-item');
    cookieItem.appendChild(UI.el('label', '', '登录状态'));
    const cookieRow = UI.el('div', 'sign-cookie-row');
    loginBtn = UI.el('button', 'btn btn-primary', '一键登录');
    loginBtn.type = 'button';
    cookieStatus = UI.el('span', 'sign-cookie-status', task?.cookie ? '已配置 ✓' : '');
    cookieRow.appendChild(loginBtn);
    cookieRow.appendChild(cookieStatus);
    cookieItem.appendChild(cookieRow);
    cookieItem.appendChild(UI.el('div', 'sf-api-note', '点「一键登录」→ 在弹出的网页中登录 → 关掉窗口，程序会自动抓取登录状态。'));
    form.appendChild(cookieItem);

    // ---- 高级设置（折叠，一般不用改；WPS 模式下隐藏） ----
    advanced = document.createElement('details');
    advanced.className = 'sign-advanced';
    const summary = document.createElement('summary');
    summary.textContent = '高级设置（选填，一般不用改）';
    advanced.appendChild(summary);

    // Cookie 文本（自动获取，也可手动编辑/粘贴）
    const cookieText = UI.el('div', 'form-item');
    cookieText.appendChild(UI.el('label', '', 'Cookie（一键登录自动填写，也可手动粘贴）'));
    cookieInput = UI.el('textarea', 'sign-textarea');
    cookieInput.placeholder = '一键登录会自动填写，也可以手动粘贴 F12 抓到的 Cookie';
    cookieInput.value = task?.cookie || '';
    cookieText.appendChild(cookieInput);
    advanced.appendChild(cookieText);

    // 请求方式
    const methodItem = UI.el('div', 'form-item');
    methodItem.appendChild(UI.el('label', '', '请求方式'));
    methodSelect = document.createElement('select');
    ['POST', 'GET'].forEach((m) => {
      const o = UI.el('option', '', m);
      o.value = m;
      methodSelect.appendChild(o);
    });
    methodSelect.value = task?.method || 'POST';
    methodItem.appendChild(methodSelect);
    advanced.appendChild(methodItem);

    // 请求体
    bodyItem = UI.el('div', 'form-item');
    bodyItem.appendChild(UI.el('label', '', '请求体（POST 时填写）'));
    bodyInput = UI.el('textarea', 'sign-textarea');
    bodyInput.placeholder = '{"token":"example.com"}   或   key1=value1&key2=value2';
    bodyInput.value = task?.body || '';
    bodyItem.appendChild(bodyInput);
    advanced.appendChild(bodyItem);

    // 额外请求头
    const headerItem = UI.el('div', 'form-item');
    headerItem.appendChild(UI.el('label', '', '额外请求头（每行 Key: Value）'));
    headerInput = UI.el('textarea', 'sign-textarea');
    headerInput.placeholder = 'authorization: Bearer xxx';
    headerInput.value = task?.extraHeaders || '';
    headerItem.appendChild(headerInput);
    advanced.appendChild(headerItem);

    // 成功判定方式
    const ruleItem = UI.el('div', 'form-item');
    ruleItem.appendChild(UI.el('label', '', '怎样算签到成功'));
    ruleSelect = document.createElement('select');
    const optStatus = UI.el('option', '', '网址返回 200 就算成功（默认）');
    optStatus.value = 'status';
    const optJson = UI.el('option', '', '返回内容里某个字段等于某个值');
    optJson.value = 'json';
    ruleSelect.appendChild(optStatus);
    ruleSelect.appendChild(optJson);
    ruleSelect.value = task?.successType || 'status';
    ruleItem.appendChild(ruleSelect);
    advanced.appendChild(ruleItem);

    // 期望状态码
    statusRow = UI.el('div', 'form-item');
    statusRow.appendChild(UI.el('label', '', '期望状态码'));
    statusInput = UI.el('input', '');
    statusInput.type = 'number';
    statusInput.value = task?.successStatus ?? 200;
    statusRow.appendChild(statusInput);
    advanced.appendChild(statusRow);

    // JSON 字段判定
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
    advanced.appendChild(fieldItem);

    form.appendChild(advanced);

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

    // 切换模板：WPS 模式隐藏 URL 和高级设置，自动填充名称
    const applyTemplate = () => {
      const tpl = templateSelect.value;
      const wps = tpl === 'wps';
      const uia = tpl === 'uia';
      urlItem.style.display = (wps || uia) ? 'none' : '';
      advanced.style.display = (wps || uia) ? 'none' : '';
      uiaItem.style.display = uia ? '' : 'none';
      cookieItem.style.display = uia ? 'none' : '';
      if (wps && !nameInput.value.trim()) nameInput.value = 'WPS';
      if (uia && !nameInput.value.trim()) nameInput.value = 'Hyperdown 签到';
    };
    templateSelect.addEventListener('change', applyTemplate);
    applyTemplate();

    // 一键登录：打开窗口 → 轮询抓 cookie
    loginBtn.addEventListener('click', async () => {
      const wps = templateSelect.value === 'wps';
      // WPS 模式用固定登录地址，自定义模式用用户填的 URL
      const loginUrl = wps ? 'https://personal-act.wps.cn' : urlInput.value.trim();
      if (!/^https?:\/\//i.test(loginUrl)) { UI.setToast('请先填写正确的签到接口地址', 'error'); return; }
      loginBtn.disabled = true;
      cookieStatus.style.color = 'var(--text-muted)';
      cookieStatus.textContent = '请在弹出网页中登录，登录后关掉窗口…';
      try {
        const openRes = await window.workbench.openSignLogin({ url: loginUrl });
        if (!openRes || !openRes.success) {
          cookieStatus.textContent = '打开登录页失败';
          UI.setToast(openRes && openRes.message ? openRes.message : '打开失败', 'error');
          return;
        }
        let lastCount = -1, stable = 0;
        for (let i = 0; i < 80; i++) {
          await new Promise(r => setTimeout(r, 1500));
          // WPS 模式抓所有 .wps.cn 域名 Cookie，自定义模式按 URL 域名过滤
          const res = wps
            ? await window.workbench.fetchSignCookieWps()
            : await window.workbench.fetchSignCookie({ url: loginUrl });
          if (res && res.success && res.count > 0) {
            if (res.count === lastCount) stable++; else { stable = 0; lastCount = res.count; }
            cookieStatus.textContent = '检测到登录（' + res.count + ' 项）…';
            if (stable >= 2) {
              cookieInput.value = res.cookie;
              cookieStatus.style.color = '#52c41a';
              cookieStatus.textContent = '已登录 ✓（' + res.count + ' 项）';
              UI.setToast('已获取登录状态', 'success');
              break;
            }
          } else {
            cookieStatus.textContent = '等待登录…';
          }
        }
        if (!cookieInput.value) {
          cookieStatus.style.color = 'var(--danger)';
          cookieStatus.textContent = '未检测到登录，请确认已登录后重试';
        }
      } catch (err) {
        cookieStatus.style.color = 'var(--danger)';
        cookieStatus.textContent = '异常：' + err.message;
        UI.setToast('登录异常：' + err.message, 'error');
      } finally {
        loginBtn.disabled = false;
      }
    });

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
      if (!name) { UI.setToast('请填写任务名称', 'error'); return; }

      const tpl = templateSelect.value;
      const uia = tpl === 'uia';
      const cookie = cookieInput.value.trim();
      if (!uia && !cookie) { UI.setToast('请先点「一键登录」获取登录状态', 'error'); return; }

      UI.setBtnLoading(saveBtn, true, '保存中…');
      try {
        const wps = tpl === 'wps';
        let data;

        if (uia) {
          // UIA 桌面应用签到：只需名称 + 程序路径
          const exePath = exePathInput.value.trim();
          if (!exePath) { UI.setToast('请填写目标程序路径', 'error'); return; }
          data = {
            taskType: 'uia',
            name,
            exePath,
            procName: procNameInput.value.trim(),
            exeArgs: task?.exeArgs || [],
            forceRelaunch: task?.forceRelaunch || false,
            closeAfterSign: closeAfterCheckbox.checked,
            btnKeywords: btnKwInput.value.trim(),
            doneKeywords: doneKwInput.value.trim(),
            successKeywords: successKwInput.value.trim(),
            navName: navNameInput.value.trim()
          };
        } else if (wps) {
          // WPS 专用签到：只需名称 + Cookie
          data = { taskType: 'wps', name, cookie };
        } else {
          // 自定义 HTTP 接口签到
          const url = urlInput.value.trim();
          if (!url) { UI.setToast('请填写签到接口地址', 'error'); return; }
          if (!/^https?:\/\//i.test(url)) { UI.setToast('网址需以 http:// 或 https:// 开头', 'error'); return; }
          data = {
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
        }

        if (editing) {
          // 编辑时清理旧字段（如从自定义切换到 WPS）
          Object.keys(task).forEach((k) => { if (!(k in data) && k !== 'id' && k !== 'lastSignDate') delete task[k]; });
          Object.assign(task, data);
        } else {
          this._tasks.push({ id: 'sign-' + Date.now(), ...data, lastSignDate: null });
        }

        await this._persist();
        UI.closeModal();
        this.render();
        UI.setToast(editing ? '已保存' : '已添加', 'success');
      } finally {
        UI.setBtnLoading(saveBtn, false);
      }
    });

    UI.openModal(editing ? '编辑签到任务' : '添加签到任务', form);
    nameInput.focus();
  }
};