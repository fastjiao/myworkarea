// =====================================================================
// modules/sign.js —— 一键签到模块
// 任务类型：
//   web     → BrowserWindow + executeJavaScript（网页自动点击）
//   desktop → PowerShell 脚本（桌面程序 SendKeys / 坐标点击 / UIAutomation）
// =====================================================================

window.Sign = {
  _tasks: [],
  _running: {},
  _psTemplates: [],  // 内置 PowerShell 脚本模板（主进程返回）

  // -------------------------------------------------------------------
  async init() {
    const saved = await window.workbench.loadSignTasks();
    if (Array.isArray(saved) && saved.length > 0) {
      this._tasks = saved;
    } else {
      this._tasks = [
        {
          id: 'sign-example-1',
          taskType: 'web',
          name: '掘金签到',
          url: 'https://juejin.cn/user/center/signin',
          buttonSelector: '',
          successText: '已签到',
          lastSignDate: null,
          nextSignDate: null
        }
      ];
    }
    // 确保旧数据有 taskType 字段
    this._tasks.forEach(t => { if (!t.taskType) t.taskType = t.exePath ? 'desktop' : 'web'; });
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
      '支持两种任务：① 网页任务（自动点网页按钮）② 桌面任务（PowerShell 控制 .exe 程序，零外部依赖）'
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

    // 类型徽章
    const typeLabel = UI.el('span', 'sign-type-badge sign-type-' + (task.taskType || 'web'));
    typeLabel.textContent = task.taskType === 'desktop' ? '桌面' : '网页';
    head.appendChild(typeLabel);

    if (this._running[task.id]) {
      head.appendChild(UI.el('span', 'skill-level sign-status-running', '签到中'));
    } else if (task.lastSignDate === DateUtil.today()) {
      head.appendChild(UI.el('span', 'skill-level sign-status-done', '今日已签'));
    } else {
      head.appendChild(UI.el('span', 'skill-level', '待签到'));
    }
    card.appendChild(head);

    // 根据任务类型显示不同的描述
    if (task.taskType === 'desktop') {
      // 桌面任务：不在卡片上显示 exe 完整路径（路径在编辑弹窗中可见）
      if (task.psScript) {
        const psPreview = UI.el('div', 'sign-script-preview');
        psPreview.textContent = 'PowerShell: ' + this._truncate(task.psScript.replace(/\s+/g, ' '), 60);
        card.appendChild(psPreview);
      }
      if (task.closeAfterSign) {
        card.appendChild(UI.el('div', 'sign-auto-close-tag', '签到后自动退出程序'));
      }
    }
    // 网页任务：URL 也不在卡片上展示，通过「打开」按钮访问签到页

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

    // 桌面任务的「打开」按钮改叫「启动」
    const toggleBtn = UI.el('button', 'btn btn-ghost btn-sm');
    toggleBtn.textContent = task.taskType === 'desktop' ? '启动' : '打开';
    toggleBtn.addEventListener('click', () => this._toggleWindow(task));
    actions.appendChild(toggleBtn);

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

  _truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.substring(0, max) + '…' : str;
  },

  // -------------------------------------------------------------------
  async _toggleWindow(task) {
    if (task.taskType === 'desktop') {
      // 桌面任务：用 PowerShell 启动 exe 并最大化显示
      if (!task.exePath) { UI.setToast('未配置可执行文件路径', 'error'); return; }
      const res = await window.workbench.executeDesktopSign({
        exePath: task.exePath,
        exeArgs: task.exeArgs || [],
        waitMode: 'fixed',
        launchDelay: 0,  // 只启动不执行脚本，不做就绪等待
        psScript: ''
      });
      if (res.success) {
        UI.setToast(`已启动「${task.name}」`, 'success');
      } else {
        UI.setToast(res.message || '启动失败', 'error');
      }
    } else {
      // 网页任务：打开隐藏 BrowserWindow
      const res = await window.workbench.toggleSignWindow({ taskId: task.id, url: task.url });
      if (res.success) {
        UI.setToast(res.message || '切换成功', 'success');
      } else {
        UI.setToast(res.message || '切换失败', 'error');
      }
    }
  },

  // -------------------------------------------------------------------
  async _doSign(task) {
    if (this._running[task.id]) return;
    this._running[task.id] = { success: false, message: '' };
    this.render();

    UI.setToast(`正在签到「${task.name}」...`, 'info');

    try {
      let res;
      if (task.taskType === 'desktop') {
        res = await window.workbench.executeDesktopSign({
          exePath: task.exePath || '',
          exeArgs: task.exeArgs || [],
          waitMode: task.waitMode || 'auto',
          waitWindowTitle: task.waitWindowTitle || '',
          launchDelay: task.launchDelay ?? 3000,
          psScript: task.psScript || '',
          verifyScript: task.verifyScript || '',
          closeAfterSign: !!task.closeAfterSign
        });
      } else {
        res = await window.workbench.executeSign({
          taskId: task.id,
          url: task.url,
          buttonSelector: task.buttonSelector || '',
          successText: task.successText || ''
        });
      }

      this._running[task.id] = { success: res.success, message: res.message || '执行完成' };

      if (res.success) {
        task.lastSignDate = DateUtil.today();
        await this._persist();
        UI.setToast(`「${task.name}」签到成功！`, 'success');
      } else {
        UI.setToast(`「${task.name}」签到失败：${res.message}`, 'error');
      }
    } catch (err) {
      this._running[task.id] = { success: false, message: '异常：' + err.message };
      UI.setToast('签到异常：' + err.message, 'error');
    }

    this.render();
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

  async _openFormModal(task) {
    const editing = !!task;
    const isDesktop = (task?.taskType === 'desktop');
    const form = UI.el('form', '');

    // 所有输入控件引用统一声明在函数顶层作用域，
    // 避免块级作用域导致 submit 处理器访问不到（ReferenceError → 按钮无反应）
    let urlInput, btnInput, sucInput;
    let exeInput, delayInput, psInput, closeAfterCheck;
    let waitModeSelect, waitTitleInput;

    // ---- 任务名称 ----
    const nameItem = UI.el('div', 'form-item');
    nameItem.appendChild(UI.el('label', '', '任务名称'));
    const nameInput = UI.el('input', '');
    nameInput.placeholder = '例如：掘金签到 / Hyperdown 打开';
    nameInput.value = task?.name || '';
    nameItem.appendChild(nameInput);
    form.appendChild(nameItem);

    // ---- 任务类型切换 ----
    const typeItem = UI.el('div', 'form-item');
    typeItem.appendChild(UI.el('label', '', '任务类型'));
    const typeWrap = UI.el('div', 'sign-type-switch');
    const webOpt = UI.el('button', 'sign-type-opt' + (!isDesktop ? ' active' : ''), '网页');
    const desktopOpt = UI.el('button', 'sign-type-opt' + (isDesktop ? ' active' : ''), '桌面 .exe');
    let currentType = isDesktop ? 'desktop' : 'web';
    typeWrap.appendChild(webOpt);
    typeWrap.appendChild(desktopOpt);
    typeItem.appendChild(typeWrap);
    form.appendChild(typeItem);

    // ====== 网页任务字段 ======
    const webFields = UI.el('div', 'sign-type-fields');
    {
      const urlItem = UI.el('div', 'form-item');
      urlItem.appendChild(UI.el('label', '', '签到页面 URL'));
      urlInput = UI.el('input', '');
      urlInput.placeholder = 'https://juejin.cn/user/center/signin  或  d:\\pages\\signin.html';
      urlInput.value = task?.url || '';
      urlItem.appendChild(urlInput);

      const urlTip = UI.el('div', 'sf-api-note');
      urlTip.style.display = 'none';
      urlTip.style.color = 'var(--danger)';
      const validateUrl = (val) => {
        if (!val.trim()) { urlTip.style.display = 'none'; return true; }
        const v = val.trim().toLowerCase();
        if (/^https?:\/\//.test(v)) { urlTip.style.display = 'none'; return true; }
        const isWinAbs = /^[a-zA-Z]:[\\/]/.test(v);
        const looksLocal = isWinAbs || v.startsWith('./') || v.startsWith('../') || v.includes('\\');
        if (looksLocal) {
          const ext = v.substring(v.lastIndexOf('.'));
          if (['.html', '.htm', '.mhtml', '.svg', '.txt', '.pdf'].indexOf(ext) !== -1) {
            urlTip.style.display = 'none'; return true;
          }
          urlTip.innerHTML = '⚠️ 本地文件只支持网页类（.html/.pdf），不支持 .exe';
          urlTip.style.display = 'block'; return false;
        }
        urlTip.innerHTML = '⚠️ 请填写 https:// 网址 或 本地 HTML 文件路径';
        urlTip.style.display = 'block'; return false;
      };
      urlInput.addEventListener('input', () => validateUrl(urlInput.value));
      urlItem.appendChild(urlTip);
      webFields.appendChild(urlItem);

      const btnItem = UI.el('div', 'form-item');
      btnItem.appendChild(UI.el('label', '', '签到按钮选择器（可选）'));
      btnInput = UI.el('input', '');
      btnInput.placeholder = '留空则自动匹配；例如 .sign-btn 或 #checkin';
      btnInput.value = task?.buttonSelector || '';
      btnItem.appendChild(btnInput);
      webFields.appendChild(btnItem);

      const sucItem = UI.el('div', 'form-item');
      sucItem.appendChild(UI.el('label', '', '签到成功标识（可选）'));
      sucInput = UI.el('input', '');
      sucInput.placeholder = '例如：已签到';
      sucInput.value = task?.successText || '';
      sucItem.appendChild(sucInput);
      webFields.appendChild(sucItem);
    }
    form.appendChild(webFields);

    // ====== 桌面任务字段 ======
    const desktopFields = UI.el('div', 'sign-type-fields');
    desktopFields.style.display = isDesktop ? '' : 'none';
    {
      // exe 路径
      const exeItem = UI.el('div', 'form-item');
      exeItem.appendChild(UI.el('label', '', '可执行文件路径'));
      exeInput = UI.el('input', '');
      exeInput.placeholder = '例如：D:\\DDL\\Hyperdown\\Hyperdown.exe';
      exeInput.value = task?.exePath || '';
      exeItem.appendChild(exeInput);
      desktopFields.appendChild(exeItem);

      // ---- 就绪检测方式 ----
      const waitItem = UI.el('div', 'form-item');
      waitItem.appendChild(UI.el('label', '', '就绪检测方式'));
      waitModeSelect = document.createElement('select');
      const optAuto = UI.el('option', '', '自动等待窗口就绪（推荐）');
      optAuto.value = 'auto';
      const optFixed = UI.el('option', '', '固定延迟（老式）');
      optFixed.value = 'fixed';
      waitModeSelect.appendChild(optAuto);
      waitModeSelect.appendChild(optFixed);
      waitModeSelect.value = task?.waitMode || 'auto';
      waitItem.appendChild(waitModeSelect);
      const waitTip = UI.el('div', 'sf-api-note');
      waitTip.textContent = '自动模式会轮询窗口：主窗口出现 → 窗口尺寸稳定（过滤启动画面）→ 可选标题匹配，最长等待 30 秒。加载慢的程序不会再"点空"。';
      waitItem.appendChild(waitTip);
      desktopFields.appendChild(waitItem);

      // ---- 窗口标题关键词（仅自动模式） ----
      const waitTitleItem = UI.el('div', 'form-item');
      waitTitleItem.appendChild(UI.el('label', '', '窗口标题关键词（可选，自动模式生效）'));
      waitTitleInput = UI.el('input', '');
      waitTitleInput.placeholder = '例如：Hyperdown；填了则等到标题栏出现该词才算就绪';
      waitTitleInput.value = task?.waitWindowTitle || '';
      waitTitleItem.appendChild(waitTitleInput);
      desktopFields.appendChild(waitTitleItem);

      // ---- 固定延迟（仅固定模式） ----
      const delayItem = UI.el('div', 'form-item');
      delayItem.appendChild(UI.el('label', '', '固定延迟（毫秒，固定模式生效）'));
      delayInput = UI.el('input', '');
      delayInput.type = 'number';
      delayInput.min = '500';
      delayInput.step = '500';
      delayInput.value = (task?.launchDelay ?? 3000);
      delayInput.placeholder = '程序启动后固定等多久再执行脚本';
      delayItem.appendChild(delayInput);
      desktopFields.appendChild(delayItem);

      // 根据检测方式切换字段显隐
      const applyWaitMode = () => {
        const isAuto = waitModeSelect.value === 'auto';
        waitTitleItem.style.display = isAuto ? '' : 'none';
        delayItem.style.display = isAuto ? 'none' : '';
      };
      waitModeSelect.addEventListener('change', applyWaitMode);
      applyWaitMode();

      // PowerShell 模板下拉
      let templates = [];
      try { templates = await window.workbench.getPsTemplates(); } catch (e) { }

      const tplItem = UI.el('div', 'form-item');
      tplItem.appendChild(UI.el('label', '', 'PowerShell 脚本模板'));
      const tplWrap = UI.el('div', 'sign-tpl-wrap');
      const tplSelect = document.createElement('select');
      const optNone = UI.el('option', '', '-- 选择模板快速填充 --');
      optNone.value = '';
      tplSelect.appendChild(optNone);
      templates.forEach(t => {
        const opt = UI.el('option', '', `${t.name} — ${t.desc}`);
        opt.value = t.id;
        tplSelect.appendChild(opt);
      });
      tplSelect.addEventListener('change', () => {
        const tpl = templates.find(t => t.id === tplSelect.value);
        if (tpl && psInput) psInput.value = tpl.script;
      });
      tplWrap.appendChild(tplSelect);
      tplItem.appendChild(tplWrap);
      desktopFields.appendChild(tplItem);

      // 自动化脚本 textarea
      const psItem = UI.el('div', 'form-item');
      const psLabelRow = UI.el('div', 'sign-ps-label-row');
      psLabelRow.appendChild(UI.el('label', '', 'PowerShell 自动化脚本'));

      // 拾取坐标按钮：全屏十字线，点哪抓哪
      const pickBtn = UI.el('button', 'btn btn-ghost btn-sm sign-pick-btn');
      pickBtn.type = 'button';
      pickBtn.textContent = '拾取屏幕坐标';
      pickBtn.title = '先点「启动」打开目标程序并停在签到界面，再点此按钮抓取按钮坐标';
      pickBtn.addEventListener('click', async () => {
        UI.setToast('移动鼠标到目标按钮上，左键确认 / ESC 取消', 'info');
        let res;
        try {
          res = await window.workbench.pickCoordinate();
        } catch (err) {
          UI.setToast('拾取失败：' + err.message, 'error');
          return;
        }
        if (!res || !res.success) {
          UI.setToast('已取消拾取', 'info');
          return;
        }
        // 把坐标写入脚本：已有 $x/$y 行则替换，否则插到脚本开头
        // 返回的 x/y 是【物理像素】（已按显示器缩放因子转换）
        const coordLine = `$x = ${res.x}; $y = ${res.y}`;
        let script = psInput.value;
        if (/\$x\s*=\s*-?\d+\s*;\s*\$y\s*=\s*-?\d+/.test(script)) {
          script = script.replace(/\$x\s*=\s*-?\d+\s*;\s*\$y\s*=\s*-?\d+/, coordLine);
        } else {
          const sfTxt = res.scaleFactor && res.scaleFactor !== 1
            ? `（缩放 ${Math.round(res.scaleFactor * 100)}%，已转为物理像素）`
            : '';
          script = `# 拾取的屏幕坐标${sfTxt}\n${coordLine}\n\n` + script;
        }
        psInput.value = script;
        UI.setToast(`已抓取坐标 (${res.x}, ${res.y}) 并写入脚本`, 'success');
      });
      psLabelRow.appendChild(pickBtn);
      psItem.appendChild(psLabelRow);

      psInput = document.createElement('textarea');
      psInput.className = 'sign-ps-editor';
      psInput.placeholder =
        `# Windows 自带 PowerShell，零安装即可用
# 常用 SendKeys 语法：
#   ^ = Ctrl    ! = Alt    + = Shift    # = Win
#   {ENTER} = 回车   {TAB} = Tab   {ESC} = Esc
#
# 示例：激活窗口 + 发送 Alt+S
Add-Type -AssemblyName System.Windows.Forms
$wshell = New-Object -ComObject WScript.Shell
$wshell.AppActivate("窗口标题")
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("!s")
Write-Host "Done"`;
      psInput.value = task?.psScript || '';
      psItem.appendChild(psInput);
      desktopFields.appendChild(psItem);

      const tip = UI.el('div', 'sf-api-note');
      tip.textContent = '建议流程：① 先只填 exe 路径，点「启动」手动打开程序 → ② 观察签到需要哪些按键 → ③ 写脚本用 SendKeys 模拟按键，或用模板里的坐标点击';
      desktopFields.appendChild(tip);

      // 签到后自动关闭程序
      const closeItem = UI.el('div', 'form-item sign-checkbox-item');
      const closeLabel = UI.el('label', 'sign-checkbox-label');
      closeAfterCheck = document.createElement('input');
      closeAfterCheck.type = 'checkbox';
      closeAfterCheck.checked = !!task?.closeAfterSign;
      closeLabel.appendChild(closeAfterCheck);
      closeLabel.appendChild(UI.el('span', '', '签到完成后自动关闭该程序'));
      closeItem.appendChild(closeLabel);
      const closeHint = UI.el('div', 'sf-field-hint', '勾选后，自动化脚本执行完会等 1.5 秒再强制结束目标进程');
      closeItem.appendChild(closeHint);
      desktopFields.appendChild(closeItem);
    }
    form.appendChild(desktopFields);

    // 类型切换（放在字段声明之后，确保 applyType 能访问 webFields/desktopFields）
    const applyType = (type) => {
      currentType = type;
      webOpt.classList.toggle('active', type === 'web');
      desktopOpt.classList.toggle('active', type === 'desktop');
      webFields.style.display = type === 'web' ? '' : 'none';
      desktopFields.style.display = type === 'desktop' ? '' : 'none';
    };
    webOpt.type = 'button';
    desktopOpt.type = 'button';
    webOpt.addEventListener('click', () => applyType('web'));
    desktopOpt.addEventListener('click', () => applyType('desktop'));

    // ---- 保存按钮 ----
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

      let data = { name, taskType: currentType };

      if (currentType === 'web') {
        const url = urlInput.value.trim();
        if (!url) { UI.setToast('请填写签到页面 URL', 'error'); return; }
        data.url = url;
        data.buttonSelector = btnInput.value.trim();
        data.successText = sucInput.value.trim();
      } else {
        const exePath = exeInput.value.trim();
        if (!exePath) { UI.setToast('请填写可执行文件路径', 'error'); return; }
        data.exePath = exePath;
        data.exeArgs = [];
        data.waitMode = waitModeSelect.value || 'auto';
        data.waitWindowTitle = waitTitleInput.value.trim();
        data.launchDelay = parseInt(delayInput.value) || 3000;
        data.psScript = psInput.value.trim();
        data.verifyScript = '';
        data.closeAfterSign = closeAfterCheck.checked;
      }

      if (editing) {
        Object.assign(task, data);
      } else {
        this._tasks.push({ id: 'sign-' + Date.now(), ...data, lastSignDate: null, nextSignDate: null });
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