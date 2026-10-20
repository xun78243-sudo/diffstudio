/**
 * 文件夹三路合并：base / left / right 三个目录树取并集，按文件平面分类。
 *
 * 判定沿用文本三路合并的思路：
 *  - 只有一侧改了 → 取改动的一侧（auto）
 *  - 两侧改成一样 → 取任一侧（auto-same）
 *  - 两侧改得不一样 / 一侧删一侧改 → 冲突（conflict）
 *
 * 只做纯数据计算，执行复制由视图负责。
 */

/** 相对路径 → 条目的 Map。条目至少含 { rel, type, size, mtimeMs }。 */
export function toPlane(entries) {
  const map = new Map();
  for (const e of entries || []) {
    if (e.type === 'dir') continue;
    map.set(e.rel, e);
  }
  return map;
}

/** 两个条目是否"未改动"：大小相同且时间戳在一秒内（与文件夹比较的容差一致）。 */
export function sameEntry(a, b) {
  if (!a || !b) return false;
  if (a.size !== b.size) return false;
  return Math.abs((a.mtimeMs || 0) - (b.mtimeMs || 0)) < 1000;
}

/**
 * 分类一个相对路径在三方中的状态。
 *
 * @returns {{rel: string, state: string, take: 'left'|'right'|null}}
 *   state: same | left-only | right-only | left-changed | right-changed |
 *          both-changed-same | conflict
 */
export function classifyThreeWay(rel, B, L, R) {
  const inB = !!B;
  const inL = !!L;
  const inR = !!R;

  // 三方都没有（只可能是目录），由调用方过滤。
  if (!inB && !inL && !inR) return { rel, state: 'same', take: null };

  const leftSameBase = inB && inL ? sameEntry(B, L) : !inB && !inL;
  const rightSameBase = inB && inR ? sameEntry(B, R) : !inB && !inR;

  if (leftSameBase && rightSameBase) {
    // 两侧都没动。若两侧都不存在而 base 存在 → 两侧都删了，也是"一致"。
    return { rel, state: 'same', take: null };
  }

  if (leftSameBase) {
    // 只有右侧变了。
    if (!inR) return { rel, state: 'right-deleted', take: 'right', deleted: true };
    if (!inB && !inL && inR) return { rel, state: 'right-only', take: 'right' };
    return { rel, state: inL ? 'right-changed' : 'right-added', take: 'right' };
  }

  if (rightSameBase) {
    if (!inL) return { rel, state: 'left-deleted', take: 'left', deleted: true };
    if (!inB && !inR && inL) return { rel, state: 'left-only', take: 'left' };
    return { rel, state: inR ? 'left-changed' : 'left-added', take: 'left' };
  }

  // 两侧都变了：内容一致则自动，否则冲突。
  if (inL && inR && sameEntry(L, R)) return { rel, state: 'both-changed-same', take: 'left' };
  return { rel, state: 'conflict', take: null };
}

/**
 * 对三方平面求并集并分类。
 *
 * @param {Array} baseEntries / leftEntries / rightEntries  walkDir 的结果数组
 * @returns {{rows: Array<{rel, base, left, right, state, take}>, summary: object}}
 */
export function mergePlanes(baseEntries, leftEntries, rightEntries) {
  const B = toPlane(baseEntries);
  const L = toPlane(leftEntries);
  const R = toPlane(rightEntries);
  const rels = [...new Set([...B.keys(), ...L.keys(), ...R.keys()])].sort((a, b) => a.localeCompare(b));
  const rows = [];
  const summary = {
    total: 0, same: 0, auto: 0, conflict: 0, leftOnly: 0, rightOnly: 0, deleted: 0,
  };
  for (const rel of rels) {
    const c = classifyThreeWay(rel, B.get(rel), L.get(rel), R.get(rel));
    const row = { rel, base: B.get(rel) || null, left: L.get(rel) || null, right: R.get(rel) || null, ...c };
    rows.push(row);
    summary.total++;
    if (c.state === 'same') summary.same++;
    else if (c.state === 'conflict') summary.conflict++;
    else if (c.deleted) summary.deleted++;
    else summary.auto++;
    if (c.state === 'left-only' || c.state === 'left-added') summary.leftOnly++;
    if (c.state === 'right-only' || c.state === 'right-added') summary.rightOnly++;
  }
  return { rows, summary };
}

/**
 * 由合并结果生成目标侧的写操作列表（复制或删除）。
 * 冲突行默认跳过，需要用户单独决定。
 */
export function planThreeWay(rows, target = 'left') {
  const ops = [];
  for (const row of rows) {
    if (!row.take || row.state === 'same') continue;
    const src = row.take === 'left' ? row.left : row.right;
    const destSide = target === 'left' ? row.left : row.right;
    if (row.deleted) {
      // 删除操作：目标侧存在才删。
      if (destSide) ops.push({ action: 'delete', rel: row.rel });
      continue;
    }
    if (!src) continue;
    ops.push({ action: 'copy', rel: row.rel, from: row.take, size: src.size });
  }
  return ops;
}
