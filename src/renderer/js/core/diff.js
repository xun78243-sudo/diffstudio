/**
 * Core diff engine.
 *
 * Implements the Myers O(ND) greedy diff algorithm for line/row sequences,
 * which is the same "Myers O(ND) alignment" algorithm referenced inside
 * Beyond Compare's binary. It produces an edit script (insert / delete /
 * equal) that is then converted into per-line "diff types" matching
 * Beyond Compare's vocabulary:
 *
 *   same    - present and identical on both sides
 *   left    - "left orphan" (only on left, was deleted)
 *   right   - "right orphan" (only on right, was inserted)
 *   change  - a run of left/right lines that naturally pair as "modified"
 *   conflict- (merge only) both versions changed the same region differently
 *
 * 行元素既可以是字符串，也可以是 { body, eol } 对象（由 splitLines 生成，
 * body 不含换行符，eol 记录该行自己的换行风格）。
 */

export const EDIT = Object.freeze({
  EQ: 0, // equal
  DEL: 1, // delete (exists on left only)
  INS: 2, // insert (exists on right only)
});

const bodyOf = (x) => (x !== null && typeof x === 'object' ? x.body : x);
const defaultEq = (x, y) => bodyOf(x) === bodyOf(y);

/**
 * 按行对齐后统计「显示行」的差异数量（BC 风格）：
 * 相同的行不计，仅左侧 / 仅右侧各计 1，修改计 1。
 */
export function countChangedRows(diffLines) {
  return diffLines.reduce((n, d) => n + (d.kind === 'same' ? 0 : 1), 0);
}

/**
 * Classic Myers O(ND) shortest edit script (forward greedy + trace).
 * Prefix/suffix trimming keeps the common "mostly equal" case fast.
 * Returns array of { type, aIdx, bIdx } ops in document order.
 *
 * 注意：`equals` 必须是纯函数——同一对元素会被比较多次（前后缀裁剪、
 * 搜索、回溯）。需要统计行尾符差异时用 `makeEquality()` 工厂。
 */
export function myersDiff(a, b, equals = defaultEq) {
  const N = a.length;
  const M = b.length;
  const MAX = N + M;
  if (MAX === 0) return [];

  // --- trim common prefix/suffix ---
  let start = 0;
  while (start < N && start < M && equals(a[start], b[start])) start++;
  let endN = N;
  let endM = M;
  while (endN > start && endM > start && equals(a[endN - 1], b[endM - 1])) {
    endN--;
    endM--;
  }

  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ type: EDIT.EQ, aIdx: i, bIdx: i });

  const n = endN - start;
  const m = endM - start;

  const middle = computeEditScript(a, b, start, start, n, m, equals);
  ops.push(...middle);

  // 公共后缀：a 的下标从 endN 起，b 的下标从 endM 起。
  // 两侧长度可能不同，不能用同一个 i 同时充当两个下标。
  const suffix = N - endN;
  for (let k = 0; k < suffix; k++) {
    ops.push({ type: EDIT.EQ, aIdx: endN + k, bIdx: endM + k });
  }
  return ops;
}

/**
 * Myers O(ND) 最短编辑脚本：前向搜索 + 回溯。
 *
 * 实现要点：第 d 轮搜索结束后，把「该轮开始前的 V」整份存入 trace。
 * 回溯时用 trace[d] 判断第 d 轮是从哪条对角线走来的，再沿着对角线
 * 把相等的部分补回脚本。aIdx / bIdx 都必须加上对应的偏移量。
 *
 * 返回 { type, aIdx, bIdx } 数组，按文档顺序排列。
 *
 * 复杂度保护：贪心 Myers 的时间/内存是 O(D × (N+M))，两个完全不同的
 * 文件（D = N+M）在 1 万行量级会卡住渲染进程数秒。超过 MAX_EDIT_BUDGET
 * 时退回「按位置配对」：结果是合法的编辑脚本（内容完全一致），只是不再
 * 保证最短，界面上表现为整块"修改"而不是零散的增删。
 */
const MAX_EDIT_BUDGET = 4_000_000;

