/**
 * 文件夹同步视图。
 *
 * 遍历两个目录树，按 Beyond Compare 的同步语义为每个条目给出建议操作
 * （复制 L→R / R→L、删除、保持不变、冲突），允许逐条调整后批量执行。
 *
 * 关键约束：
 *  - 删除是破坏性的，执行前必须二次确认；删除前还会用 fs:exists 复核，
 *    避免把已经被外部改动的条目删掉。
 *  - 复制/删除按「相对路径」映射到另一侧，路径分隔符跟随基准目录风格。
 *  - 行按所在文件夹分组，折叠状态在重绘后保留，便于逐层核对。
 */

import { el, formatBytes } from '../core/ui.js';
import { setStatus } from '../core/status.js';

const OP = {
  COPY_LR: 'copy-lr',
  COPY_RL: 'copy-rl',
  DEL_L: 'del-l',
  DEL_R: 'del-r',
  LEAVE: 'leave',
  CONFLICT: 'conflict',
};

export function createFolderSyncSession(container, context, initial = {}) {
  const api = context.api;
  const t = context.t;
  const state = {
    left: '',
    right: '',
    rows: [],
    collapsed: new Set(),
    /** 执行期间锁定操作下拉框，防止边改边跑。 */
    running: false,
  };

  const leftInput = el('input', { class: 'path-input', placeholder: t('folderSync.leftPlaceholder') });
  const rightInput = el('input', { class: 'path-input', placeholder: t('folderSync.rightPlaceholder') });
  const btnLeft = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('folderSync.pickLeft'), 'data-role': 'pick-left' });
  const btnRight = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('folderSync.pickRight'), 'data-role': 'pick-right' });
  const btnSync = el('button', { class: 'icon-btn', text: '⇄ ' + t('folderSync.tabTitle'), title: t('folderSync.analyze'), 'data-role': 'analyze' });
  const btnRun = el('button', { class: 'icon-btn primary', text: '▶ ' + t('folderSync.run'), title: t('folderSync.run'), 'data-role': 'run' });

  const toolbar = el('div', { class: 'session-toolbar' },
    el('span', { text: t('common.sideLeft') }), leftInput, btnLeft,
    el('span', { text: t('common.sideRight') }), rightInput, btnRight,
    el('span', { class: 'spacer' }), btnSync, btnRun,
  );

  const btnAllLr = el('button', { class: 'icon-btn', text: t('folderSync.selectAllCopyLr'), 'data-role': 'select-all-lr' });
  const btnAllRl = el('button', { class: 'icon-btn', text: t('folderSync.selectAllCopyRl'), 'data-role': 'select-all-rl' });
  const btnReset = el('button', { class: 'icon-btn', text: '↺ ' + t('folderSync.resetAll'), 'data-role': 'reset-all' });
  const btnExpand = el('button', { class: 'icon-btn', text: t('folderSync.expandAll'), 'data-role': 'expand-all' });
  const btnCollapse = el('button', { class: 'icon-btn', text: t('folderSync.collapseAll'), 'data-role': 'collapse-all' });
  const syncBar = el('div', { class: 'sync-toolbar' }, btnAllLr, btnAllRl, btnReset, el('span', { class: 'spacer' }), btnExpand, btnCollapse);

  const legend = el('div', { class: 'legend' },
    legendItem('var(--sw-copy-lr)', t('folderSync.legendCopyLr')),
    legendItem('var(--sw-copy-rl)', t('folderSync.legendCopyRl')),
    legendItem('var(--sw-conflict)', t('folderSync.legendConflict')),
    legendItem('var(--sw-leave)', t('folderSync.legendLeave')),
  );

  const treeEl = el('div', { class: 'tree' });
  const treeWrap = el('div', { class: 'pane-body' }, treeEl);
  const root = el('div', { class: 'session' }, toolbar, syncBar, legend, treeWrap);
  container.append(root);

  function legendItem(color, text) {
    return el('div', { class: 'it' }, el('span', { class: 'sw', style: `background:${color}` }), el('span', { text }));
  }

  /** 通知外壳：用户已打开这些文件（最近打开 / 重启恢复都依赖它）。 */
  function notePaths() {
    if (typeof context.notePaths === 'function') {
      context.notePaths('sync', [state.left, state.right]);
    }
  }

  async function pickSide(side) {
    const dir = await api.openDirectory();
    if (!dir) return;
    if (side === 'left') { state.left = dir; leftInput.value = dir; }
    else { state.right = dir; rightInput.value = dir; }
    notePaths();
    if (state.left && state.right) analyze();
  }

  btnLeft.addEventListener('click', () => pickSide('left'));
  btnRight.addEventListener('click', () => pickSide('right'));
  btnSync.addEventListener('click', () => {
    state.left = leftInput.value.trim();
    state.right = rightInput.value.trim();
    analyze();
  });
  btnRun.addEventListener('click', runSync);
  btnAllLr.addEventListener('click', () => {
    for (const row of state.rows) if (row.L && row.op !== OP.CONFLICT) row.op = OP.COPY_LR;
    renderRows();
  });
  btnAllRl.addEventListener('click', () => {
    for (const row of state.rows) if (row.R && row.op !== OP.CONFLICT) row.op = OP.COPY_RL;
    renderRows();
  });
  btnReset.addEventListener('click', () => {
    for (const row of state.rows) row.op = row.suggested;
    renderRows();
  });
  btnExpand.addEventListener('click', () => { state.collapsed.clear(); renderRows(); });
  btnCollapse.addEventListener('click', () => {
    for (const row of state.rows) if (row.item && row.item.type === 'dir') state.collapsed.add(row.key);
    renderRows();
  });

  async function walkDir(rootPath) {
    const map = new Map();
    const stack = [rootPath];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = await api.listDir(cur, rootPath); } catch (e) { continue; }
      for (const ent of entries) {
        map.set(ent.rel, { name: ent.name, type: ent.type, size: ent.size, mtimeMs: ent.mtimeMs, path: ent.path });
        if (ent.type === 'dir') stack.push(ent.path);
      }
    }
    return map;
  }

  async function analyze({ silent = false } = {}) {
    const l = state.left.trim();
    const r = state.right.trim();
    if (!l || !r) { if (!silent) setStatus(t('folderSync.pickBoth')); return; }

    if (!silent) setStatus(t('folderSync.running'));
    treeEl.innerHTML = '';
    state.rows = [];

    const [lm, rm] = await Promise.all([walkDir(l), walkDir(r)]);
    const keys = [...new Set([...lm.keys(), ...rm.keys()])].sort((a, b) => a.localeCompare(b));

    for (const key of keys) {
      const L = lm.get(key);
      const R = rm.get(key);
      const suggested = suggest(L, R);
      state.rows.push({ key, L, R, item: L || R, suggested, op: suggested });
    }

    renderRows();
    const pending = state.rows.filter((x) => isAction(x.op)).length;
    if (!silent) setStatus(t('folderSync.status', { n: state.rows.length, pending }));
    return state.rows;
  }

  /** 建议操作：与 BC 同步的默认值一致（较新/仅一侧 → 复制，其余保持）。 */
  function suggest(L, R) {
    if (L && R) {
      if (L.type === 'dir' && R.type === 'dir') return OP.LEAVE;
      if (L.type !== R.type) return OP.CONFLICT;
      const sameSize = L.size === R.size;
      const delta = L.mtimeMs - R.mtimeMs;
      if (sameSize && Math.abs(delta) < 1000) return OP.LEAVE;
      if (Math.abs(delta) < 1000) return OP.LEAVE;
      return delta > 0 ? OP.COPY_LR : OP.COPY_RL;
    }
    return L ? OP.COPY_LR : OP.COPY_RL;
  }

  function isAction(op) {
    return op !== OP.LEAVE && op !== OP.CONFLICT;
  }

  function renderRows() {
    treeEl.innerHTML = '';
    // 按父目录分组，便于逐层核对。
    const groups = new Map();
    for (const row of state.rows) {
      const parent = row.key.includes('\\') || row.key.includes('/')
        ? row.key.slice(0, Math.max(row.key.lastIndexOf('\\'), row.key.lastIndexOf('/')))
        : '.';
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(row);
    }

    for (const [group, rows] of groups) {
      const head = el('div', { class: 'tree-row' });
      head.append(el('span', { class: 'tw-cell' + (state.collapsed.has(group) ? '' : '') }));
      head.append(el('span', { class: 'ic', text: state.collapsed.has(group) ? '▸' : '▾' }));
      head.append(el('span', { class: 'name', text: group === '.' ? t('folderSync.rootGroup') : group }));
      head.addEventListener('click', () => {
        if (state.collapsed.has(group)) state.collapsed.delete(group);
        else state.collapsed.add(group);
        renderRows();
      });
      treeEl.append(head);
      if (state.collapsed.has(group)) continue;

      for (const row of rows) treeEl.append(renderRow(row));
    }
  }

  function renderRow(row) {
    const item = row.item;
    const isDir = item.type === 'dir';
    const r = el('div', { class: 'tree-row op-' + row.op, 'data-rel': row.key });
    r.append(el('span', { class: 'tw-cell' }));
    r.append(el('span', { class: 'ic', text: isDir ? '📁' : '📄' }));
    r.append(el('span', { class: 'name', text: item.name, title: row.key }));
    if (!isDir) r.append(el('span', { class: 'size', text: formatBytes(item.size) }));

    const opSelect = el('select', { class: 'op-select', disabled: state.running ? '' : undefined });
    for (const [val, label] of [
      [OP.COPY_LR, t('folderSync.opCopyLr')],
      [OP.COPY_RL, t('folderSync.opCopyRl')],
      [OP.LEAVE, t('folderSync.opLeave')],
      [OP.DEL_L, t('folderSync.opDeleteL')],
      [OP.DEL_R, t('folderSync.opDeleteR')],
      [OP.CONFLICT, t('folderSync.opConflict')],
    ]) {
      const o = el('option', { value: val, text: label });
      if (val === row.op) o.selected = true;
      opSelect.append(o);
    }
    opSelect.addEventListener('change', () => {
      row.op = opSelect.value;
      r.className = 'tree-row op-' + row.op;
    });
    r.append(opSelect);
    // 取消执行时需要把下拉框同步回建议操作，这里保留引用。
    row.select = opSelect;
    row.rowEl = r;
    return r;
  }

  async function runSync() {
    if (state.running) return;
    const toRun = state.rows.filter((x) => isAction(x.op));
    if (!toRun.length) { setStatus(t('folderSync.nothingToRun')); return; }

    const deletes = toRun.filter((x) => x.op === OP.DEL_L || x.op === OP.DEL_R);
    const copies = toRun.length - deletes.length;
    const parts = [];
    if (copies) parts.push(t('folderSync.confirm', { n: copies }));
    if (deletes.length) parts.push(t('folderSync.deleteConfirm', { n: deletes.length }));
    if (!window.confirm(parts.join('\n'))) {
      // 取消时把行恢复为建议操作，否则下拉框仍停在「删除」，
      // 下一次点「执行」会把用户早已放弃的操作重新提交一遍。
      // 只改现有下拉框的值，不重绘：重绘会替换掉调用方手里的行节点。
      for (const row of toRun) {
        row.op = row.suggested;
        row.select.value = row.suggested;
        row.rowEl.className = 'tree-row op-' + row.suggested;
      }
      setStatus(t('folderSync.cancelled'));
      return;
    }

    state.running = true;
    setStatus(t('folderSync.running'));
    let copied = 0;
    let deleted = 0;
    let failed = 0;
    for (const row of toRun) {
      try {
        const { L, R } = row;
        if (row.op === OP.COPY_LR && L) {
          const dest = join(state.right, row.key);
          if (L.type === 'dir') await api.mkdir(dest);
          else await api.copy(L.path, dest);
          copied++;
        } else if (row.op === OP.COPY_RL && R) {
          const dest = join(state.left, row.key);
          if (R.type === 'dir') await api.mkdir(dest);
          else await api.copy(R.path, dest);
          copied++;
        } else if (row.op === OP.DEL_L && L) {
          // 删除前复核：文件可能已被外部删除或替换，宁可不删也不误删。
          if (await api.exists(L.path)) await api.delete(L.path);
          deleted++;
        } else if (row.op === OP.DEL_R && R) {
          if (await api.exists(R.path)) await api.delete(R.path);
          deleted++;
        } else {
          // 行里已经没有可执行的那一侧条目（例如已被外部改动），如实计为失败。
          failed++;
        }
      } catch (e) {
        failed++;
        console.error('sync failed', row.key, e);
      }
    }
    state.running = false;

    let msg = t('folderSync.done', { done: copied, failed });
    if (deleted) msg += ' · ' + t('folderSync.deleted', { n: deleted });

    // 刷新界面上的建议操作（复制完成后两侧应变为"保持"），
    // 但状态栏要保留本次执行结果，不要被"分析完成"覆盖。
    await analyze({ silent: true });
    setStatus(msg);
  }

  /**
   * 用与基准目录一致的路径分隔符拼接。
   * 相对路径里的分隔符沿用左侧基准目录的风格。
   */
  function join(base, rel) {
    const sep = base.includes('\\') ? '\\' : '/';
    return base.replace(/[\\/]+$/, '') + sep + rel.replace(/[\\/]+/g, sep);
  }

  // 由其他会话带着路径打开时，预填两侧并立即分析。
  // analyze 是函数声明，此处调用时已经可用。
  if (initial.left || initial.right) {
    if (initial.left) { state.left = initial.left; leftInput.value = initial.left; }
    if (initial.right) { state.right = initial.right; rightInput.value = initial.right; }
    if (state.left && state.right) analyze();
  }


  function getState() {
    return { left: leftInput.value.trim(), right: rightInput.value.trim() };
  }

  return { destroy() {}, getState };
}
