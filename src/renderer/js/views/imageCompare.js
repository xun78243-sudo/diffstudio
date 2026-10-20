/**
 * 图片比较视图。
 *
 * 两张图片逐像素比较：先按容差判定每个像素是否相同，再在"并集画布"
 * （两张图尺寸不同时取较大者）上渲染。
 *
 * 解码在主进程完成（Electron 的 nativeImage），这里只消费 RGBA 像素数组，
 * 因此视图本身不做任何格式解析。差异渲染到 <canvas>，不往 DOM 里塞
 * 按像素生成的元素——一张 1920×1080 的图会生成两百多万个节点。
 *
 * 快捷操作：
 *   差异 / 左侧 / 右侧  切换渲染模式
 *   适应 / 实际大小     缩放
 *   上一处 / 下一处     在差异区域之间跳转（差异按连通块分组）
 */

import { el, formatBytes, basename } from '../core/ui.js';
import { comparePixels, fitScale, stepIndex, findRegions } from '../core/imageDiff.js';
import { setStatus } from '../core/status.js';

export function createImageCompareSession(container, context, initial = {}) {
  const api = context.api;
  const t = context.t;
  const state = {
    leftPath: '',
    rightPath: '',
    left: null,
    right: null,
    /** 并集画布尺寸 */
    width: 0,
    height: 0,
    regions: [],
    cursor: -1,
    mode: 'diff', // diff | left | right
    zoom: 0, // 0 = 适应窗口
    tolerance: 0,
  };

  const leftInput = el('input', { class: 'path-input', placeholder: t('image.leftPlaceholder') });
  const rightInput = el('input', { class: 'path-input', placeholder: t('image.rightPlaceholder') });
  const btnLeft = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('image.openLeft'), 'data-role': 'open-left' });
  const btnRight = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('image.openRight'), 'data-role': 'open-right' });
  const btnSwap = el('button', { class: 'icon-btn', text: '⇄', title: t('image.swapSides'), 'data-role': 'swap' });
  const btnFit = el('button', { class: 'icon-btn', text: t('image.zoomFit'), title: t('image.zoomFit'), 'data-role': 'zoom-fit' });
  const btnZoomIn = el('button', { class: 'icon-btn', text: '＋', title: t('image.zoomIn'), 'data-role': 'zoom-in' });
  const btnZoomOut = el('button', { class: 'icon-btn', text: '－', title: t('image.zoomOut'), 'data-role': 'zoom-out' });
  const btnActual = el('button', { class: 'icon-btn', text: '1:1', title: t('image.zoomActual'), 'data-role': 'zoom-actual' });

  const modeSelect = el('select', { 'data-role': 'mode', title: t('image.modeHint') });
  for (const [value, key] of [['diff', 'image.diffMode'], ['left', 'image.leftMode'], ['right', 'image.rightMode']]) {
    modeSelect.append(el('option', { value, text: t(key) }));
  }

  const tolInput = el('input', {
    type: 'number', min: '0', max: '255', value: '0', class: 'tol-input',
    title: t('image.toleranceHint'), 'data-role': 'tolerance',
  });
  const btnPrev = el('button', { class: 'icon-btn', text: '↑', title: t('image.prevDiff'), 'data-role': 'prev-diff' });
  const btnNext = el('button', { class: 'icon-btn', text: '↓', title: t('image.nextDiff'), 'data-role': 'next-diff' });
  const navLabel = el('span', { class: 'nav-label', 'data-role': 'nav-status' });
  const btnSave = el('button', { class: 'icon-btn', text: t('image.saveDiff'), title: t('image.saveDiffHint'), 'data-role': 'save-diff' });

  const toolbar = el('div', { class: 'session-toolbar' },
    el('span', { text: t('common.sideLeft') }), leftInput, btnLeft,
    el('span', { text: t('common.sideRight') }), rightInput, btnRight,
    el('span', { class: 'spacer' }), btnSave, btnSwap,
  );

  const viewBar = el('div', { class: 'session-subbar' },
    modeSelect,
    el('span', { class: 'sep' }),
    tolInput, el('span', { text: t('image.tolerance') }),
    el('span', { class: 'spacer' }),
    btnZoomOut, btnFit, btnZoomIn, btnActual,
    el('span', { class: 'sep' }),
    btnPrev, btnNext, navLabel,
  );

  const canvas = el('canvas', { class: 'image-canvas', 'data-role': 'canvas' });
  const info = el('div', { class: 'image-info', 'data-role': 'image-info' });
  const stage = el('div', { class: 'image-stage' }, canvas, info);
  const root = el('div', { class: 'session image-session' }, toolbar, viewBar, stage);
  // 异步加载期间用户可能已切换成别的会话：容器已脱离文档就不再画。
  if (!container.isConnected) return;
  container.append(root);

  // ---- 数据加载 ----

  /** 通知外壳：用户已打开这些文件（最近打开 / 重启恢复都依赖它）。 */
  function notePaths() {
    if (typeof context.notePaths === 'function') {
      context.notePaths('image', [state.leftPath, state.rightPath]);
    }
  }

  async function loadSide(side) {
    const path = side === 'left' ? state.leftPath : state.rightPath;
    if (!path) return null;
    const res = await api.readImage(path);
    if (!res || !res.ok) {
      setStatus(t('image.unsupported'));
      return null;
    }
    return res;
  }

  async function load() {
    state.leftPath = leftInput.value.trim();
    state.rightPath = rightInput.value.trim();
    if (!state.leftPath || !state.rightPath) { setStatus(t('image.pickBoth')); return; }
    setStatus(t('image.loading'));
    try {
      const [l, r] = await Promise.all([loadSide('left'), loadSide('right')]);
      if (!l || !r) return;
      state.left = l;
      state.right = r;
      recompute();
      notePaths();
    } catch (err) {
      setStatus(t('image.openFailed', { msg: err.message }));
    }
  }

  /** 按当前容差重新比较并重绘（不重新解码）。 */
  function recompute() {
    const { left, right } = state;
    if (!left || !right) return;
    state.width = Math.max(left.width, right.width);
    state.height = Math.max(left.height, right.height);
    const res = comparePixels(left, right, state.tolerance);
    state.result = res;
    state.cursor = -1;

    // 差异掩码计算一次，供分区与渲染共用
    const differs = new Uint8Array(state.width * state.height);
    const A = left;
    const B = right;
    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const p = y * state.width + x;
        const inL = x < A.width && y < A.height;
        const inR = x < B.width && y < B.height;
        let d = false;
        if (inL && inR) {
          const i = (y * A.width + x) * 4;
          const j = (y * B.width + x) * 4;
          d = Math.max(
            Math.abs(A.data[i] - B.data[j]),
            Math.abs(A.data[i + 1] - B.data[j + 1]),
            Math.abs(A.data[i + 2] - B.data[j + 2]),
            Math.abs(A.data[i + 3] - B.data[j + 3]),
          ) > state.tolerance;
        } else {
          const src = inL ? A : B;
          const i = inL ? (y * A.width + x) * 4 : (y * B.width + x) * 4;
          d = src.data[i + 3] !== 0;
        }
        if (d) differs[p] = 1;
      }
    }
    state.differs = differs;
    // 只在尺寸较小的差异图上做连通分区，避免整幅大图的扫描开销
    state.regions = res.differing ? findRegions(state.width, state.height, differs) : [];

    draw();
    const pct = state.width * state.height
      ? ((res.differing / (state.width * state.height)) * 100).toFixed(2) + '%'
      : '0%';
    const sizes = res.sameSize
      ? t('image.sameSize')
      : t('image.sizeDiff', { lw: left.width, lh: left.height, rw: right.width, rh: right.height });
    info.textContent = `${sizes} · ${basename(state.leftPath)} (${formatBytes(left.size)}) ↔ ${basename(state.rightPath)} (${formatBytes(right.size)}) · ${res.differing} px (${pct})`;
    if (!res.differing) setStatus(t('image.noDiffs'));
    else setStatus(t('image.status', { w: state.width, h: state.height, n: res.differing, pct }));
    updateNav();
  }

  // ---- 渲染 ----

  function currentScale() {
    const rect = stage.getBoundingClientRect();
    const vw = Math.max(64, rect.width - 24);
    const vh = Math.max(64, rect.height - 24);
    return state.zoom || fitScale(state.width, state.height, vw, vh);
  }

  function draw() {
    const { left, right } = state;
    if (!left || !right) return;
    let scale = currentScale();
    // 缩放大图时只渲染可见区域，避免超大画布
    const vw = Math.max(1, state.width);
    const vh = Math.max(1, state.height);
    canvas.width = Math.max(1, Math.round(vw * scale));
    canvas.height = Math.max(1, Math.round(vh * scale));
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // 棋盘格背景，便于看出透明区域
    ctx.fillStyle = '#f4f4f4';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const img = ctx.createImageData(state.width, state.height);
    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const p = y * state.width + x;
        const o = p * 4;
        const src = state.mode === 'right' ? right : left;
        // "差异"模式下以左图为底，差异像素标红；只在一侧存在的区域用淡红
        if (state.mode === 'diff' && state.differs[p]) {
          img.data[o] = 220;
          img.data[o + 1] = 40;
          img.data[o + 2] = 40;
          img.data[o + 3] = 255;
          continue;
        }
        if (x < src.width && y < src.height) {
          const i = (y * src.width + x) * 4;
          img.data[o] = src.data[i];
          img.data[o + 1] = src.data[i + 1];
          img.data[o + 2] = src.data[i + 2];
          img.data[o + 3] = src.data[i + 3];
        } else {
          img.data[o + 3] = 0;
        }
      }
    }
    // 先把小图放进临时 canvas 再缩放绘制，避免逐像素缩放导致模糊/卡顿
    const tmp = document.createElement('canvas');
    tmp.width = state.width;
    tmp.height = state.height;
    tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);

    // 当前差异区域描边
    const r = state.regions[state.cursor];
    if (r && state.mode === 'diff') {
      ctx.strokeStyle = 'rgba(220,40,40,0.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x * scale + 0.5, r.y * scale + 0.5, r.w * scale, r.h * scale);
    }
  }

  function updateNav() {
    const n = state.regions.length;
    btnPrev.disabled = !n;
    btnNext.disabled = !n;
    navLabel.textContent = n ? t('image.navStatus', { n, cur: Math.max(1, state.cursor + 1) }) : '';
  }

  function jump(dir) {
    if (!state.regions.length) { setStatus(t('image.noDiffs')); return; }
    state.cursor = stepIndex(state.cursor, state.regions.length, dir);
    draw();
    updateNav();
    const r = state.regions[state.cursor];
    // 跳转后把差异区域滚动到视口中间
    const scale = currentScale();
    stage.scrollTo({
      left: Math.max(0, r.cx * scale - stage.clientWidth / 2),
      top: Math.max(0, r.cy * scale - stage.clientHeight / 2),
      behavior: 'smooth',
    });
  }

  // ---- 交互 ----

  btnLeft.addEventListener('click', async () => {
    const res = await api.openFiles({ multi: false, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp'] }] });
    if (!res || !res[0]) return;
    state.leftPath = res[0];
    leftInput.value = res[0];
    if (state.rightPath) load();
  });
  btnRight.addEventListener('click', async () => {
    const res = await api.openFiles({ multi: false, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp'] }] });
    if (!res || !res[0]) return;
    state.rightPath = res[0];
    rightInput.value = res[0];
    if (state.leftPath) load();
  });

  btnSwap.addEventListener('click', () => {
    const p = leftInput.value;
    leftInput.value = rightInput.value;
    rightInput.value = p;
    if (state.leftPath && state.rightPath) load();
  });

  modeSelect.addEventListener('change', () => {
    state.mode = modeSelect.value;
    draw();
  });
  tolInput.addEventListener('change', () => {
    state.tolerance = Math.max(0, Math.min(255, Number(tolInput.value) || 0));
    tolInput.value = String(state.tolerance);
    if (state.left && state.right) recompute();
  });

  btnFit.addEventListener('click', () => { state.zoom = 0; draw(); });
  btnActual.addEventListener('click', () => { state.zoom = 1; draw(); });
  btnZoomIn.addEventListener('click', () => { state.zoom = Math.min(8, currentScale() * 1.5); draw(); });
  btnZoomOut.addEventListener('click', () => { state.zoom = Math.max(0.05, currentScale() / 1.5); draw(); });
  btnPrev.addEventListener('click', () => jump(-1));
  btnNext.addEventListener('click', () => jump(1));

  btnSave.addEventListener('click', async () => {
    if (!state.differs) { setStatus(t('image.pickBoth')); return; }
    // 差异图：差异像素红、其余黑色，便于在报告里一眼定位
    const data = new Array(state.width * state.height * 4);
    for (let p = 0; p < state.width * state.height; p++) {
      const o = p * 4;
      const on = state.differs[p];
      data[o] = on ? 255 : 30;
      data[o + 1] = on ? 40 : 30;
      data[o + 2] = on ? 40 : 30;
      data[o + 3] = 255;
    }
    try {
      const path = await api.saveFile({ title: t('image.saveDiff'), defaultPath: 'image-diff.png' });
      if (!path) return;
      await api.savePng(path, state.width, state.height, data);
      setStatus(t('image.saved', { path }));
    } catch (err) {
      setStatus(t('image.openFailed', { msg: err.message }));
    }
  });

  for (const input of [leftInput, rightInput]) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  }

  const onResize = () => { if (!state.zoom) draw(); };
  window.addEventListener('resize', onResize);

  if (initial.left) leftInput.value = initial.left;
  if (initial.right) rightInput.value = initial.right;
  if (initial.left && initial.right) load();


  function getState() {
    return { left: leftInput.value.trim(), right: rightInput.value.trim() };
  }

  return {
    destroy() {
      window.removeEventListener('resize', onResize);
    },
    getState,
    /** 测试钩子：直接注入解码好的像素，避免依赖真实图片文件。 */
    __load(l, r) {
      state.left = l;
      state.right = r;
      recompute();
    },
    __state: state,
  };
}
