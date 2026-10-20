/**
 * 文件夹三路合并视图（base / left / right）。
 *
 * 三方目录取并集后按 folderMerge.js 的规则分类：
 * 只有一侧改动 → 自动；两侧改成一样 → 自动；两侧不一致 → 冲突（默认跳过）。
 * 用户可以逐行改选「取左侧 / 取右侧 / 跳过」，再写入任一侧。
 *
 * 与文本合并一致：冲突永远不会被静默解决，必须显式选择。
 */

import { el, formatBytes } from '../core/ui.js';
import { setStatus } from '../core/status.js';
import { mergePlanes, planThreeWay } from '../core/folderMerge.js';
import { buildReport } from '../core/patch.js';
import { joinPath } from '../core/fileOps.js';

const LABEL = {
  same: 'labelSame',
  'left-only': 'labelAuto',
  'right-only': 'labelAuto',
  'left-added': 'labelAuto',
  'right-added': 'labelAuto',
  'left-changed': 'labelAuto',
  'right-changed': 'labelAuto',
  'both-changed-same': 'labelAuto',
  'left-deleted': 'labelDeleted',
  'right-deleted': 'labelDeleted',
  conflict: 'labelConflict',
};

export function createFolderMergeSession(container, context, initial = {}) {
  const api = context.api;
  const t = context.t;
  const state = {
    base: '', left: '', right: '',
    rows: [],
    summary: null,
    target: 'left',
    /** 用户对冲突行的选择：rel -> 'left' | 'right' | null */
    choices: new Map(),
    undo: null,
    token: 0,
  };

  const baseInput = el('input', { class: 'path-input', placeholder: t('folderMerge.basePlaceholder'), 'data-role': 'base-path' });
  const leftInput = el('input', { class: 'path-input', placeholder: t('folderMerge.leftPlaceholder'), 'data-role': 'left-path' });
  const rightInput = el('input', { class: 'path-input', placeholder: t('folderMerge.rightPlaceholder'), 'data-role': 'right-path' });
  const btnBase = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('folderMerge.pickBase'), 'data-role': 'pick-base' });
  const btnLeft = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('folderMerge.pickLeft'), 'data-role': 'pick-left' });
  const btnRight = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('folderMerge.pickRight'), 'data-role': 'pick-right' });
  const btnMerge = el('button', { class: 'icon-btn', text: t('folderMerge.merge'), 'data-role': 'merge' });
  const btnApply = el('button', { class: 'icon-btn primary', text: '▶ ' + t('folderMerge.apply'), 'data-role': 'apply' });
  const btnUndo = el('button', { class: 'icon-btn', text: '↶ ' + t('folderMerge.undo'), 'data-role': 'undo' });
  const btnReport = el('button', { class: 'icon-btn', text: t('folderMerge.exportReport'), 'data-role': 'export-report' });

  const toolbar = el('div', { class: 'session-toolbar' },
    el('span', { text: 'base' }), baseInput, btnBase,
    el('span', { text: t('common.sideLeft') }), leftInput, btnLeft,
    el('span', { text: t('common.sideRight') }), rightInput, btnRight,
    el('span', { class: 'spacer' }), btnMerge, btnApply, btnUndo, btnReport,
  );

  const targetSelect = el('select', { 'data-role': 'target' });
  for (const [v, k] of [['left', 'folderMerge.targetLeft'], ['right', 'folderMerge.targetRight']]) {
    targetSelect.append(el('option', { value: v, text: t(k) }));
  }
  const summaryEl = el('span', { class: 'legend-note', 'data-role': 'merge-summary' });
  const mergeBar = el('div', { class: 'filter-bar' }, targetSelect, summaryEl);
  const legend = el('div', { class: 'legend' },
    legendItem('var(--sw-same, #e6f4ea)', t('folderMerge.labelSame')),
    legendItem('var(--sw-copy-lr, #dbeafe)', t('folderMerge.labelAuto')),
    legendItem('var(--sw-conflict, #fee2e2)', t('folderMerge.labelConflict')),
    legendItem('var(--sw-leave, #fef3c7)', t('folderMerge.labelDeleted')),
  );
  const treeEl = el('div', { class: 'tree', 'data-role': 'merge-tree' });
  const treeWrap = el('div', { class: 'pane-body' }, treeEl);
  const root = el('div', { class: 'session' }, toolbar, mergeBar, legend, treeWrap);
  container.append(root);

  function legendItem(color, text) {
    return el('div', { class: 'it' }, el('span', { class: 'sw', style: `background:${color}` }), el('span', { text }));
  }

  async function pick(which) {
    const dir = await api.openDirectory();
    if (!dir) return;
    if (which === 'base') { state.base = dir; baseInput.value = dir; }
    if (which === 'left') { state.left = dir; leftInput.value = dir; }
    if (which === 'right') { state.right = dir; rightInput.value = dir; }
    if (typeof context.notePaths === 'function') context.notePaths('folder-merge', [state.base, state.left, state.right].filter(Boolean));
  }
  btnBase.addEventListener('click', () => pick('base'));
  btnLeft.addEventListener('click', () => pick('left'));
  btnRight.addEventListener('click', () => pick('right'));
  btnMerge.addEventListener('click', () => {
    state.base = baseInput.value.trim();
    state.left = leftInput.value.trim();
    state.right = rightInput.value.trim();
    analyze();
  });
  targetSelect.addEventListener('change', () => {
    state.target = targetSelect.value;
    renderSummary();
  });
  btnApply.addEventListener('click', applyMerge);
  btnUndo.addEventListener('click', undoMerge);
  btnReport.addEventListener('click', exportReport);

  async function walk(dir) {
    const out = [];
    if (!dir) return out;
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = await api.listDir(cur, dir); } catch (e) { continue; }
      for (const ent of entries) {
        out.push({ rel: ent.rel, type: ent.type, size: ent.size, mtimeMs: ent.mtimeMs, path: ent.path, name: ent.name });
        if (ent.type === 'dir') stack.push(ent.path);
      }
    }
    return out;
  }

  async function analyze() {
    if (!state.base || !state.left || !state.right) { setStatus(t('folderMerge.pickAll')); return; }
    const token = ++state.token;
    setStatus(t('folderMerge.running'));
    const [b, l, r] = await Promise.all([walk(state.base), walk(state.left), walk(state.right)]);
    if (token !== state.token) return;
    const merged = mergePlanes(b, l, r);
    state.rows = merged.rows;
    state.summary = merged.summary;
    state.choices.clear();
    renderRows();
    setStatus(t('folderMerge.status', {
      n: merged.summary.total, auto: merged.summary.auto,
      conflict: merged.summary.conflict, deleted: merged.summary.deleted,
    }));
  }

  /** 行的有效取值：自动行用 take，冲突行用用户选择。 */
  function effectiveTake(row) {
    if (row.state === 'conflict') return state.choices.get(row.rel) || null;
    return row.take;
  }

  function renderSummary() {
    const ops = planThreeWay(rowsWithChoices(), state.target);
    summaryEl.textContent = t('folderMerge.summary', { n: ops.length });
    btnApply.disabled = ops.length === 0;
  }

  /** 把冲突行的选择写回 take，供 planThreeWay 使用。 */
  function rowsWithChoices() {
    return state.rows.map((row) => {
      const take = effectiveTake(row);
      if (row.state !== 'conflict') return row;
      // 冲突行：选中的一侧若在 base/对该侧都不存在，说明是"删除"，否则按复制处理。
      if (!take) return { ...row, take: null };
      return { ...row, take, deleted: !row[take] };
    });
  }

  function renderRows() {
    treeEl.innerHTML = '';
    if (!state.rows.length) {
      treeEl.append(el('div', { class: 'tree-row empty' }, el('span', { class: 'name', text: '—' })));
      renderSummary();
      return;
    }
    for (const row of state.rows) {
      const cls = row.state === 'conflict' ? 'conflict'
        : row.state === 'same' ? 'same'
          : (row.state.endsWith('deleted')) ? 'left-newer' : 'diff';
      const r = el('div', { class: 'tree-row ' + cls, 'data-rel': row.rel });
      r.append(el('span', { class: 'tw-cell' }));
      r.append(el('span', { class: 'ic', text: '📄' }));
      r.append(el('span', { class: 'name', text: row.rel, title: row.rel }));
      const sizes = ['base', 'left', 'right'].map((s) => (row[s] ? formatBytes(row[s].size) : '—')).join(' / ');
      r.append(el('span', { class: 'size', text: sizes }));

      const take = effectiveTake(row);
      const sel = el('select', { class: 'op-select', 'data-role': 'take' });
      for (const [v, label] of [['left', t('folderMerge.takeLeft')], ['right', t('folderMerge.takeRight')], ['', t('folderMerge.takeNone')]]) {
        const o = el('option', { value: v, text: label });
        if ((take || '') === v) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener('change', () => {
        if (sel.value) state.choices.set(row.rel, sel.value);
        else state.choices.delete(row.rel);
        renderRows();
      });
      r.append(sel);
      r.append(el('span', { class: 'op', text: t('folderMerge.' + LABEL[row.state]) }));
      treeEl.append(r);
    }
    renderSummary();
  }

  async function applyMerge() {
    const ops = planThreeWay(rowsWithChoices(), state.target);
    if (!ops.length) { setStatus(t('folderMerge.nothingToDo')); return; }
    const copies = ops.filter((o) => o.action === 'copy').length;
    const deletes = ops.filter((o) => o.action === 'delete').length;
    if (!window.confirm(t('folderMerge.confirm', { copy: copies, delete: deletes }))) return;

    // 目标侧 = 写入的一侧；来源 = 另一侧。base 只用于判定，不参与写入。
    const targetBase = state.target === 'left' ? state.left : state.right;
    const sideBase = { left: state.left, right: state.right };
    const undo = [];
    let ok = 0;
    let failed = 0;
    const rowsByRel = new Map(state.rows.map((r) => [r.rel, r]));

    for (const op of ops) {
      const row = rowsByRel.get(op.rel);
      const destPath = joinPath(targetBase, op.rel);
      try {
        if (op.action === 'delete') {
          if (await api.exists(destPath)) {
            const backup = destPath + '.diffstudio-undo';
            await api.copy(destPath, backup);
            await api.delete(destPath);
            undo.push({ action: 'restore', path: destPath, backup });
          }
          ok++;
          continue;
        }
        const srcRow = row && row[op.from];
        if (!srcRow) { failed++; continue; }
        // 覆盖前备份，撤销时放回。
        let backup = null;
        if (await api.exists(destPath)) {
          backup = destPath + '.diffstudio-undo';
          await api.copy(destPath, backup);
        }
        await api.copy(srcRow.path, destPath);
        undo.push({ action: backup ? 'restore' : 'remove', path: destPath, backup });
        ok++;
      } catch (err) {
        failed++;
      }
    }
    state.undo = undo.length ? undo : null;
    await analyze();
    setStatus(t('folderMerge.applied', { ok, failed }));
  }

  async function undoMerge() {
    const undo = state.undo;
    if (!undo) { setStatus(t('folderMerge.undoNone')); return; }
    let ok = 0;
    let failed = 0;
    for (const step of [...undo].reverse()) {
      try {
        if (step.action === 'remove') await api.delete(step.path);
        else if (step.action === 'restore') {
          await api.copy(step.backup, step.path);
          await api.delete(step.backup);
        }
        ok++;
      } catch (err) {
        failed++;
      }
    }
    state.undo = null;
    await analyze();
    setStatus(t('folderMerge.undone', { ok, failed }));
  }

  async function exportReport() {
    if (!state.rows.length) { setStatus(t('folderMerge.needMerged')); return; }
    const report = buildReport({
      title: t('folderMerge.reportTitle'),
      leftName: `${t('folderMerge.basePlaceholder')} ${state.base}`,
      rightName: `${state.left} ⇄ ${state.right}`,
      generated: new Date().toLocaleString(),
      sections: [{
        title: t('folderMerge.reportSection'),
        rows: state.rows.map((row) => ({
          status: t('folderMerge.' + LABEL[row.state]),
          left: row.rel + '  ' + (row.left ? formatBytes(row.left.size) : '—'),
          right: row.right ? formatBytes(row.right.size) : '—',
        })),
      }],
    }, 'html');
    try {
      const path = await api.saveFile({ title: t('folderMerge.exportReport'), defaultPath: 'folder-merge.html' });
      if (!path) return;
      await api.writeText(path, report);
      setStatus(t('folderMerge.reportSaved', { path }));
    } catch (err) {
      setStatus(t('folderCompare.compareFailed', { msg: err.message }));
    }
  }

  if (initial.base) { state.base = initial.base; baseInput.value = initial.base; }
  if (initial.left) { state.left = initial.left; leftInput.value = initial.left; }
  if (initial.right) { state.right = initial.right; rightInput.value = initial.right; }
  if (state.base && state.left && state.right) analyze();

  function getState() {
    return { base: baseInput.value.trim(), left: leftInput.value.trim(), right: rightInput.value.trim() };
  }

  return { destroy() {}, getState };
}
