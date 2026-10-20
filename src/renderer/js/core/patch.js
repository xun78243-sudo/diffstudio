/**
 * 统一的差异与补丁格式。
 *
 * 文本补丁沿用 Unified Diff（`--- a` / `+++ b` / `@@ -l,n +l,n @@`），
 * 这样生成的文件可以直接给 `git apply` / `patch` 使用，也能被 DiffStudio
 * 自己读回来。表格、十六进制比较复用这里的分块结果生成差异报告。
 *
 * 所有函数都只依赖纯数据，不碰 DOM 和文件系统，便于单测。
 */

import { buildDiffLines } from './diff.js';

/**
 * 把 buildDiffLines 的逐行结果切成「连续改动块 + 前后各 context 行」的补丁块。
 *
 * @returns {Array<{aStart:number,bStart:number,rows:Array}>}
 */
export function makeHunks(diffLines, context = 3) {
  if (!diffLines.length) return [];
  const hunks = [];
  let i = 0;
  const n = diffLines.length;

  while (i < n) {
    // 找下一处改动
    while (i < n && diffLines[i].kind === 'same') i++;
    if (i >= n) break;

    let start = i;
    let end = i;
    // 向前、向后各延伸到 context 行；相邻块之间的相同行不足 2*context 时合并
    while (end < n) {
      if (diffLines[end].kind === 'same') {
        let k = end;
        while (k < n && diffLines[k].kind === 'same') k++;
        if (k >= n || k - end > context * 2) {
          end = Math.min(n, end + context);
          break;
        }
        end = k;
      } else {
        end++;
      }
    }
    start = Math.max(0, start - context);
    if (hunks.length) start = Math.max(start, hunks[hunks.length - 1].end);

    const rows = diffLines.slice(start, end);
    // 行号取该块内第一条有内容行的索引
    let aStart = 0;
    let bStart = 0;
    for (const r of rows) {
      if (r.aIdx != null) { aStart = r.aIdx + 1; break; }
    }
    for (const r of rows) {
      if (r.bIdx != null) { bStart = r.bIdx + 1; break; }
    }
    const aCount = rows.filter((r) => r.kind !== 'right').length;
    const bCount = rows.filter((r) => r.kind !== 'left').length;
    if (aStart === 0) aStart = 1;
    if (bStart === 0) bStart = 1;
    hunks.push({ aStart, bStart, aCount, bCount, rows, start, end });
    i = end;
  }
  return hunks;
}

/**
 * 取 hunk 行在某一侧的正文。
 *
 * hunk 行与 buildDiffLines 的行记录同形：正文在 a/b，原始行对象在
 * aLine/bLine（{ body, eol }），取 body 即可（eol 不写进补丁）。
 */

/** 生成 Unified Diff 文本。无差异时返回空字符串。 */
export function toUnifiedPatch(diffLines, opts = {}) {
  const hunks = makeHunks(diffLines, opts.context ?? 3);
  if (!hunks.length) return '';
  // File headers use the same name on both sides: git apply keys off one
  // path, so the usual a/ -> b/ pair reads as a rename and fails.
  const name = opts.fileName ?? opts.aName ?? 'file';
  const eol = '\n';
  // Every line carries its own terminator; headers must be lines too.
  const out = [];
  out.push('--- ' + name + eol);
  out.push('+++ ' + name + eol);
  for (const h of hunks) {
    out.push('@@ -' + h.aStart + ',' + h.aCount + ' +' + h.bStart + ',' + h.bCount + ' @@' + eol);
    // 末行没有换行符时要在补丁行后面加 "\ No newline at end of file"，
    // 否则 git apply 会按"带换行"去匹配原文，导致整块对不上。
    const marker = '\\ No newline at end of file' + eol;
    let aCount = 0;
    let bCount = 0;
    const index = out.length - 1;
    for (const r of h.rows) {
      const aBody = String(r.a ?? '') + eol;
      const bBody = String(r.b ?? '') + eol;
      // buildDiffLines adds an empty trailing row when the file ends in a
      // newline; that is the file terminator, not a line. Keep it out of the
      // body but count it so the hunk header matches what the parser sees.
      if (r.aIdx < 0 && r.bIdx < 0) continue;
      if (r.aIdx >= 0) aCount++;
      if (r.bIdx >= 0) bCount++;
      if (r.kind === 'same') {
        out.push(' ' + aBody);
        if (r.aLine && typeof r.aLine === 'object' && r.aLine.eol === '') out.push(marker);
      } else if (r.kind === 'left') {
        out.push('-' + aBody);
        if (r.aLine && typeof r.aLine === 'object' && r.aLine.eol === '') out.push(marker);
      } else if (r.kind === 'right') {
        out.push('+' + bBody);
        if (r.bLine && typeof r.bLine === 'object' && r.bLine.eol === '') out.push(marker);
      } else {
        out.push('-' + aBody);
        if (r.aLine && typeof r.aLine === 'object' && r.aLine.eol === '') out.push(marker);
        out.push('+' + bBody);
        if (r.bLine && typeof r.bLine === 'object' && r.bLine.eol === '') out.push(marker);
      }
    }
    if (aCount !== h.aCount || bCount !== h.bCount) {
      // 极端情况（空行对象不完整）时以实际写出的行数为准，避免块头与正文不符。
      out[index] = '@@ -' + h.aStart + ',' + aCount + ' +' + h.bStart + ',' + bCount + ' @@' + eol;
    }
  }
  const joined = out.join('');
  // 每行以换行符结尾：git apply（以及本程序的解析器）都按行读取，
  // 末尾少一个换行会被当作"补丁被截断"。
  return joined;
}

