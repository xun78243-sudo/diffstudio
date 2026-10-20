/**
 * 文件夹比较视图。
 *
 * 递归遍历两个目录树，按 Beyond Compare 的语义对每个条目分类
 * （仅左 / 仅右 / 左新 / 右新 / 不同 / 相同），并渲染可折叠的树。
 * 可切换为逐个比较文件内容。
 *
 * 另外提供 BC 文件夹比较的常用能力：
 *   - 文件掩码（*.js;*.ts）与排除目录（node_modules;dist）
 *   - 显示筛选（只看差异 / 只看左 / 只看右 ...）
 *   - 行内「复制到左 / 右」，双击文件打开文本比较
 */

import { el, formatBytes, globMatch, splitList } from '../core/ui.js';
import { viewerFor } from '../core/viewer.js';
import { planFolderPatch, describePlan, describeOp, patchReportModel } from '../core/folderPatch.js';
import { buildReport } from '../core/patch.js';
import { setStatus } from '../core/status.js';
import { searchFiles } from '../core/search.js';
import { compileRules, isUnimportantPath } from '../core/unimportant.js';
import {
  planRename, planMove, planNewFolder, parseTouchTime, existingNames,
  baseName as pathBaseName, dirName as pathDirName,
} from '../core/fileOps.js';
import { readArchive, readZipEntry, inflateGzip, gzipEntries, parseTar, detectArchiveFormat } from '../core/archive.js';

const S = {
  SAME: 'same',
  LEFT_ORPHAN: 'left-orphan',
  RIGHT_ORPHAN: 'right-orphan',
  LEFT_NEWER: 'left-newer',
  RIGHT_NEWER: 'right-newer',
  DIFF: 'diff',
};

/** 内容比较的字节上限，与主进程 fs:read-file-for-compare 默认值保持一致。 */
const CONTENT_LIMIT = 256 * 1024 * 1024;

/** 显示筛选：每种筛选对每个状态返回 true 表示可见。 */
const FILTERS = {
  all: () => true,
  diff: (st) => st !== S.SAME,
  left: (st) => st === S.LEFT_ORPHAN || st === S.LEFT_NEWER,
  right: (st) => st === S.RIGHT_ORPHAN || st === S.RIGHT_NEWER,
  orphans: (st) => st === S.LEFT_ORPHAN || st === S.RIGHT_ORPHAN,
};