function computeEditScript(a, b, aOffset, bOffset, n, m, equals) {
  if (n === 0 && m === 0) return [];
  if (n === 0) {
    const ops = [];
    for (let j = 0; j < m; j++) ops.push({ type: EDIT.INS, aIdx: -1, bIdx: bOffset + j });
    return ops;
  }
  if (m === 0) {
    const ops = [];
    for (let i = 0; i < n; i++) ops.push({ type: EDIT.DEL, aIdx: aOffset + i, bIdx: -1 });
    return ops;
  }
  // 上界：Dmax × (N+M) 超过预算就不做完整搜索。
  if (n * m > MAX_EDIT_BUDGET && (n + m) * (n + m) > MAX_EDIT_BUDGET) {
    return positionalScript(aOffset, bOffset, n, m);
  }

  const max = n + m;
  const offset = max + 1;
  const size = 2 * max + 3;

  // V 以 offset + k 索引存放对角线 k 上的最远 x
  let V = new Int32Array(size);
  V[offset + 1] = 0;
  const trace = [];

  let foundD = -1;
  for (let d = 0; d <= max && foundD < 0; d++) {
    trace.push(V.slice()); // 第 d 轮开始前的状态
    const next = V.slice();
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && V[offset + k - 1] < V[offset + k + 1])) {
        x = V[offset + k + 1]; // 向下：插入
      } else {
        x = V[offset + k - 1] + 1; // 向右：删除
      }
      let y = x - k;
      while (x < n && y < m && equals(a[aOffset + x], b[bOffset + y])) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
    V = next;
  }

  const ops = [];
  let x = n;
  let y = m;

  for (let d = foundD; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;

    let prevK;
    if (k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;

    // 先回退对角线上的相等部分
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ type: EDIT.EQ, aIdx: aOffset + x, bIdx: bOffset + y });
    }
    if (x === prevX) {
      y--;
      ops.push({ type: EDIT.INS, aIdx: -1, bIdx: bOffset + y });
    } else {
      x--;
      ops.push({ type: EDIT.DEL, aIdx: aOffset + x, bIdx: -1 });
    }
  }

  // 第 0 轮只可能来自左上角：沿对角线补齐
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ type: EDIT.EQ, aIdx: aOffset + x, bIdx: bOffset + y });
  }
  while (x > 0) {
    x--;
    ops.push({ type: EDIT.DEL, aIdx: aOffset + x, bIdx: -1 });
  }
  while (y > 0) {
    y--;
    ops.push({ type: EDIT.INS, aIdx: -1, bIdx: bOffset + y });
  }

  return ops.reverse();
}

/**
 * 降级脚本：按位置逐行配对（同一位置的行既不保证相等，也不做内容判断），
 * 一侧多出来的部分作为删除 / 插入。
 *
 * 用途仅限「编辑距离过大、完整搜索会卡住界面」的兜底场景，仍然保证
 * 应用脚本后能正确还原目标序列。界面上表现为整块"修改"。
 */
function positionalScript(aOffset, bOffset, n, m) {
  const ops = [];
  const len = Math.min(n, m);
  let k = 0;
  for (; k < len; k++) ops.push({ type: EDIT.EQ, aIdx: aOffset + k, bIdx: bOffset + k });
  for (; k < n; k++) ops.push({ type: EDIT.DEL, aIdx: aOffset + k, bIdx: -1 });
  for (; k < m; k++) ops.push({ type: EDIT.INS, aIdx: -1, bIdx: bOffset + k });
  return ops;
}

/**
 * 「按内容相等」的比较函数工厂。
 * 每当判定一对行相等时，记录两侧各自使用的行尾符，用于提示
 * "内容相同但换行风格不同"。结果通过返回函数的 `.eol` 读取。
 */
export function makeEquality() {
  const eol = { left: new Set(), right: new Set() };
  const fn = (x, y) => {
    if (bodyOf(x) !== bodyOf(y)) return false;
    eol.left.add(x.eol ?? '');
    eol.right.add(y.eol ?? '');
    return true;
  };
  fn.eol = eol;
  return fn;
}

/**
 * Convert a flat edit script into grouped "diff lines" with Beyond Compare
 * semantics. Consecutive non-equal ops are gathered into a single block:
 *  - 块内既有删除又有插入 => 逐行配对为 "change"；
 *  - 只有一侧 => "left" / "right" 孤立行。
 *
 * 配对数量不等时，先用 LCS 找出一侧本来就存在、未被改动的行作为锚点，
 * 锚点记为 "same"，剩余行再按顺序配对。这样可以避免
 * left=[old] / right=[n1, n2] 被硬配成 "change + 新增" 的伪结果。
 */
