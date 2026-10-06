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

// 把 KeyboardEvent.code 转为友好显示名
function _keyLabel(code) {
  const map = {
    Space: '空格', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
    MediaPlayPause: '▶/⏸', MediaTrackNext: '下一首', MediaTrackPrevious: '上一首'
  };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

window.SettingsWidget = {
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

  // 打开设置弹窗（左侧导航 + 右侧面板）
  async openSettings() {
    const layout = UI.el('div', 'settings-layout');
    const nav = UI.el('div', 'settings-nav');
    const panel = UI.el('div', 'settings-panel');

    // 分区定义：第一个为「通用」（明暗模式 + 开机自启动 + 后台运行），其余按模块命名
    const sections = [
      { id: 'general', label: '通用', build: (p) => this._buildGeneralSection(p) },
      { id: 'netease', label: '网易云音乐', build: (p) => this._buildNeteaseSection(p) }
    ];

    sections.forEach((s, i) => {
      const item = UI.el('button', 'settings-nav-item' + (i === 0 ? ' active' : ''));
      item.textContent = s.label;
      item.type = 'button';
      item.addEventListener('click', async () => {
        nav.querySelectorAll('.settings-nav-item').forEach((n) => n.classList.remove('active'));
        item.classList.add('active');
        panel.innerHTML = '';
        await s.build(panel);
      });
      nav.appendChild(item);
    });

    layout.appendChild(nav);
    layout.appendChild(panel);
    await sections[0].build(panel);

    UI.openModal('设置', layout, 'settings-modal');
  },

  // 通用分区：明暗模式（跟随系统/亮色/暗色）+ 开机自启动 + 关闭后后台运行
  _buildGeneralSection(panel) {
    // ---- 明暗模式三选 ----
    const themeField = UI.el('div', 'settings-field');
    themeField.appendChild(UI.el('label', 'settings-field-label', '明暗模式'));
    themeField.appendChild(UI.el('div', 'settings-field-desc', '跟随系统会随 OS 明暗偏好自动切换'));
    const opts = UI.el('div', 'theme-options');
    const modes = [['system', '跟随系统'], ['light', '亮色'], ['dark', '暗色']];
    const current = Store.settings.theme || 'system';
    modes.forEach(([val, label]) => {
      const opt = UI.el('button', 'theme-option' + (current === val ? ' active' : ''));
      opt.textContent = label;
      opt.type = 'button';
      opt.addEventListener('click', () => {
        opts.querySelectorAll('.theme-option').forEach((o) => o.classList.remove('active'));
        opt.classList.add('active');
        applyTheme(val);
      });
      opts.appendChild(opt);
    });
    themeField.appendChild(opts);
    panel.appendChild(themeField);

    // ---- 开机自启动 ----
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
    panel.appendChild(autoRow);

    // ---- 关闭后继续后台运行 ----
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
    panel.appendChild(bgRow);

    // 统一读取两项当前状态
    Promise.all([
      window.workbench.getAutoStart(),
      window.workbench.getBackgroundRun()
    ]).then(([autoOn, bgOn]) => {
      autoCheckbox.checked = !!autoOn;
      bgCheckbox.checked = !!bgOn;
    }).catch(() => {
      autoCheckbox.checked = false;
      bgCheckbox.checked = false;
    });

    autoCheckbox.addEventListener('change', async () => {
      const want = autoCheckbox.checked;
      try {
        const actual = await window.workbench.setAutoStart(want);
        autoCheckbox.checked = actual;
        UI.setToast(actual ? '已开启开机自启动' : '已关闭开机自启动', 'success');
      } catch (e) {
        autoCheckbox.checked = !want;
        UI.setToast('设置失败：' + e.message, 'error');
      }
    });

    bgCheckbox.addEventListener('change', async () => {
      const want = bgCheckbox.checked;
      try {
        const res = await window.workbench.setBackgroundRun(want);
        if (res && res.success === false) {
          bgCheckbox.checked = !want;
          return UI.setToast('设置失败：' + (res.message || '未知错误'), 'error');
        }
        bgCheckbox.checked = res.value;
        UI.setToast(res.value ? '已开启：关闭窗口将最小化到系统托盘' : '已关闭：关闭窗口即退出应用', 'success');
      } catch (e) {
        bgCheckbox.checked = !want;
        UI.setToast('设置失败：' + e.message, 'error');
      }
    });
  },

  // 网易云音乐分区：打卡目标数量（持久化到 netease-data.json）
  _buildNeteaseSection(panel) {
    if (!window.Netease) {
      panel.appendChild(UI.el('div', 'empty-tip', '网易云音乐模块未加载'));
      return;
    }
    const field = UI.el('div', 'settings-field');
    field.appendChild(UI.el('label', 'settings-field-label', '打卡目标数量'));
    field.appendChild(UI.el('div', 'settings-field-desc', '每日听歌打卡刷的歌曲数量（1-300，网易云每日上限 300）'));
    const input = document.createElement('input');
    input.className = 'settings-input';
    input.type = 'number';
    input.min = '1';
    input.max = '300';
    input.value = String(window.Netease._dakaTarget || 300);
    field.appendChild(input);
    panel.appendChild(field);

    // ---- 快捷键自定义（上一首 / 下一首 / 暂停播放） ----
    panel.appendChild(UI.el('div', 'settings-section-title', '快捷键'));
    const sc = (Store.settings && Store.settings.neteaseShortcuts) || {};
    const shortcutDefs = [
      ['prev', '上一首', 'ArrowLeft'],
      ['next', '下一首', 'ArrowRight'],
      ['playPause', '暂停 / 播放', 'Space']
    ];
    const shortcutInputs = {};
    shortcutDefs.forEach(([key, label, def]) => {
      const f = UI.el('div', 'settings-field');
      f.appendChild(UI.el('label', 'settings-field-label', label));
      const inp = UI.el('input', 'settings-input shortcut-input');
      inp.value = _keyLabel(sc[key] || def);
      inp.dataset.code = sc[key] || def;
      inp.readOnly = true;
      inp.placeholder = '点击后按下快捷键';
      inp.addEventListener('focus', () => { inp.value = '请按下快捷键…'; });
      inp.addEventListener('keydown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        inp.dataset.code = e.code;
        inp.value = _keyLabel(e.code);
        inp.blur();
      });
      shortcutInputs[key] = inp;
      f.appendChild(inp);
      panel.appendChild(f);
    });

    const actions = UI.el('div', 'settings-actions');
    const saveBtn = UI.el('button', 'settings-btn', '保存');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', async () => {
      const v = Math.min(300, Math.max(1, parseInt(input.value, 10) || 300));
      window.Netease._dakaTarget = v;
      input.value = String(v);
      // 收集快捷键
      const newSc = {};
      Object.keys(shortcutInputs).forEach((k) => { newSc[k] = shortcutInputs[k].dataset.code; });
      Store.settings.neteaseShortcuts = newSc;
      UI.setBtnLoading(saveBtn, true, '保存中…');
      try {
        await Store.saveSettings();
        if (typeof window.Netease._saveLocalData === 'function') {
          await window.Netease._saveLocalData();
        }
        UI.setToast('已保存网易云设置', 'success');
      } catch (e) {
        UI.setToast('保存失败：' + e.message, 'error');
      } finally {
        UI.setBtnLoading(saveBtn, false);
      }
    });
    actions.appendChild(saveBtn);
    panel.appendChild(actions);
  }
};