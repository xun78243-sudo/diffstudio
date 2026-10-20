/**
 * Shared UI helpers used across session views.
 */

import { myersDiff, EDIT } from './diff.js';

export const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
};

export function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function splitLines(text) {
  const src = String(text ?? '');
  const lines = [];
  let start = 0;
  // 逐行保留各自的换行符（CRLF / LF / CR），以便识别换行风格差异。
  const re = /\r\n|\n|\r/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    lines.push({ body: src.slice(start, m.index), eol: m[0] });
    start = m.index + m[0].length;
  }
  // 文件末尾若没有换行符，最后一行仍然是一条内容行；
  // 若以换行符结尾，则不会再产生一个空的"尾行"。
  if (start < src.length) lines.push({ body: src.slice(start), eol: '' });
  return lines;
}

/** 文件中出现的换行符种类集合，例如 new Set(['\r\n'])。 */
export function eolKinds(lines) {
  const kinds = new Set();
  for (const l of lines) if (l.eol) kinds.add(l.eol);
  return kinds;
}

/** 把换行符渲染为可读文本：\r\n -> "CRLF"，\n -> "LF"。 */
export function eolName(eol) {
  if (eol === '\r\n') return 'CRLF';
  if (eol === '\r') return 'CR';
  if (eol === '\n') return 'LF';
  return 'NONE';
}

/**
 * 用原始行对象还原完整文本（保留各自的换行符）。
 *
 * 传入 `eol` 时会统一输出换行符：每行都用该换行符，只有最后一行且原本
 * 没有换行符（文件末尾无换行）时保持无换行。合并结果跨版本拼装后必须
 * 这样做，否则同一文件里会混着 CRLF 和 LF。
 */
export function joinLines(lines, eol) {
  const last = lines.length - 1;
  return lines
    .map((l, i) => {
      const body = l.body ?? '';
      if (eol === undefined) return body + (l.eol ?? '');
      const keepEol = !(i === last && !l.eol);
      return keepEol ? body + eol : body;
    })
    .join('');
}

/** 行内容为空时，界面上显示一个浅色的占位符，否则空行看起来像"没渲染"。 */
export const EMPTY_LINE_MARK = '·';

/**
 * 按 glob 规则匹配文件名（大小写不敏感，与 Beyond Compare 的默认行为一致）。
 *
 * 支持 `*`（任意字符，不跨越路径分隔符）、`?`（单个字符）和 `{a,b}`。
 * 多个模式用分号分隔，例如 `*.js;*.ts`。
 */
export function globMatch(pattern, name) {
  const src = String(pattern ?? '').trim();
  if (!src) return true;
  const target = String(name ?? '').toLowerCase();
  return src
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .some((p) => globToRegExp(p).test(target));
}

function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') re += '[^\\\\/]*';
    else if (ch === '?') re += '[^\\\\/]';
    else if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end > 0) {
        const alts = pattern.slice(i + 1, end).split(',');
        re += '(?:' + alts.map(escapeRegExp).join('|') + ')';
        i = end;
      } else {
        re += '\\{';
      }
    } else re += escapeRegExp(ch);
  }
  try {
    return new RegExp('^' + re + '$', 'i');
  } catch (err) {
    // 非法模式（例如格式错误的 `{`）按字面匹配，不让界面抛错。
    return new RegExp('^' + escapeRegExp(pattern) + '$', 'i');
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]]/g, '\\$&');
}

/** 便于单元测试：把输入框里逗号/分号分隔的列表切成去空白的数组。 */
export function splitList(text) {
  return String(text ?? '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 相对路径是否命中排除项。
 *
 * 排除项可以写顶层目录名（`node_modules`），也可以是相对路径
 * （`src/generated`）。只有当某一级路径「整段相等」时才算命中——
 * 用子串匹配会把 `lib` 误判成 `libs`。
 *
 * @param {string} rel 以 / 或 \ 分隔的相对路径
 * @param {Set<string>} excluded 已转小写的排除项
 */
export function isExcluded(rel, excluded) {
  if (!excluded || !excluded.size) return false;
  const parts = String(rel ?? '').split(/[\\/]+/).filter(Boolean);
  let acc = '';
  for (const part of parts) {
    acc = acc ? acc + '/' + part : part;
    const lower = acc.toLowerCase();
    if (excluded.has(lower) || excluded.has(part.toLowerCase())) return true;
  }
  return false;
}

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

export function basename(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1];
}

export function dirname(p) {
  const i = Math.max(String(p).lastIndexOf('\\'), String(p).lastIndexOf('/'));
  return i < 0 ? '' : String(p).slice(0, i);
}

/**
 * Character-level diff within a single line, for inline highlighting.
 * Returns array of { text, kind: 'same'|'add'|'del' }.
 *
 * 使用 Myers（行内通常很短，可以精确到最优）；超长行（压缩后的文件、
 * minified JS 等）直接放弃逐字符标色，避免 O(m*n) 的内存占用把界面卡死。
 */
const INLINE_MAX = 2000;

export function diffChars(a, b) {
  const s = String(a ?? '');
  const t = String(b ?? '');
  if (s.length > INLINE_MAX || t.length > INLINE_MAX) {
    return [{ text: s, kind: 'del' }, { text: t, kind: 'add' }];
  }
  const left = Array.from(s);
  const right = Array.from(t);
  const ops = myersDiff(left, right);
  const out = [];
  for (const op of ops) {
    if (op.type === EDIT.EQ) out.push({ text: left[op.aIdx], kind: 'same' });
    else if (op.type === EDIT.DEL) out.push({ text: left[op.aIdx], kind: 'del' });
    else out.push({ text: right[op.bIdx], kind: 'add' });
  }
  return out;
}

export function renderInlineHighlight(chunks) {
  return chunks
    .map((c) => {
      if (c.kind === 'del') return `<span class="del-w">${escapeHtml(c.text)}</span>`;
      if (c.kind === 'add') return `<span class="add-w">${escapeHtml(c.text)}</span>`;
      return escapeHtml(c.text);
    })
    .join('');
}