export function createFolderCompareSession(container, context, initial = {}) {
  const api = context.api;
  const t = context.t;
  const state = {
    left: '',
    right: '',
    /** rel -> { name, type, size, mtimeMs, path } */
    leftMap: new Map(),
    rightMap: new Map(),
    /** rel -> 状态字符串 */
    status: new Map(),
    /** 当前折叠的目录 rel 集合 */
    collapsed: new Set(),
    selected: null,
    filter: 'all',
    mask: '',
    exclude: '',
    /** 「不重要文件」规则原文（正则，换行或分号分隔） */
    unimportantPaths: '',
    /** 递归比较期间用于丢弃过期结果的令牌 */
    runToken: 0,
    /** 最近一次单文件复制，用于「撤销上一步」 */
    lastCopy: null,
    /** 文件夹补丁预览：{ target, mode, ops }，null 表示没有预览 */
    patchPlan: null,
    /** 补丁执行后的撤销清单：[{ action, path, backup }] */
    patchUndo: null,
  };
  let enableContent = false;

  const leftInput = el('input', { class: 'path-input', placeholder: t('folderCompare.leftPlaceholder') });
  const rightInput = el('input', { class: 'path-input', placeholder: t('folderCompare.rightPlaceholder') });
  const btnLeft = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('folderCompare.pickLeft'), 'data-role': 'pick-left' });
  const btnRight = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('folderCompare.pickRight'), 'data-role': 'pick-right' });
  const btnCompare = el('button', { class: 'icon-btn', text: '⇄ ' + t('folderCompare.tabTitle'), title: t('folderCompare.compare'), 'data-role': 'compare' });
  const btnContent = el('button', { class: 'icon-btn', text: t('folderCompare.toggleContent'), title: t('folderCompare.toggleContent'), 'data-role': 'toggle-content' });
  const btnSwap = el('button', { class: 'icon-btn', text: '⇄', title: t('folderCompare.swapSides'), 'data-role': 'swap' });
  const btnReport = el('button', { class: 'icon-btn', text: t('folderCompare.exportReport'), title: t('folderCompare.exportReportHint'), 'data-role': 'export-report' });
  // 文件夹补丁：把一侧独有的文件（及可选的内容差异）"铺"到另一侧，先预览再执行。
  const btnPatch = el('button', { class: 'icon-btn', text: t('folderCompare.patchBtn'), title: t('folderCompare.patchHint'), 'data-role': 'folder-patch-btn' });
  const btnPatchReport = el('button', { class: 'icon-btn', text: t('folderCompare.patchReport'), title: t('folderCompare.patchReport'), 'data-role': 'folder-patch-report' });
  // 文件操作：重命名 / 新建文件夹 / Touch / 移动，以及跨文件搜索与压缩包比较。
  const btnRename = el('button', { class: 'icon-btn', text: t('folderCompare.rename'), title: t('folderCompare.rename'), 'data-role': 'rename' });
  const btnNewFolder = el('button', { class: 'icon-btn', text: '+' + t('folderCompare.newFolder'), title: t('folderCompare.newFolder'), 'data-role': 'new-folder' });
  const btnTouch = el('button', { class: 'icon-btn', text: t('folderCompare.touch'), title: t('folderCompare.touch'), 'data-role': 'touch' });
  const btnMove = el('button', { class: 'icon-btn', text: t('folderCompare.move'), title: t('folderCompare.move'), 'data-role': 'move' });
  const btnSearch = el('button', { class: 'icon-btn', text: t('folderCompare.search'), title: t('folderCompare.search'), 'data-role': 'find-in-files' });
  const btnArchiveLeft = el('button', { class: 'icon-btn', text: '🗜', title: t('folderCompare.archiveHint'), 'data-role': 'archive-left' });
  const btnArchiveRight = el('button', { class: 'icon-btn', text: '🗜', title: t('folderCompare.archiveHint'), 'data-role': 'archive-right' });

  const toolbar = el('div', { class: 'session-toolbar' },
    el('span', { text: t('common.sideLeft') }), leftInput, btnLeft,
    el('span', { text: t('common.sideRight') }), rightInput, btnRight,
    el('span', { class: 'spacer' }), btnSwap, btnPatch, btnReport, btnContent, btnCompare,
  );
  // 第二行工具条：破坏性操作独立一行，避免误点到「比较」。
  const opsBar = el('div', { class: 'sync-toolbar' },
    btnRename, btnNewFolder, btnTouch, btnMove, btnSearch,
    el('span', { class: 'spacer' }), btnArchiveLeft, btnArchiveRight);

  const maskInput = el('input', { class: 'mask', type: 'text', placeholder: t('folderCompare.maskPlaceholder'), title: t('folderCompare.maskHint'), 'data-role': 'mask' });
  const excludeInput = el('input', { class: 'exclude', type: 'text', placeholder: t('folderCompare.excludePlaceholder'), title: t('folderCompare.excludeHint'), 'data-role': 'exclude' });
  const filterSelect = el('select', { 'data-role': 'filter' });
  for (const [value, key] of [
    ['all', 'folderCompare.showAll'],
    ['diff', 'folderCompare.showDiff'],
    ['left', 'folderCompare.showLeft'],
    ['right', 'folderCompare.showRight'],
    ['orphans', 'folderCompare.showOrphans'],
  ]) {
    filterSelect.append(el('option', { value, text: t(key) }));
  }
  const shownCount = el('span', { class: 'shown-count', 'data-role': 'shown-count' });
  const btnUndo = el('button', { class: 'icon-btn', text: '↶ ' + t('folderCompare.undo'), title: t('folderCompare.undoHint'), 'data-role': 'undo' });

  const filterBar = el('div', { class: 'filter-bar' }, maskInput, excludeInput, filterSelect, shownCount, btnUndo);

  // 「不重要文件」规则：按相对路径的正则剔除条目，仅影响显示，不改变比较结果。
  const unimportantInput = el('input', {
    class: 'exclude', type: 'text',
    placeholder: t('folderCompare.unimportantPlaceholder'),
    'data-role': 'unimportant-files',
  });
  const unimportantNote = el('span', { class: 'unimportant-note', 'data-role': 'unimportant-files-invalid' });
  const unimportantBar = el('div', { class: 'filter-bar' }, unimportantInput, unimportantNote);
  // 规则是正则；写错时只提示、不过滤，避免「填错就整棵树消失」。
  let unimportantTimer = null;
  function applyUnimportant() {
    state.unimportantPaths = unimportantInput.value.trim();
    const compiled = compileRules(state.unimportantPaths);
    const bad = compiled.ok === false;
    unimportantBar.classList.toggle('invalid', bad);
    unimportantInput.title = bad ? t('folderCompare.unimportantInvalid') : t('folderCompare.unimportantHint');
    unimportantNote.textContent = bad ? t('folderCompare.unimportantInvalid') : '';
    // 刻意不走 showTree()：它只在「视图停在搜索结果」时才重绘，
    // 而规则改动必须无条件重绘一次，否则过滤结果不更新。
    treeShowingSearch = false;
    renderTree();
  }
  // 输入时防抖：每敲一个字符都整树重建会明显卡顿。
  unimportantInput.addEventListener('input', () => {
    clearTimeout(unimportantTimer);
    unimportantTimer = setTimeout(applyUnimportant, 200);
  });
  // 失焦 / 回车立刻生效，不必等防抖。
  unimportantInput.addEventListener('change', () => {
    clearTimeout(unimportantTimer);
    applyUnimportant();
  });

  // ---------------------------------------------------------------------
  // 查找文件内文本：支持普通文本 / 正则 / 全字 / 区分大小写
  // ---------------------------------------------------------------------
  const searchInput = el('input', {
    class: 'find-input', type: 'text',
    placeholder: t('folderCompare.searchPlaceholder'),
    title: t('folderCompare.searchHint'),
    'data-role': 'search-query',
  });
  const searchRegexBox = el('input', { type: 'checkbox', 'data-role': 'search-regex' });
  const searchWordBox = el('input', { type: 'checkbox', 'data-role': 'search-word' });
  const searchCaseBox = el('input', { type: 'checkbox', 'data-role': 'search-case' });
  const searchRegex = el('label', { class: 'search-opt' }, searchRegexBox, el('span', { text: t('folderCompare.searchRegex') }));
  const searchWord = el('label', { class: 'search-opt' }, searchWordBox, el('span', { text: t('folderCompare.searchWholeWord') }));
  const searchCase = el('label', { class: 'search-opt' }, searchCaseBox, el('span', { text: t('folderCompare.searchCase') }));
  const btnSearchGo = el('button', { class: 'icon-btn', text: t('folderCompare.searchGo'), 'data-role': 'search-go' });
  // 默认隐藏：点工具栏的「查找」才展开，避免常驻占一行。
  const searchBar = el('div', { class: 'search-bar hidden' },
    searchInput, btnSearchGo, searchRegex, searchWord, searchCase);


  const treeEl = el('div', { class: 'tree' });
  // 查找结果复用 treeEl 展示（renderSearchResults 直接清空重填）。
  // 回到文件树时若还停在搜索结果上，需要重新渲染，否则筛选改动看不到效果。
  let treeShowingSearch = false;
  // 搜索结束后回到文件树；treeEl 已被搜索结果占用，此时必须重绘。
  const showTree = () => {
    if (!treeShowingSearch) return;
    treeShowingSearch = false;
    renderTree();
  };
  const treeWrap = el('div', { class: 'pane-body' }, treeEl);
  const legend = el('div', { class: 'legend' });
  // 补丁预览：默认隐藏；生成计划后列出每一步，并给出执行/撤销/导出报告。
  const patchList = el('div', { class: 'rows folder-patch-rows', 'data-role': 'folder-patch-list' });
  const patchSummary = el('span', { class: 'legend-note', 'data-role': 'folder-patch-summary' });
  const btnPatchLeft = el('button', { class: 'icon-btn', text: t('folderCompare.patchToLeft'), title: t('folderCompare.patchToLeft'), 'data-role': 'patch-to-left' });
  const btnPatchRight = el('button', { class: 'icon-btn', text: t('folderCompare.patchToRight'), title: t('folderCompare.patchToRight'), 'data-role': 'patch-to-right' });
  const btnPatchContent = el('button', { class: 'icon-btn', text: t('folderCompare.patchIncludeContent'), title: t('folderCompare.patchIncludeContent'), 'data-role': 'patch-include-content' });
  const btnPatchApply = el('button', { class: 'icon-btn primary', text: t('folderCompare.patchApply'), title: t('folderCompare.patchApply'), 'data-role': 'folder-patch-apply' });
  const btnPatchUndo = el('button', { class: 'icon-btn', text: '↶ ' + t('folderCompare.patchUndo'), title: t('folderCompare.patchUndo'), 'data-role': 'folder-patch-undo' });
  const btnPatchClose = el('button', { class: 'icon-btn', text: '✕', title: t('folderCompare.patchClose'), 'data-role': 'folder-patch-close' });
  const patchPanel = el('div', { class: 'folder-patch', 'data-role': 'folder-patch-body' },
    el('div', { class: 'folder-patch-head' },
      el('span', { class: 'label', text: t('folderCompare.patchTitle') }),
      patchSummary, el('span', { class: 'spacer' }),
      btnPatchLeft, btnPatchRight, btnPatchContent, btnPatchApply, btnPatchUndo, btnPatchClose),
    el('div', { class: 'folder-patch-body' }, patchList));
  patchPanel.hidden = true;
  const root = el('div', { class: 'session' }, toolbar, opsBar, filterBar, unimportantBar, searchBar, legend, treeWrap, patchPanel);
  container.append(root);

  function renderLegend() {
    legend.innerHTML = '';
    for (const [cls, key] of [
      ['same', 'folderCompare.labelSame'],
      ['diff', 'folderCompare.labelDiff'],
      ['left-orphan', 'folderCompare.labelLeftOrphan'],
      ['right-orphan', 'folderCompare.labelRightOrphan'],
      ['left-newer', 'folderCompare.labelLeftNewer'],
      ['right-newer', 'folderCompare.labelRightNewer'],
    ]) {
      legend.append(el('div', { class: 'it' },
        el('span', { class: 'sw status-swatch ' + cls }),
        el('span', { text: t(key) })));
    }
  }
  renderLegend();

  btnContent.addEventListener('click', () => {
    enableContent = !enableContent;
    btnContent.classList.toggle('active', enableContent);
    if (state.left && state.right) compare();
  });

  filterSelect.addEventListener('change', () => {
    state.filter = filterSelect.value;
    renderTree();
  });
  // 掩码与排除项在回车或失焦时生效，避免每敲一个字符就重新遍历目录。
  for (const input of [maskInput, excludeInput]) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilters(); });
    input.addEventListener('change', applyFilters);
  }

  function applyFilters() {
    state.mask = maskInput.value.trim();
    state.exclude = excludeInput.value.trim();
    if (state.left && state.right) compare();
  }

  /** 通知外壳：用户已打开这些文件（最近打开 / 重启恢复都依赖它）。 */
  function notePaths() {
    if (typeof context.notePaths === 'function') {
      context.notePaths('folder', [state.left, state.right]);
    }
  }

  async function pickSide(side) {
    const dir = await api.openDirectory();
    if (!dir) return;
    if (side === 'left') { state.left = dir; leftInput.value = dir; }
    else { state.right = dir; rightInput.value = dir; }
    notePaths();
    if (state.left && state.right) compare();
  }

  btnLeft.addEventListener('click', () => pickSide('left'));
  btnRight.addEventListener('click', () => pickSide('right'));
  btnSwap.addEventListener('click', () => {
    const l = leftInput.value;
    leftInput.value = rightInput.value;
    rightInput.value = l;
    state.left = leftInput.value.trim();
    state.right = rightInput.value.trim();
    state.leftMap.clear();
    state.rightMap.clear();
    state.lastCopy = null;
    compare();
  });
  btnReport.addEventListener('click', exportReport);
  btnUndo.addEventListener('click', undoLastCopy);
  btnCompare.addEventListener('click', () => {
    state.left = leftInput.value.trim();
    state.right = rightInput.value.trim();
    compare();
  });

  // 由其他会话带着路径打开时（例如从文件夹比较跳转），预填两侧并立即比较。
  if (initial.left || initial.right) {
    if (initial.left) { state.left = initial.left; leftInput.value = initial.left; }
    if (initial.right) { state.right = initial.right; rightInput.value = initial.right; }
    if (state.left && state.right) compare();
  }

  async function compare() {
    const l = state.left.trim();
    const r = state.right.trim();
    if (!l || !r) { setStatus(t('folderCompare.pickBoth')); return; }

    const token = ++state.runToken;
    setStatus(t('folderSync.running'));
    treeEl.innerHTML = '';
    try {
      const [leftTree, rightTree] = await Promise.all([walkDir(l), walkDir(r)]);
      if (token !== state.runToken) return; // 已经有更新的一次比较

      state.leftMap = leftTree;
      state.rightMap = rightTree;
      await classifyAll(token);
      if (token !== state.runToken) return;

      state.collapsed.clear();
      state.selected = null;
      renderTree();
      const all = new Set([...leftTree.keys(), ...rightTree.keys()]);
      setStatus(t('folderCompare.status', { n: all.size, left: baseName(l), right: baseName(r) }));
    } catch (err) {
      setStatus(t('folderCompare.compareFailed', { msg: err.message }));
    }
  }

  /** 遍历目录；跳过被排除的目录，跳过不符合掩码的文件。 */
  async function walkDir(rootPath) {
    const map = new Map();
    const excluded = new Set(splitList(state.exclude).map((s) => s.toLowerCase()));
    const stack = [rootPath];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try {
        entries = await api.listDir(cur, rootPath);
      } catch (e) {
        continue;
      }
      for (const ent of entries) {
        if (ent.type === 'dir') {
          map.set(ent.rel, { name: ent.name, type: ent.type, size: ent.size, mtimeMs: ent.mtimeMs, path: ent.path });
          if (!excluded.has(ent.name.toLowerCase())) stack.push(ent.path);
          continue;
        }
        // 掩码只作用于文件；目录始终保留，否则整棵子树会消失。
        if (state.mask && !globMatch(state.mask, ent.name)) continue;
        map.set(ent.rel, { name: ent.name, type: ent.type, size: ent.size, mtimeMs: ent.mtimeMs, path: ent.path });
      }
    }
    return map;
  }

  async function classifyAll(token) {
    state.status = new Map();
    const keys = [...new Set([...state.leftMap.keys(), ...state.rightMap.keys()])];
    // 文件内容比较较慢，串行执行可以避免同时打开过多文件句柄。
    for (const key of keys) {
      if (token !== state.runToken) return;
      const st = await classify(state.leftMap.get(key), state.rightMap.get(key));
      state.status.set(key, st);
    }
  }

  async function classify(L, R) {
    if (L && R) {
      if (L.type === 'dir' && R.type === 'dir') return S.SAME;
      if (L.type !== R.type) return S.DIFF;
      if (enableContent) return compareContent(L, R);
      if (L.size !== R.size) return S.DIFF;
      // 时间戳精度因文件系统而异（FAT 只有 2 秒），1 秒内的差异视为相同，
      // 与 Beyond Compare 默认的「时间戳容差」一致。
      const delta = L.mtimeMs - R.mtimeMs;
      if (Math.abs(delta) < 1000) return S.SAME;
      return delta > 0 ? S.LEFT_NEWER : S.RIGHT_NEWER;
    }
    return L ? S.LEFT_ORPHAN : S.RIGHT_ORPHAN;
  }

  /**
   * 把「不重要文件」规则解析成判定函数。
   *
   * 规则写错时返回 null：宁可不过滤，也不能因为用户少打一个括号就让整棵树消失。
   */
  function unimportantMatcher() {
    const unr = compileRules(state.unimportantPaths || '');
    if (!unr.ok || !(unr.rules || []).length) return null;
    return (key) => isUnimportantPath(String(key).replace(/\\/g, '/'), unr.rules);
  }

  /** 目录在筛选后是否仍应显示：自身或任一子孙可见。 */
  function visibleDirs() {
    const test = FILTERS[state.filter];
    const isUnimportant = unimportantMatcher();
    const visible = new Set();
    for (const [key, st] of state.status) {
      if (isUnimportant && isUnimportant(key)) continue;
      if (!test(st)) continue;
      // 命中的文件自身可见，且它到根的每一级祖先目录都要保留，
      // 否则父目录不在 visible 里，这个文件在按父目录分组的树中就渲染不出来。
      visible.add(key);
      let p = parentKey(key);
      while (p !== '') { visible.add(p); p = parentKey(p); }
    }
    return visible;
  }

  function renderTree() {
    treeEl.innerHTML = '';
    const allKeys = [...state.status.keys()].sort((a, b) => a.localeCompare(b));
    if (allKeys.length === 0) {
      treeEl.append(el('div', { class: 'tree-row empty' },
        el('span', { class: 'name', text: t('folderCompare.empty') })));
      shownCount.textContent = t('folderCompare.shownCount', { shown: 0, total: 0 });
      return;
    }

    // 「不重要文件」规则独立于差异筛选：只看 status，不区分左右，
    // 因此即使当前是「全部」也要经过 visibleDirs 才会被剔除。
    const visible = state.filter === 'all' && !state.unimportantPaths ? new Set(allKeys) : visibleDirs();
    const children = new Map();
    for (const key of allKeys) {
      if (!visible.has(key)) continue;
      const parent = parentKey(key);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(key);
    }

    const renderLevel = (parentKeyPath, target) => {
      for (const key of children.get(parentKeyPath) || []) {
        const L = state.leftMap.get(key);
        const R = state.rightMap.get(key);
        const item = L || R;
        const isDir = item && item.type === 'dir';
        const st = state.status.get(key) || S.SAME;

        const row = renderRow(key, item, st, isDir);
        target.append(row);

        if (isDir) {
          const childContainer = el('div', { class: 'child' });
          const hasChildren = (children.get(key) || []).length > 0;
          if (hasChildren) {
            const isCollapsed = state.collapsed.has(key);
            const toggle = el('span', { class: 'tw', text: isCollapsed ? '▸' : '▾' });
            row.querySelector('.tw-cell').append(toggle);
            if (isCollapsed) childContainer.style.display = 'none';
            const flip = () => {
              if (state.collapsed.has(key)) state.collapsed.delete(key);
              else state.collapsed.add(key);
              renderTree();
            };
            toggle.addEventListener('click', (e) => { e.stopPropagation(); flip(); });
            row.querySelector('.name').addEventListener('dblclick', flip);
            target.append(childContainer);
            if (!isCollapsed) renderLevel(key, childContainer);
          } else {
            row.querySelector('.ic').textContent = '📂';
          }
        }
      }
    };
    renderLevel('', treeEl);

    const total = allKeys.length;
    const shown = [...visible].length;
    shownCount.textContent = t('folderCompare.shownCount', { shown, total });
  }

  function renderRow(key, item, st, isDir) {
    const name = key.split(/[\\/]/).pop() || key;
    const row = el('div', { class: 'tree-row ' + st, 'data-rel': key });
    row.append(el('span', { class: 'tw-cell' }));
    row.append(el('span', { class: 'ic', text: isDir ? '📁' : '📄' }));
    row.append(el('span', { class: 'name', text: name, title: key }));
    if (!isDir) row.append(el('span', { class: 'size', text: formatBytes(item ? item.size : 0) }));
    row.append(el('span', { class: 'op', text: labelFor(st) }));

    // 行内操作：仅对文件提供，目录的批量复制不在此处提供（避免半途失败）。
    const actions = el('span', { class: 'row-actions' });
    if (!isDir && st !== S.SAME) {
      if (state.leftMap.has(key)) {
        const btn = el('button', { text: '→', title: t('folderCompare.copyToRight'), 'data-role': 'copy-right' });
        btn.addEventListener('click', (e) => { e.stopPropagation(); copyItem(key, 'right'); });
        actions.append(btn);
      }
      if (state.rightMap.has(key)) {
        const btn = el('button', { text: '←', title: t('folderCompare.copyToLeft'), 'data-role': 'copy-left' });
        btn.addEventListener('click', (e) => { e.stopPropagation(); copyItem(key, 'left'); });
        actions.append(btn);
      }
    }
    row.append(actions);

    row.addEventListener('click', () => {
      state.selected = key;
      for (const r of treeEl.querySelectorAll('.tree-row.selected')) r.classList.remove('selected');
      row.classList.add('selected');
    });
    row.addEventListener('dblclick', () => {
      // 与 BC 一致：目录是折叠 / 展开，文件按内容类型打开对应的比较窗口。
      if (isDir) return;
      openComparisonFor(key);
    });
    return row;
  }

  /**
   * 双击文件：按扩展名挑比较窗口（文本 / 表格 / 图片 / 十六进制），
   * 两侧缺失的一侧传空串，会话会把已有的一侧预填好。
   */
  function openComparisonFor(rel) {
    const L = state.leftMap.get(rel);
    const R = state.rightMap.get(rel);
    if (typeof context.openSession !== 'function') return;
    const kind = viewerFor(rel);
    context.openSession(kind, { left: L ? L.path : '', right: R ? R.path : '' });
    setStatus(t('folderCompare.openedAs', { name: rel, kind: t('viewer.' + kind) }));
  }

  async function copyItem(rel, direction) {
    const src = direction === 'right' ? state.leftMap.get(rel) : state.rightMap.get(rel);
    const base = direction === 'right' ? state.right : state.left;
    if (!src) { setStatus(t('folderCompare.needFile')); return; }
    const dest = joinPath(base, rel);
    const destMap = direction === 'right' ? state.rightMap : state.leftMap;
    const existed = destMap.has(rel);
    try {
      await api.copy(src.path, dest);
      // 记录覆盖前的状态，供「撤销上一步」还原。
      state.lastCopy = { rel, direction, existed, prev: existed ? destMap.get(rel) : null };
      setStatus(direction === 'right'
        ? t('folderCompare.copiedToRight', { name: rel })
        : t('folderCompare.copiedToLeft', { name: rel }));
      // 只刷新受影响的条目状态，避免整棵树重新遍历。
      const token = ++state.runToken;
      if (direction === 'right') state.rightMap.set(rel, { ...src, path: dest });
      else state.leftMap.set(rel, { ...src, path: dest });
      state.status.set(rel, S.SAME);
      if (token === state.runToken) renderTree();
    } catch (err) {
      setStatus(t('folderCompare.compareFailed', { msg: err.message }));
    }
  }

  /**
   * 撤销上一次单文件复制。
   * 目标原本不存在：删掉刚复制的文件；目标原本存在（被覆盖）：先写回覆盖前的
   * 内容，再重新比较——只改状态表会让界面显示「已还原」，磁盘上却仍是新内容。
   */
  async function undoLastCopy() {
    const last = state.lastCopy;
    if (!last) { setStatus(t('folderCompare.undoNone')); return; }
    const { rel, direction, existed, prev } = last;
    const destMap = direction === 'right' ? state.rightMap : state.leftMap;
    if (!existed) {
      // 目标原本不存在：删除刚复制的文件
      try {
        const base = direction === 'right' ? state.right : state.left;
        await api.delete(joinPath(base, rel));
      } catch (err) {
        setStatus(t('folderCompare.compareFailed', { msg: err.message }));
        return;
      }
      destMap.delete(rel);
      state.lastCopy = null;
      await compare();
      setStatus(t('folderCompare.undone', { name: rel }));
      return;
    }
    // 目标原本存在：复制前的原内容已备份在 `<文件>.diffstudio-undo`（见 copyItem）。
    const destDir = direction === 'right' ? state.right : state.left;
    const dest = joinPath(destDir, rel);
    try {
      if (existed) await api.copy(dest + '.diffstudio-undo', dest);
    } catch (err) {
      setStatus(t('folderCompare.compareFailed', { msg: err.message }));
      return;
    }
    destMap.set(rel, prev);
    state.lastCopy = null;
    await compare();
    setStatus(t('folderCompare.undoOverwritten', { name: rel }));
  }

  /** 导出当前（筛选后可见的）差异清单为 HTML 报告。 */
  async function exportReport() {
    if (!state.status.size) { setStatus(t('folderCompare.needBoth')); return; }
    const visible = state.filter === 'all' && !state.unimportantPaths ? new Set(state.status.keys()) : visibleDirs();
    const rows = [];
    for (const key of [...state.status.keys()].sort((a, b) => a.localeCompare(b))) {
      const st = state.status.get(key);
      if (st === S.SAME || !visible.has(key)) continue;
      const L = state.leftMap.get(key);
      const R = state.rightMap.get(key);
      rows.push({
        status: labelFor(st),
        left: L ? formatBytes(L.size) : '—',
        right: R ? formatBytes(R.size) : '—',
        name: key,
      });
    }
    const report = buildReport({
      title: t('folderCompare.reportTitle'),
      leftName: state.left,
      rightName: state.right,
      generated: new Date().toLocaleString(),
      sections: [{
        title: t('folderCompare.reportSection'),
        rows: rows.map((r) => ({ status: r.status, left: r.name + '  ' + r.left, right: r.right })),
      }],
    }, 'html');
    try {
      const path = await api.saveFile({
        title: t('folderCompare.exportReport'),
        defaultPath: 'folder-report.html',
      });
      if (!path) return;
      await api.writeText(path, report);
      setStatus(t('folderCompare.reportSaved', { path }));
    } catch (err) {
      setStatus(t('folderCompare.compareFailed', { msg: err.message }));
    }
  }

  function labelFor(st) {
    switch (st) {
      case S.SAME: return t('folderCompare.labelSame');
      case S.DIFF: return t('folderCompare.labelDiff');
      case S.LEFT_ORPHAN: return t('folderCompare.labelLeftOrphan');
      case S.RIGHT_ORPHAN: return t('folderCompare.labelRightOrphan');
      case S.LEFT_NEWER: return t('folderCompare.labelLeftNewer');
      case S.RIGHT_NEWER: return t('folderCompare.labelRightNewer');
      default: return '';
    }
  }

  function parentKey(key) {
    const i = Math.max(key.lastIndexOf('\\'), key.lastIndexOf('/'));
    return i < 0 ? '' : key.slice(0, i);
  }

  function baseName(p) {
    const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  function joinPath(base, rel) {
    const sep = base.includes('\\') ? '\\' : '/';
    return base.replace(/[\\/]+$/, '') + sep + rel.replace(/[\\/]+/g, sep);
  }

  async function compareContent(L, R) {
    try {
      const [a, b] = await Promise.all([
        api.readFileForCompare(L.path, CONTENT_LIMIT),
        api.readFileForCompare(R.path, CONTENT_LIMIT),
      ]);
      if (a.tooBig || b.tooBig) return S.DIFF;
      // 逐字节比较，避免哈希碰撞把不同文件判成相同。
      return sameBytes(a.buffer, b.buffer) ? S.SAME : S.DIFF;
    } catch (e) {
      return S.DIFF;
    }
  }


  // ---------------------------------------------------------------------
  // 文件夹补丁：先算计划、再预览、最后一键执行；执行过的每步都可以撤销。
  // ---------------------------------------------------------------------

  /** 当前比较结果里参与补丁的条目。 */

  /**
   * 这一轮没找到、判断不了的状态（有开放句柄等）不能进补丁计划：
   * 复制 / 删除本来是同一件事的两面，猜错会删掉用户的数据。
   */
  function isClean(st) {
    return st === S.SAME || st === S.DIFF || st === S.LEFT_ORPHAN || st === S.RIGHT_ORPHAN;
  }
  function patchEntries() {
    const out = [];
    for (const [rel, st] of state.status) {
      const L = state.leftMap.get(rel);
      const R = state.rightMap.get(rel);
      const e = L || R;
      if (!isClean(st)) continue;
      out.push({ rel, name: e ? e.name : rel.split(/[\\/]/).pop(), type: e ? e.type : 'file', size: e ? e.size : 0, status: st });
    }
    return out;
  }

  /** 计划里涉及的目录：复制文件前要先建父目录。 */
  function parentDirs(ops) {
    const set = new Set();
    for (const op of ops) {
      const parts = op.rel.split(/[\\/]/);
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
      if (op.type === 'dir' && op.action === 'copy') set.add(op.rel);
    }
    return set;
  }

  function makePlan(target, mode) {
    if (!state.status.size) { setStatus(t('folderCompare.needBoth')); return null; }
    // 内容比较没打开时，「包含内容差异」无意义，退回只补缺失项。
    const realMode = enableContent ? mode : 'tree';
    const ops = planFolderPatch(patchEntries(), target, realMode);
    state.patchPlan = { target, mode: realMode, ops };
    renderPatchPanel();
    return state.patchPlan;
  }

  function renderPatchPanel() {
    const plan = state.patchPlan;
    patchPanel.hidden = !plan;
    btnPatchLeft.classList.toggle('active', !!plan && plan.target === 'left');
    btnPatchRight.classList.toggle('active', !!plan && plan.target === 'right');
    btnPatchContent.classList.toggle('active', !!plan && plan.mode === 'content');
    patchList.innerHTML = '';
    if (!plan) return;
    const n = describePlan(plan.ops);
    patchSummary.textContent = t('folderCompare.patchSummary', {
      total: plan.ops.length, copy: n.copy, overwrite: n.overwrite, delete: n.delete,
    });
    btnPatchApply.disabled = plan.ops.length === 0;
    if (!plan.ops.length) {
      patchList.append(el('div', { class: 'row kind-same' }, el('span', { class: 'code', text: t('folderCompare.patchEmpty') })));
      return;
    }
    for (const op of plan.ops) {
      const kind = op.action === 'delete' ? 'left' : op.action === 'overwrite' ? 'change' : 'right';
      patchList.append(el('div', { class: 'row kind-' + kind + ' patch-row', 'data-rel': op.rel },
        el('span', { class: 'text', text: describeOp(op) })));
    }
  }

  /** 执行计划：覆盖前把目标另存为备份，撤销时再放回。 */
  async function applyPatch() {
    const plan = state.patchPlan;
    if (!plan || !plan.ops.length) { setStatus(t('folderCompare.patchEmpty')); return; }
    const targetBase = plan.target === 'left' ? state.left : state.right;
    const sourceBase = plan.target === 'left' ? state.right : state.left;
    const undo = [];
    let ok = 0;
    let failed = 0;
    // 父目录在每次复制前补建（按路径长度从浅到深），这样目录本身是否新建
    // 仍由计划决定，撤销时才不会把原本就存在的目录记成"自己建的"。
    const dirs = [...new Set([...parentDirs(plan.ops), ...plan.ops.filter((o) => o.action === 'mkdir').map((o) => o.rel)])]
      .sort((a, b) => a.length - b.length);
    for (const op of plan.ops) {
      const from = joinPath(sourceBase, op.rel);
      const to = joinPath(targetBase, op.rel);
      try {
        if (op.action === 'mkdir') {
          await api.mkdir(to);
          // 撤销时只在目录为空时删掉，避免误删用户后来放进去的东西。
          undo.push({ action: 'rmdir', path: to, backup: null });
        } else if (op.action === 'delete') {
          // 删除也要能撤回：先把即将删掉的文件复制成备份。
          const backup = to + '.diffstudio-undo';
          await api.copy(to, backup);
          await api.delete(to);
          undo.push({ action: 'restore', path: to, backup });
        } else {
          for (const d of dirs) {
            if (op.rel !== d && !op.rel.startsWith(d + '/')) continue;
            try { await api.mkdir(joinPath(targetBase, d)); } catch (e) { /* 已存在 */ }
          }
          let backup = null;
          if (op.action === 'overwrite') {
            backup = to + '.diffstudio-undo';
            await api.copy(to, backup);
          }
          await api.copy(from, to);
          undo.push({ action: op.action === 'overwrite' ? 'restore' : 'remove', path: to, backup });
        }
        ok++;
      } catch (err) {
        failed++;
      }
    }
    state.patchUndo = undo.length ? undo : null;
    state.patchPlan = null;
    renderPatchPanel();
    await compare();
    setStatus(t('folderCompare.patchApplied', { ok, failed }));
  }

  /** 撤销刚执行的补丁：新建的删掉，覆盖的放回备份。 */
  async function undoPatch() {
    const undo = state.patchUndo;
    if (!undo) { setStatus(t('folderCompare.patchUndoNone')); return; }
    let ok = 0;
    let failed = 0;
    for (const step of [...undo].reverse()) {
      try {
        if (step.action === 'remove') await api.delete(step.path);
        else if (step.action === 'rmdir') {
          try { await api.delete(step.path); } catch (e) { /* 非空目录就保留 */ }
        } else if (step.action === 'restore') {
          await api.copy(step.backup, step.path);
          await api.delete(step.backup);
        }
        ok++;
      } catch (err) {
        failed++;
      }
    }
    state.patchUndo = null;
    await compare();
    setStatus(t('folderCompare.patchUndone', { ok, failed }));
  }

  btnPatch.addEventListener('click', () => makePlan('right', 'tree'));
  btnPatchLeft.addEventListener('click', () => makePlan('left', 'tree'));
  btnPatchRight.addEventListener('click', () => makePlan('right', 'tree'));
  btnPatchContent.addEventListener('click', () => {
    const next = state.patchPlan && state.patchPlan.mode === 'content' ? 'tree' : 'content';
    makePlan(state.patchPlan ? state.patchPlan.target : 'right', next);
  });
  btnPatchApply.addEventListener('click', applyPatch);
  btnPatchUndo.addEventListener('click', undoPatch);
  btnPatchClose.addEventListener('click', () => { state.patchPlan = null; renderPatchPanel(); });
  btnPatchReport.addEventListener('click', exportPatchReport);

  /** 把补丁计划导出为报告（不执行任何复制）。 */
  async function exportPatchReport() {
    const plan = state.patchPlan || makePlan('right', 'tree');
    if (!plan) return;
    const report = buildReport(patchReportModel(
      plan.ops, state.left, state.right, new Date().toLocaleString(), t('folderCompare.patchTitle'),
    ), 'html');
    try {
      const path = await api.saveFile({ title: t('folderCompare.patchReport'), defaultPath: 'folder-patch.html' });
      if (!path) return;
      await api.writeText(path, report);
      setStatus(t('folderCompare.patchReportSaved', { path }));
    } catch (err) {
      setStatus(t('folderCompare.compareFailed', { msg: err.message }));
    }
  }

  // ---------------------------------------------------------------------
  // 文件操作：重命名 / 新建文件夹 / Touch / 移动（都带前置校验）
  // ---------------------------------------------------------------------

  function errText(reason) {
    switch (reason) {
      case 'exists': return t('folderCompare.errExists');
      case 'reserved': return t('folderCompare.errReserved');
      case 'illegal': return t('folderCompare.errIllegal');
      case 'trailingDotSpace': return t('folderCompare.errTrailing');
      default: return t('folderCompare.errNameInvalid');
    }
  }

  /** 找到某条目所在的基准目录与相对路径；两侧都有时优先左侧。 */
  function locate(rel) {
    const L = state.leftMap.get(rel);
    if (L) return { item: L, base: state.left, map: state.leftMap, side: 'left' };
    const R = state.rightMap.get(rel);
    if (R) return { item: R, base: state.right, map: state.rightMap, side: 'right' };
    return null;
  }

  /** 该条目所在目录下的现有名字（小写），用于查重。 */
  function namesIn(dirPath) {
    const out = [];
    const maps = [state.leftMap, state.rightMap];
    for (const map of maps) {
      for (const item of map.values()) {
        if (pathDirName(item.path).toLowerCase() === dirPath.toLowerCase()) out.push({ name: item.name });
      }
    }
    return existingNames(out);
  }

  async function doRename() {
    const rel = state.selected;
    if (!rel) { setStatus(t('folderCompare.selectFirst')); return; }
    const loc = locate(rel);
    if (!loc) return;
    const oldName = loc.item.name;
    const input = window.prompt(t('folderCompare.renamePrompt', { name: oldName }), oldName);
    if (input === null) return;
    const plan = planRename(pathDirName(loc.item.path), oldName, input, namesIn(pathDirName(loc.item.path)));
    if (!plan.ok) { setStatus(errText(plan.reason)); return; }
    if (plan.noop) return;
    try {
      const r = await api.rename(plan.from, plan.to);
      if (r && r.ok === false) { setStatus(errText(r.reason)); return; }
      await compare();
      setStatus(t('folderCompare.opDone', { name: plan.name }));
    } catch (err) {
      setStatus(t('folderCompare.compareFailed', { msg: err.message }));
    }
  }

  async function doNewFolder() {
    const dir = state.selected ? pathDirName(locate(state.selected).item.path) : state.right || state.left;
    if (!dir) { setStatus(t('folderCompare.selectFirst')); return; }
    const input = window.prompt(t('folderCompare.newFolderPrompt'), '');
    if (input === null) return;
    const plan = planNewFolder(dir, input, namesIn(dir));
    if (!plan.ok) { setStatus(errText(plan.reason)); return; }
    try {
      await api.mkdir(plan.path);
      await compare();
      setStatus(t('folderCompare.folderCreated', { name: plan.name }));
    } catch (err) {
      setStatus(t('folderCompare.compareFailed', { msg: err.message }));
    }
  }

  async function doTouch() {
    const rel = state.selected;
    if (!rel) { setStatus(t('folderCompare.selectFirst')); return; }
    const loc = locate(rel);
    const input = window.prompt(t('folderCompare.touchPrompt'), '');
    if (input === null) return;
    const ms = parseTouchTime(input);
    if (ms === null) { setStatus(t('folderCompare.errNameInvalid')); return; }
    try {
      await api.touch(loc.item.path, ms);
      await compare();
      setStatus(t('folderCompare.touched', { name: loc.item.name }));
    } catch (err) {
      setStatus(t('folderCompare.compareFailed', { msg: err.message }));
    }
  }

  /** 把选中条目移动到对侧的同名相对位置之外——这里移动"另一侧根目录下"。 */
  async function doMove() {
    const rel = state.selected;
    if (!rel) { setStatus(t('folderCompare.selectFirst')); return; }
    const loc = locate(rel);
    const destBase = loc.side === 'left' ? state.right : state.left;
    if (!destBase) { setStatus(t('folderCompare.needBoth')); return; }
    if (!window.confirm(t('folderCompare.movePrompt', { name: loc.item.name }))) return;
    const destDir = pathDirName(joinPath(destBase, rel));
    const destTaken = namesIn(destDir);
    const plan = planMove(pathDirName(loc.item.path), loc.item.name, destDir, destTaken);
    if (!plan.ok) { setStatus(errText(plan.reason)); return; }
    try {
      const r = await api.move(plan.from, plan.to);
      if (r && r.ok === false) { setStatus(errText(r.reason)); return; }
      await compare();
      setStatus(t('folderCompare.moved', { name: loc.item.name }));
    } catch (err) {
      setStatus(t('folderCompare.compareFailed', { msg: err.message }));
    }
  }

  btnRename.addEventListener('click', doRename);
  btnNewFolder.addEventListener('click', doNewFolder);
  btnTouch.addEventListener('click', doTouch);
  btnMove.addEventListener('click', doMove);

  // ---------------------------------------------------------------------
  // 查找文件内文本
  // ---------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // 查找文件内文本：支持普通文本 / 正则 / 全字 / 区分大小写
  // ---------------------------------------------------------------------

  async function findInFiles() {
    if (!state.left || !state.right) { setStatus(t('folderCompare.needBoth')); return; }
    const query = searchInput.value;
    if (!query) return;
    const opts = {
      regex: searchRegexBox.checked,
      wholeWord: searchWordBox.checked,
      caseSensitive: searchCaseBox.checked,
    };
    setStatus(t('folderCompare.searchRunning'));
    // 只搜文本：二进制文件没有"行"可言，按扩展名粗略过滤，避免把大文件全读进来。
    const payload = [];
    for (const map of [state.leftMap, state.rightMap]) {
      for (const [rel, item] of map) {
        if (item.type === 'dir') continue;
        if (item.size > 8 * 1024 * 1024) continue;
        if (viewerFor(rel) !== 'text') continue;
        let text;
        try {
          const r = await api.readText(item.path, 'auto');
          if (r.binary) continue;
          text = r.text;
        } catch (e) { continue; }
        payload.push({ rel, path: item.path, text });
      }
    }
    // searchFiles 统一处理正则 / 全字 / 大小写，并限制单行长度与命中上限。
    const res = searchFiles(payload, query, opts);
    if (!res.ok) {
      setStatus(t('folderCompare.searchInvalid'));
      return;
    }
    renderSearchResults(res.files.map((f) => ({ file: f.rel, hits: f.hits })), payload.length);
  }

  function renderSearchResults(groups, scanned) {
    treeShowingSearch = true;
    treeEl.innerHTML = '';
    if (!groups.length) {
      treeEl.append(el('div', { class: 'tree-row empty' }, el('span', { class: 'name', text: t('folderCompare.searchNothing') })));
      setStatus(t('folderCompare.searchNothing'));
      return;
    }
    let total = 0;
    for (const g of groups) {
      const head = el('div', { class: 'tree-row' },
        el('span', { class: 'tw-cell' }), el('span', { class: 'ic', text: '📄' }),
        el('span', { class: 'name', text: g.file }), el('span', { class: 'op', text: String(g.hits.length) }));
      treeEl.append(head);
      for (const h of g.hits) {
        treeEl.append(el('div', { class: 'tree-row diff', 'data-rel': g.file },
          el('span', { class: 'tw-cell' }), el('span', { class: 'ic', text: String(h.line) }),
          el('span', { class: 'name', text: h.text })));
        total++;
      }
    }
    setStatus(t('folderCompare.searchDone', { n: total, files: groups.length }));
  }

  // 工具栏「寻找」按钮只负责展开查找栏；回车或「查找」按钮才真正执行。
  btnSearch.addEventListener('click', () => {
    searchBar.classList.toggle('hidden');
    if (!searchBar.classList.contains('hidden')) searchInput.focus();
    else showTree();
  });
  btnSearchGo.addEventListener('click', findInFiles);
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') findInFiles(); });

  // ---------------------------------------------------------------------
  // 压缩包：把某一侧的压缩包解析成文件夹树（只读）
  // ---------------------------------------------------------------------

  async function openArchive(side) {
    const picked = await api.openFiles({ filters: [{ name: 'Archives', extensions: ['zip', 'tar', 'tgz', 'gz', 'jar', 'war'] }] });
    if (!picked || !picked[0]) return;
    const file = picked[0];
    const raw = await api.readRaw(file);
    if (raw.tooBig) { setStatus(t('folderCompare.archiveSize')); return; }
    let bytes = raw.data instanceof Uint8Array ? raw.data : Uint8Array.from(raw.data);
    let parsed = readArchive(file, bytes);

    // .tgz 是"gzip 包着 tar"：先解压一层，再按 tar 解析。
    if (parsed.format === 'gzip') {
      const inflated = await inflateGzip(bytes);
      if (!inflated.ok) { setStatus(t('folderCompare.archiveBad', { reason: inflated.reason })); return; }
      const inner = inflated.data;
      if (detectArchiveFormat('inner.tar', inner) === 'tar') {
        bytes = inner;
        parsed = { ok: true, format: 'tar', entries: parseTar(inner).entries };
      } else {
        parsed = { ok: true, format: 'raw', entries: gzipEntries(file, raw.data)[0] ? gzipEntries(file, raw.data) : [] };
      }
    }
    if (!parsed.ok) { setStatus(t('folderCompare.archiveBad', { reason: parsed.reason })); return; }

    // 解压到临时目录后，用普通的文件夹比较逻辑去比：虚拟 FS 需要改动所有读盘路径，
    // 落地到临时目录更简单，也比较快，且与既有 IPC 完全兼容。
    const tmp = (await api.getHome()).tmp;
    const stamp = 'diffstudio-' + Date.now();
    const dest = joinPath(tmp, stamp + (side === 'left' ? '-L' : '-R'));
    for (const ent of parsed.entries) {
      const target = joinPath(dest, ent.path);
      if (ent.dir) { await api.mkdir(target); continue; }
      const fileBytes = await archiveEntryBytes(file, bytes, parsed, ent);
      if (!fileBytes) continue;
      await api.writeBinary(target, Array.from(fileBytes));
    }
    const dir = dest;
    if (side === 'left') { state.left = dir; leftInput.value = dir; }
    else { state.right = dir; rightInput.value = dir; }
    if (state.left && state.right) compare();
    else setStatus(t('folderCompare.archiveOpen' ) + ': ' + dir);
  }

  /** 取压缩包内单个条目的字节。ZIP 需要按方法解压，TAR 需要按偏移切片。 */
  async function archiveEntryBytes(file, bytes, parsed, ent) {
    if (parsed.format === 'zip') {
      const r = await readZipEntry(bytes, ent);
      return r.ok ? r.data : null;
    }
    if (parsed.format === 'tar') {
      const start = ent.offset;
      if (typeof start !== 'number') return null;
      return bytes.subarray(start, start + ent.size);
    }
    return null;
  }

  btnArchiveLeft.addEventListener('click', () => openArchive('left'));
  btnArchiveRight.addEventListener('click', () => openArchive('right'));

  /** 供应用外壳记住路径，用于"最近打开"和重启恢复。 */
  function getState() {
    return { left: leftInput.value.trim(), right: rightInput.value.trim() };
  }


  return { destroy() {}, getState };
}

/**
 * 逐字节比较两个 Buffer/Uint8Array。
 * Buffer 经 IPC 传过来后可能变成普通数组或 Uint8Array，这里统一处理。
 */
function sameBytes(a, b) {
  const A = toBytes(a);
  const B = toBytes(b);
  if (A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return false;
  return true;
}

function toBytes(buf) {
  if (!buf) return new Uint8Array(0);
  if (buf instanceof Uint8Array) return buf;
  if (buf.type === 'Buffer' && Array.isArray(buf.data)) return Uint8Array.from(buf.data);
  return Uint8Array.from(buf);
}
