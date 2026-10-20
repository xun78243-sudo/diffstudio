/**
 * 表格比较视图（CSV）。
 *
 * 解析两个 CSV 文件，把首行当作表头，**按表头名称对齐列**，再用 Myers
 * 对齐数据行，因此中间插入或删除一行不会让后面所有行都显示为差异。
 * 语义对齐 Beyond Compare 的表格比较会话（限定为分隔符文本）。
 */

import { el } from '../core/ui.js';
import { myersDiff, EDIT } from '../core/diff.js';
import { parseCsv } from '../core/csv.js';
import { setStatus } from '../core/status.js';

export function createTableCompareSession(container, context, initial = {}) {
  const api = context.api;
  const t = context.t;
  const state = { leftPath: '', rightPath: '', ignoreWhitespace: false };

  const leftInput = el('input', { class: 'path-input', placeholder: t('table.leftPlaceholder') });
  const rightInput = el('input', { class: 'path-input', placeholder: t('table.rightPlaceholder') });
  const btnLeft = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('table.openLeft'), 'data-role': 'open-left' });
  const btnRight = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('table.openRight'), 'data-role': 'open-right' });
  const btnCompare = el('button', { class: 'icon-btn', text: '↻ ' + t('table.tabTitle'), title: t('table.compare'), 'data-role': 'compare' });
  const btnTrim = el('button', { class: 'icon-btn', text: t('table.ignoreWhitespace'), title: t('table.ignoreWhitespaceHint'), 'data-role': 'ignore-whitespace' });

  const toolbar = el('div', { class: 'session-toolbar' },
    el('span', { text: t('common.sideLeft') }), leftInput, btnLeft,
    el('span', { text: t('common.sideRight') }), rightInput, btnRight,
    el('span', { class: 'spacer' }), btnTrim, btnCompare,
  );

  const legend = el('div', { class: 'legend' },
    legendItem('var(--c-change)', t('table.legendCell')),
    legendItem('var(--c-right)', t('table.legendRowRight')),
    legendItem('var(--c-left)', t('table.legendRowLeft')),
  );

  function legendItem(color, text) {
    return el('div', { class: 'it' }, el('span', { class: 'sw', style: `background:${color}` }), el('span', { text }));
  }

  function makePane(label) {
    const header = el('div', { class: 'pane-header' }, el('span', { class: 'label', text: label }));
    const body = el('div', { class: 'pane-body' });
    return { header, body, pane: el('div', { class: 'pane' }, header, body) };
  }
  const L = makePane(t('common.leftPane'));
  const R = makePane(t('common.rightPane'));
  const panes = el('div', { class: 'panes side-by-side' }, L.pane, R.pane);

  const root = el('div', { class: 'session' }, toolbar, legend, panes);
  container.append(root);

  /** 通知外壳：用户已打开这些文件（最近打开 / 重启恢复都依赖它）。 */
  function notePaths() {
    if (typeof context.notePaths === 'function') {
      context.notePaths('table', [state.leftPath, state.rightPath]);
    }
  }

  async function pick(side) {
    const res = await api.openFiles({
      multi: false,
      filters: [{ name: 'CSV / Text', extensions: ['csv', 'txt', 'tsv'] }],
    });
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

  btnTrim.addEventListener('click', () => {
    state.ignoreWhitespace = !state.ignoreWhitespace;
    btnTrim.classList.toggle('active', state.ignoreWhitespace);
    if (state.leftPath && state.rightPath) compare();
  });

  async function compare() {
    // 输入框是唯一事实来源（用户可以粘贴路径后回车）。
    state.leftPath = leftInput.value.trim();
    state.rightPath = rightInput.value.trim();
    if (!state.leftPath || !state.rightPath) { setStatus(t('table.pickBoth')); return; }
    let l, r;
    try {
      [l, r] = await Promise.all([
        api.readText(state.leftPath),
        api.readText(state.rightPath),
      ]);
    } catch (err) {
      setStatus(t('textCompare.openFailed', { msg: err.message }));
      return;
    }

    const left = parseCsv(l.text);
    const right = parseCsv(r.text);
    const leftHeader = left[0] || [];
    const rightHeader = right[0] || [];

    // 列对齐：按表头名称匹配；匹配不上的列再按位置就近配对（BC 的"线索"）。
    // 表头不一致时，也允许两表直接按位置对齐。
    const columns = alignColumns(leftHeader, rightHeader);
    const leftBody = left.slice(1);
    const rightBody = right.slice(1);

    // 行对齐：先按「整行内容」做 Myers，插入/删除不会污染后续行。
    // 两侧完全相同的行视为锚点；剩余行再按顺序配对为修改。
    const collapsed = (body, side) => body.map((row) => pickColumns(row, columns, side));
    const leftKeys = collapsed(leftBody, 'leftIndex');
    const rightKeys = collapsed(rightBody, 'rightIndex');
    const sameKey = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

    // 没有任何一行完全相同（例如两侧每行都被修改过）时，Myers 没有锚点，
    // 会退化成一长串删除+插入。此时按位置逐行对齐，结果更符合直觉，
    // 也与 Beyond Compare 在两侧行数相同时的默认配对一致。
    const hasAnchor = leftKeys.some((lk) => rightKeys.some((rk) => sameKey(lk, rk)));
    const rowOps = hasAnchor
      ? myersDiff(leftKeys, rightKeys, sameKey)
      : pairedOps(leftBody.length, rightBody.length);

    function pairedOps(nA, nB) {
      const out = [];
      const n = Math.min(nA, nB);
      for (let k = 0; k < n; k++) out.push({ type: EDIT.EQ, aIdx: k, bIdx: k });
      for (let k = n; k < nA; k++) out.push({ type: EDIT.DEL, aIdx: k, bIdx: -1 });
      for (let k = n; k < nB; k++) out.push({ type: EDIT.INS, aIdx: -1, bIdx: k });
      return out;
    }

    let diffCells = 0;
    let leftOnlyRows = 0;
    let rightOnlyRows = 0;

    // 两个窗格必须使用同一套列顺序与列宽：否则同一个单元格在左右两侧
    // 会落在不同的列位置上，用户无法横着扫视比较。
    // 列在某一侧不存在时（仅对侧有的列）该侧渲染一个空白占位单元格。
    const colWidths = computeColumnWidths(columns, leftBody, rightBody);
    const tL = buildTable(columns, 'leftIndex', colWidths);
    const tR = buildTable(columns, 'rightIndex', colWidths);

    // 把编辑脚本合并成 [删除... | 插入...] 的改动块，块内按顺序配对。
    let i = 0;
    while (i < rowOps.length) {
      const op = rowOps[i];
      if (op.type === EDIT.EQ) {
        appendRow(op.aIdx, op.bIdx, false);
        i++;
        continue;
      }
      const dels = [];
      const inss = [];
      while (i < rowOps.length && rowOps[i].type !== EDIT.EQ) {
        if (rowOps[i].type === EDIT.DEL) dels.push(rowOps[i].aIdx);
        else inss.push(rowOps[i].bIdx);
        i++;
      }
      const n = Math.max(dels.length, inss.length);
      for (let k = 0; k < n; k++) {
        appendRow(dels[k], inss[k], false);
      }
    }

    /**
     * 追加一行。leftIdx / rightIdx 为 undefined 表示该侧没有这一行。
     * 每侧都按 columns 的统一顺序渲染，缺失的列输出空白占位。
     */
    function appendRow(leftIdx, rightIdx, forceDiff) {
      const lr = leftIdx === undefined ? null : leftBody[leftIdx];
      const rr = rightIdx === undefined ? null : rightBody[rightIdx];

      const trL = el('tr');
      const trR = el('tr');
      let rowDiffers = !!forceDiff;

      // 单元格差异：按列映射逐列比较（重复的列映射不会重复计数）
      for (const col of columns) {
        if (col.leftIndex < 0 || col.rightIndex < 0) continue;
        if (!lr || !rr) continue;
        const lv = lr[col.leftIndex] ?? '';
        const rv = rr[col.rightIndex] ?? '';
        if (!cellEquals(lv, rv)) { diffCells++; rowDiffers = true; }
      }

      for (const col of columns) {
        // 左侧单元格
        const lv = lr && col.leftIndex >= 0 ? lr[col.leftIndex] ?? '' : '';
        const tdL = el('td', { text: lv });
        if (col.leftIndex < 0) tdL.classList.add('missing-col');
        else if (lr && rr && col.rightIndex >= 0 && !cellEquals(lv, rr[col.rightIndex] ?? '')) {
          tdL.classList.add('diff');
        }
        trL.append(tdL);

        // 右侧单元格（列映射可能把左右列重排，这里按 col.rightIndex 取值）
        const rv = rr && col.rightIndex >= 0 ? rr[col.rightIndex] ?? '' : '';
        const tdR = el('td', { text: rv });
        if (col.rightIndex < 0) tdR.classList.add('missing-col');
        else if (lr && rr && col.leftIndex >= 0 && !cellEquals(lr[col.leftIndex] ?? '', rv)) {
          tdR.classList.add('diff');
        }
        trR.append(tdR);
      }

      if (!rr) {
        leftOnlyRows++;
        for (const td of trL.children) td.classList.add('only-left');
      } else if (!lr) {
        rightOnlyRows++;
        for (const td of trR.children) td.classList.add('only-right');
      } else if (rowDiffers) {
        trL.classList.add('row-diff');
        trR.classList.add('row-diff');
      }

      tL.append(trL);
      tR.append(trR);
    }

    L.body.innerHTML = '';
    R.body.innerHTML = '';
    L.body.append(tL);
    R.body.append(tR);

    setStatus(t('table.status', {
      leftRows: leftBody.length,
      rightRows: rightBody.length,
      n: diffCells,
      leftOnly: leftOnlyRows,
      rightOnly: rightOnlyRows,
    }));
  }

  /** 单元格相等判断：可选忽略首尾空白 / 忽略大小写。 */
  function cellEquals(a, b) {
    if (a === b) return true;
    if (!state.ignoreWhitespace) return false;
    return String(a).trim() === String(b).trim();
  }

  /**
   * 生成列映射：[{ label, leftIndex, rightIndex }]。
   *
   * 1. 先按表头名称一对一配对（列顺序不同也能对齐）；
   * 2. 名称对不上的列再按位置就近配对 —— 两个表都几乎没有表头时，
   *    仍按位置并列比较，而不是把所有列都标成"仅左/仅右"。
   */
  function alignColumns(lh, rh) {
    const pairs = new Map(); // leftIndex -> rightIndex
    const usedRight = new Set();

    for (let i = 0; i < lh.length; i++) {
      const name = (lh[i] ?? '').trim();
      if (!name) continue;
      const j = rh.findIndex((h, idx) => !usedRight.has(idx) && (h ?? '').trim() === name);
      if (j >= 0) { pairs.set(i, j); usedRight.add(j); }
    }

    // 按位置兜底配对
    const freeLeft = [];
    for (let i = 0; i < lh.length; i++) if (!pairs.has(i)) freeLeft.push(i);
    const freeRight = [];
    for (let j = 0; j < rh.length; j++) if (!usedRight.has(j)) freeRight.push(j);
    for (let k = 0; k < Math.min(freeLeft.length, freeRight.length); k++) {
      pairs.set(freeLeft[k], freeRight[k]);
      usedRight.add(freeRight[k]);
    }

    // 输出顺序：先跟左侧顺序，再把右侧独有的列追加在后面
    const cols = [];
    for (let i = 0; i < lh.length; i++) {
      const j = pairs.has(i) ? pairs.get(i) : -1;
      cols.push({
        label: (lh[i] ?? '') + (j < 0 ? t('table.colLeft') : ''),
        leftIndex: i,
        rightIndex: j,
        leftName: (lh[i] ?? '') + (j < 0 ? t('table.colLeft') : ''),
        rightName: j < 0 ? '' : (rh[j] ?? ''),
      });
    }
    for (let j = 0; j < rh.length; j++) {
      if (usedRight.has(j)) continue;
      cols.push({
        label: (rh[j] ?? '') + t('table.colRight'),
        leftIndex: -1,
        rightIndex: j,
        leftName: '',
        rightName: (rh[j] ?? '') + t('table.colRight'),
      });
    }
    return cols;
  }

  function pickColumns(row, columns, side) {
    return columns.map((c) => {
      const idx = c[side];
      return idx >= 0 ? row[idx] ?? '' : '';
    });
  }

  /**
   * 按统一列顺序构建表头。
   *
   * 两个窗格使用同一套列顺序与列宽（colWidths），左右相同的列才能横向对齐；
   * 本侧没有的列渲染成带 `missing-col` 样式的空白表头。
   */
  function buildTable(columns, side, colWidths) {
    const table = el('table', { class: 'data-table' });
    const head = el('tr');
    columns.forEach((col, i) => {
      const th = el('th', { text: col[side === 'leftIndex' ? 'leftName' : 'rightName'] ?? '' });
      if (colWidths && colWidths[i]) th.style.width = colWidths[i] + 'px';
      if (col[side] < 0) th.classList.add('missing-col');
      head.append(th);
    });
    table.append(head);
    return table;
  }

  /**
   * 估算列宽（像素）。按字符数 × 约 7.2px + 内边距，再多留一点余量，
   * 避免短内容被截断；上限 320px，防止某个超长字段把整张表撑爆。
   */
  function computeColumnWidths(columns, leftRows, rightRows) {
    return columns.map((col) => {
      let maxLen = 4;
      const name = (col.leftName || col.rightName || '').length;
      maxLen = Math.max(maxLen, name);
      for (const row of leftRows) {
        if (col.leftIndex >= 0) maxLen = Math.max(maxLen, String(row[col.leftIndex] ?? '').length);
      }
      for (const row of rightRows) {
        if (col.rightIndex >= 0) maxLen = Math.max(maxLen, String(row[col.rightIndex] ?? '').length);
      }
      return Math.min(320, Math.max(56, Math.round(maxLen * 7.2) + 18));
    });
  }


  function getState() {
    return { left: leftInput.value.trim(), right: rightInput.value.trim() };
  }

  return { destroy() {}, getState };
}
