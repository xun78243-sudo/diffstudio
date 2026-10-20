/**
 * 替换规则（Beyond Compare 的 Replacement / 正则替换）。
 *
 * BC 的语义：在比较**之前**把文本按规则替换掉，因此被替换的部分不参与比较。
 * 与「重要/不重要规则」的区别：
 *  - 不重要规则是**后处理**：diff 照常算，再把结果降级，原文始终可见；
 *  - 替换规则是**预处理**：先把文本改写，再算 diff，所以行内容、行号都对得上，
 *    但显示的仍然是原文（替换只影响比较，不修改文件）。
 *
 * 语法（每行或分号分隔一条）：`/pattern/flags=>replacement`
 *   - 省略 flags 时默认 `g`，大小写敏感；
 *   - `=>` 两侧允许留空（空 replacement 等价于删除）；
 *   - 也支持旧式写法 `pattern=>replacement`（不带 `/.../`），此时按字面量处理 pattern，
 *     避免用户写 `1.0=>2.0` 时 `.` 被当成通配符。
 */

import { splitLines } from './ui.js';

const SEP = '=>';

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 编译替换规则文本。
 *
 * @returns {{ok: boolean, rules: Array<{source:string, re:RegExp, to:string}>, reason?: 'invalid', source?: string}}
 */
export function compileReplacements(text) {
  const src = String(text ?? '');
  // 只去掉行首空白：替换文本可能是空格（如「把空白统一成单个空格」），行尾空白有语义。
  const parts = src.split(/\r?\n|;/).map((s) => s.replace(/^\s+/, '')).filter((s) => s.length > 0);  const rules = [];
  for (const p of parts) {
    const parsed = splitRule(p);
    if (!parsed) {
      // 没有 => 的规则说明写错了，直接报错而不是静默忽略。
      return { ok: false, reason: 'invalid', source: p, rules };
    }
    try {
      rules.push({ source: p, re: new RegExp(parsed.pattern, parsed.flags), to: parsed.to });
    } catch (err) {
      return { ok: false, reason: 'invalid', source: p, rules };
    }
  }
  return { ok: true, rules };
}

/**
 * 把一条规则拆成 pattern / flags / 替换文本。
 *
 * 不能简单地 `indexOf('=>')`：正则里可能自带 `=>`（如 `/(?=x)/`），
 * 所以先看是否以 `/` 开头，是则找到**未转义**的结尾 `/`，其后的 `=>` 才是分隔符。
 */
function splitRule(p) {
  if (p.startsWith('/')) {
    // 找到结尾的斜杠：跳过 \/ 转义。
    let end = -1;
    for (let i = 1; i < p.length; i++) {
      if (p[i] === '\\') { i++; continue; }
      if (p[i] === '/') { end = i; break; }
    }
    if (end < 0) return null;
    const fm = /^([a-z]*)\s*=>([\s\S]*)$/.exec(p.slice(end + 1));
    if (!fm) return null;
    const flags = fm[1].includes('g') ? fm[1] : fm[1] + 'g';
    return { pattern: p.slice(1, end), flags, to: fm[2] };
  }
  const at = p.indexOf(SEP);
  if (at < 0) return null;
  // 没有 /.../ 包裹时按字面量处理，符合用户对 `1.0=>2.0` 的直觉。
  return {
    pattern: escapeRegExp(p.slice(0, at).trim()),
    flags: 'g',
    to: p.slice(at + SEP.length),
  };
}

/** 依次应用所有替换规则；返回替换后的文本。 */
export function applyReplacements(text, rules) {
  let s = String(text ?? '');
  if (!rules || !rules.length) return s;
  for (const r of rules) {
    r.re.lastIndex = 0;
    s = s.replace(r.re, r.to);
  }
  return s;
}

/**
 * 对按行切好的结果应用替换规则。
 *
 * 行对象形如 `{ body, eol }`。替换可能吃掉换行符导致行数变化，
 * 因此这里先拼回整段文本再替换、再重新切分，避免行对象与文本不一致。
 *
 * @param {Array<{body:string, eol:string}>} lines
 * @returns {{lines: Array, changed: boolean}}
 */
export function replaceLines(lines, rules) {
  if (!rules || !rules.length) return { lines, changed: false };
  const original = lines.map((l) => l.body + (l.eol ?? '')).join('');
  const replaced = applyReplacements(original, rules);
  if (replaced === original) return { lines, changed: false };
  return { lines: splitLines(replaced), changed: true };
}

/**
 * 统计一条替换规则影响到的行数（用于状态栏提示"替换影响 N 行"）。
 * 按原始行逐行测试，跨行规则会产生偏差，这里只做粗略提示。
 */
export function countAffected(lines, rules) {
  if (!rules || !rules.length) return 0;
  let n = 0;
  for (const l of lines || []) {
    const body = String(l.body ?? l ?? '');
    for (const r of rules) {
      r.re.lastIndex = 0;
      if (r.re.test(body)) {
        n++;
        break;
      }
    }
  }
  return n;
}
