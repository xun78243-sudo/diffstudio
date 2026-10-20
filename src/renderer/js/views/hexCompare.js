/**
 * 十六进制比较视图。
 *
 * 读取两个二进制文件（有大小上限），按字节比较，渲染十六进制 + ASCII
 * 两列。不同的字节高亮；仅一侧存在的字节（文件长度不同）也视为差异。
 * 语义对齐 Beyond Compare 的十六进制比较视图，并提供「上一处 / 下一处
 * 差异」导航（按连续差异行分组）。
 *
 * 只渲染可见窗口：文件可以远大于屏幕，整份铺进 DOM 会把内存吃光。
 * 编辑模式下在左侧输入框填「偏移:字节」，回车即改写该字节，保存写回磁盘。
 */

import { el, formatBytes, basename } from '../core/ui.js';
import { setStatus } from '../core/status.js';

const MAX_BYTES = 16 * 1024 * 1024; // 16 MB cap per read; only visible rows are rendered
const BYTES_PER_ROW = 16;
const ROW_HEIGHT = 18; // keep in sync with the .hex-row line-height

export function createHexCompareSession(container, context, initial = {}) {
  const api = context.api;
  const t = context.t;
  const state = {
    leftPath: '',
    rightPath: '',
    /** 每行是否为差异行，供导航使用 */
    diffRows: [],
    /** 每处连续差异块的首行下标 */
    anchors: [],
    cursor: -1,
    /** 当前高亮的行（导航定位） */
    currentRow: -1,
    /** 两侧字节（编辑后是内存中的副本，保存时写盘） */
    leftBytes: new Uint8Array(0),
    rightBytes: new Uint8Array(0),
    dirty: false,
  };

  const leftInput = el('input', { class: 'path-input', placeholder: t('textCompare.leftPlaceholder') });
  const rightInput = el('input', { class: 'path-input', placeholder: t('textCompare.rightPlaceholder') });
  const btnLeft = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('hex.openLeft'), 'data-role': 'open-left' });
  const btnRight = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('hex.openRight'), 'data-role': 'open-right' });
  const btnCompare = el('button', { class: 'icon-btn', text: '↻ ' + t('hex.tabTitle'), title: t('hex.compare'), 'data-role': 'compare' });
  const btnPrev = el('button', { class: 'icon-btn', text: '↑', title: t('hex.prevDiff'), 'data-role': 'prev-diff' });
  const btnNext = el('button', { class: 'icon-btn', text: '↓', title: t('hex.nextDiff'), 'data-role': 'next-diff' });
  const btnSave = el('button', { class: 'icon-btn', text: '💾 ' + t('common.save'), title: t('hex.save'), 'data-role': 'save' });
  const navLabel = el('span', { class: 'nav-label', 'data-role': 'nav-status' });

  const toolbar = el('div', { class: 'session-toolbar' },
    el('span', { text: t('common.sideLeft') }), leftInput, btnLeft,
    el('span', { text: t('common.sideRight') }), rightInput, btnRight,
    el('span', { class: 'spacer' }), btnPrev, btnNext, navLabel, btnSave, btnCompare,
  );

  const legend = el('div', { class: 'legend' },
    el('div', { class: 'it' }, el('span', { class: 'sw', style: 'background: var(--c-change)' }), el('span', { text: t('hex.legend') })));
  const editInput = el('input', { class: 'path-input', placeholder: t('hex.editHint'), 'data-role': 'hex-edit' });
  legend.append(editInput);

  function makePane(label) {
    const header = el('div', { class: 'pane-header' }, el('span', { class: 'label', text: label }));
    const rows = el('div', { class: 'hex-rows' });
    // 虚拟滚动要在 pane-body 内绝对定位 viewport，占位 spacer 负责撑出滚动条。
    rows.className = 'hex-rows';
    rows.style.position = 'relative';
    const body = el('div', { class: 'pane-body' }, rows);
    return { header, rows, side: label, body, pane: el('div', { class: 'pane' }, header, body) };
  }
  const L = makePane(t('common.sideLeft'));
  const R = makePane(t('common.sideRight'));
  const panes = el('div', { class: 'panes side-by-side' }, L.pane, R.pane);

  const root = el('div', { class: 'session' }, toolbar, legend, panes);
  container.append(root);

  /** 通知外壳：用户已打开这些文件（最近打开 / 重启恢复都依赖它）。 */
  function notePaths() {
    if (typeof context.notePaths === 'function') {
      context.notePaths('hex', [state.leftPath, state.rightPath]);
    }
  }

  async function pick(side) {
    const res = await api.openFiles({ multi: false });
    if (!res || !res[0]) return;
    if (side === 'left') { state.leftPath = res[0]; leftInput.value = res[0]; }
    else { state.rightPath = res[0]; rightInput.value = res[0]; }
    notePaths();
    if (state.leftPath && state.rightPath) compare();
  }

  // 由其他会话带着路径打开时，预填两侧并立即比较。
  if (initial.left || initial.right) {
    if (initial.left) { state.leftPath = initial.left; leftInput.value = initial.left; }
    if (initial.right) { state.rightPath = initial.right; rightInput.value = initial.right; }
    if (state.leftPath && state.rightPath) compare();
  }
  btnLeft.addEventListener('click', () => pick('left'));
  btnRight.addEventListener('click', () => pick('right'));
  btnCompare.addEventListener('click', compare);
  btnPrev.addEventListener('click', () => jumpDiff(-1));
  btnNext.addEventListener('click', () => jumpDiff(1));
  btnSave.addEventListener('click', save);
  editInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyEdit(); }
    if (e.key === 'Escape') editInput.blur();
  });

  // 窗口尺寸变化后可见行数变了，按新高度重画。
  let ro = null;
  const onResize = () => {
    if (L.virtual) { paintWindow(L, L.body.scrollTop); paintWindow(R, R.body.scrollTop); }
  };
  window.addEventListener('resize', onResize);
  // pane-body 高度变化（工具栏换行、布局切换）不会触发 window resize。
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(onResize);
    ro.observe(L.body);
  }

  async function compare() {
    state.leftPath = leftInput.value.trim();
    state.rightPath = rightInput.value.trim();
    if (!state.leftPath || !state.rightPath) { setStatus(t('hex.pickBoth')); return; }
    setStatus(t('hex.reading'));
    let l, r;
    try {
      // 上限写死 16 MB：超过时只比较前 16 MB，状态栏会明确提示。
      // 传 undefined 会落回主进程的 1 MB 默认值，文件超出部分就静默丢掉了。
      [l, r] = await Promise.all([
        api.readBinary(state.leftPath, MAX_BYTES),
        api.readBinary(state.rightPath, MAX_BYTES),
      ]);
    } catch (err) {
      setStatus(t('textCompare.openFailed', { msg: err.message }));
      return;
    }

    state.leftBytes = toBytes(l.data);
    state.rightBytes = toBytes(r.data);
    state.dirty = false;
    state.leftSize = l.size;    state.rightSize = r.size;
    state.sizeTruncated = l.size > MAX_BYTES || r.size > MAX_BYTES;
    recomputeDiff();
    renderHex(L, state.leftPath, state.leftBytes, state.rightBytes, state.rowCount);
    renderHex(R, state.rightPath, state.rightBytes, state.leftBytes, state.rowCount);
    updateNav();
    reportStatus();
  }

  /** 重新计算差异行与导航锚点（编辑一个字节后也要调用）。 */
  function recomputeDiff() {
    const a = state.leftBytes;
    const b = state.rightBytes;
    const rowCount = Math.ceil(Math.max(a.length, b.length) / BYTES_PER_ROW);
    state.rowCount = rowCount;
    state.diffRows = new Uint8Array(rowCount);
    state.anchors = [];
    for (let row = 0; row < rowCount; row++) {
      const start = row * BYTES_PER_ROW;
      let differs = false;
      for (let i = 0; i < BYTES_PER_ROW && !differs; i++) {
        const idx = start + i;
        if (idx >= a.length && idx >= b.length) continue;
        if (idx >= a.length || idx >= b.length || a[idx] !== b[idx]) differs = true;
      }
      state.diffRows[row] = differs ? 1 : 0;
      if (differs && (row === 0 || !state.diffRows[row - 1])) state.anchors.push(row);
    }
    state.cursor = -1;
    state.currentRow = -1;
  }

  function reportStatus() {
    const diffBytes = countDifferences(state.leftBytes, state.rightBytes);
    setStatus(
      t('hex.status', {
        leftSize: formatBytes(state.leftSize),
        rightSize: formatBytes(state.rightSize),
        n: diffBytes,
      })
      + (state.sizeTruncated ? t('hex.truncated') : '')
      + (state.dirty ? t('hex.edited') : ''),
    );
    if (diffBytes === 0 && !state.dirty) setStatus(t('hex.noDiffs'));
  }

  /**
   * 编辑一个字节：输入 `偏移:值`，例如 `1A:FF` 或 `26:0`。
   * 偏移按字节（十六进制），两侧都可改：以 `L:` / `R:` 前缀指定侧，
   * 缺省改左侧。越界写入会被拒绝（不允许用编辑改变文件长度）。
   */
  function applyEdit() {
    const raw = editInput.value.trim();
    if (!raw) return;
    const m = /^(?:([LRlr]):)?([0-9a-fA-F]+)\s*:\s*(?:0x)?([0-9a-fA-F]{1,2})$/.exec(raw);
    if (!m) { setStatus(t('hex.editSyntax')); return; }
    const side = (m[1] || 'L').toUpperCase();
    const offset = parseInt(m[2], 16);
    const value = parseInt(m[3], 16);
    const target = side === 'L' ? state.leftBytes : state.rightBytes;
    if (offset >= target.length) { setStatus(t('hex.editOutOfRange', { max: (target.length - 1).toString(16) })); return; }

    target[offset] = value;
    state.dirty = true;
    editInput.value = '';
    recomputeDiff();
    renderHex(L, state.leftPath, state.leftBytes, state.rightBytes, state.rowCount);
    renderHex(R, state.rightPath, state.rightBytes, state.leftBytes, state.rowCount);
    scrollToRow(Math.floor(offset / BYTES_PER_ROW));
    updateNav();
    reportStatus();
    setStatus(t('hex.editedByte', { side, offset: offset.toString(16).toUpperCase(), value: value.toString(16).toUpperCase().padStart(2, '0') }));
  }

  async function save() {
    if (!state.dirty) { setStatus(t('hex.nothingToSave')); return; }
    try {
      const sides = [
        { path: state.leftPath, data: state.leftBytes },
        { path: state.rightPath, data: state.rightBytes },
      ];
      for (const s of sides) {
        await api.writeBinary(s.path, Array.from(s.data));
      }
      state.dirty = false;
      reportStatus();
      setStatus(t('hex.saved', { path: state.leftPath }));
    } catch (err) {
      setStatus(t('textCompare.openFailed', { msg: err.message }));
    }
  }

  function updateNav() {
    const n = state.anchors.length;
    btnPrev.disabled = n === 0;
    btnNext.disabled = n === 0;
    navLabel.textContent = n === 0 ? '' : t('hex.navStatus', { n, cur: Math.max(state.cursor + 1, 1) });
  }

  function jumpDiff(dir) {
    const n = state.anchors.length;
    if (!n) { setStatus(t('hex.noDiffs')); return; }
    if (state.cursor < 0) state.cursor = dir > 0 ? 0 : n - 1;
    else state.cursor = (state.cursor + dir + n) % n;
    const target = state.anchors[state.cursor];
    state.currentRow = target;
    scrollToRow(target);
    updateNav();
  }

  // 两侧按相对位置同步滚动；滚动时重画各自的可见窗口。
  L.body.addEventListener('scroll', () => { R.body.scrollTop = L.body.scrollTop; });
  R.body.addEventListener('scroll', () => { L.body.scrollTop = R.body.scrollTop; });

  /**
   * 差异字节数：重叠部分逐字节比较，长度差的部分也计入差异。
   */
  function countDifferences(a, b) {
    let n = 0;
    const common = Math.min(a.length, b.length);
    for (let i = 0; i < common; i++) if (a[i] !== b[i]) n++;
    return n + Math.abs(a.length - b.length);
  }

  function renderHex(pane, filePath, data, other, rows) {
    pane.header.innerHTML = '';
    pane.header.append(el('span', { class: 'label', text: pane.side }), el('span', { text: basename(filePath) }));
    pane.rows.innerHTML = '';
    // 大文件不会整份铺进 DOM：用与总行数等高的占位撑出滚动条，只渲染可见窗口。
    pane.virtual = { data, other, rows };
    // 先建占位再画：ensureSpacer 末尾会同步画出第一屏，窗口被隐藏时也看不到空白。
    ensureSpacer(pane, rows);
  }

  function ensureSpacer(pane, rows) {
    if (!pane.spacer) {
      pane.spacer = el('div', { class: 'hex-spacer' });
      pane.viewport = el('div', { class: 'hex-viewport' });
      pane.rows.append(pane.spacer, pane.viewport);
    }
    const height = Math.ceil(rows * ROW_HEIGHT);
    pane.spacer.style.height = height + 'px';
    // 隐藏窗口里的 requestAnimationFrame 可能长期不触发，滚动条会空着；
    // 先同步画出第一屏，下一帧再按真实可见高度校正。
    drawRows(pane, pane.body.scrollTop);
  }

  /** 立即重画一屏（同步，不经过 rAF）。 */
  function drawRows(pane, scrollTop) {
    const v = pane.virtual;
    if (!v) return;
    const total = v.rows;
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 1);
    const count = Math.ceil((pane.body.clientHeight || 600) / ROW_HEIGHT) + 3;
    const last = Math.min(total, first + count);

    pane.viewport.style.transform = 'translateY(' + first * ROW_HEIGHT + 'px)';
    pane.viewport.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let row = first; row < last; row++) {
      frag.append(hexRow(v.data, v.other, row, row === state.currentRow));
    }
    pane.viewport.append(frag);
    pane.firstRow = first;
    pane.lastRow = last;
  }

  /** 只重画 `scrollTop` 附近的行；窗口外保留上下各一行缓冲，减少滚动抖动。 */
  function paintWindow(pane, scrollTop) {
    if (!pane.virtual) return;
    // 滚动事件会成串到达，合并到下一帧再重画。
    if (pane.pending !== undefined) cancelAnimationFrame(pane.pending);
    pane.pending = requestAnimationFrame(() => {
      pane.pending = undefined;
      drawRows(pane, scrollTop);
    });
  }

  function hexRow(data, other, row, isCurrent) {
    const offset = row * BYTES_PER_ROW;
    const rowEl = el('div', { class: 'hex-row' + (isCurrent ? ' current' : ''), 'data-row': String(row) });
    rowEl.append(el('span', { class: 'hex-offset', text: offset.toString(16).toUpperCase().padStart(8, '0') }));

    const bytesEl = el('span', { class: 'hex-bytes' });
    let ascii = '';
    for (let i = 0; i < BYTES_PER_ROW; i++) {
      const idx = offset + i;
      if (idx >= data.length) {
        bytesEl.append(el('span', { class: 'hex-byte', text: '  ' }));
        bytesEl.append(' ');
        ascii += ' ';
        continue;
      }
      const b = data[idx];
      // 对端没有这一字节（文件更短）同样是差异。
      const diff = idx >= other.length || b !== other[idx];
      bytesEl.append(el('span', { class: 'hex-byte' + (diff ? ' diff' : ''), text: b.toString(16).toUpperCase().padStart(2, '0') }));
      bytesEl.append(' ');
      ascii += b >= 32 && b < 127 ? String.fromCharCode(b) : '·';
    }
    rowEl.append(bytesEl);
    rowEl.append(el('span', { class: 'hex-ascii', text: ascii }));
    return rowEl;
  }

  /** 滚动到某一行（按虚拟滚动坐标），并重画可见窗口。 */
  function scrollToRow(row) {
    const target = Math.max(0, row * ROW_HEIGHT - L.body.clientHeight / 2);
    L.body.scrollTop = target;
    R.body.scrollTop = target;
    paintWindow(L, target);
    paintWindow(R, target);
  }


  function getState() {
    return { left: leftInput.value.trim(), right: rightInput.value.trim() };
  }

  return {
    destroy() {
      window.removeEventListener('resize', onResize);
      if (ro) ro.disconnect();
      if (L.pending !== undefined) cancelAnimationFrame(L.pending);
      if (R.pending !== undefined) cancelAnimationFrame(R.pending);
    },
    getState,
  };
}

/** IPC 传回的二进制可能是 Buffer 序列化后的 { type, data } 形式。 */
function toBytes(buf) {
  if (!buf) return new Uint8Array(0);
  if (buf instanceof Uint8Array) return buf;
  if (buf.type === 'Buffer' && Array.isArray(buf.data)) return Uint8Array.from(buf.data);
  return Uint8Array.from(buf);
}
