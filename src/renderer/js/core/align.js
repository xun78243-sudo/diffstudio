/**
 * 手动对齐（Align With）的行重排。
 *
 * Beyond Compare 的文本比较里，两侧的行由算法自动配对；如果算法把不该配对
 * 的行凑到了一起，用户可以手动指定「左第 i 行 与 右第 j 行对齐」，程序再
 * 以这一对为锚点，把两侧重新配对。
 *
 * 重新配对必须与自动比较使用同一套规则，否则手动指定一个锚点后，其余位置
 * 的配对方式会突然改变（行号错位、差异块数量跳变）。因此这里直接复用
 * buildDiffLines：把两侧行数组在锚点处切成若干段，逐段比较后拼接。
 */

import { buildDiffLines } from './diff.js';

/** 行条目（{ body, eol }）取正文；已经是字符串时原样返回。 */
function bodyOf(item) {
  return item !== null && typeof item === 'object' ? item.body : item;
}

/**
 * @param {string[]} leftLines
 * @param {string[]} rightLines
 * @param {Array<{aIdx:number,bIdx:number}>} anchors 以 0 为起点的行号，升序
 * @param {(a:string,b:string)=>boolean} [equals]
 * @returns {Array} 与 buildDiffLines 相同结构的行记录
 */
export function realignWithAnchors(leftLines, rightLines, anchors, equals) {
  const valid = [...anchors]
    .filter((x) => Number.isInteger(x.aIdx) && Number.isInteger(x.bIdx))
    .sort((x, y) => x.aIdx - y.aIdx);

  const rows = [];
  let aCur = 0;
  let bCur = 0;

  for (const anc of valid) {
    // 越界或顺序倒退的锚点直接跳过（界面可能因重排后索引失效）
    if (anc.aIdx < aCur || anc.bIdx < bCur) continue;
    if (anc.aIdx >= leftLines.length || anc.bIdx >= rightLines.length) continue;

    const aSeg = leftLines.slice(aCur, anc.aIdx);
    const bSeg = rightLines.slice(bCur, anc.bIdx);
    const seg = buildDiffLines(aSeg, bSeg, equals);
    // 段内行号是相对段首的，补上偏移量
    for (const r of seg) {
      if (r.aIdx != null && r.aIdx >= 0) r.aIdx += aCur;
      if (r.bIdx != null && r.bIdx >= 0) r.bIdx += bCur;
    }
    rows.push(...seg);

    // 锚点本身：两侧文本一致则标成 same，否则强制作为一对差异。
    // 行记录必须与 buildDiffLines 同形：渲染器、编辑与保存都只认
    // `a`/`b` 正文和 `aLine`/`bLine` 的 `{ body, eol }` 条目。
    const aRaw = leftLines[anc.aIdx];
    const bRaw = rightLines[anc.bIdx];
    const same = equals ? equals(aRaw, bRaw) : bodyOf(aRaw) === bodyOf(bRaw);
    rows.push({
      kind: same ? 'same' : 'change',
      aIdx: anc.aIdx,
      bIdx: anc.bIdx,
      a: bodyOf(aRaw),
      b: bodyOf(bRaw),
      aLine: aRaw ?? null,
      bLine: bRaw ?? null,
      aligned: true,
    });
    aCur = anc.aIdx + 1;
    bCur = anc.bIdx + 1;
  }

  const seg = buildDiffLines(leftLines.slice(aCur), rightLines.slice(bCur), equals);
  for (const r of seg) {
    if (r.aIdx != null && r.aIdx >= 0) r.aIdx += aCur;
    if (r.bIdx != null && r.bIdx >= 0) r.bIdx += bCur;
  }
  rows.push(...seg);
  return rows;
}
