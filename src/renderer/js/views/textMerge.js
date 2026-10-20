/**
 * 三路文本合并视图。
 *
 * 加载共同祖先（base）、我方（mine）与对方（theirs）三个版本，按 diff3
 * 语义对齐，允许用户对每一处改动「取我方 / 取对方 / 取祖先」，自动识别
 * 双方对同一区域的冲突。语义对齐 Beyond Compare 的文本合并会话。
 */

import { threeWayMerge } from '../core/diff.js';
import { el, splitLines, joinLines } from '../core/ui.js';
import { setStatus } from '../core/status.js';

export function createMergeSession(container, context, initial = {}) {
  const api = context.api;
  const t = context.t;
  const state = {
    basePath: '',
    leftPath: '',
    rightPath: '',
    rows: [],
    conflicts: 0,
    /** 输出文件的换行风格，跟随共同祖先文件；由 eolOf 在合并时确定 */
    outputEol: '\r\n',
  };

  /** resolution: hunkId -> { rows: [{ original, text }] } */
  const resolution = new Map();
  let selectedHunk = null;

  // --- 工具栏 ---
  const baseInput = el('input', { class: 'path-input', placeholder: t('merge.basePlaceholder') });
  const leftInput = el('input', { class: 'path-input', placeholder: t('merge.leftPlaceholder') });
  const rightInput = el('input', { class: 'path-input', placeholder: t('merge.rightPlaceholder') });
  const btnBase = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('merge.openBase'), 'data-role': 'open-base' });
  const btnLeft = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('merge.openLeft'), 'data-role': 'open-left' });
  const btnRight = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('merge.openRight'), 'data-role': 'open-right' });
  const btnMerge = el('button', { class: 'icon-btn', text: '↻ ' + t('merge.mergeBtn'), title: t('merge.mergeBtn') });
  const btnSave = el('button', { class: 'icon-btn primary', text: '💾 ' + t('merge.save'), title: t('merge.save'), 'data-role': 'save' });

  const toolbar = el('div', { class: 'session-toolbar' },
    el('span', { text: t('merge.base') }), baseInput, btnBase,
    el('span', { text: t('merge.mine') }), leftInput, btnLeft,
    el('span', { text: t('merge.theirs') }), rightInput, btnRight,
    el('span', { class: 'spacer' }), btnMerge, btnSave,
  );

  // --- 解决操作 ---
  const takeLeft = el('button', { class: 'icon-btn', text: t('merge.takeLeft'), 'data-role': 'take-left' });
  const takeRight = el('button', { class: 'icon-btn', text: t('merge.takeRight'), 'data-role': 'take-right' });
  const takeBase = el('button', { class: 'icon-btn', text: t('merge.takeBase'), 'data-role': 'take-base' });
  const prevConflict = el('button', { class: 'icon-btn', text: t('merge.prevConflict'), 'data-role': 'prev-conflict' });
  const nextConflict = el('button', { class: 'icon-btn', text: t('merge.nextConflict'), 'data-role': 'next-conflict' });
  const actions = el('div', { class: 'merge-actions' },
    el('span', { class: 'hint', text: t('merge.currentDiff') }),
    takeLeft, takeRight, takeBase,
    el('span', { class: 'spacer' }),
    prevConflict, nextConflict,
  );

  const legend = el('div', { class: 'legend' },
    legendItem('var(--c-left)', t('merge.legendLeft')),
    legendItem('var(--c-right)', t('merge.legendRight')),
    legendItem('var(--c-conflict)', t('merge.legendConflict')),
    legendItem('var(--c-resolved)', t('merge.legendResolved')),
  );

  function legendItem(color, text) {
    return el('div', { class: 'it' }, el('span', { class: 'sw', style: `background:${color}` }), el('span', { text }));
  }

  function makePane(label) {
    const header = el('div', { class: 'pane-header' }, el('span', { class: 'label', text: label }));
    const rows = el('div', { class: 'rows locked' });
    const body = el('div', { class: 'pane-body' }, rows);
    return { header, rows, pane: el('div', { class: 'pane' }, header, body) };
  }
  const L = makePane(t('merge.paneLeft'));
  const B = makePane(t('merge.paneBase'));
  const R = makePane(t('merge.paneRight'));
  const topPanes = el('div', { class: 'panes three-way' }, L.pane, B.pane, R.pane);

  const outHeader = el('div', { class: 'pane-header' }, el('span', { class: 'label', text: t('merge.output') }));
  const outRows = el('div', { class: 'rows locked' });
  const outBody = el('div', { class: 'pane-body' }, outRows);
  const outPane = el('div', { class: 'pane' }, outHeader, outBody);
  const bottom = el('div', { class: 'panes output-pane' }, outPane);

  const root = el('div', { class: 'session' }, toolbar, actions, legend, topPanes, bottom);
  container.append(root);

  /** 通知外壳：用户已打开这些文件（最近打开 / 重启恢复都依赖它）。 */
  function notePaths() {
    if (typeof context.notePaths === 'function' && state.basePath) {
      context.notePaths('merge', [state.basePath, state.leftPath, state.rightPath]);
    }
  }

  async function pick(side) {
    const res = await api.openFiles({ multi: false });
    if (!res || !res[0]) return;
    const r = await api.readText(res[0]);
    if (r.binary) { setStatus(t('merge.binary')); return; }
    if (side === 'base') { state.basePath = res[0]; baseInput.value = res[0]; }
    else if (side === 'left') { state.leftPath = res[0]; leftInput.value = res[0]; }
    else { state.rightPath = res[0]; rightInput.value = res[0]; }
    if (state.basePath && state.leftPath && state.rightPath) { merge(); notePaths(); }
  }

  // 三个路径都齐时立即合并；缺少 base 时只做预填，由用户补全。
  if (initial.base || initial.left || initial.right) {
    if (initial.base) { state.basePath = initial.base; baseInput.value = initial.base; }
    if (initial.left) { state.leftPath = initial.left; leftInput.value = initial.left; }
    if (initial.right) { state.rightPath = initial.right; rightInput.value = initial.right; }
    if (state.basePath && state.leftPath && state.rightPath) merge();
  }
  btnBase.addEventListener('click', () => pick('base'));
  btnLeft.addEventListener('click', () => pick('left'));
  btnRight.addEventListener('click', () => pick('right'));
  btnMerge.addEventListener('click', merge);

  async function merge() {
    if (!state.basePath || !state.leftPath || !state.rightPath) {
      setStatus(t('merge.pickThree'));
      return;
    }
    let b, l, r;
    try {
      [b, l, r] = await Promise.all([
        api.readText(state.basePath),
        api.readText(state.leftPath),
        api.readText(state.rightPath),
      ]);
    } catch (err) {
      setStatus(t('textCompare.openFailed', { msg: err.message }));
      return;
    }
    // 三路比较同样按「忽略行尾符」对齐；输出时统一使用祖先文件的换行风格，
    // 避免"我方取 CRLF、对方取 LF"拼出混合换行符的文件。
    const baseLines = splitLines(b.text);
    const result = threeWayMerge(baseLines, splitLines(l.text), splitLines(r.text));
    state.rows = result.rows;
    state.conflicts = result.conflictCount;
    state.outputEol = eolOf(baseLines);
    resolution.clear();
    selectedHunk = null;
    render();
    updateStatus();
  }

  function unresolvedCount() {
    const hunks = new Set();
    for (const row of state.rows) {
      if (row.hunkId && !resolution.has(row.hunkId)) hunks.add(row.hunkId);
    }
    return hunks.size;
  }

  function updateStatus() {
    setStatus(t('merge.status', {
      n: state.rows.length,
      conflicts: state.conflicts,
      pending: unresolvedCount(),
    }));
  }

  function hunkRows(hunkId) {
    return state.rows.filter((r) => r.hunkId === hunkId);
  }

  function isFirstOfHunk(row) {
    const list = hunkRows(row.hunkId);
    return list[0] === row;
  }

  function render() {
    L.rows.innerHTML = '';
    B.rows.innerHTML = '';
    R.rows.innerHTML = '';
    outRows.innerHTML = '';

    const fL = document.createDocumentFragment();
    const fB = document.createDocumentFragment();
    const fR = document.createDocumentFragment();
    const fO = document.createDocumentFragment();

    for (const row of state.rows) {
      const hunkId = row.hunkId ?? null;
      const resolved = hunkId !== null && resolution.has(hunkId);
      const cls = resolved ? 'kind-resolved' : rowCls(row);
      const sel = hunkId !== null && hunkId === selectedHunk ? ' selected' : '';

      const mk = (text) => {
        const r = el('div', { class: 'row ' + cls + sel });
        const code = el('span', { class: 'code', text: text ?? '' });
        if (text === '' || text === undefined) code.classList.add('empty-line');
        r.append(code);
        if (hunkId !== null) r.addEventListener('click', () => selectHunk(hunkId));
        return r;
      };

      fL.append(mk(row.left));
      fB.append(mk(row.base));
      fR.append(mk(row.right));

      if (resolved) {
        // 已解决的块只输出一次，内容取用户选定的那一侧
        if (isFirstOfHunk(row)) {
          for (const out of resolution.get(hunkId).rows) {
            const r = el('div', { class: 'row kind-resolved' + sel });
            const code = el('span', { class: 'code', text: out.text ?? '' });
            if (out.text === '') code.classList.add('empty-line');
            r.append(code);
            fO.append(r);
          }
        }
      } else {
        // 未解决的改动：整块展开成占位行
        for (const r of previewRows(row, hunkId, sel)) fO.append(r);
      }
    }

    L.rows.append(fL);
    B.rows.append(fB);
    R.rows.append(fR);
    outRows.append(fO);
  }

  /** Beyond Compare 风格的合并行配色。 */
  function rowCls(row) {
    switch (row.state) {
      case 'same': return 'kind-same';
      case 'leftChanged': return 'kind-left';
      case 'rightChanged': return 'kind-right';
      case 'conflict': return 'kind-conflict';
      default: return 'kind-same';
    }
  }

  /**
   * 未解决的改动在输出面板里的占位行。
   * 冲突展开成标准冲突标记，并且整处冲突只出现一次。
   */
  function previewRows(row, hunkId, sel) {
    const mk = (text, cls) => {
      const r = el('div', { class: 'row ' + cls + sel });
      const code = el('span', { class: 'code', text });
      if (text === '') code.classList.add('empty-line');
      r.append(code);
      if (hunkId !== null) r.addEventListener('click', () => selectHunk(hunkId));
      return r;
    };

    if (row.state === 'conflict') {
      if (!isFirstOfHunk(row)) return [];
      const rows = hunkRows(hunkId);
      const out = [mk(t('merge.conflictTags'), 'kind-conflict')];
      for (const r of rows) out.push(mk(r.left ?? '', 'kind-conflict'));
      out.push(mk(t('merge.conflictSep'), 'kind-conflict'));
      for (const r of rows) out.push(mk(r.right ?? '', 'kind-conflict'));
      out.push(mk(t('merge.conflictEnd'), 'kind-conflict'));
      return out;
    }

    if (row.state === 'leftChanged') return [mk(row.left ?? '', 'kind-left')];
    if (row.state === 'rightChanged') return [mk(row.right ?? '', 'kind-right')];
    return [mk(row.base ?? '', 'kind-same')];
  }

  function selectHunk(hunkId) {
    selectedHunk = hunkId;
    render();
  }

  /** 对当前选中的改动块整体执行「取我方 / 取对方 / 取祖先」。 */
  function resolveCurrent(mode) {
    let hunkId = selectedHunk;
    if (!hunkId) {
      const first = state.rows.find((r) => r.hunkId && !resolution.has(r.hunkId));
      if (!first) { setStatus(t('merge.noDiffs')); return; }
      hunkId = first.hunkId;
    }

    const picked = hunkRows(hunkId)
      .map((r) => ({
        // 输出行的「身体」来自被选中的那一侧，但换行符统一交给
        // joinLines(out, state.outputEol) 处理，避免拼出混合换行符的文件。
        original: { body: mode === 'left' ? r.left : mode === 'right' ? r.right : r.base, eol: '\n' },
        text: mode === 'left' ? r.left : mode === 'right' ? r.right : r.base,
      }))
      // 该侧原本没有的行（纯插入）在那一版本里不存在，直接丢弃
      .filter((x) => x.text !== undefined);

    resolution.set(hunkId, { rows: picked });

    // 自动跳到下一处未解决的改动，并重绘：已解决的行换成「已解决」样式，
    // 输出面板同步显示选定的内容。
    const next = state.rows.find((r) => r.hunkId && r.hunkId !== hunkId && !resolution.has(r.hunkId));
    selectedHunk = next ? next.hunkId : null;
    render();
    updateStatus();
  }

  takeLeft.addEventListener('click', () => resolveCurrent('left'));
  takeRight.addEventListener('click', () => resolveCurrent('right'));
  takeBase.addEventListener('click', () => resolveCurrent('base'));

  function jumpConflict(dir) {
    const conflicts = [...new Set(state.rows.filter((r) => r.state === 'conflict').map((r) => r.hunkId))];
    if (!conflicts.length) { setStatus(t('merge.noConflicts')); return; }
    const unresolved = conflicts.filter((id) => !resolution.has(id));
    const pool = unresolved.length ? unresolved : conflicts;
    const at = pool.indexOf(selectedHunk);
    const target = at < 0 ? pool[0] : pool[(at + dir + pool.length) % pool.length];
    selectedHunk = target;
    render();
  }

  nextConflict.addEventListener('click', () => jumpConflict(1));
  prevConflict.addEventListener('click', () => jumpConflict(-1));

  btnSave.addEventListener('click', async () => {
    if (!state.rows.length) { setStatus(t('merge.pickThree')); return; }
    const pending = unresolvedCount();
    if (pending > 0) { setStatus(t('merge.unresolved', { n: pending })); return; }

    // 输出：未改动的行原样，每个改动块用选定的那一侧替换一次。
    const out = [];
    const emitted = new Set();
    for (const row of state.rows) {
      if (row.hunkId && resolution.has(row.hunkId)) {
        if (emitted.has(row.hunkId)) continue;
        emitted.add(row.hunkId);
        for (const item of resolution.get(row.hunkId).rows) out.push(item.original);
      } else {
        out.push(row.original);
      }
    }

    const path = await api.saveFile({ title: t('merge.saveTitle'), defaultPath: 'merged.txt' });
    if (!path) return;
    // 换行风格跟随祖先文件（合并结果通常要写回原文件位置）
    await api.writeText(path, joinLines(out, state.outputEol));
    setStatus(t('merge.saved', { path }));
  });


  function getState() {
    return {
      base: baseInput.value.trim(),
      left: leftInput.value.trim(),
      right: rightInput.value.trim(),
    };
  }

  return { destroy() {}, getState };
}

/**
 * 取文件的主要换行符（出现次数最多的那一种）。
 *
 * 输出文件只使用一种换行风格：逐行保留原始换行符会让「我方 CRLF + 对方 LF」
 * 拼出混合换行的文件。完全没有换行符时退回平台默认（Windows 用 CRLF）。
 */
function eolOf(lines) {
  const counts = new Map();
  for (const l of lines) {
    const eol = l && l.eol;
    if (eol) counts.set(eol, (counts.get(eol) || 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [eol, n] of counts) if (n > bestCount) { best = eol; bestCount = n; }
  if (best) return best;
  return typeof process !== 'undefined' && process.platform === 'win32' ? '\r\n' : '\n';
}
