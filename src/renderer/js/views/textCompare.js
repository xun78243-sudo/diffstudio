/**
 * 文本比较视图。
 *
 * 加载两个文本文件，用 Myers O(ND) 对齐，渲染左右同步滚动、按语义着色的
 * 并排（或上下）视图，并在"已修改"的行内做字符级高亮。语义与 Beyond
 * Compare 的文本比较一致：相同 / 仅左侧 / 仅右侧 / 已修改。
 *
 * 换行符按「忽略行尾符」处理（与 BC 默认设置相同），但会在图例处提示
 * 两侧实际使用的换行风格，避免用户以为文件完全一致。
 *
 * 交互（对齐 Beyond Compare 文本比较的常用操作）：
 *   Alt+↑ / Alt+↓      上一处 / 下一处差异
 *   Enter（查找框内）   查找下一个；Shift+Enter 查找上一个
 *   ← / →              把选中行复制到右 / 左（编辑模式下）
 *   Ctrl+F2            设置 / 取消书签
 *   Ctrl+S（编辑模式）  保存
 */

import { buildDiffLines, makeEquality, countChangedRows } from '../core/diff.js';
import { realignWithAnchors } from '../core/align.js';
import { buildPatch, toUnifiedPatch, buildReport } from '../core/patch.js';
import {
  el,
  splitLines,
  formatBytes,
  basename,
  renderInlineHighlight,
  diffChars,
  eolKinds,
  eolName,
  joinLines,
  EMPTY_LINE_MARK,
} from '../core/ui.js';
import { setStatus } from '../core/status.js';
import { ENCODINGS } from '../core/encoding.js';

/**
 * 忽略空白 / 大小写时的行比较函数。
 * 只影响"是否相等"的判定，不改变显示出来的原始文本。
 */
function makeComparator({ ignoreWhitespace, ignoreCase }) {
  const norm = (s) => {
    let v = String(s ?? '');
    // 与 BC 的「忽略空白」一致：首尾空白、行内连续空白（空格/Tab）都不参与比较，
    // 只 trim 会导致 "a  b" 与 "a b" 仍算不同。
    if (ignoreWhitespace) v = v.replace(/\s+/g, ' ').trim();
    if (ignoreCase) v = v.toLowerCase();
    return v;
  };
  return (x, y) => norm(x.body ?? x) === norm(y.body ?? y);
}

/** 转义正则元字符，供"全部替换"按字面量匹配（大小写不敏感）。 */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 取一文件中出现最多的换行符；没有换行符时返回 \n。 */function dominantEol(lines) {
  const counts = new Map();
  for (const l of lines || []) if (l.eol) counts.set(l.eol, (counts.get(l.eol) || 0) + 1);
  let best = '\n';
  let n = 0;
  for (const [eol, c] of counts) if (c > n) { best = eol; n = c; }
  return best;
}