export function buildDiffLines(a, b, equals) {
  const cmp = equals || defaultEq;
  const ops = myersDiff(a, b, cmp);
  const lines = [];

  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === EDIT.EQ) {
      lines.push(makeRow('same', a[op.aIdx], b[op.bIdx], op.aIdx, op.bIdx));
      i++;
      continue;
    }

    const dels = [];
    const inss = [];
    while (i < ops.length && ops[i].type !== EDIT.EQ) {
      const o = ops[i];
      if (o.type === EDIT.DEL) dels.push({ idx: o.aIdx, item: a[o.aIdx] });
      else inss.push({ idx: o.bIdx, item: b[o.bIdx] });
      i++;
    }

    if (dels.length > 0 && inss.length > 0) {
      for (const row of pairChange(dels, inss, cmp)) lines.push(row);
    } else if (dels.length > 0) {
      for (const d of dels) {
        lines.push({ kind: 'left', aIdx: d.idx, bIdx: -1, a: bodyOf(d.item), b: undefined, aLine: d.item, bLine: null });
      }
    } else {
      for (const ins of inss) {
        lines.push({ kind: 'right', aIdx: -1, bIdx: ins.idx, a: undefined, b: bodyOf(ins.item), aLine: null, bLine: ins.item });
      }
    }
  }

  return lines;
}

function makeRow(kind, aItem, bItem, aIdx, bIdx) {
  return {
    kind,
    aIdx,
    bIdx,
    a: aItem === undefined ? undefined : bodyOf(aItem),
    b: bItem === undefined ? undefined : bodyOf(bItem),
    aLine: aItem ?? null,
    bLine: bItem ?? null,
  };
}

/** 在一个改动块内配对左右两侧的行，返回按显示顺序排列的行记录。 */
function pairChange(dels, inss, cmp) {
  const out = [];
  // 左侧 / 右侧各用一个游标，按锚点分段推进
  const left = dels;
  const right = inss;
  let li = 0;
  let ri = 0;

  const emitPair = () => {
    const row = makeRow('change', left[li].item, right[ri].item, left[li].idx, right[ri].idx);
    row.removed = { aIdx: left[li].idx, text: bodyOf(left[li].item) };
    row.added = { bIdx: right[ri].idx, text: bodyOf(right[ri].item) };
    out.push(row);
    li++;
    ri++;
  };

  // 数量相等时直接按顺序配对
  if (left.length === right.length) {
    while (li < left.length) emitPair();
    return out;
  }

  // 数量不等：在两侧之间求 LCS，找到"本来就存在、未被改动"的行作为锚点。
  const anchors = myersDiff(left.map((x) => x.item), right.map((x) => x.item), cmp)
    .filter((o) => o.type === EDIT.EQ);

  for (const anchor of anchors) {
    // 锚点之前：能成对的先配对，一侧多出来的单独成行（放在锚点之前）
    while (li < anchor.aIdx && ri < anchor.bIdx) emitPair();
    while (li < anchor.aIdx) { out.push(orphanRow(left[li], true)); li++; }
    while (ri < anchor.bIdx) { out.push(orphanRow(right[ri], false)); ri++; }

    // 锚点本身两侧一致，保持为 same
    out.push(makeRow('same', left[li].item, right[ri].item, left[li].idx, right[ri].idx));
    li++;
    ri++;
  }

  // 尾部：同样的规则
  while (li < left.length && ri < right.length) emitPair();
  while (li < left.length) { out.push(orphanRow(left[li], true)); li++; }
  while (ri < right.length) { out.push(orphanRow(right[ri], false)); ri++; }
  return out;
}

/** 只在左或只在右的孤立行。`onLeft` 表示该行属于左侧。 */
function orphanRow(entry, onLeft) {
  return {
    kind: onLeft ? 'left' : 'right',
    aIdx: onLeft ? entry.idx : -1,
    bIdx: onLeft ? -1 : entry.idx,
    a: onLeft ? bodyOf(entry.item) : undefined,
    b: onLeft ? undefined : bodyOf(entry.item),
    aLine: onLeft ? entry.item : null,
    bLine: onLeft ? null : entry.item,
  };
}

/**
 * Three-way merge (diff3) using a common ancestor.
 *
 * Converts the two diffs (base->left and base->right) into hunk lists
 * located by base position, then walks them in order. Each output row has
 * Beyond Compare merge semantics:
 *   same         - unchanged everywhere, or both sides changed identically
 *   leftChanged  - only the left side touched this region
 *   rightChanged - only the right side touched this region
 *   conflict     - both sides changed the same/overlapping region differently
 *
 * 返回 { rows, conflictCount }。rows 中每行都带 `original`（该行来源的原始
 * 行对象），界面据此还原正确的换行符；`hunkId` 用于把同一改动块的多行
 * 作为一个整体处理。
 */
