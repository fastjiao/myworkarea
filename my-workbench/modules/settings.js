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
    autoText.appendChild(UI.el('div', 'settings-row-desc', '登录 Windows 后自动启动 jiao公台'));

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

    UI.openModal('设置', form);
  }
};