export function createTextCompareSession(container, context, initial = {}) {
  const api = context.api;
  const t = context.t;
  const state = {
    leftPath: '',
    rightPath: '',
    leftLines: [],
    rightLines: [],
    diffLines: [],
    /** 每处连续差异块的首行在 diffLines 中的下标（差异导航用） */
    diffRows: [],
    cursor: -1,
    /** 当前选中行在 diffLines 中的下标 */
    selected: -1,
    bookmarks: new Set(),
    editing: false,
    /** 忽略选项是数据，不是 DOM 样式：DOM 会被语言切换重建，状态不能跟着丢。 */
    ignoreWhitespace: false,
    ignoreCase: false,
    /**
     * 手动对齐锚点 `[{ aIdx, bIdx }]`（Align With）。
     * 只要存在锚点就改用 realignWithAnchors，重新读文件或点"重新比较"时清空。
     */
    anchors: [],
    /** 自动换行显示（仅影响呈现，不影响比较结果） */
    wordWrap: false,
    /** 把制表符显示成空格（同 BC 的"显示制表符"选项） */
    tabSize: 0,
    leftSize: 0,
    rightSize: 0,
    /** 用户选择的编码（auto 表示自动检测）；保存时按实际检测到的编码写回。 */
    encoding: 'auto',
    /** 读文件时实际使用的编码，保存时优先用它，避免改变文件编码。 */
    leftEncoding: 'utf8',
    rightEncoding: 'utf8',
  };

  // --- 工具栏 ---
  const leftInput = el('input', { class: 'path-input', placeholder: t('textCompare.leftPlaceholder') });
  const rightInput = el('input', { class: 'path-input', placeholder: t('textCompare.rightPlaceholder') });
  const btnLeft = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('textCompare.openLeft'), 'data-role': 'open-left' });
  const btnRight = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('textCompare.openRight'), 'data-role': 'open-right' });
  const btnRefresh = el('button', { class: 'icon-btn', text: '↻ ' + t('textCompare.recompareBtn'), title: t('textCompare.recompare'), 'data-role': 'recompare' });
  const btnLayout = el('button', { class: 'icon-btn', text: '⇅ ' + t('textCompare.layoutToggle'), title: t('textCompare.layout'), 'data-role': 'layout' });
  const btnEdit = el('button', { class: 'icon-btn', text: '✎ ' + t('common.edit'), title: t('textCompare.editOn'), 'data-role': 'edit' });
  const btnSave = el('button', { class: 'icon-btn', text: '💾 ' + t('common.save'), title: t('common.save'), 'data-role': 'save' });
  const btnIgnoreWs = el('button', { class: 'icon-btn', text: t('textCompare.ignoreWhitespace'), title: t('textCompare.ignoreWhitespaceHint'), 'data-role': 'ignore-whitespace' });
  const btnIgnoreCase = el('button', { class: 'icon-btn', text: t('textCompare.ignoreCase'), title: t('textCompare.ignoreCaseHint'), 'data-role': 'ignore-case' });
  // 编码：auto 时按内容检测；指定后重新读取两侧文件。保存也按这个编码写回，
  // 否则打开一个 GBK 文件改两行再保存，整个文件就被改成 UTF-8 了。
  const encSelect = el('select', { class: 'toolbar-select', title: t('textCompare.encodingHint'), 'data-role': 'encoding' },
    ...ENCODINGS.map((id) => el('option', { value: id, text: t('encoding.' + id) })));

  const toolbar = el('div', { class: 'session-toolbar' },
    el('span', { text: t('common.sideLeft') }), leftInput, btnLeft,
    el('span', { text: t('common.sideRight') }), rightInput, btnRight,
    el('span', { class: 'spacer' }),
    encSelect, btnIgnoreWs, btnIgnoreCase, btnEdit, btnSave, btnLayout, btnRefresh,
  );

  // --- 差异导航 / 书签 / 查找（第二行工具栏） ---
  const btnPrev = el('button', { class: 'icon-btn', text: '↑', title: t('textCompare.prevDiff'), 'data-role': 'prev-diff' });
  const btnNext = el('button', { class: 'icon-btn', text: '↓', title: t('textCompare.nextDiff'), 'data-role': 'next-diff' });
  const navLabel = el('span', { class: 'nav-label', 'data-role': 'nav-status' });
  const btnBookmark = el('button', { class: 'icon-btn', text: '⚑', title: t('textCompare.bookmarkAdd'), 'data-role': 'bookmark-toggle' });
  const btnBookPrev = el('button', { class: 'icon-btn', text: '⚑↑', title: t('textCompare.bookmarkPrev'), 'data-role': 'bookmark-prev' });
  const btnBookNext = el('button', { class: 'icon-btn', text: '⚑↓', title: t('textCompare.bookmarkNext'), 'data-role': 'bookmark-next' });
  const findInput = el('input', { class: 'find-input', placeholder: t('textCompare.findPlaceholder'), 'data-role': 'find-input' });
  const btnFindPrev = el('button', { class: 'icon-btn', text: '‹', title: t('textCompare.findPrev'), 'data-role': 'find-prev' });
  const btnFindNext = el('button', { class: 'icon-btn', text: '›', title: t('textCompare.findNext'), 'data-role': 'find-next' });

  // --- 对齐 / 显示 / 导出（第一行工具栏右侧） ---
  const btnSwap = el('button', { class: 'icon-btn', text: '⇄', title: t('textCompare.swapSides'), 'data-role': 'swap' });
  const btnClearBookmarks = el('button', { class: 'icon-btn', text: '⚑✕', title: t('textCompare.clearBookmarks'), 'data-role': 'clear-bookmarks' });
  const btnAlign = el('button', { class: 'icon-btn', text: t('textCompare.alignWith'), title: t('textCompare.alignHint'), 'data-role': 'align' });
  const btnIsolate = el('button', { class: 'icon-btn', text: t('textCompare.isolate'), title: t('textCompare.isolateHint'), 'data-role': 'isolate' });
  const btnWrap = el('button', { class: 'icon-btn', text: t('textCompare.wordWrap'), title: t('textCompare.wordWrapHint'), 'data-role': 'word-wrap' });
  const btnTabs = el('button', { class: 'icon-btn', text: t('textCompare.tabsToSpaces'), title: t('textCompare.tabsToSpacesHint'), 'data-role': 'tabs-to-spaces' });
  const btnPatch = el('button', { class: 'icon-btn', text: t('textCompare.exportPatch'), title: t('textCompare.exportPatchHint'), 'data-role': 'export-patch' });
  const btnReport = el('button', { class: 'icon-btn', text: t('textCompare.exportReport'), title: t('textCompare.exportReportHint'), 'data-role': 'export-report' });
  const replaceInput = el('input', { class: 'find-input', placeholder: t('textCompare.replacePlaceholder'), 'data-role': 'replace-input' });
  const btnReplace = el('button', { class: 'icon-btn', text: t('textCompare.replace'), title: t('textCompare.replaceHint'), 'data-role': 'replace' });
  const btnReplaceAll = el('button', { class: 'icon-btn', text: t('textCompare.replaceAll'), title: t('textCompare.replaceAllHint'), 'data-role': 'replace-all' });

  const navBar = el('div', { class: 'session-subbar' },
    btnPrev, btnNext, navLabel,
    el('span', { class: 'sep' }),
    btnBookmark, btnBookPrev, btnBookNext,
    el('span', { class: 'spacer' }),
    btnSwap, btnClearBookmarks, btnAlign, btnIsolate, btnWrap, btnTabs,
    el('span', { class: 'sep' }),
    btnPatch, btnReport,
  );

  // --- 查找 / 替换（独立一行，输入框较多，和导航混排会太挤） ---
  const findBar = el('div', { class: 'session-subbar' },
    findInput, btnFindPrev, btnFindNext,
    el('span', { class: 'sep' }),
    replaceInput, btnReplace, btnReplaceAll,
  );

  // --- 图例 ---
  const eolNote = el('span', { class: 'legend-note' });
  const legend = el('div', { class: 'legend' },
    legendItem('var(--c-left)', t('textCompare.legendLeft')),
    legendItem('var(--c-right)', t('textCompare.legendRight')),
    legendItem('var(--c-change)', t('textCompare.legendChange')),
    eolNote,
  );

  // --- 窗格 ---
  const leftHeader = el('div', { class: 'pane-header' }, el('span', { class: 'label', text: t('common.leftPane') }));
  const rightHeader = el('div', { class: 'pane-header' }, el('span', { class: 'label', text: t('common.rightPane') }));
  const leftRows = el('div', { class: 'rows', id: 'tc-left' });
  const rightRows = el('div', { class: 'rows', id: 'tc-right' });
  const leftBody = el('div', { class: 'pane-body', tabindex: '-1' }, leftRows);
  const rightBody = el('div', { class: 'pane-body', tabindex: '-1' }, rightRows);
  const leftPane = el('div', { class: 'pane' }, leftHeader, leftBody);
  const rightPane = el('div', { class: 'pane' }, rightHeader, rightBody);
  const panes = el('div', { class: 'panes side-by-side' }, leftPane, rightPane);

  const root = el('div', { class: 'session' }, toolbar, navBar, findBar, legend, panes);
  container.append(root);

  let sideBySide = true;

  function legendItem(color, text) {
    return el('div', { class: 'it' }, el('span', { class: 'sw', style: `background:${color}` }), el('span', { text }));
  }

  /** 通知外壳：用户已打开这些文件（最近打开 / 重启恢复都依赖它）。 */
  function notePaths() {
    if (typeof context.notePaths === 'function') {
      context.notePaths('text', [state.leftPath, state.rightPath]);
    }
  }

  async function openSide(side) {
    try {
      const res = await api.openFiles({ multi: false });
      if (!res || !res[0]) return;
      if (side === 'left') { state.leftPath = res[0]; leftInput.value = res[0]; }
      else { state.rightPath = res[0]; rightInput.value = res[0]; }
      await recompute();
      notePaths();
    } catch (err) {
      setStatus(t('textCompare.openFailed', { msg: err.message }));
    }
  }

  /**
   * 只按当前忽略选项重新对齐并渲染（不重新读文件）。
   * 忽略空白 / 大小写只影响“哪些行算相等”，行内容本身没变。
   */
  function recomputeDiff() {
    if (!state.leftLines.length && !state.rightLines.length) return;
    renderComparison();
  }

  async function recompute() {
    // 输入框才是唯一事实来源：用户可能直接粘贴路径后回车。
    state.leftPath = leftInput.value.trim();
    state.rightPath = rightInput.value.trim();
    if (!state.leftPath || !state.rightPath) {
      setStatus(t('textCompare.pickBoth'));
      return;
    }
    let l;
    let r;
    try {
      [l, r] = await Promise.all([
        api.readText(state.leftPath, state.encoding),
        api.readText(state.rightPath, state.encoding),
      ]);
    } catch (err) {
      setStatus(t('textCompare.openFailed', { msg: err.message }));
      return;
    }
    if (l.binary || r.binary) {
      setStatus(t('textCompare.binaryDetected'));
      return;
    }
    state.leftEncoding = l.encoding || 'utf8';
    state.rightEncoding = r.encoding || 'utf8';
    // 自动检测出的编码显示在下拉框里（auto 仍保留为选中态，便于看出是自动识别的）。
    encSelect.title = t('textCompare.encodingDetected', {
      left: t('encoding.' + state.leftEncoding),
      right: t('encoding.' + state.rightEncoding),
    });
    state.leftLines = splitLines(l.text);
    state.rightLines = splitLines(r.text);
    state.leftSize = l.text.length;
    state.rightSize = r.text.length;
    state.bookmarks.clear();
    state.anchors = [];
    state.cursor = -1;
    state.selected = -1;

    leftHeader.innerHTML = '';
    leftHeader.append(el('span', { class: 'label', text: t('common.leftPane') }), el('span', { text: basename(state.leftPath) }));
    rightHeader.innerHTML = '';
    rightHeader.append(el('span', { class: 'label', text: t('common.rightPane') }), el('span', { text: basename(state.rightPath) }));

    renderComparison();
  }

  /** 根据当前忽略选项重新对齐并渲染（不重新读文件）。 */
  function renderComparison() {
    const { ignoreWhitespace, ignoreCase } = state;
    // makeEquality 只负责「忽略行尾符」并记录换行风格；忽略空白 / 大小写
    // 由 makeComparator 负责。两者不能串联：串联会让忽略选项永远不生效。
    const norm = makeComparator({ ignoreWhitespace, ignoreCase });
    const eolTracker = makeEquality();
    const cmp = (x, y) => {
      const equal = norm(x, y);
      if (equal) eolTracker(x, y);
      return equal;
    };

    const diffLines = state.anchors.length
      ? realignWithAnchors(state.leftLines, state.rightLines, state.anchors, cmp)
      : buildDiffLines(state.leftLines, state.rightLines, cmp);
    // 隔离视图：只渲染一个区域，但行号保持文件中的真实行号
    const w = state.window;
    state.allDiffLines = diffLines;
    // 行索引映射：渲染行号 -> 全文行号。隔离视图下两者不同，
    // selected/cursor/diffRows 一律用全文行号，避免折叠后点到错行、或者
    // 再点一次「隔离」时用过滤后的索引去切全文数组（表现为按钮无反应）。
    state.fullIndex = [];
    // 窗口是一对行区间 [aStart,aEnd) × [bStart,bEnd)。两侧都有行时必须同时落在
    // 各自区间内；只有一侧有行（纯新增/删除）时，按有行号的那一侧判断。
    // 若把「任一侧在窗口内」当成命中，窗口外的同类行会从另一侧漏进来，
    // 隔离视图就会退化成全文。
    const inWindow = (a, b) => {
      const hasA = a >= 0;
      const hasB = b >= 0;
      if (hasA && hasB) return a >= w.aStart && a < w.aEnd && b >= w.bStart && b < w.bEnd;
      if (hasA) return a >= w.aStart && a < w.aEnd;
      if (hasB) return b >= w.bStart && b < w.bEnd;
      return false;
    };
    state.diffLines = w
      ? diffLines.filter((r, i) => {
        const keep = inWindow(r.aIdx == null ? -1 : r.aIdx, r.bIdx == null ? -1 : r.bIdx);
        if (keep) state.fullIndex.push(i);
        return keep;
      })
      : (state.fullIndex = diffLines.map((_, i) => i), diffLines);

    // 差异导航锚点：每处连续差异块的第一行（全文行号）。
    state.diffRows = [];
    let prevChanged = false;
    for (let i = 0; i < diffLines.length; i++) {
      const changed = diffLines[i].kind !== 'same';
      if (changed && !prevChanged) state.diffRows.push(i);
      prevChanged = changed;
    }
    if (state.cursor >= state.diffRows.length) state.cursor = state.diffRows.length - 1;
    // 书签本来就用全文行号保存；隔离视图重建时保留落在当前窗口内的那些，
    // 退出隔离后其余书签仍然存在。
    if (w) {
      state.bookmarks = new Set([...state.bookmarks].filter((i) => state.fullIndex.includes(i)));
    }

    // 只渲染过滤后的行（隔离视图下就是那一个块），行号仍来自全文。
    render(state.diffLines);

    const changed = countChangedRows(diffLines);
    // 行尾符提示：只在实际存在差异时提示。
    const le = [...eolKinds(state.leftLines)].map(eolName).join('/') || eolName('');
    const re = [...eolKinds(state.rightLines)].map(eolName).join('/') || eolName('');
    const ignoring = ignoreWhitespace || ignoreCase;
    eolNote.textContent =
      (le === re ? '' : t('textCompare.eolWarning', { left: le, right: re })) +
      (ignoring ? t('textCompare.ignoreLegend') : '');

    updateNav();
    if (changed === 0) {
      setStatus(t('textCompare.noDiffs'));
    } else {
      setStatus(t('textCompare.status', {
        leftSize: formatBytes(state.leftSize),
        rightSize: formatBytes(state.rightSize),
        n: changed,
      }));
    }
  }

  function render(diffLines) {
    leftRows.innerHTML = '';
    rightRows.innerHTML = '';

    const fragL = document.createDocumentFragment();
    const fragR = document.createDocumentFragment();

    for (let i = 0; i < diffLines.length; i++) {
      const d = diffLines[i];
      const cls = `row kind-${d.kind}`;

      // 左侧
      const lRow = el('div', { class: cls, 'data-row': String(i) });
      lRow.append(el('span', { class: 'gutter', text: d.aIdx >= 0 ? String(d.aIdx + 1) : '', 'data-role': 'gutter-left' }));
      if (state.bookmarks.has(i)) lRow.classList.add('bookmarked');
      const lCode = el('span', { class: 'code' });
      if (d.kind === 'change' && d.removed && d.added) {
        lCode.innerHTML = renderInlineHighlight(diffChars(d.removed.text, d.added.text).filter((c) => c.kind !== 'add'));
      } else {
        lCode.textContent = d.a ?? '';
      }
      markEmpty(lCode, d.a);
      lRow.append(lCode);
      bindRow(lRow, i);
      fragL.append(lRow);

      // 右侧
      const rRow = el('div', { class: cls, 'data-row': String(i) });
      rRow.append(el('span', { class: 'gutter', text: d.bIdx >= 0 ? String(d.bIdx + 1) : '', 'data-role': 'gutter-right' }));
      if (state.bookmarks.has(i)) rRow.classList.add('bookmarked');
      const rCode = el('span', { class: 'code' });
      if (d.kind === 'change' && d.removed && d.added) {
        rCode.innerHTML = renderInlineHighlight(diffChars(d.removed.text, d.added.text).filter((c) => c.kind !== 'del'));
      } else {
        rCode.textContent = d.b ?? '';
      }
      markEmpty(rCode, d.b);
      rRow.append(rCode);
      bindRow(rRow, i);
      fragR.append(rRow);
    }

    leftRows.append(fragL);
    rightRows.append(fragR);
    applyDisplayOptions();
    applySelection();
  }

  /**
   * 显示选项（自动换行 / 制表符宽度）只作用于呈现：
   * 用 CSS class 与 `tab-size` 实现，不重写文本内容，避免与编辑、复制
   * 使用不同的字符串导致"看起来一样、实际有差异"。
   */
  function applyDisplayOptions() {
    for (const pane of [leftPane, rightPane]) {
      pane.classList.toggle('wrap', state.wordWrap);
    }
    for (const code of [...leftRows.querySelectorAll('.code'), ...rightRows.querySelectorAll('.code')]) {
      code.style.tabSize = state.tabSize || '';
    }
  }

  function bindRow(rowEl, index) {
    rowEl.addEventListener('click', () => {
      selectRow(index);
    });
  }

  /**
   * 选中某一行，并把差异导航的游标同步到「该行所属的差异块」。
   *
   * 用户点过一行再按「下一处」，应当从点中的位置继续，而不是从上次
   * 导航留下的旧位置继续——否则界面上选中的行和当前位置对不上。
   */
  // --- 行号换算：dataset.row 是渲染行号；state.selected / cursor /
  // bookmarks / diffRows 一律使用全文行号，隔离视图下也不会错位。 ---
  const fullRow = (row) => (row == null || row < 0 ? -1 : state.fullIndex[row] ?? -1);
  const viewRow = (full) => (full == null || full < 0 ? -1 : state.fullIndex.indexOf(full));
  /** 当前选中行对应的数据（未选中返回 undefined）。 */
  const selectedLine = () => state.diffLines[viewRow(state.selected)];

  function selectRow(index) {
    // index 通常来自点击（渲染行号）；查找、书签跳转传的已经是全文行号。
    const full = index >= 0 && index < state.diffLines.length ? fullRow(index) : index;
    state.selected = full;
    const d = selectedLine();
    if (d && d.kind !== 'same') {
      for (let i = state.diffRows.length - 1; i >= 0; i--) {
        if (state.diffRows[i] <= full) { state.cursor = i; break; }
      }
      updateNav();
    }
    applySelection();
  }

  /** 选中行在两侧同时高亮（比较视图里"当前行"是成对的概念）。 */
  function applySelection() {
    const sel = viewRow(state.selected);
    for (const rowEl of leftRows.children) {
      rowEl.classList.toggle('selected', Number(rowEl.dataset.row) === sel);
    }
    for (const rowEl of rightRows.children) {
      rowEl.classList.toggle('selected', Number(rowEl.dataset.row) === sel);
    }
  }

  function updateNav() {
    const n = state.diffRows.length;
    btnPrev.disabled = n === 0;
    btnNext.disabled = n === 0;
    if (n === 0) { navLabel.textContent = ''; return; }
    // cursor 为 -1 表示还没跳到任何差异；此时向前跳的位置是第 1 处，
    // 不能直接 +1 显示成「第 0 处」。
    const cur = (state.cursor < 0 ? 0 : state.cursor) + 1;
    navLabel.textContent = t('textCompare.navStatus', { n, cur });
  }

  /** 空行用一个浅色圆点占位，否则用户会以为该行没有渲染。 */
  function markEmpty(codeEl, text) {
    if (text === '' || text === undefined) {
      codeEl.classList.add('empty-line');
      codeEl.textContent = EMPTY_LINE_MARK;
    }
  }

  function jumpDiff(dir) {
    const n = state.diffRows.length;
    if (!n) { setStatus(t('textCompare.noDiffs')); return; }
    if (state.cursor < 0) state.cursor = dir > 0 ? 0 : n - 1;
    else state.cursor = (state.cursor + dir + n) % n;
    const row = state.diffRows[state.cursor];
    state.selected = row;
    applySelection();
    scrollRowIntoView(viewRow(row));
    updateNav();
  }

  /** 把 diffLines 的第 row 行滚动到左侧窗格的中部，并同步右侧。 */
  function scrollRowIntoView(row) {
    const target = leftRows.children[row];
    if (!target) return;
    leftBody.scrollTop = Math.max(0, target.offsetTop - leftBody.clientHeight / 2);
    syncScroll(leftBody, rightBody);
  }

  /**
   * 把选中行复制到另一侧。
   * @param {'left'|'right'} targetSide 目标侧
   */
  function copyTo(targetSide) {
    if (state.selected < 0) { setStatus(t('textCompare.nothingToCompare')); return; }
    if (!state.editing) { setStatus(t('textCompare.editLocked')); return; }
    const d = selectedLine();
    if (!d) return;
    const source = targetSide === 'right' ? state.leftLines : state.rightLines;
    const target = targetSide === 'right' ? state.rightLines : state.leftLines;
    const sourceIdx = targetSide === 'right' ? d.aIdx : d.bIdx;
    const targetIdx = targetSide === 'right' ? d.bIdx : d.aIdx;
    if (sourceIdx < 0 || targetIdx < 0 || !source[sourceIdx] || !target[targetIdx]) {
      setStatus(t('textCompare.needBothSides'));
      return;
    }
    // 只替换内容，保留目标行原有的换行符。
    target[targetIdx] = { body: source[sourceIdx].body, eol: target[targetIdx].eol };
    renderComparison();
    setStatus(targetSide === 'right' ? t('textCompare.copiedRight') : t('textCompare.copiedLeft'));
  }

  // --- 查找：在两侧文本中定位（优先当前行 → 向后 → 回绕） ---
  function find(dir) {
    const q = findInput.value;
    if (!q) { setStatus(t('textCompare.findNone', { q })); return; }
    const needle = q.toLowerCase();
    const startFrom = state.selected >= 0 ? state.selected : -1;
    const total = state.diffLines.length;
    for (let step = 1; step <= total; step++) {
      const idx = dir > 0
        ? (startFrom + step + total) % total
        : (startFrom - step + total * 2) % total;
      const d = state.diffLines[idx];
      const l = (d.a ?? '').toLowerCase();
      const r = (d.b ?? '').toLowerCase();
      if (l.includes(needle) || r.includes(needle)) {
        selectRow(idx);
        scrollRowIntoView(idx);
        highlightMatches(needle, idx);
        setStatus(t('textCompare.findHit', { q }));
        // 键盘焦点交还给比较区：用户按 Enter 是为了「看结果」，接下来多半要按
        // ←/→ 或 Alt+↓ 操作。焦点留在查找框里，这些键会变成输入字符。
        leftBody.focus();
        return;
      }
    }
    highlightMatches(needle, -1);
    setStatus(t('textCompare.findNone', { q }));
  }

  /**
   * 把查找命中的文本标成 <mark class="find-hit">，当前命中再加 .current。
   *
   * 差异行本来就用 <span> 做字符级高亮，所以这里只改文本节点：
   * 遍历 .code 下的文本节点（跳过 mark 内部），逐段包成 mark，
   * 这样不会把之前的 <span> 结构冲掉，也不会重复包裹。
   */
  function highlightMatches(needle, currentRow) {
    for (const pane of [leftRows, rightRows]) {
      for (const old of pane.querySelectorAll('mark.find-hit')) {
        const parent = old.parentNode;
        parent.replaceChild(document.createTextNode(old.textContent), old);
        parent.normalize();
      }
      if (!needle) continue;
      for (const code of pane.querySelectorAll('.code')) {
        const rowEl = code.parentElement;
        const isCurrent = currentRow >= 0 && Number(rowEl.dataset.row) === currentRow;
        const text = code.textContent || '';
        const lower = text.toLowerCase();
        let from = 0;
        let at = lower.indexOf(needle, from);
        if (at < 0) continue;
        // 倒序替换，避免前面的替换改变后面的偏移
        const spans = [];
        while (at >= 0) {
          spans.push(at);
          at = lower.indexOf(needle, at + needle.length);
        }
        for (let k = spans.length - 1; k >= 0; k--) {
          const s = spans[k];
          wrapTextRange(code, s, s + needle.length, isCurrent);
        }
      }
    }
  }

  /** 把 el 的文本区间 [start, end) 包进 mark（只处理文本节点）。 */
  function wrapTextRange(el, start, end, isCurrent) {
    let pos = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const targets = [];
    let node = walker.nextNode();
    while (node) {
      const len = node.nodeValue.length;
      const s = Math.max(start, pos);
      const e = Math.min(end, pos + len);
      if (s < e) targets.push({ node, s: s - pos, e: e - pos });
      pos += len;
      node = walker.nextNode();
    }
    // 从后往前改，保证同一文本节点内多个命中时偏移仍然有效
    for (let i = targets.length - 1; i >= 0; i--) {
      const { node: n, s, e } = targets[i];
      if (n.parentNode && n.parentNode.tagName === 'MARK') continue;
      n.splitText(e);
      const mid = n.splitText(s);
      const mark = document.createElement('mark');
      mark.className = 'find-hit' + (isCurrent ? ' current' : '');
      mid.parentNode.replaceChild(mark, mid);
      mark.appendChild(mid);
    }
    // 命中落在行首/行尾时会切出空的父节点：parent.normalize() 只合并同一父节点
    // 下的相邻文本，父节点本身的空壳没有影响，保持原样。
  }

  // --- 替换：只改数据，改完重新对齐；进入编辑模式前不允许改写 ---
  /**
   * 在两侧的行上做字面量替换（大小写不敏感，与查找一致）。
   * 保留每行原有的换行符，只替换正文。
   */
  function replaceOne() {
    const q = findInput.value;
    const rep = replaceInput.value;
    if (!q) { setStatus(t('textCompare.replaceEmpty')); return; }
    if (!state.editing) { setStatus(t('textCompare.replaceLocked')); return; }
    const needle = q.toLowerCase();
    let done = 0;
    for (const d of state.diffLines) {
      if (d.kind !== 'same') continue;
      for (const line of [d.aLine, d.bLine]) {
        if (!line || done) continue;
        const idx = line.body.toLowerCase().indexOf(needle);
        if (idx < 0) continue;
        line.body = line.body.slice(0, idx) + rep + line.body.slice(idx + q.length);
        done++;
      }
      if (done) break;
    }
    if (!done) { setStatus(t('textCompare.findNone', { q })); return; }
    const keep = state.selected;
    renderComparison();
    state.selected = keep;
    applySelection();
    find(1);
    setStatus(t('textCompare.replaced', { n: 1 }));
  }

  function replaceAll() {
    const q = findInput.value;
    const rep = replaceInput.value;
    if (!q) { setStatus(t('textCompare.replaceEmpty')); return; }
    if (!state.editing) { setStatus(t('textCompare.replaceLocked')); return; }
    let done = 0;
    for (const lines of [state.leftLines, state.rightLines]) {
      for (const line of lines) {
        // split/join 避免 $ 等特殊字符被当作替换模式解释
        const parts = line.body.split(new RegExp(escapeRegExp(q), 'gi'));
        if (parts.length > 1) {
          done += parts.length - 1;
          line.body = parts.join(rep);
        }
      }
    }
    renderComparison();
    setStatus(done ? t('textCompare.replaced', { n: done }) : t('textCompare.findNone', { q }));
  }

  // --- 对齐（Align With） ---
  /**
   * 把当前选中行对齐到对侧的同号行。两侧行数不同时，用户往往就是想把
   * 「左第 N 行」当作「右第 M 行」的对应项，这里用选中的行号作为锚点，
   * 无法配对的行保持原来的孤立状态。
   */
  function alignSelection() {
    const d = selectedLine();
    if (!d) { setStatus(t('textCompare.alignNeedRow')); return; }
    const aIdx = d.aIdx >= 0 ? d.aIdx : null;
    const bIdx = d.bIdx >= 0 ? d.bIdx : null;
    if (aIdx == null || bIdx == null) {
      setStatus(t('textCompare.alignNeedBoth'));
      return;
    }
    state.anchors.push({ aIdx, bIdx });
    renderComparison();
    setStatus(t('textCompare.aligned', { a: aIdx + 1, b: bIdx + 1 }));
  }

  /** 只保留当前差异块，其余相同的行折叠——对应 BC 的 "Isolate"。 */
  function toggleIsolate() {
    // 再次点击即恢复完整视图
    if (state.window) {
      state.window = null;
      renderComparison();
      // 按钮不能继续显示为按下状态（否则“已退出隔离”但按钮还亮着）。
      btnIsolate.classList.remove('active');
      setStatus(t('textCompare.isolateOff'));
      return;
    }
    if (state.selected < 0 || selectedLine()?.kind === 'same') {
      // 没有选中差异行时直接隔离第一处差异（与 BC 一致）：用户的意图是
      // “只看差异”，让他先回去点一行再点回来没有意义。全文无差异才提示。
      if (!state.diffRows.length) { setStatus(t('textCompare.noDiffs')); return; }
      selectRow(viewRow(state.diffRows[0]));
      state.cursor = 0;
    }
    // 找到当前差异块的起止，前后各留 3 行上下文——与 BC 的隔离视图一致。
    // 这里拿到的 diffLines 是全文，索引与 state.diffRows 一致。
    const diffLines = state.allDiffLines || [];
    let s = state.selected;
    while (s > 0 && diffLines[s - 1]?.kind !== 'same') s--;
    let e = state.selected;
    while (e < diffLines.length - 1 && diffLines[e + 1]?.kind !== 'same') e++;
    const pad = 3;
    const aLo = diffLines.slice(s, e + 1).map((r) => r.aIdx).filter((x) => x != null && x >= 0);
    const bLo = diffLines.slice(s, e + 1).map((r) => r.bIdx).filter((x) => x != null && x >= 0);
    // 差异块为空（理论上不会发生）时不要算出 NaN 窗口，否则所有行都会被过滤掉。
    if (!aLo.length && !bLo.length) { setStatus(t('textCompare.noDiffs')); return; }
    // 改动块可能只有一侧有行，用前一行推出另一侧的起始位置
    const prev = diffLines[s - 1];
    const a0 = aLo.length ? Math.min(...aLo) : (prev && prev.aIdx >= 0 ? prev.aIdx + 1 : 0);
    const b0 = bLo.length ? Math.min(...bLo) : (prev && prev.bIdx >= 0 ? prev.bIdx + 1 : 0);
    state.window = {
      aStart: Math.max(0, a0 - pad),
      aEnd: Math.min(state.leftLines.length, Math.max(...aLo, a0 - 1) + 1 + pad),
      bStart: Math.max(0, b0 - pad),
      bEnd: Math.min(state.rightLines.length, Math.max(...bLo, b0 - 1) + 1 + pad),
    };
    // 此时选择索引落在全文坐标系里；按钮按下态必须在重绘之后设置。
    renderComparison();
    btnIsolate.classList.add('active');
    // 隔离视图里行数变少，状态栏单独提示。
    setStatus(t('textCompare.isolated', { n: state.diffRows.length }));
  }

  // --- 书签 ---
  function toggleBookmark() {
    if (state.selected < 0) return;
    if (state.bookmarks.has(state.selected)) state.bookmarks.delete(state.selected);
    else state.bookmarks.add(state.selected);
    render(state.diffLines);
    setStatus(t('textCompare.bookmarkStatus', { n: state.bookmarks.size }));
  }

  function jumpBookmark(dir) {
    const list = [...state.bookmarks].sort((a, b) => a - b);
    if (!list.length) { setStatus(t('textCompare.bookmarkNone')); return; }
    let next;
    if (state.selected < 0) next = dir > 0 ? list[0] : list[list.length - 1];
    else if (dir > 0) next = list.find((i) => i > state.selected) ?? list[0];
    else next = [...list].reverse().find((i) => i < state.selected) ?? list[list.length - 1];
    selectRow(next);
    scrollRowIntoView(viewRow(next));
  }

  // --- 编辑与保存 ---
  // 行级 div 无法承载光标，所以编辑直接写回数据模型：开启编辑后，
  // 双击某行即可原地修改该行文本。
  function setEditing(on) {
    state.editing = on;
    btnEdit.classList.toggle('active', on);
    btnEdit.title = on ? t('textCompare.editOff') : t('textCompare.editOn');
    leftPane.classList.toggle('editing', on);
    rightPane.classList.toggle('editing', on);
    if (on) bindEditing();
  }

  function bindEditing() {
    for (const [rowsEl, side] of [[leftRows, 'left'], [rightRows, 'right']]) {
      for (const rowEl of rowsEl.children) {
        if (rowEl.dataset.editBound) continue;
        rowEl.dataset.editBound = '1';
        rowEl.addEventListener('dblclick', () => startInlineEdit(rowEl, side));
      }
    }
  }

  /** 双击行 → 在行内出现输入框，回车提交、Esc 取消。 */
  function startInlineEdit(rowEl, side) {
    if (!state.editing) return;
    const idx = viewRow(fullRow(Number(rowEl.dataset.row)));
    if (!state.diffLines[idx]) return;
    const line = side === 'left' ? state.diffLines[idx].aLine : state.diffLines[idx].bLine;
    if (!line) { setStatus(t('textCompare.needBothSides')); return; }
    const code = rowEl.querySelector('.code');
    const input = el('input', { class: 'inline-edit', value: line.body });
    code.textContent = '';
    code.append(input);
    input.focus();
    input.select();
    const commit = (ok) => {
      if (ok) {
        line.body = input.value;
        renderComparison();
      } else {
        render(state.diffLines);
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', () => commit(true));
  }

  async function save() {
    if (!state.editing) { setStatus(t('textCompare.editLocked')); return; }
    const sides = [
      { path: state.leftPath, lines: state.leftLines, encoding: state.leftEncoding },
      { path: state.rightPath, lines: state.rightLines, encoding: state.rightEncoding },
    ];
    try {
      for (const s of sides) {
        if (!s.path) continue;
        // 按读入时的编码写回：打开 GBK / UTF-16 文件后编辑保存不会悄悄改成
        // UTF-8，也不会丢掉 BOM。
        await api.writeText(s.path, joinLines(s.lines, dominantEol(s.lines)), s.encoding);
      }
      setStatus(t('textCompare.saved', { path: state.leftPath }));
    } catch (err) {
      setStatus(t('textCompare.openFailed', { msg: err.message }));
    }
  }

  // --- 交换左右 / 清除书签 / 导出 ---
  /**
   * 交换左右两侧。
   * 交换后左/右路径、内容与选项都跟着换位，重新比较一次，
   * 避免"标题写的是右边文件、显示的却是左边内容"。
   */
  async function swapSides() {
    const l = leftInput.value;
    leftInput.value = rightInput.value;
    rightInput.value = l;
    state.anchors = state.anchors.map((a) => ({ aIdx: a.bIdx, bIdx: a.aIdx }));
    state.window = null;
    state.bookmarks.clear();
    state.selected = -1;
    state.cursor = -1;
    await recompute();
  }

  function clearBookmarks() {
    if (!state.bookmarks.size) { setStatus(t('textCompare.bookmarkNone')); return; }
    state.bookmarks.clear();
    render(state.diffLines);
    setStatus(t('textCompare.bookmarkCleared'));
  }

  /** 生成两侧当前内容的补丁（含未保存的编辑），无差异时提示。 */
  function makePatchText() {
    // Line objects keep their { body, eol }: patch lines must carry a
    // terminator, otherwise git apply rejects the file.
    return toUnifiedPatch(buildPatch(state.leftLines, state.rightLines).diffLines, {
      // Same name on both sides: git apply keys off one path.
      fileName: basename(state.leftPath || 'file'),
    });
  }

  async function exportPatch() {
    if (!state.leftPath || !state.rightPath) { setStatus(t('textCompare.pickBoth')); return; }
    const text = makePatchText();
    if (!text) {
      // 空补丁没有实用价值，也不写空文件，直接告知用户。
      setStatus(t('textCompare.noDiffs'));
      return;
    }
    try {
      const path = await api.saveFile({
        title: t('textCompare.exportPatch'),
        defaultPath: basename(state.leftPath || 'left') + '.patch',
      });
      if (!path) return;
      await api.writeText(path, text);
      setStatus(t('textCompare.patchSaved', { path }));
    } catch (err) {
      setStatus(t('textCompare.openFailed', { msg: err.message }));
    }
  }

  async function exportReport(format = 'html') {
    const rows = state.diffLines.map((d) => ({
      status: d.kind,
      left: d.a ?? '',
      right: d.b ?? '',
    }));
    const report = buildReport({
      title: t('textCompare.reportTitle'),
      leftName: state.leftPath,
      rightName: state.rightPath,
      generated: new Date().toLocaleString(),
      sections: [{ title: t('textCompare.reportSection'), rows }],
    }, format);
    try {
      const path = await api.saveFile({
        title: t('textCompare.exportReport'),
        defaultPath: basename(state.leftPath || 'left') + '.report.' + (format === 'html' ? 'html' : 'txt'),
      });
      if (!path) return;
      await api.writeText(path, report);
      setStatus(t('textCompare.reportSaved', { path }));
    } catch (err) {
      setStatus(t('textCompare.openFailed', { msg: err.message }));
    }
  }

  // 两侧按相对位置同步滚动。
  function syncScroll(src, dst) {
    const srcMax = src.scrollHeight - src.clientHeight;
    const dstMax = dst.scrollHeight - dst.clientHeight;
    if (srcMax <= 0 || dstMax <= 0) return;
    const target = (src.scrollTop / srcMax) * dstMax;
    if (Math.abs(dst.scrollTop - target) < 1) return;
    dst.scrollTop = target;
  }
  leftBody.addEventListener('scroll', () => syncScroll(leftBody, rightBody));
  rightBody.addEventListener('scroll', () => syncScroll(rightBody, leftBody));

  btnLeft.addEventListener('click', () => openSide('left'));
  btnRight.addEventListener('click', () => openSide('right'));
  btnRefresh.addEventListener('click', recompute);
  btnPrev.addEventListener('click', () => jumpDiff(-1));
  btnNext.addEventListener('click', () => jumpDiff(1));
  btnBookmark.addEventListener('click', toggleBookmark);
  btnBookPrev.addEventListener('click', () => jumpBookmark(-1));
  btnBookNext.addEventListener('click', () => jumpBookmark(1));
  btnSwap.addEventListener('click', swapSides);
  btnClearBookmarks.addEventListener('click', clearBookmarks);
  btnAlign.addEventListener('click', alignSelection);
  btnIsolate.addEventListener('click', toggleIsolate);
  btnPatch.addEventListener('click', exportPatch);
  btnReport.addEventListener('click', () => exportReport('html'));
  btnReplace.addEventListener('click', replaceOne);
  btnReplaceAll.addEventListener('click', replaceAll);

  // 显示选项：按钮状态用 .active 表示，与忽略选项一致。
  btnWrap.addEventListener('click', () => {
    state.wordWrap = !state.wordWrap;
    btnWrap.classList.toggle('active', state.wordWrap);
    applyDisplayOptions();
  });
  btnTabs.addEventListener('click', () => {
    // 在「制表符原样」与「按 4 列对齐」之间切换
    state.tabSize = state.tabSize ? 0 : 4;
    btnTabs.classList.toggle('active', !!state.tabSize);
    applyDisplayOptions();
    setStatus(state.tabSize ? t('textCompare.tabsOn') : t('textCompare.tabsOff'));
  });

  for (const [btn, key] of [[btnIgnoreWs, 'ignoreWhitespace'], [btnIgnoreCase, 'ignoreCase']]) {
    btn.classList.toggle('active', state[key]);
    btn.addEventListener('click', () => {
      state[key] = !state[key];
      btn.classList.toggle('active', state[key]);
      // 必须重新对齐，而不是只重画：忽略空白/大小写改变的是「哪些行算相等」，
      // 只调 renderComparison 会沿用旧的 diffLines，差异数量永远不变。
      recomputeDiff();
    });
  }

  btnEdit.addEventListener('click', () => {
    setEditing(!state.editing);
    setStatus(state.editing ? t('textCompare.editOn') : t('textCompare.editOff'));
  });
  btnSave.addEventListener('click', save);

  encSelect.addEventListener('change', async () => {
    state.encoding = encSelect.value;
    // 改编码等于换了种方式读文件，必须重新读取才能看到效果。
    if (state.leftPath && state.rightPath) await recompute();
  });

  btnLayout.addEventListener('click', () => {
    sideBySide = !sideBySide;
    panes.className = sideBySide ? 'panes side-by-side' : 'panes over-under';
  });

  for (const input of [leftInput, rightInput]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') recompute();
    });
  }

  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); find(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') findInput.blur();
  });
  // 「上一个」/「下一个」按钮与已打开的查找框联动：输入框里已经有词时，
  // 直接按按钮继续找；没有词时才把焦点交给输入框，避免点了没反应。
  btnFindNext.addEventListener('click', () => {
    if (!findInput.value) { findInput.focus(); return; }
    find(1);
  });
  btnFindPrev.addEventListener('click', () => {
    if (!findInput.value) { findInput.focus(); return; }
    find(-1);
  });
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); replaceOne(); }
    if (e.key === 'Escape') replaceInput.blur();
  });

  // 快捷键只在当前会话内生效，避免影响其他标签页。
  // 监听必须挂在 container（本标签页的根节点）上：挂在 window 上时，标签页关闭后
  // 监听器仍然存活，每开关一次文本比较就多叠一层，Alt+↓ 会一次跳 N 格。
  const onKey = (e) => {
    if (!container.isConnected || !container.classList.contains('active')) return;
    const tag = e.target && e.target.tagName;
    // 在输入框、下拉框、按钮上按键属于控件自身的操作（Enter 提交、方向键切换
    // 选项），不能同时当成比较视图的快捷键。
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON';
    if (typing && !e.ctrlKey && !e.altKey && !e.shiftKey) return;
    // e.key 按住 Shift / CapsLock 时是大写，统一转小写再比较，否则 Ctrl+S 等会失效。
    if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); jumpDiff(1); }
    else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); jumpDiff(-1); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      // 与 BC 一致：Ctrl+F 把焦点放到查找框并选中已有文字，方便直接重输。
      e.preventDefault();
      findInput.focus();
      findInput.select();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'g') { e.preventDefault(); jumpDiff(1); }
    else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'r') { e.preventDefault(); replaceAll(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'r') { e.preventDefault(); replaceOne(); }
    else if (e.ctrlKey && e.key === 'F2') { e.preventDefault(); toggleBookmark(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 's') {
      if (!state.editing) {
        // 未进入编辑模式时 Ctrl+S 不应毫无反应：明确告诉用户要先进入编辑模式。
        e.preventDefault();
        setStatus(t('textCompare.saveNeedsEdit'));
        return;
      }
      e.preventDefault();
      save();
    } else if (!typing && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && state.selected >= 0) {
      // 箭头方向即数据流向：→ 把左侧内容送到右侧，← 反之。
      // 未进入编辑模式时也要走 copyTo：由它给出「需先进入编辑模式」的提示，
      // 而不是按下去毫无反应。
      copyTo(e.key === 'ArrowRight' ? 'right' : 'left');
    }
  };
  // 监听在 container 上：挂在 window 上的监听在标签页关闭后不会被清掉，
  // 每次开关文本比较都会叠加一层，快捷键会被执行 N 次。
  container.addEventListener('keydown', onKey);

  // 从文件夹比较打开时预填两侧路径并立即比较。
  if (initial.encoding && ENCODINGS.includes(initial.encoding)) {
    state.encoding = initial.encoding;
    encSelect.value = initial.encoding;
  }
  if (initial.left) leftInput.value = initial.left;
  if (initial.right) rightInput.value = initial.right;
  if (initial.left && initial.right) {
    state.leftPath = initial.left;
    state.rightPath = initial.right;
    // 带路径打开的会话（最近列表、命令行、恢复会话）同样要进「最近打开」。
    recompute().then(notePaths);
  }

  return {
    destroy() {
      container.removeEventListener('keydown', onKey);
    },
    /** 供应用外壳记住"上次比较的是哪两个文件"，用于重启后恢复。 */
    getState() {
      return { left: leftInput.value.trim(), right: rightInput.value.trim(), encoding: state.encoding };
    },
  };
}