export function threeWayMerge(base, left, right, equals) {
  const cmp = equals || defaultEq;

  const toHunks = (from, to) => {
    const ops = myersDiff(from, to, cmp);
    const hunks = [];
    let b = 0;
    let i = 0;
    while (i < ops.length) {
      const op = ops[i];
      if (op.type === EDIT.EQ) {
        b++;
        i++;
        continue;
      }
      const baseStart = b;
      const lines = [];
      while (i < ops.length && ops[i].type !== EDIT.EQ) {
        if (ops[i].type === EDIT.DEL) b++;
        else lines.push(to[ops[i].bIdx]);
        i++;
      }
      hunks.push({ baseStart, baseLen: b - baseStart, lines });
    }
    return hunks;
  };

  const linesEqual = (x, y) => x.length === y.length && x.every((ln, k) => cmp(ln, y[k]));

  const leftHunks = toHunks(base, left);
  const rightHunks = toHunks(base, right);

  const rows = [];
  let conflictCount = 0;
  let seq = 0;
  for (const h of [...leftHunks, ...rightHunks]) h.id = 'h' + ++seq;

  const pushSame = (k) => {
    const b = bodyOf(base[k]);
    rows.push({ state: 'same', base: b, left: b, right: b, original: base[k] });
  };

  // 纯插入（baseLen === 0）落在 baseStart 这个间隙上，视为点区间 P{baseStart}
  // 以与同位置的另一侧插入判定重叠。
  const span = (h) => (h.baseLen === 0 ? [h.baseStart, h.baseStart + 1] : [h.baseStart, h.baseStart + h.baseLen]);
  const overlaps = (p, q) => span(p)[0] < span(q)[1] && span(q)[0] < span(p)[1];

  let bi = 0;
  let i = 0;
  let j = 0;

  while (i < leftHunks.length || j < rightHunks.length) {
    const hL = i < leftHunks.length ? leftHunks[i] : null;
    const hR = j < rightHunks.length ? rightHunks[j] : null;

    if (hL && hR && overlaps(hL, hR)) {
      while (bi < Math.max(hL.baseStart, hR.baseStart)) pushSame(bi++);

      if (linesEqual(hL.lines, hR.lines)) {
        for (const ln of hL.lines) {
          const t = bodyOf(ln);
          rows.push({ state: 'same', base: undefined, left: t, right: t, original: ln, hunkId: hL.id });
        }
      } else {
        conflictCount++;
        const n = Math.max(hL.lines.length, hR.lines.length);
        for (let k = 0; k < n; k++) {
          const aLn = hL.lines[k];
          const bLn = hR.lines[k];
          const baseIdx = hL.baseStart + k;
          rows.push({
            state: 'conflict',
            base: baseIdx < base.length ? bodyOf(base[baseIdx]) : undefined,
            left: aLn === undefined ? undefined : bodyOf(aLn),
            right: bLn === undefined ? undefined : bodyOf(bLn),
            original: aLn !== undefined ? aLn : bLn,
            hunkId: hL.id,
          });
        }
      }
      bi = Math.max(bi, hL.baseStart + hL.baseLen, hR.baseStart + hR.baseLen);
      i++;
      j++;
    } else if (hL && (!hR || hL.baseStart <= hR.baseStart)) {
      while (bi < hL.baseStart) pushSame(bi++);
      for (const ln of hL.lines) {
        rows.push({ state: 'leftChanged', base: undefined, left: bodyOf(ln), right: undefined, original: ln, hunkId: hL.id });
      }
      bi = Math.max(bi, hL.baseStart + hL.baseLen);
      i++;
    } else {
      while (bi < hR.baseStart) pushSame(bi++);
      for (const ln of hR.lines) {
        rows.push({ state: 'rightChanged', base: undefined, left: undefined, right: bodyOf(ln), original: ln, hunkId: hR.id });
      }
      bi = Math.max(bi, hR.baseStart + hR.baseLen);
      j++;
    }
  }
  while (bi < base.length) pushSame(bi++);

  return { rows, conflictCount };
}

/**
 * Simple whole-file hash for quick equality checks.
 */
export function simpleHash(arr) {
  let h = 5381;
  for (let i = 0; i < arr.length; i++) {
    h = ((h << 5) + h + arr[i]) & 0x7fffffff;
  }
  return h >>> 0;
}
