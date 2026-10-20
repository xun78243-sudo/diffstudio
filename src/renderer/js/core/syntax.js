/**
 * 语法高亮（Beyond Compare 的 Syntax Highlighting 对应能力）。
 *
 * 目标不是做完整的语言解析器，而是"够用且不会错乱"的词法着色：
 * 用一条组合正则按优先级扫描，识别注释、字符串、数字、关键字与标识符以外的东西。
 * 这样不需要为每种语言维护状态机，也不会因为缩进/嵌套导致整屏跑色。
 *
 * 设计约束：
 *  - 必须无第三方依赖（只用于只读展示，出错也只是颜色不对）；
 *  - 只能产出 token，不直接拼 HTML——由调用方转义，避免 XSS；
 *  - 跨行结构（如未闭合的块注释）按行独立处理，单行内自洽。
 */

/** 语言定义：name / keywords / 行注释 / 块注释 / 字符串引号。 */
export const LANGUAGES = {
  none: { label: 'Plain text', keywords: [], lineComment: [], block: null, quotes: [] },
  javascript: {
    label: 'JavaScript',
    keywords: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'break', 'continue',
      'class', 'extends', 'new', 'this', 'super', 'import', 'export', 'from', 'default', 'async', 'await', 'try',
      'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'switch', 'case', 'delete', 'void', 'yield',
      'true', 'false', 'null', 'undefined', 'static', 'get', 'set'],
    lineComment: ['//'],
    block: ['/*', '*/'],
    quotes: ['"', "'", '`'],
  },
  typescript: { label: 'TypeScript', inherit: 'javascript', extraKeywords: ['interface', 'type', 'enum', 'implements', 'public', 'private', 'protected', 'readonly', 'declare', 'namespace', 'abstract', 'as', 'satisfies'] },
  python: {
    label: 'Python',
    keywords: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'import', 'from',
      'as', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'yield', 'global', 'nonlocal', 'pass', 'assert',
      'del', 'in', 'is', 'not', 'and', 'or', 'True', 'False', 'None', 'async', 'await', 'self'],
    lineComment: ['#'],
    block: null,
    quotes: ['"', "'"],
  },
  java: {
    label: 'Java',
    keywords: ['public', 'private', 'protected', 'class', 'interface', 'extends', 'implements', 'static', 'final',
      'void', 'int', 'long', 'double', 'float', 'boolean', 'char', 'byte', 'short', 'new', 'return', 'if', 'else',
      'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'try', 'catch', 'finally', 'throw',
      'throws', 'import', 'package', 'this', 'super', 'null', 'true', 'false', 'abstract', 'synchronized'],
    lineComment: ['//'],
    block: ['/*', '*/'],
    quotes: ['"', "'"],
  },
  c: {
    label: 'C / C++',
    keywords: ['int', 'long', 'short', 'char', 'float', 'double', 'void', 'unsigned', 'signed', 'const', 'static',
      'struct', 'union', 'enum', 'typedef', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
      'break', 'continue', 'goto', 'sizeof', 'extern', 'inline', 'class', 'public', 'private', 'protected', 'new',
      'delete', 'namespace', 'using', 'template', 'nullptr', 'true', 'false'],
    lineComment: ['//'],
    block: ['/*', '*/'],
    quotes: ['"', "'"],
  },
  json: {
    label: 'JSON',
    keywords: ['true', 'false', 'null'],
    lineComment: [],
    block: null,
    quotes: ['"'],
  },
  xml: {
    label: 'XML / HTML',
    keywords: [],
    lineComment: [],
    block: ['<!--', '-->'],
    quotes: ['"', "'"],
  },
  sql: {
    label: 'SQL',
    keywords: ['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table',
      'alter', 'drop', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by', 'order', 'having', 'limit',
      'and', 'or', 'not', 'null', 'as', 'distinct', 'union', 'case', 'when', 'then', 'else', 'end'],
    lineComment: ['--'],
    block: ['/*', '*/'],
    quotes: ["'", '"'],
    caseInsensitive: true,
  },
  shell: {
    label: 'Shell',
    keywords: ['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac',
      'function', 'return', 'export', 'local', 'echo', 'exit', 'set', 'cd'],
    lineComment: ['#'],
    block: null,
    quotes: ['"', "'"],
  },
};

