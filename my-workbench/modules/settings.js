// =====================================================================
// modules/settings.js —— 设置弹窗模块
// 职责：
//   1. 侧边栏底部齿轮按钮 → 打开悬浮设置弹窗（复用通用 modal）
//   2. 设置项：开机自启动开关（读写系统登录项，经 IPC 由主进程操作）
//   3. 设置项：关闭后继续后台运行（主进程拦截关闭 → 隐藏到系统托盘）
// 说明：
//   - 自启动状态由操作系统保存（Windows 注册表 Run 键），打开弹窗时实时读取
//   - 后台运行状态由主进程持有并持久化到 data/bg-run.json
//   - 🔴 后续新增设置项：在 openSettings() 内按 settings-row 结构追加即可
//   - 组件挂在 window.SettingsWidget，由 renderer.js 在 init() 中统一调用
// =====================================================================

window.SettingsWidget = {
  // -------------------------------------------------------------------
  init() {
    const btn = document.getElementById('settings-btn');
    if (!btn) return;
    // 填充齿轮图标（来自 modules/icons.js 的 settings-gear）
    const icon = document.getElementById('settings-icon');
    if (icon) icon.innerHTML = window.svgIcon('settings-gear', 20);
    btn.addEventListener('click', () => this.openSettings());

    // 主进程通知：窗口被隐藏到托盘时给出 Toast 提示
    if (window.workbench.onBackgroundNotice) {
      window.workbench.onBackgroundNotice((msg) => UI.setToast(msg, 'info'));
    }
  },

  // -------------------------------------------------------------------
  // 打开设置弹窗（悬浮于页面之上，复用 UI.openModal 通用模态框）
  // -------------------------------------------------------------------
  async openSettings() {
    const form = UI.el('form', '');

    // ===================== 设置项 1：开机自启动 =====================
    const autoRow = UI.el('div', 'settings-row');
    const autoText = UI.el('div', 'settings-row-text');
    autoText.appendChild(UI.el('div', 'settings-row-title', '开机自启动'));
    autoText.appendChild(UI.el('div', 'settings-row-desc', '登录 Windows 后自动启动 教公台-阡稻工作室'));

    const autoSwitch = UI.el('label', 'toggle-switch');
    autoSwitch.title = '开机自启动';
    const autoCheckbox = document.createElement('input');
    autoCheckbox.type = 'checkbox';
    autoCheckbox.setAttribute('aria-label', '开机自启动');
    autoSwitch.appendChild(autoCheckbox);
    autoSwitch.appendChild(UI.el('span', 'toggle-slider'));
    autoRow.appendChild(autoText);
    autoRow.appendChild(autoSwitch);
    form.appendChild(autoRow);

    // ===================== 设置项 2：关闭后继续后台运行 =====================
    const bgRow = UI.el('div', 'settings-row');
    const bgText = UI.el('div', 'settings-row-text');
    bgText.appendChild(UI.el('div', 'settings-row-title', '关闭后继续后台运行'));
    bgText.appendChild(UI.el('div', 'settings-row-desc', '关闭窗口后最小化到系统托盘，可从托盘恢复或退出'));

    const bgSwitch = UI.el('label', 'toggle-switch');
    bgSwitch.title = '关闭后继续后台运行';
    const bgCheckbox = document.createElement('input');
    bgCheckbox.type = 'checkbox';
    bgCheckbox.setAttribute('aria-label', '关闭后继续后台运行');
    bgSwitch.appendChild(bgCheckbox);
    bgSwitch.appendChild(UI.el('span', 'toggle-slider'));
    bgRow.appendChild(bgText);
    bgRow.appendChild(bgSwitch);
    form.appendChild(bgRow);

    // 统一读取两项当前状态
    try {
      const [autoOn, bgOn] = await Promise.all([
        window.workbench.getAutoStart(),
        window.workbench.getBackgroundRun()
      ]);
      autoCheckbox.checked = !!autoOn;
      bgCheckbox.checked = !!bgOn;
    } catch (e) {
      autoCheckbox.checked = false;
      bgCheckbox.checked = false;
    }

    // —— 开关 1：写系统登录项，失败或与预期不符时回滚 ——
    autoCheckbox.addEventListener('change', async () => {
      const want = autoCheckbox.checked;
      try {
        const actual = await window.workbench.setAutoStart(want);
        autoCheckbox.checked = actual;
        UI.setToast(actual ? '已开启开机自启动' : '已关闭开机自启动', 'success');
      } catch (e) {
        autoCheckbox.checked = !want; // 失败回滚
        UI.setToast('设置失败：' + e.message, 'error');
      }
    });

    // —— 开关 2：写主进程持久化状态（bg-run.json）——
    bgCheckbox.addEventListener('change', async () => {
      const want = bgCheckbox.checked;
      try {
        const res = await window.workbench.setBackgroundRun(want);
        if (res && res.success === false) {
          bgCheckbox.checked = !want; // 失败回滚
          return UI.setToast('设置失败：' + (res.message || '未知错误'), 'error');
        }
        bgCheckbox.checked = res.value;
        UI.setToast(res.value ? '已开启：关闭窗口将最小化到系统托盘' : '已关闭：关闭窗口即退出应用', 'success');
      } catch (e) {
        bgCheckbox.checked = !want; // 失败回滚
        UI.setToast('设置失败：' + e.message, 'error');
      }
    });

    // 🔴 后续新增设置项：在此按上面的 settings-row 结构继续追加
    // 抖音续火花配置面板（目标好友 / 定时 / 选择器 / 文案库 / 操作按钮）
    await this.buildFireSparkSection(form);

    UI.openModal('设置', form);
  },

  // -------------------------------------------------------------------
  // 构建续火花配置面板（追加到设置表单）
  // 包含：启用开关、目标好友、定时 cron、页面 URL、DOM 选择器、文案库、操作按钮
  // -------------------------------------------------------------------
  async buildFireSparkSection(form) {
    // 读取当前配置与文案库（失败时用默认值）
    let config = { enabled: true, targetFriend: '', scheduleTime: '00 01 * * *', chatUrl: 'https://www.douyin.com/', selectors: {} };
    let messages = [];
    try {
      config = await window.workbench.fireSparkGetConfig();
      messages = await window.workbench.fireSparkGetMessages();
    } catch (e) { /* 读取失败用默认值 */ }
    config = config || {};
    config.selectors = config.selectors || {};

    // 分隔标题
    form.appendChild(UI.el('div', 'settings-section-title', '抖音续火花（后台自动化）'));

    // 启用开关
    const enRow = UI.el('div', 'settings-row');
    const enText = UI.el('div', 'settings-row-text');
    enText.appendChild(UI.el('div', 'settings-row-title', '启用定时续火花'));
    enText.appendChild(UI.el('div', 'settings-row-desc', '每天定时在隐藏窗口自动给指定好友发消息续火花'));
    const enSwitch = UI.el('label', 'toggle-switch');
    const enCheckbox = document.createElement('input');
    enCheckbox.type = 'checkbox';
    enCheckbox.checked = !!config.enabled;
    enSwitch.appendChild(enCheckbox);
    enSwitch.appendChild(UI.el('span', 'toggle-slider'));
    enRow.appendChild(enText);
    enRow.appendChild(enSwitch);
    form.appendChild(enRow);

    // 目标好友昵称
    const friendField = UI.el('div', 'settings-field');
    friendField.appendChild(UI.el('label', 'settings-field-label', '目标好友昵称'));
    friendField.appendChild(UI.el('div', 'settings-field-desc', '要续火花的抖音好友昵称（需与聊天列表显示一致）'));
    const friendInput = document.createElement('input');
    friendInput.className = 'settings-input';
    friendInput.value = config.targetFriend || '';
    friendInput.placeholder = '例如：小明';
    friendField.appendChild(friendInput);
    form.appendChild(friendField);

    // 定时时间（cron 表达式）
    const cronField = UI.el('div', 'settings-field');
    cronField.appendChild(UI.el('label', 'settings-field-label', '定时时间（cron 表达式）'));
    cronField.appendChild(UI.el('div', 'settings-field-desc', '默认 00 01 * * * 表示每天 00:01 触发（分 时 日 月 周）'));
    const cronInput = document.createElement('input');
    cronInput.className = 'settings-input';
    cronInput.value = config.scheduleTime || '00 01 * * *';
    cronInput.placeholder = '00 01 * * *';
    cronField.appendChild(cronInput);
    form.appendChild(cronField);

    // 续火花页面 URL
    const urlField = UI.el('div', 'settings-field');
    urlField.appendChild(UI.el('label', 'settings-field-label', '续火花页面地址'));
    urlField.appendChild(UI.el('div', 'settings-field-desc', '隐藏窗口加载的页面（抖音私信/创作者平台）'));
    const urlInput = document.createElement('input');
    urlInput.className = 'settings-input';
    urlInput.value = config.chatUrl || 'https://www.douyin.com/';
    urlField.appendChild(urlInput);
    form.appendChild(urlField);

    // DOM 选择器分组（占位，需填入实测值）
    form.appendChild(UI.el('div', 'settings-section-title', 'DOM 选择器（需填入实测值）'));
    const selectorDefs = [
      ['chatEntry', '聊天入口选择器', '进入私信/聊天入口的 CSS 选择器'],
      ['friendItem', '好友会话选择器', '定位目标好友会话的 CSS 选择器'],
      ['inputBox', '输入框选择器', '消息输入框的 CSS 选择器'],
      ['sendBtn', '发送按钮选择器', '发送按钮的 CSS 选择器']
    ];
    const selectorInputs = {};
    selectorDefs.forEach((def) => {
      const key = def[0], label = def[1], desc = def[2];
      const field = UI.el('div', 'settings-field');
      field.appendChild(UI.el('label', 'settings-field-label', label));
      field.appendChild(UI.el('div', 'settings-field-desc', desc));
      const input = document.createElement('input');
      input.className = 'settings-input';
      input.value = config.selectors[key] || '';
      input.placeholder = '例如：.chat-input';
      field.appendChild(input);
      selectorInputs[key] = input;
      form.appendChild(field);
    });

    // 随机文案库（每行一条）
    const msgField = UI.el('div', 'settings-field');
    msgField.appendChild(UI.el('label', 'settings-field-label', '随机文案库（每行一条）'));
    msgField.appendChild(UI.el('div', 'settings-field-desc', '每次续火花随机抽取一条，防止被判定为机器人'));
    const msgArea = document.createElement('textarea');
    msgArea.className = 'settings-textarea';
    msgArea.value = Array.isArray(messages) ? messages.join('\n') : '';
    msgArea.placeholder = '在吗在吗\n今天也要加油哦\n续个火花';
    msgField.appendChild(msgArea);
    form.appendChild(msgField);

    // 操作按钮区
    const actions = UI.el('div', 'settings-actions');

    // 登录续火花：显示隐藏窗口，首次手动登录抖音（cookie 持久化到 persist:fire-session）
    const loginBtn = UI.el('button', 'settings-btn secondary', '登录续火花');
    loginBtn.type = 'button';
    loginBtn.addEventListener('click', async () => {
      try {
        await window.workbench.fireSparkShowLogin();
        UI.setToast('已打开续火花窗口，请登录抖音（登录后可关闭该窗口）', 'info', 4000);
      } catch (e) {
        UI.setToast('打开失败：' + e.message, 'error');
      }
    });
    actions.appendChild(loginBtn);

    // 立即执行一次（手动触发）
    const runBtn = UI.el('button', 'settings-btn secondary', '立即执行一次');
    runBtn.type = 'button';
    runBtn.addEventListener('click', async () => {
      try {
        UI.setToast('正在执行续火花…', 'info');
        const r = await window.workbench.fireSparkRun();
        UI.setToast(r.message, r.success ? 'success' : 'error', 4000);
      } catch (e) {
        UI.setToast('执行失败：' + e.message, 'error');
      }
    });
    actions.appendChild(runBtn);

    // 保存配置（收集表单值写回，保存后主进程自动重启定时任务）
    const saveBtn = UI.el('button', 'settings-btn', '保存配置');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', async () => {
      const newConfig = {
        enabled: enCheckbox.checked,
        targetFriend: friendInput.value.trim(),
        scheduleTime: cronInput.value.trim() || '00 01 * * *',
        chatUrl: urlInput.value.trim() || 'https://www.douyin.com/',
        selectors: {}
      };
      Object.keys(selectorInputs).forEach((key) => {
        newConfig.selectors[key] = selectorInputs[key].value.trim();
      });
      const newMessages = msgArea.value.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
      try {
        await window.workbench.fireSparkSaveConfig(newConfig);
        await window.workbench.fireSparkSaveMessages(newMessages);
        UI.setToast('续火花配置已保存', 'success');
      } catch (e) {
        UI.setToast('保存失败：' + e.message, 'error');
      }
    });
    actions.appendChild(saveBtn);

    form.appendChild(actions);
  }
};