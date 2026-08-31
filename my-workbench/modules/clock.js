// =====================================================================
// modules/clock.js —— 右上角时钟组件（渲染进程）
// 职责：
//   1. 模式 A（默认）：圆形模拟时钟，含时针 / 分针 / 秒针
//   2. 模式 B：数字时钟，显示 HH:MM:SS
//   3. 点击切换两种模式；按住拖动可移动组件位置（均写入 localStorage 记忆）
// 说明：
//   - 指针旋转使用 CSS transform: rotate()，由 requestAnimationFrame 逐帧驱动
//   - 秒针默认平滑扫描转动；系统开启「减少动态效果」时降级为每秒跳动
//   - 交互区分「点击」与「拖动」：位移小于阈值的按下-抬起视为点击切换，
//     超过阈值视为拖动，结束拖动时不会误触发模式切换
//   - 组件挂在 window.ClockWidget，由 renderer.js 在 init() 中统一调用
// =====================================================================

window.ClockWidget = {
  // 当前显示模式：'analog'（模拟） | 'digital'（数字）
  _mode: 'analog',
  // localStorage 记忆键名（如需调整持久化键，改这里即可）
  _STORAGE_KEY: 'workbench-clock-mode',
  // 位置记忆键名
  _POS_KEY: 'workbench-clock-pos',
  // 判定「点击 / 拖动」的位移阈值（像素，平方值比较）
  _DRAG_THRESHOLD: 5,
  // 数字文本缓存（避免每帧重复写 DOM，秒数变化时才更新）
  _lastTime: '',
  _lastDate: '',
  // requestAnimationFrame 句柄
  _rafId: null,
  // 系统是否要求减少动态效果
  _reduceMotion: false,
  // 拖拽状态
  _dragging: false,
  _moved: false,
  _dragStartX: 0,
  _dragStartY: 0,
  _dragStartLeft: 0,
  _dragStartTop: 0,
  // DOM 元素引用（init 时缓存）
  _root: null,
  _hourHand: null,
  _minuteHand: null,
  _secondHand: null,
  _digitalH: null,
  _digitalM: null,
  _digitalS: null,
  _digitalDate: null,

  // -------------------------------------------------------------------
  init() {
    const root = document.getElementById('clock-widget');
    if (!root) return;
    this._root = root;
    this._reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // 1. 动态生成 12 个刻度（12/3/6/9 三个方向为主刻度）与 4 个数字标注
    const dial = root.querySelector('.clock-analog');
    if (dial) {
      for (let i = 0; i < 12; i++) {
        const deg = i * 30;
        const tick = document.createElement('div');
        tick.className = 'clock-tick' + (i % 3 === 0 ? ' major' : '');
        tick.style.transform = `rotate(${deg}deg)`;
        dial.appendChild(tick);
      }
      // 12/3/6/9 四个整点数字
      [[12, 0], [3, 90], [6, 180], [9, 270]].forEach(([num, deg]) => {
        const wrap = document.createElement('div');
        wrap.className = 'clock-num';
        wrap.style.transform = `rotate(${deg}deg)`;
        const span = document.createElement('span');
        span.textContent = num;
        // 数字随外层容器旋转后，需反向旋转回正，保证数字始终正向显示
        span.style.transform = `translateX(-50%) rotate(${-deg}deg)`;
        wrap.appendChild(span);
        dial.appendChild(wrap);
      });
    }

    // 2. 缓存指针与数字元素
    this._hourHand = root.querySelector('.hand-hour');
    this._minuteHand = root.querySelector('.hand-minute');
    this._secondHand = root.querySelector('.hand-second');
    this._digitalH = root.querySelector('#clock-dh');
    this._digitalM = root.querySelector('#clock-dm');
    this._digitalS = root.querySelector('#clock-ds');
    this._digitalDate = root.querySelector('#clock-date');

    // 3. 恢复上次记忆的显示模式（默认模拟时钟）
    let saved = null;
    try { saved = localStorage.getItem(this._STORAGE_KEY); } catch (e) { /* 忽略 */ }
    this._mode = saved === 'digital' ? 'digital' : 'analog';
    this._applyMode();

    // 4. 恢复上次记忆的位置（未记忆时保持 CSS 默认右上角）
    this._restorePosition();

    // 5. 绑定交互：
    //    - mousedown 开始潜在拖拽；document 上监听 move/up 保证拖动不中断
    //    - 键盘 Enter / Space 切换模式
    root.addEventListener('mousedown', (e) => this._onDragStart(e));
    document.addEventListener('mousemove', (e) => this._onDragMove(e));
    document.addEventListener('mouseup', (e) => this._onDragEnd(e));
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.toggleMode();
      }
    });

    // 6. 窗口尺寸变化时，把组件重新约束回可视区域内
    window.addEventListener('resize', () => this._restorePosition());

    // 7. 启动逐帧刷新循环
    const step = () => {
      this._tick();
      this._rafId = requestAnimationFrame(step);
    };
    this._rafId = requestAnimationFrame(step);
  },

  // -------------------------------------------------------------------
  // 切换显示模式（对外可调用）
  // -------------------------------------------------------------------
  toggleMode() {
    this._mode = this._mode === 'analog' ? 'digital' : 'analog';
    this._applyMode();
  },

  /** 应用当前模式到 DOM，并写入 localStorage 记忆 */
  _applyMode() {
    this._root.dataset.mode = this._mode;
    // 记忆用户偏好（如需关闭持久化，注释下面这行即可）
    try { localStorage.setItem(this._STORAGE_KEY, this._mode); } catch (e) { /* 忽略 */ }
  },

  // -------------------------------------------------------------------
  // 拖拽交互：按下开始 → 移动跟随 → 抬起判定点击 or 拖动
  // -------------------------------------------------------------------

  /** 按下：记录起点，并把 CSS 的 right 定位转换为 left/top 以便拖动 */
  _onDragStart(e) {
    if (e.button !== 0) return; // 仅响应左键
    this._dragging = true;
    this._moved = false;
    this._dragStartX = e.clientX;
    this._dragStartY = e.clientY;

    // 首次拖动时，把「靠右/靠上」定位换算成绝对 left/top（锚定左上角）
    const rect = this._root.getBoundingClientRect();
    this._root.style.right = 'auto';
    this._root.style.left = rect.left + 'px';
    this._root.style.top = rect.top + 'px';
    this._dragStartLeft = rect.left;
    this._dragStartTop = rect.top;

    this._root.classList.add('dragging');
  },

  /** 移动：跟随鼠标增量更新位置，并约束在窗口内 */
  _onDragMove(e) {
    if (!this._dragging) return;
    const dx = e.clientX - this._dragStartX;
    const dy = e.clientY - this._dragStartY;
    if (dx * dx + dy * dy >= this._DRAG_THRESHOLD * this._DRAG_THRESHOLD) {
      this._moved = true;
    }
    const left = this._dragStartLeft + dx;
    const top = this._dragStartTop + dy;
    this._root.style.left = left + 'px';
    this._root.style.top = top + 'px';
    this._clampToViewport();
  },

  /** 抬起：结束拖动；位移小视为点击，切换模式 */
  _onDragEnd() {
    if (!this._dragging) return;
    this._dragging = false;
    this._root.classList.remove('dragging');
    this._clampToViewport();

    // 记忆当前左上角位置（如需关闭位置记忆，注释下面这段即可）
    try {
      localStorage.setItem(this._POS_KEY, JSON.stringify({
        left: parseFloat(this._root.style.left),
        top: parseFloat(this._root.style.top)
      }));
    } catch (e) { /* 忽略 */ }

    if (!this._moved) this.toggleMode();
  },

  /** 从 localStorage 恢复位置；无记录则保持 CSS 默认，并做一次边界约束 */
  _restorePosition() {
    let pos = null;
    try { pos = JSON.parse(localStorage.getItem(this._POS_KEY) || 'null'); } catch (e) { /* 忽略 */ }
    if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
      this._root.style.right = 'auto';
      this._root.style.left = pos.left + 'px';
      this._root.style.top = pos.top + 'px';
    }
    this._clampToViewport();
  },

  /** 约束组件不超出可视区域 */
  _clampToViewport() {
    const w = this._root.offsetWidth;
    const h = this._root.offsetHeight;
    let left = parseFloat(this._root.style.left);
    let top = parseFloat(this._root.style.top);
    if (Number.isNaN(left) || Number.isNaN(top)) return;
    if (left < 0) left = 0;
    if (top < 0) top = 0;
    if (left > window.innerWidth - w) left = Math.max(0, window.innerWidth - w);
    if (top > window.innerHeight - h) top = Math.max(0, window.innerHeight - h);
    this._root.style.left = left + 'px';
    this._root.style.top = top + 'px';
  },

  // -------------------------------------------------------------------
  // 每帧更新：模拟指针角度（无条件）+ 数字文本（仅 digital 模式）
  // 说明：指针每帧都更新，保证从数字模式切回模拟时钟时指针位置不产生跳跃
  // -------------------------------------------------------------------
  _tick() {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    // reduceMotion 时秒针取整（每秒跳动），否则叠加毫秒实现平滑扫描
    const sFloat = now.getSeconds() + (this._reduceMotion ? 0 : now.getMilliseconds() / 1000);
    const s = now.getSeconds();

    // —— 指针角度：秒针 6°/秒，分针 6°/分（含秒进度），时针 30°/时（含分/秒进度）——
    const secDeg = sFloat * 6;
    const minDeg = (m + sFloat / 60) * 6;
    const hourDeg = ((h % 12) + m / 60 + s / 3600) * 30;
    if (this._secondHand) this._secondHand.style.transform = `rotate(${secDeg}deg)`;
    if (this._minuteHand) this._minuteHand.style.transform = `rotate(${minDeg}deg)`;
    if (this._hourHand) this._hourHand.style.transform = `rotate(${hourDeg}deg)`;

    // —— 数字模式：仅当秒或日期变化时更新对应文本 ——
    if (this._mode !== 'digital') return;

    const hh = String(h).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    const timeKey = hh + mm + ss;
    if (timeKey !== this._lastTime) {
      this._lastTime = timeKey;
      if (this._digitalH) this._digitalH.textContent = hh;
      if (this._digitalM) this._digitalM.textContent = mm;
      if (this._digitalS) this._digitalS.textContent = ss;
    }

    // 日期行随日期变化更新（跨天时才触发）
    const dateKey = DateUtil.format(now);
    if (dateKey !== this._lastDate) {
      this._lastDate = dateKey;
      if (this._digitalDate) {
        this._digitalDate.textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
      }
    }
  }
};