/** 取语言定义，处理 inherit。 */
export function getLanguage(name) {
  const def = LANGUAGES[name] || LANGUAGES.none;
  if (!def.inherit) return def;
  const base = LANGUAGES[def.inherit];
  return {
    ...base,
    ...def,
    keywords: [...(base.keywords || []), ...(def.extraKeywords || [])],
  };
}

/** 按扩展名猜语言；识别不了返回 none（不猜错比猜错好）。 */
export function detectLanguage(filePath) {
  const m = /\.([a-z0-9]+)$/i.exec(String(filePath ?? ''));
  if (!m) return 'none';
  const ext = m[1].toLowerCase();
  const map = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', java: 'java', c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c', cs: 'c',
    json: 'json', xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml',
    sql: 'sql', sh: 'shell', bash: 'shell',
  };
  return map[ext] || 'none';
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把一行文本切成 token。
 *
 * @param {string} line 单行原文（不含换行符）
 * @param {object|string} lang 语言名或定义
 * @returns {Array<{text:string, type:string}>} type ∈ comment|string|number|keyword|plain
 */
export function tokenizeLine(line, lang) {
  const src = String(line ?? '');
  const def = typeof lang === 'string' ? getLanguage(lang) : (lang || LANGUAGES.none);
  if (!src) return [];
  const keywords = def.keywords || [];
  const quotes = def.quotes || [];
  const comments = def.lineComment || [];
  const hasBlock = Array.isArray(def.block) && def.block.length === 2;
  // 既没有注释也没有字符串和关键字：纯文本不必扫描。
  if (!keywords.length && !quotes.length && !comments.length && !hasBlock) return [{ text: src, type: 'plain' }];

  const alts = [];
  // 注释优先：注释里的引号/关键字都不应该被识别。
  if (comments.length) {
    alts.push({ type: 'comment', re: `(?:${comments.map((c) => escapeRe(c)).join('|')})[^\\n]*` });
  }
  if (hasBlock) {
    const [open, close] = def.block;
    alts.push({ type: 'comment', re: `${escapeRe(open)}[\\s\\S]*?(?:${escapeRe(close)}|$)` });
  }
  if (quotes.length) {
    // 每种引号单独一条：成对匹配优先，未闭合的吃到行尾（避免整屏跑色）。
    for (const q of quotes) {
      const e = escapeRe(q);
      alts.push({ type: 'string', re: `${e}(?:\\\\.|(?!${e})[^\\\\])*${e}` });
    }
    for (const q of quotes) {
      const e = escapeRe(q);
      alts.push({ type: 'string', re: `${e}(?:\\\\.|[^\\\\\\n])*$` });
    }
  }
  alts.push({ type: 'number', re: '\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b' });
  if (keywords.length) {
    const flags = def.caseInsensitive ? 'i' : '';
    alts.push({ type: 'keyword', re: `\\b(?:${keywords.map(escapeRe).join('|')})\\b`, flags });
  }

  // 组合成一个带具名分组的正则，一次扫描即可。
  const pattern = alts.map((a, i) => `(?<g${i}>${a.re})`).join('|');
  let re;
    try {
    // `i` 必须作用在整条组合正则上：子分支各自带标志不生效，SQL 等语言依赖它。
    re = new RegExp(pattern, `g${def.caseInsensitive ? 'i' : ''}`);
  } catch (err) {
    // 组合失败时退化为纯文本，宁可没颜色也不要让整行消失。
    return [{ text: src, type: 'plain' }];
  }

  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ text: src.slice(last, m.index), type: 'plain' });
    const gi = Object.keys(m.groups || {}).find((k) => m.groups[k] !== undefined);
    const idx = gi ? Number(gi.slice(1)) : 0;
    out.push({ text: m[0], type: alts[idx]?.type || 'plain' });
    last = m.index + m[0].length;
    // 空匹配保护：正则意外匹配空串时推进一位，避免死循环。
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < src.length) out.push({ text: src.slice(last), type: 'plain' });
  return out;
}

/** 把 token 渲染成 HTML（转义在调用方完成）。 */
export function tokenizeToChunks(line, lang) {
  return tokenizeLine(line, lang).map((t) => ({ text: t.text, type: t.type }));
}
