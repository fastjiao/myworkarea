// =====================================================================
// modules/skills.js —— 技能库模块（Find Skills）
// 职责：
//   1. 展示可用技能列表（卡片网格）
//   2. 提供搜索功能（按名称 / 描述 / 分类模糊匹配）
//   3. 提供分类浏览（分类标签栏筛选）
//   4. 支持添加 / 编辑 / 删除技能
// 说明：技能数据存于 Store.skills，持久化到 data/skills.json。
// =====================================================================

window.Skills = {
  // 当前搜索关键词
  _keyword: '',
  // 当前选中的分类（'all' 表示全部）
  _category: 'all',

  // -------------------------------------------------------------------
  init() {
    Store.onChange(() => this.render());
    this.render();
  },

  // -------------------------------------------------------------------
  render() {
    const page = document.getElementById('page-skills');
    page.innerHTML = '';

    const section = UI.el('div', 'section');

    // 标题
    const title = UI.el('div', 'section-title');
    title.appendChild(UI.el('span', '', '可用技能'));
    title.appendChild(this._buildToolbarAdd());
    section.appendChild(title);

    // 搜索框
    section.appendChild(this._buildSearch());

    // 分类标签栏
    section.appendChild(this._buildCategoryBar());

    // 技能卡片网格
    section.appendChild(this._buildGrid());

    page.appendChild(section);
  },

  // -------------------------------------------------------------------
  // 工具栏：添加技能按钮
  // -------------------------------------------------------------------
  _buildToolbarAdd() {
    const addBtn = UI.el('button', 'btn btn-primary btn-sm');
    addBtn.appendChild(UI.icon('plus', 14));
    addBtn.appendChild(UI.el('span', '', '添加技能'));
    addBtn.addEventListener('click', () => this._openSkillModal(null));
    return addBtn;
  },

  // -------------------------------------------------------------------
  // 搜索框
  // -------------------------------------------------------------------
  _buildSearch() {
    const wrap = UI.el('div', 'skills-toolbar');
    const searchBox = UI.el('div', 'skills-search');
    searchBox.appendChild(UI.icon('search', 16));
    const input = UI.el('input', '');
    input.placeholder = '搜索技能名称、描述或分类…';
    input.value = this._keyword;
    input.addEventListener('input', () => {
      this._keyword = input.value.trim();
      // 只重渲染网格，避免输入框因整页重建而失焦
      this._rerenderGrid();
    });
    searchBox.appendChild(input);
    wrap.appendChild(searchBox);
    return wrap;
  },

  // -------------------------------------------------------------------
  // 分类标签栏
  // -------------------------------------------------------------------
  _buildCategoryBar() {
    const bar = UI.el('div', 'category-bar');

    // 从技能列表去重得到全部分类
    const categories = ['all', ...new Set(Store.skills.map((s) => s.category).filter(Boolean))];

    categories.forEach((cat) => {
      const label = cat === 'all' ? '全部' : cat;
      const chip = UI.el('button', 'category-chip' + (this._category === cat ? ' active' : ''), label);
      chip.addEventListener('click', () => {
        this._category = cat;
        this.render();
      });
      bar.appendChild(chip);
    });

    return bar;
  },

  // -------------------------------------------------------------------
  // 技能卡片网格
  // -------------------------------------------------------------------
  _buildGrid() {
    const grid = UI.el('div', 'skill-grid');
    const list = this._filter();

    if (list.length === 0) {
      grid.appendChild(UI.el('div', 'empty-tip', '没有匹配的技能'));
      return grid;
    }

    list.forEach((skill) => grid.appendChild(this._buildSkillCard(skill)));
    return grid;
  },

  /** 仅重建网格（供搜索输入时使用，避免输入框失焦） */
  _rerenderGrid() {
    const page = document.getElementById('page-skills');
    const old = page.querySelector('.skill-grid');
    const next = this._buildGrid();
    if (old) old.replaceWith(next);
    else page.appendChild(next);
  },

  _filter() {
    const kw = this._keyword.toLowerCase();
    return Store.skills.filter((s) => {
      const matchCategory = this._category === 'all' || s.category === this._category;
      const matchKeyword = !kw
        || s.name.toLowerCase().includes(kw)
        || (s.desc || '').toLowerCase().includes(kw)
        || (s.category || '').toLowerCase().includes(kw);
      return matchCategory && matchKeyword;
    });
  },

  // -------------------------------------------------------------------
  // 单个技能卡片
  // -------------------------------------------------------------------
  _buildSkillCard(skill) {
    const card = UI.el('div', 'skill-card');

    const head = UI.el('div', 'skill-card-head');
    head.appendChild(UI.el('div', 'skill-name', skill.name));
    if (skill.level) head.appendChild(UI.el('span', 'skill-level', skill.level));
    card.appendChild(head);

    if (skill.category) card.appendChild(UI.el('div', 'skill-category', skill.category));
    if (skill.desc) card.appendChild(UI.el('div', 'skill-desc', skill.desc));

    const actions = UI.el('div', 'skill-actions');
    const editBtn = UI.el('button', 'btn btn-ghost btn-sm');
    editBtn.appendChild(UI.icon('edit', 13));
    editBtn.addEventListener('click', () => this._openSkillModal(skill));
    const delBtn = UI.el('button', 'btn btn-ghost btn-sm text-danger');
    delBtn.appendChild(UI.icon('trash', 13));
    delBtn.addEventListener('click', () => this._removeSkill(skill));
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    card.appendChild(actions);

    return card;
  },

  // -------------------------------------------------------------------
  // 删除技能
  // -------------------------------------------------------------------
  async _removeSkill(skill) {
    Store.skills = Store.skills.filter((s) => s.id !== skill.id);
    const saved = await Store.saveSkills();
    if (saved && saved.success === false) {
      return UI.setToast('删除失败：' + saved.message, 'error');
    }
    Store.notify();
    UI.setToast('已删除技能「' + skill.name + '」', 'success');
  },

  // -------------------------------------------------------------------
  // 添加 / 编辑技能模态框
  // -------------------------------------------------------------------
  /**
   * @param {object|null} skill 传入技能表示编辑，null 表示新建
   */
  _openSkillModal(skill) {
    const isEdit = !!skill;
    const form = UI.el('form', '');

    const nameItem = UI.el('div', 'form-item');
    nameItem.appendChild(UI.el('label', '', '技能名称'));
    const nameInput = UI.el('input', '');
    nameInput.placeholder = '例如：Electron 开发';
    nameInput.value = isEdit ? skill.name : '';
    nameItem.appendChild(nameInput);
    form.appendChild(nameItem);

    const row = UI.el('div', 'form-row');

    const catItem = UI.el('div', 'form-item');
    catItem.appendChild(UI.el('label', '', '分类'));
    const catInput = UI.el('input', '');
    catInput.placeholder = '例如：开发';
    catInput.value = isEdit ? (skill.category || '') : '';
    catItem.appendChild(catInput);
    row.appendChild(catItem);

    const levelItem = UI.el('div', 'form-item');
    levelItem.appendChild(UI.el('label', '', '熟练度'));
    const levelSelect = UI.el('select', '');
    ['精通', '熟练', '熟悉', '了解'].forEach((lv) => {
      const o = UI.el('option', '', lv);
      o.value = lv;
      levelSelect.appendChild(o);
    });
    levelSelect.value = isEdit ? (skill.level || '熟悉') : '熟悉';
    levelItem.appendChild(levelSelect);
    row.appendChild(levelItem);

    form.appendChild(row);

    const descItem = UI.el('div', 'form-item');
    descItem.appendChild(UI.el('label', '', '描述'));
    const descInput = UI.el('textarea', '');
    descInput.placeholder = '简要描述该技能（可选）';
    descInput.value = isEdit ? (skill.desc || '') : '';
    descItem.appendChild(descInput);
    form.appendChild(descItem);

    const actions = UI.el('div', 'form-actions');
    const cancelBtn = UI.el('button', 'btn btn-ghost', '取消');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => UI.closeModal());
    const submitBtn = UI.el('button', 'btn btn-primary', isEdit ? '保存' : '添加');
    submitBtn.type = 'submit';
    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    form.appendChild(actions);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) {
        UI.setToast('请填写技能名称', 'error');
        return;
      }
      const data = {
        name,
        category: catInput.value.trim(),
        level: levelSelect.value,
        desc: descInput.value.trim()
      };

      if (isEdit) {
        Object.assign(skill, data);
      } else {
        Store.skills.push({ id: 'skill-' + Date.now(), ...data });
      }
      const saved = await Store.saveSkills();
      if (saved && saved.success === false) {
        return UI.setToast('保存失败：' + saved.message, 'error');
      }
      UI.closeModal();
      Store.notify();
      UI.setToast(isEdit ? '已更新技能' : '已添加技能', 'success');
    });

    UI.openModal(isEdit ? '编辑技能' : '添加技能', form);
    nameInput.focus();
  }
};