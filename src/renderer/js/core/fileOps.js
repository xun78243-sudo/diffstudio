/**
 * 文件操作计划（重命名 / 移动 / 新建文件夹 / Touch）。
 *
 * 这里只负责"该做什么"的纯逻辑：校验、目标路径推导、冲突检测，
 * 真正的 IO 由视图通过 IPC 执行。这样误操作可以在执行前被拦下，
 * 也可以在没有文件系统的情况下单测。
 */

/** 路径分隔符沿用基准路径：Windows 用 `\`，其余用 `/`。 */
function sepOf(base) {
  return String(base).includes('\\') ? '\\' : '/';
}

function stripTrailing(p) {
  return String(p).replace(/[\\/]+$/, '');
}

function join(base, rel) {
  const sep = sepOf(base);
  return stripTrailing(base) + sep + String(rel).replace(/[\\/]+/g, sep);
}

function baseName(p) {
  const parts = stripTrailing(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function dirName(p) {
  const s = stripTrailing(p);
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i <= 0 ? s : s.slice(0, i);
}

/** 校验单个文件名：不能为空、不能含分隔符、不能是 . / ..、不能含非法字符。 */
export function validateName(name) {
  const n = String(name ?? '').trim();
  if (!n) return { ok: false, reason: 'empty' };
  if (n === '.' || n === '..') return { ok: false, reason: 'reserved' };
  if (/[\\/:*?"<>|]/.test(n)) return { ok: false, reason: 'illegal' };
  // Windows 不允许以空格或点结尾。
  if (/[ .]$/.test(n)) return { ok: false, reason: 'trailingDotSpace' };
  return { ok: true, name: n };
}

/**
 * 把 fs:list-dir 的条目转成小写名字集合，用于同目录查重。
 * 大小写不敏感：Windows 文件系统本来就大小写不敏感，宁可拒绝也不覆盖。
 */
export function existingNames(entries) {
  const set = new Set();
  for (const e of entries || []) {
    const n = typeof e === 'string' ? e : e.name;
    if (n) set.add(String(n).toLowerCase());
  }
  return set;
}

/**
 * 计划一次重命名。
 *
 * @param {string} dir  条目所在目录
 * @param {string} oldName 原文件名
 * @param {string} newName 新文件名
 * @param {Set<string>} taken 该目录现有名字（小写），含 oldName
 */
export function planRename(dir, oldName, newName, taken) {
  const v = validateName(newName);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (v.name === oldName) return { ok: true, from: join(dir, oldName), to: join(dir, oldName), noop: true };
  if (taken && taken.has(v.name.toLowerCase())) return { ok: false, reason: 'exists' };
  return { ok: true, from: join(dir, oldName), to: join(dir, v.name), name: v.name };
}

/**
 * 计划把条目移动到目标目录。
 * 移动到自身所在目录视为无操作；目标目录里已有同名条目则拒绝。
 */
export function planMove(srcDir, name, destDir, destTaken) {
  const same = stripTrailing(srcDir).toLowerCase() === stripTrailing(destDir).toLowerCase();
  if (same) return { ok: true, from: join(srcDir, name), to: join(srcDir, name), noop: true };
  if (destTaken && destTaken.has(String(name).toLowerCase())) return { ok: false, reason: 'exists' };
  return { ok: true, from: join(srcDir, name), to: join(destDir, name), name };
}

/** 计划新建文件夹：名称必须合法且同目录不重名。 */
export function planNewFolder(dir, name, taken) {
  const v = validateName(name);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (taken && taken.has(v.name.toLowerCase())) return { ok: false, reason: 'exists' };
  return { ok: true, path: join(dir, v.name), name: v.name };
}

/**
 * 解析 Touch 的时间输入。
 *
 * 支持：
 *  - 空串        → 使用当前时间
 *  - `+1h` / `-30m` / `+2d`（h/m/s/d/w）
 *  - ISO 日期 `2026-10-20` 或 `2026-10-20T12:34:56`
 * 返回毫秒时间戳；无法解析返回 null。
 */
export function parseTouchTime(input, now = Date.now()) {
  const s = String(input ?? '').trim();
  if (!s) return now;
  const rel = /^([+-])\s*(\d+(?:\.\d+)?)\s*([smhdw])$/i.exec(s);
  if (rel) {
    const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[rel[3].toLowerCase()];
    const sign = rel[1] === '-' ? -1 : 1;
    return now + sign * parseFloat(rel[2]) * unit;
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

export { join as joinPath, baseName, dirName };
