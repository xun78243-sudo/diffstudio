/**
 * 文件夹内文本搜索（Find in Files）。
 *
 * 纯逻辑部分：把查询转成正则、在一段文本里找命中、按命中行生成结果。
 * 文件遍历与读取由视图通过 IPC 完成，这里不碰文件系统。
 */

/** 转义正则元字符，供"普通文本"模式使用。 */
export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 构造搜索用的全局正则。
 *
 * @param {string} query 关键词
 * @param {{regex?: boolean, caseSensitive?: boolean, wholeWord?: boolean}} opts
 * @returns {{ok: true, re: RegExp} | {ok: false, reason: string}}
 */
export function buildSearchRegExp(query, opts = {}) {
  const q = String(query ?? '');
  if (!q) return { ok: false, reason: 'empty' };
  let src = opts.regex ? q : escapeRegExp(q);
  if (opts.wholeWord) {
    // 不用后行断言：旧版 Chromium 里 `(?<!)` 是语法错误，会直接抛异常。
    // 改成"前置边界(非捕获) + 前瞻"，匹配到的仍然只是关键词本身。
    src = '(?:^|\\W)(?:' + src + ')(?![\\w$])';
  }
  const flags = 'gm' + (opts.caseSensitive ? '' : 'i');
  try {
    return { ok: true, re: new RegExp(src, flags) };
  } catch (err) {
    return { ok: false, reason: 'invalid' };
  }
}

/**
 * 在文本里查找，返回命中行（行号从 1 开始）与该行内容。
 *
 * 长度设上限：命中的是整行，一整个压缩过的 bundle 行可能几十万字符，
 * 展示用不着，也会拖垮渲染。
 */
export function searchText(text, query, opts = {}) {
  const built = buildSearchRegExp(query, opts);
  if (!built.ok) return { ok: false, reason: built.reason, hits: [] };

  const maxLineLen = opts.maxLineLength ?? 400;
  const maxHits = opts.maxHits ?? 2000;
  const lines = String(text).split(/\r\n|\n|\r/);
  const hits = [];
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    built.re.lastIndex = 0;
    if (!built.re.test(line)) continue;
    total++;
    if (hits.length < maxHits) {
      hits.push({
        line: i + 1,
        text: line.length > maxLineLen ? line.slice(0, maxLineLen) + '…' : line,
        truncatedLine: line.length > maxLineLen,
      });
    }
  }
  return { ok: true, hits, total, capped: total > hits.length };
}

/**
 * 汇总多个文件的结果，供界面按文件分组展示。
 *
 * @param {Array<{path: string, rel: string, text: string}>} files
 */
export function searchFiles(files, query, opts = {}) {
  const out = [];
  let total = 0;
  for (const f of files || []) {
    const r = searchText(f.text, query, opts);
    if (!r.ok) return { ok: false, reason: r.reason, files: [] };
    if (!r.total) continue;
    total += r.total;
    out.push({ path: f.path, rel: f.rel, hits: r.hits, total: r.total, capped: r.capped });
  }
  return { ok: true, files: out, total };
}
