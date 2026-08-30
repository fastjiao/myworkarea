// =====================================================================
// modules/skill-finder.js —— AI 技能发现器
// 职责：
//   1. 标签输入：用户添加/删除关注标签（Tag 胶囊）
//   2. 固定网站抓取：调用主进程 IPC 抓取预设网站 + AI 分析
//      数据源：Cocoloop、Three UI、站酷、React Bits
//   3. 结果展示：卡片网格展示 AI 发现的新技能
//   4. 一键入库：将 AI 发现的技能添加到 Store.skills
//   5. API 配置：支持配置 OpenAI 兼容 API
// =====================================================================

window.SkillFinder = {
  // 当前标签列表
  _tags: [],
  // 搜索状态: idle | searching | done | error
  _status: 'idle',
  // 搜索结果
  _results: [],
  // 错误信息
  _error: '',
  // 数据源信息
  _sources: [],
  // 抓取错误
  _fetchErrors: [],
  _apiConfig: { apiKey: '', apiEndpoint: '', model: 'gpt-4o-mini' },

  // -------------------------------------------------------------------
  init() {
    // 从 settings 中读取 API 配置
    this._apiConfig.apiKey = Store.settings.skillFinderApiKey || '';
    this._apiConfig.apiEndpoint = Store.settings.skillFinderApiEndpoint || '';
    this._apiConfig.model = Store.settings.skillFinderModel || 'gpt-4o-mini';
    Store.onChange(() => this.render());
    this.render();
  },

  // -------------------------------------------------------------------
  render() {
    const page = document.getElementById('page-skill-finder');
    page.innerHTML = '';

    const section = UI.el('div', 'section');

    // 标题栏
    const title = UI.el('div', 'section-title');
    title.appendChild(UI.el('span', '', 'AI 技能发现器'));
    title.appendChild(this._buildSettingsBtn());
    section.appendChild(title);

    // 描述
    const desc = UI.el('div', 'sf-desc', '输入关注的领域标签，AI 将从 Cocoloop、Three UI、站酷、React Bits、GitHub 等网站中挖掘相关技能');
    section.appendChild(desc);

    // 标签输入区
    section.appendChild(this._buildTagInput());

    // 标签列表
    section.appendChild(this._buildTagList());

    // 操作按钮
    section.appendChild(this._buildActions());

    // 加载动画
    if (this._status === 'searching') {
      section.appendChild(this._buildLoading());
    }

    // 错误提示
    if (this._status === 'error') {
      section.appendChild(this._buildError());
    }

    // 统计信息
    if (this._status === 'done' && this._results.length > 0) {
      section.appendChild(this._buildStats());
    }

    // 结果区域
    section.appendChild(this._buildResults());

    // 空状态提示
    if (this._status === 'idle' && this._results.length === 0) {
      section.appendChild(this._buildEmpty());
    }

    page.appendChild(section);
  },

  // -------------------------------------------------------------------
  // API 设置按钮
  // -------------------------------------------------------------------
  _buildSettingsBtn() {
    const btn = UI.el('button', 'btn btn-ghost btn-sm');
    btn.appendChild(UI.icon('settings', 14));
    btn.appendChild(UI.el('span', '', 'API 设置'));
    btn.addEventListener('click', () => this._openApiSettings());
    return btn;
  },

  // -------------------------------------------------------------------
  // 标签输入组件
  // -------------------------------------------------------------------
  _buildTagInput() {
    const wrap = UI.el('div', 'sf-tag-input-wrap');

    const input = UI.el('input', 'sf-tag-input');
    input.placeholder = '输入标签后按回车，例如：Electron、AI、前端...';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = input.value.trim();
        if (val && !this._tags.includes(val)) {
          this._tags.push(val);
          input.value = '';
          this._rerenderTagList();
          this._rerenderActions();
        }
      }
      // 退格键删除最后一个标签
      if (e.key === 'Backspace' && input.value === '' && this._tags.length > 0) {
        this._tags.pop();
        this._rerenderTagList();
        this._rerenderActions();
      }
    });

    wrap.appendChild(input);
    return wrap;
  },

  // -------------------------------------------------------------------
  // 标签胶囊列表
  // -------------------------------------------------------------------
  _buildTagList() {
    const wrap = UI.el('div', 'sf-tag-list');

    this._tags.forEach((tag, i) => {
      const chip = UI.el('span', 'sf-tag');
      chip.textContent = tag;
      const close = UI.el('span', 'sf-tag-remove');
      close.innerHTML = '×';
      close.addEventListener('click', () => {
        this._tags.splice(i, 1);
        this._rerenderTagList();
        this._rerenderActions();
      });
      chip.appendChild(close);
      wrap.appendChild(chip);
    });

    if (this._tags.length === 0) {
      const tip = UI.el('span', 'sf-tag-empty', '暂无标签，请输入后回车添加');
      wrap.appendChild(tip);
    }

    return wrap;
  },

  _rerenderTagList() {
    const page = document.getElementById('page-skill-finder');
    const old = page.querySelector('.sf-tag-list');
    const next = this._buildTagList();
    if (old) old.replaceWith(next);
  },

  _rerenderActions() {
    const page = document.getElementById('page-skill-finder');
    const old = page.querySelector('.sf-actions');
    const next = this._buildActions();
    if (old) old.replaceWith(next);
  },

  // -------------------------------------------------------------------
  // 操作按钮
  // -------------------------------------------------------------------
  _buildActions() {
    const wrap = UI.el('div', 'sf-actions');

    const searchBtn = UI.el('button', 'btn btn-primary sf-search-btn');
    searchBtn.disabled = this._tags.length === 0 || this._status === 'searching';
    searchBtn.appendChild(UI.icon('search', 16));
    searchBtn.appendChild(UI.el('span', '', this._status === 'searching' ? '搜索中...' : '开始搜寻'));
    searchBtn.addEventListener('click', () => this._startSearch());

    const clearBtn = UI.el('button', 'btn btn-ghost');
    clearBtn.appendChild(UI.el('span', '', '清空结果'));
    clearBtn.addEventListener('click', () => {
      this._results = [];
      this._status = 'idle';
      this._error = '';
      this.render();
    });

    wrap.appendChild(searchBtn);
    if (this._results.length > 0 || this._status === 'done') {
      wrap.appendChild(clearBtn);
    }
    return wrap;
  },

  // -------------------------------------------------------------------
  // 加载动画
  // -------------------------------------------------------------------
  _buildLoading() {
    const wrap = UI.el('div', 'sf-loading');
    const spinner = UI.el('div', 'sf-spinner');
    spinner.innerHTML = window.svgIcon('loading', 36);
    wrap.appendChild(spinner);
    wrap.appendChild(UI.el('div', 'sf-loading-text', '正在抓取网站并分析技能...'));
    return wrap;
  },

  // -------------------------------------------------------------------
  // 错误提示
  // -------------------------------------------------------------------
  _buildError() {
    const wrap = UI.el('div', 'sf-error');
    wrap.appendChild(UI.el('div', 'sf-error-icon', '!'));
    wrap.appendChild(UI.el('div', 'sf-error-text', this._error));
    return wrap;
  },

  // -------------------------------------------------------------------
  // 统计信息
  // -------------------------------------------------------------------
  _buildStats() {
    const wrap = UI.el('div', 'sf-stats');
    wrap.textContent = `找到 ${this._results.length} 个推荐技能`;
    if (this._sources.length > 0) {
      const srcInfo = UI.el('div', 'sf-stats-sources');
      srcInfo.textContent = '数据来源：' + this._sources.join('、');
      wrap.appendChild(srcInfo);
    }
    if (this._fetchErrors.length > 0) {
      const errInfo = UI.el('div', 'sf-stats-errors');
      errInfo.textContent = '部分站点抓取失败：' + this._fetchErrors.join('；');
      wrap.appendChild(errInfo);
    }
    return wrap;
  },

  // -------------------------------------------------------------------
  // 结果卡片网格
  // -------------------------------------------------------------------
  _buildResults() {
    const grid = UI.el('div', 'skill-grid');

    if (this._results.length === 0 && this._status !== 'idle') {
      grid.appendChild(UI.el('div', 'empty-tip', '没有找到相关技能'));
      return grid;
    }

    this._results.forEach((skill) => {
      grid.appendChild(this._buildSkillCard(skill));
    });

    return grid;
  },

  // -------------------------------------------------------------------
  // 单个技能卡片
  // -------------------------------------------------------------------
  _buildSkillCard(skill) {
    const card = UI.el('div', 'skill-card');

    // 头部：名称 + 熟练度
    const head = UI.el('div', 'skill-card-head');
    const nameEl = UI.el('div', 'skill-name', skill.name || '未知技能');
    head.appendChild(nameEl);
    if (skill.level) {
      head.appendChild(UI.el('span', 'skill-level', skill.level));
    }
    card.appendChild(head);

    // 分类
    if (skill.category) {
      card.appendChild(UI.el('div', 'skill-category', skill.category));
    }

    // 描述
    if (skill.description) {
      card.appendChild(UI.el('div', 'skill-desc', skill.description));
    }

    // AI 推荐理由
    if (skill.reason) {
      const reasonWrap = UI.el('div', 'sf-reason');
      reasonWrap.appendChild(UI.el('span', 'sf-reason-label', 'AI 推荐：'));
      reasonWrap.appendChild(UI.el('span', '', skill.reason));
      card.appendChild(reasonWrap);
    }

    // 来源链接
    if (skill.source_url) {
      const linkWrap = UI.el('div', 'sf-link');
      const link = UI.el('a', 'sf-source-link', '查看来源');
      link.href = skill.source_url;
      link.target = '_blank';
      link.appendChild(UI.icon('external', 12));
      linkWrap.appendChild(link);
      card.appendChild(linkWrap);
    }

    // 操作按钮
    const actions = UI.el('div', 'skill-actions');

    // 检查是否已存在于技能库
    const exists = Store.skills.some((s) => s.name === skill.name);
    if (exists) {
      const addedBtn = UI.el('button', 'btn btn-sm', '已添加');
      addedBtn.disabled = true;
      addedBtn.style.opacity = '0.5';
      actions.appendChild(addedBtn);
    } else {
      const addBtn = UI.el('button', 'btn btn-primary btn-sm');
      addBtn.appendChild(UI.icon('plus', 13));
      addBtn.appendChild(UI.el('span', '', '添加到技能库'));
      addBtn.addEventListener('click', () => this._addToSkills(skill));
      actions.appendChild(addBtn);
    }

    card.appendChild(actions);
    return card;
  },

  // -------------------------------------------------------------------
  // 空状态提示
  // -------------------------------------------------------------------
  _buildEmpty() {
    const wrap = UI.el('div', 'sf-empty');
    wrap.appendChild(UI.el('div', 'sf-empty-icon', '🔍'));
    wrap.appendChild(UI.el('div', 'sf-empty-title', '输入标签，发现新技能'));
    wrap.appendChild(UI.el('div', 'sf-empty-desc', '输入你感兴趣的领域标签，回车添加，然后点击"开始搜寻" — AI 将从 Cocoloop、Three UI、站酷、React Bits、GitHub 等网站中挖掘技能'));
    return wrap;
  },

  // -------------------------------------------------------------------
  // 核心：开始搜索
  // -------------------------------------------------------------------
  async _startSearch() {
    if (this._tags.length === 0) return;

    this._status = 'searching';
    this._error = '';
    this._results = [];
    this._sources = [];
    this._fetchErrors = [];
    this._rerenderActions();

    // 更新 loading 状态
    const page = document.getElementById('page-skill-finder');
    const section = page.querySelector('.section');
    // 移除旧 loading 和旧结果
    const oldLoading = section.querySelector('.sf-loading');
    if (oldLoading) oldLoading.remove();
    // 添加新 loading
    section.appendChild(this._buildLoading());

    try {
      const result = await window.workbench.searchSkills({
        tags: this._tags,
        apiConfig: this._apiConfig
      });

      if (result.success && result.data) {
        this._results = result.data;
        this._sources = result.sources || [];
        this._fetchErrors = result.fetchErrors || [];
        this._status = 'done';
      } else {
        this._error = result.message || '搜索失败，请重试';
        this._status = 'error';
      }
    } catch (err) {
      this._error = '网络或系统错误：' + (err.message || '未知错误');
      this._status = 'error';
    }

    this.render();
  },

  // -------------------------------------------------------------------
  // 添加到技能库
  // -------------------------------------------------------------------
  async _addToSkills(skill) {
    const newSkill = {
      id: 'skill-' + Date.now(),
      name: skill.name || '未知技能',
      category: skill.category || '开发',
      level: skill.level || '熟悉',
      desc: skill.description || skill.reason || ''
    };

    Store.skills.push(newSkill);
    const saved = await Store.saveSkills();
    if (saved && saved.success === false) {
      return UI.setToast('添加失败：' + saved.message, 'error');
    }
    Store.notify();
    UI.setToast('已添加技能「' + newSkill.name + '」', 'success');

    // 刷新当前卡片状态
    this.render();
  },

  // -------------------------------------------------------------------
  // API 配置模态框
  // -------------------------------------------------------------------
  _openApiSettings() {
    const form = UI.el('form', '');

    // 说明
    const note = UI.el('div', 'sf-api-note');
    note.innerHTML = '配置 OpenAI 兼容 API（支持 OpenAI、DeepSeek、通义千问等），AI 将分析 Cocoloop、Three UI、站酷、React Bits 等网站的内容并提取技能。<br>如不配置，将使用基础提取模式（结果质量较低）。';
    form.appendChild(note);

    // API Key
    const keyItem = UI.el('div', 'form-item');
    keyItem.appendChild(UI.el('label', '', 'API Key'));
    const keyInput = UI.el('input', '');
    keyInput.type = 'password';
    keyInput.placeholder = 'sk-...';
    keyInput.value = this._apiConfig.apiKey;
    keyItem.appendChild(keyInput);
    form.appendChild(keyItem);

    // API Endpoint
    const epItem = UI.el('div', 'form-item');
    epItem.appendChild(UI.el('label', '', 'API 地址（可选）'));
    const epInput = UI.el('input', '');
    epInput.placeholder = 'https://api.openai.com/v1（留空默认 OpenAI）';
    epInput.value = this._apiConfig.apiEndpoint;
    epItem.appendChild(epInput);
    form.appendChild(epItem);

    // Model
    const modelItem = UI.el('div', 'form-item');
    modelItem.appendChild(UI.el('label', '', '模型名'));
    const modelInput = UI.el('input', '');
    modelInput.placeholder = 'gpt-4o-mini / deepseek-chat';
    modelInput.value = this._apiConfig.model;
    modelItem.appendChild(modelInput);
    form.appendChild(modelItem);

    // 常用模型提示
    const modelHint = UI.el('div', 'sf-model-hint');
    modelHint.textContent = '常用模型：gpt-4o-mini、gpt-4o、deepseek-chat、qwen-turbo';
    form.appendChild(modelHint);

    // 按钮
    const actions = UI.el('div', 'form-actions');
    const cancelBtn = UI.el('button', 'btn btn-ghost', '取消');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => UI.closeModal());
    const saveBtn = UI.el('button', 'btn btn-primary', '保存');
    saveBtn.type = 'submit';
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    form.appendChild(actions);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      this._apiConfig.apiKey = keyInput.value.trim();
      this._apiConfig.apiEndpoint = epInput.value.trim();
      this._apiConfig.model = modelInput.value.trim() || 'gpt-4o-mini';

      // 保存到 settings
      Store.settings.skillFinderApiKey = this._apiConfig.apiKey;
      Store.settings.skillFinderApiEndpoint = this._apiConfig.apiEndpoint;
      Store.settings.skillFinderModel = this._apiConfig.model;
      await Store.saveSettings();

      UI.closeModal();
      UI.setToast('API 配置已保存', 'success');
    });

    UI.openModal('AI API 配置', form);
  }
};