/**
 * 解析 Unified Diff，返回以 0 为起点的改动列表：
 * `[{ aStart, aLines, bStart, bLines }]`
 *
 * 只接受本程序能生成的子集：块头 + 空格/-/+ 行。遇到 `\ No newline` 之类的
 * 扩展写法时忽略该行，保持宽容。
 */
export function parseUnifiedPatch(text) {
  // 统一成 \n 再切分。补丁文件以换行结尾时 split 会多出一个空串，
  // 那不是一行内容，必须去掉；否则每行都会多吞一个换行符。
  const lines = String(text ?? '').replaceAll('\r\n', '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const hunks = [];
  let cur = null;
  let aLine = 0;
  let bLine = 0;
  // 上一行补丁行的对象，遇到 "\ No newline at end of file" 时要去掉它的行尾。
  let prevLine = null;
  const stripEol = (line) => {
    if (line) line.eol = '';
  };
  for (const raw of lines) {
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (!m) throw new Error('bad hunk header: ' + raw);
      aLine = Number(m[1]) - 1;
      bLine = Number(m[3]) - 1;
      cur = { aStart: aLine, aLines: [], bStart: bLine, bLines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // 文件头 --- / +++ 之类
    if (!raw.length) continue;
    // 补丁里的末行标记：上一行属于文件末尾且没有换行符。
    if (raw.startsWith('\\ ')) {
      stripEol(prevLine);
      continue;
    }
    // 行对象与视图里的行同形：{ body, eol }；补丁行一律带行尾。
    const line = { body: raw.slice(1), eol: '\n' };
    prevLine = line;
    const tag = raw[0];
    if (tag === ' ') {
      cur.aLines.push(line);
      cur.bLines.push(line);
      aLine++;
      bLine++;
    } else if (tag === '-') {
      cur.aLines.push(line);
      aLine++;
    } else if (tag === '+') {
      cur.bLines.push(line);
      bLine++;
    }
  }
  return hunks;
}

/**
 * 比较一行：解析出的行是 { body, eol }，调用方传进来的原始行也可能是
 * 同样形状（视图里 splitLines 的结果），也可能只是纯字符串。
 */
function sameLine(a, b) {
  const bodyOf = (x) => (x && typeof x === 'object' ? x.body : x);
  // 文件末行可能没有换行符：解析出的补丁行总是带一个，比较时只看正文。
  return bodyOf(a) === bodyOf(b);
}

/**
 * 把补丁应用到原始行数组上。
 *
 * 输入与输出都是纯字符串数组（不含换行符），这样调用方可以直接与文件
 * 内容按行比较；内部的 hunk 行是 { body, eol } 对象，界线只在这一层。
 *
 * 返回 `{ lines, applied, rejected }`：每应用一块就推进游标，按行号顺延；
 * 上下文不匹配的块计入 rejected（不抛错，便于界面显示"部分失败"）。
 */
export function applyUnifiedPatch(originalLines, patchText) {
  const hunks = parseUnifiedPatch(patchText);
  const out = [];
  let cursor = 0;
  let applied = 0;
  let rejected = 0;
  /** 第一块对不上的 hunk 下标（-1 表示全部通过或没有块） */
  let rejectedIndex = -1;
  hunks.forEach((h, index) => {
    const at = h.aStart;
    if (at < cursor || at > originalLines.length) {
      rejected++;
      if (rejectedIndex < 0) rejectedIndex = index;
      return;
    }
    // 上下文校验：hunk 的原始侧必须与文件对应位置完全一致
    const expect = h.aLines;
    let ok = at + expect.length <= originalLines.length;
    if (ok) {
      for (let i = 0; i < expect.length; i++) {
        if (!sameLine(originalLines[at + i], expect[i])) { ok = false; break; }
      }
    }
    if (!ok) {
      rejected++;
      if (rejectedIndex < 0) rejectedIndex = index;
      return;
    }
    out.push(...originalLines.slice(cursor, at));
    out.push(...h.bLines.map((ln) => (typeof ln === 'string' ? ln : ln.body)));
    cursor = at + expect.length;
    applied++;
  });
  out.push(...originalLines.slice(cursor));
  return { lines: out, applied, rejected, rejectedIndex, total: hunks.length };
}

/** 生成两份数据（行数组）的补丁，供文本 / 表格 / 十六进制视图共用。 */
export function buildPatch(aLines, bLines, opts = {}) {
  const diffLines = buildDiffLines(aLines, bLines, opts.equals);
  return {
    diffLines,
    patch: toUnifiedPatch(diffLines, opts),
    changed: diffLines.filter((r) => r.kind !== 'same').length,
  };
}

/**
 * 差异报告（HTML / 纯文本）。
 *
 * @param {{title:string, leftName:string, rightName:string,
 *          sections:Array<{title:string, rows:Array<{status:string, left:string, right:string}>}>}} model
 */
export function buildReport(model, format = 'html') {
  const esc = (s) => String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  const sections = model.sections ?? [];

  if (format === 'text') {
    const out = [];
    out.push(model.title || 'DiffStudio');
    out.push('='.repeat(60));
    for (const sec of sections) {
      out.push('');
      out.push('## ' + (sec.title || ''));
      out.push('-'.repeat(60));
      for (const r of sec.rows) {
        if (r.status === 'same') continue;
        out.push(`[${r.status}] ${r.left ?? ''}  |  ${r.right ?? ''}`);
      }
    }
    return out.join('\n') + '\n';
  }

  const rows = [];
  for (const sec of sections) {
    const changed = sec.rows.filter((r) => r.status !== 'same');
    rows.push(
      `<h2>${esc(sec.title)} <small style="color:#666;font-weight:normal">(${changed.length} / ${sec.rows.length})</small></h2>`,
    );
    if (!changed.length) {
      rows.push('<p style="color:#888">无差异</p>');
      continue;
    }
    rows.push('<table>');
    for (const r of changed) {
      const cls = r.status === 'left' ? 'l' : r.status === 'right' ? 'r' : 'c';
      rows.push(
        `<tr class="${cls}"><td class="s">${esc(r.status)}</td><td>${esc(r.left)}</td><td>${esc(r.right)}</td></tr>`,
      );
    }
    rows.push('</table>');
  }
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(model.title || 'DiffStudio')}</title>
<style>
 body{font:13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;margin:24px;color:#222}
 h1{font-size:18px;margin:0 0 4px} h2{font-size:14px;margin:24px 0 8px}
 .meta{color:#666;margin-bottom:16px}
 table{border-collapse:collapse;width:100%;font-family:Consolas,monospace;font-size:12px}
 td{border:1px solid #e3e6ea;padding:3px 6px;vertical-align:top;white-space:pre-wrap;word-break:break-all}
 td.s{width:70px;color:#666;background:#f6f8fa}
 tr.l td:nth-child(2){background:#ffecec} tr.r td:nth-child(3){background:#eaffea}
 tr.c td:nth-child(2),tr.c td:nth-child(3){background:#fff8dd}
</style></head><body>
<h1>${esc(model.title || 'DiffStudio')}</h1>
<div class="meta">${esc(model.leftName ?? '')} &nbsp;↔&nbsp; ${esc(model.rightName ?? '')}<br>${esc(model.generated ?? '')}</div>
${rows.join('\n')}
</body></html>`;
}
