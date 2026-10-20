/** 生成或应用 Unified Diff 的独立会话。
 *
 * 与文本比较共用 `core/patch.js`：左边选原始文件、右边选修改后的文件即可
 * 生成补丁；也可以把已有补丁「应用」到左边文件上（先备份为 .orig，可撤销）。
 */

import { buildPatch, parseUnifiedPatch, applyUnifiedPatch } from '../core/patch.js';
import { el, splitLines, basename } from '../core/ui.js';
import { setStatus } from '../core/status.js';

/** 补丁块数：解析结果的长度。 */
function hunkCount(patchText) {
  return parseUnifiedPatch(patchText).length;
}

export function createPatchSession(container, context, initial = {}) {
  const api = context.api;
  const t = context.t;
  const state = {
    leftPath: '',
    rightPath: '',
    patchPath: '',
    /** 当前补丁文本（生成或读取自文件） */
    patchText: '',
    /** 生成补丁时的行数，仅用于状态提示 */
    patchLines: 0,
    /** 最近一次应用补丁的撤销信息 { path, before, after } */
    lastApply: null,
  };

  const leftInput = el('input', { class: 'path-input', placeholder: t('patch.leftPlaceholder') });
  const rightInput = el('input', { class: 'path-input', placeholder: t('patch.rightPlaceholder') });
  const patchInput = el('input', { class: 'path-input', placeholder: t('patch.openPatch'), readonly: '' });
  const btnLeft = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('patch.openLeft'), 'data-role': 'open-left' });
  const btnRight = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('patch.openRight'), 'data-role': 'open-right' });
  const btnPatchFile = el('button', { class: 'icon-btn', text: t('common.pickFile'), title: t('patch.openPatch'), 'data-role': 'open-patch' });
  const btnMake = el('button', { class: 'icon-btn primary', text: t('patch.make'), title: t('patch.make'), 'data-role': 'make-patch' });
  const btnApply = el('button', { class: 'icon-btn', text: t('patch.apply'), title: t('patch.applyHint'), 'data-role': 'apply-patch' });
  const btnSave = el('button', { class: 'icon-btn', text: '💾 ' + t('common.save'), title: t('patch.make'), 'data-role': 'save-patch' });
  const btnUndo = el('button', { class: 'icon-btn', text: '↶ ' + t('patch.undo'), title: t('patch.undo'), 'data-role': 'undo-patch' });
  btnUndo.disabled = true;

  const toolbar = el('div', { class: 'session-toolbar' },
    el('span', { text: t('common.sideLeft') }), leftInput, btnLeft,
    el('span', { text: t('common.sideRight') }), rightInput, btnRight,
    el('span', { class: 'spacer' }),
    btnMake, btnSave,
  );
  const subbar = el('div', { class: 'session-subbar' },
    patchInput, btnPatchFile,
    el('span', { class: 'sep' }),
    btnApply, btnUndo,
    el('span', { class: 'spacer' }),
    el('span', { class: 'legend-note', text: t('patch.applyHint') }),
  );

  const title = el('div', { class: 'pane-header' }, el('span', { class: 'label', text: t('patch.previewTitle') }));
  const body = el('div', { class: 'rows patch-preview', 'data-role': 'patch-preview' });
  const preview = el('div', { class: 'pane' }, title, el('div', { class: 'pane-body' }, body));
  const panes = el('div', { class: 'panes single' }, preview);

  const root = el('div', { class: 'session' }, toolbar, subbar, panes);
  container.append(root);

  function notePaths() {
    if (typeof context.notePaths === 'function') {
      context.notePaths('patch', [state.leftPath, state.rightPath, state.patchPath]);
    }
  }

  function renderPreview() {
    body.innerHTML = '';
    if (!state.patchText) {
      body.append(el('div', { class: 'empty-hint', text: t('patch.empty') }));
      return;
    }
    const lines = state.patchText.replaceAll('\r\n', '\n').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) {
      const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'right' : line.startsWith('-') ? 'left' : 'same';
      body.append(el('div', { class: `row kind-${kind} patch-row` },
        el('span', { class: 'text', text: line || ' ' })));
    }
  }

  function setPatch(text) {
    state.patchText = text || '';
    state.patchLines = state.patchText ? state.patchText.replace(/\n$/, '').split('\n').length : 0;
    renderPreview();
  }

  async function openSide(side) {
    try {
      const res = await api.openFiles({ multi: false });
      if (!res || !res[0]) return;
      if (side === 'left') { state.leftPath = res[0]; leftInput.value = res[0]; }
      else { state.rightPath = res[0]; rightInput.value = res[0]; }
      notePaths();
    } catch (err) {
      setStatus(t('patch.readFailed', { msg: err.message }));
    }
  }

  async function openPatchFile() {
    try {
      const res = await api.openFiles({ multi: false });
      if (!res || !res[0]) return;
      state.patchPath = res[0];
      patchInput.value = res[0];
      const file = await api.readText(res[0]);
      if (file.binary) { setStatus(t('patch.parseFailed', { msg: basename(res[0]) })); return; }
      // 读进来先校验一遍：坏补丁不要等到「应用」时才报错。
      const hunks = parseUnifiedPatch(file.text);
      setPatch(file.text);
      setStatus(t('patch.parsed', { hunks: hunks.length }));
      notePaths();
    } catch (err) {
      setStatus(t('patch.parseFailed', { msg: err.message }));
    }
  }

  async function makePatch() {
    state.leftPath = leftInput.value.trim();
    state.rightPath = rightInput.value.trim();
    if (!state.leftPath || !state.rightPath) { setStatus(t('patch.pickBoth')); return; }
    try {
      const [l, r] = await Promise.all([api.readText(state.leftPath), api.readText(state.rightPath)]);
      if (l.binary || r.binary) { setStatus(t('patch.pickBoth')); return; }
      // buildPatch 直接产出 Unified Diff；文件名两侧相同，git apply 才对得上路径。
      const built = buildPatch(splitLines(l.text), splitLines(r.text), {
        fileName: basename(state.leftPath || 'file'),
      });
      setPatch(built.patch);
      if (!built.patch) { setStatus(t('patch.noChanges')); return; }
      const hunks = hunkCount(built.patch);
      setStatus(t('patch.made', { hunks, lines: state.patchLines }));
    } catch (err) {
      setStatus(t('patch.readFailed', { msg: err.message }));
    }
  }

  async function savePatch() {
    if (!state.patchText) { setStatus(t('patch.pickPatch')); return; }
    try {
      const path = await api.saveFile({
        title: t('patch.make'),
        defaultPath: basename(state.leftPath || 'changes') + '.patch',
      });
      if (!path) return;
      await api.writeText(path, state.patchText);
      state.patchPath = path;
      patchInput.value = path;
      setStatus(t('patch.saved', { path }));
    } catch (err) {
      setStatus(t('patch.saveFailed', { msg: err.message }));
    }
  }

  async function applyPatch() {
    if (!state.leftPath) { setStatus(t('patch.pickLeft')); return; }
    if (!state.patchText) { setStatus(t('patch.pickPatch')); return; }
    try {
      const hunks = parseUnifiedPatch(state.patchText);
      const file = await api.readText(state.leftPath);
      const eol = file.text.includes('\r\n') ? '\r\n' : '\n';
      const original = splitLines(file.text);
      const plain = original.map((ln) => (typeof ln === 'string' ? ln : ln.body));
      const res = applyUnifiedPatch(plain, state.patchText);
      if (res.rejected) {
        const bad = res.rejectedIndex >= 0 ? res.rejectedIndex : 0;
        setStatus(t('patch.broken', { n: bad + 1, line: hunks[bad] ? hunks[bad].aStart + 1 : 1 }));
        return;
      }
      const next = res.lines.join(eol) + (file.text.endsWith('\n') || file.text.endsWith('\r\n') ? eol : '');
      // 可撤销：先记下原文，再覆盖。
      state.lastApply = { path: state.leftPath, before: file.text };
      await api.writeText(state.leftPath, next);
      btnUndo.disabled = false;
      setStatus(t('patch.applied', { path: basename(state.leftPath) }));
      renderPreview();
    } catch (err) {
      setStatus(t('patch.applyFailed', { msg: err.message }));
    }
  }

  async function undoPatch() {
    if (!state.lastApply) return;
    try {
      await api.writeText(state.lastApply.path, state.lastApply.before);
      state.lastApply = null;
      btnUndo.disabled = true;
      setStatus(t('patch.undone', { path: basename(state.leftPath) }));
    } catch (err) {
      setStatus(t('patch.undoFailed', { msg: err.message }));
    }
  }

  btnLeft.addEventListener('click', () => openSide('left'));
  btnRight.addEventListener('click', () => openSide('right'));
  btnPatchFile.addEventListener('click', openPatchFile);
  btnMake.addEventListener('click', makePatch);
  btnSave.addEventListener('click', savePatch);
  btnApply.addEventListener('click', applyPatch);
  btnUndo.addEventListener('click', undoPatch);

  for (const input of [leftInput, rightInput]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') makePatch();
    });
  }

  // 预填路径后自动跑一次，和别的会话一样。
  if (initial.left) { state.leftPath = initial.left; leftInput.value = initial.left; }
  if (initial.right) { state.rightPath = initial.right; rightInput.value = initial.right; }

  renderPreview();
  if (state.leftPath && state.rightPath) makePatch();

  return {
    getState: () => ({ left: state.leftPath, right: state.rightPath }),
    /** 测试与状态检查用：当前补丁文本、预览行数 */
    get patch() { return state.patchText; },
    get patchLines() { return state.patchLines; },
    destroy() {}
  };
}
