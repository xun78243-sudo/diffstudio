/**
 * 重要 / 不重要规则（Beyond Compare 的 Unimportant text）。
 *
 * BC 的语义是：命中的文本不参与比较，因此"只在这些文本上不同"的差异
 * 会被降级为"不重要差异"——仍然可见，但不再计入差异数、也不会被
 * 差异导航跳到，导出补丁时可选择忽略。
 *
 * 这里采用"后处理"实现：先照常算 diff，再判断每一处差异是否"只是不重要文本造成的"，
 * 是就标成 kind = 'unimportant'。这样不需要改动 Myers 引擎，规则随时可以开关。
 */

/** 把规则文本转成正则；每行 / 每个分号分隔项各算一条规则。 */
export function compileRules(text, opts = {}) {
  const src = String(text ?? '');
  const parts = src.split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean);
  const flags = 'g' + (opts.caseSensitive ? '' : 'i');
  const rules = [];
  for (const p of parts) {
    try {
      rules.push({ source: p, re: new RegExp(opts.literal ? escapeRegExp(p) : p, flags) });
    } catch (err) {
      return { ok: false, reason: 'invalid', source: p, rules };
    }
  }
  return { ok: true, rules };
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 去掉命中规则的部分，返回剩余文本；没有规则命中时返回原文本。 */
export function stripUnimportant(text, rules) {
  let s = String(text ?? '');
  if (!rules || !rules.length) return s;
  for (const r of rules) {
    r.re.lastIndex = 0;
    s = s.replace(r.re, '');
  }
  return s;
}

/**
 * 判断一对差异行是否"只在不重要文本上不同"。
 *
 * @param {{left?: string, right?: string}} pair
 * @param {Array} rules compileRules 的结果
 */
export function isUnimportantPair(pair, rules) {
  if (!rules || !rules.length) return false;
  const left = String(pair.left ?? '');
  const right = String(pair.right ?? '');
  // 完全相同不是"差异"，谈不上重要与否。
  if (left === right) return false;
  const l = stripUnimportant(left, rules);
  const r = stripUnimportant(right, rules);
  // 去掉后相等 = 差异确实只来自不重要文本。
  if (l !== r) return false;
  // 必须至少有一侧真的被规则命中过，否则只是原本就没有差异。
  return l !== left || r !== right;
}

/**
 * 对 buildDiffLines 的输出做后处理，把"只在不重要文本上不同"的行标成 unimportant。
 *
 * 规则：
 *  - `change` 行：两侧文本去掉不重要部分后相同 → unimportant
 *  - `left` / `right` 孤立行：该行去掉不重要部分后为空 → unimportant
 *    （例如整行就是一段被忽略的时间戳）
 *
 * 返回新数组，不修改入参。
 */
export function markUnimportant(diffLines, rules) {
  if (!rules || !rules.length) return diffLines;
  return diffLines.map((row) => {
    if (row.kind === 'same') return row;
    const left = row.a ?? '';
    const right = row.b ?? '';
    if (row.kind === 'change') {
      return isUnimportantPair({ left, right }, rules) ? { ...row, kind: 'unimportant' } : row;
    }
    // 孤立行：去掉不重要文本后没有任何实质内容。
    const only = String(row.kind === 'left' ? left : right);
    const stripped = stripUnimportant(only, rules);
    if (stripped !== only && stripped.trim() === '') {
      return { ...row, kind: 'unimportant' };
    }
    return row;
  });
}

/** 统计 unimportant 行数（用于状态栏提示）。 */
export function countUnimportant(diffLines) {
  return (diffLines || []).filter((r) => r.kind === 'unimportant').length;
}

/**
 * 生成文件夹比较用的"不重要文件"判定：按相对路径匹配规则。
 * 命中即视为不重要（BC 里对应"不重要文件"筛选）。
 */
export function isUnimportantPath(rel, rules) {
  if (!rules || !rules.length) return false;
  for (const r of rules) {
    r.re.lastIndex = 0;
    if (r.re.test(String(rel))) return true;
  }
  return false;
}
