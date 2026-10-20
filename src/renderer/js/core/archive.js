/**
 * 压缩包只读解析（ZIP / TAR / GZIP），用于"把压缩包当文件夹比较"。
 *
 * 不引入第三方依赖：BC 用内嵌 7-Zip，本程序只覆盖最常见的三种格式。
 * 解析结果是纯数据 `{ entries }`，可以直接送进文件夹比较的树逻辑。
 *
 * 安全性：条目路径一律按 POSIX 相对路径规范化，`..` 与绝对路径会被拒绝，
 * 这样后续"解压到临时目录"时不可能写到目录外面（zip-slip）。
 */

const HAS_DEFLATE = typeof DecompressionStream !== 'undefined';

/** 把压缩包内路径规范化为 `a/b/c`；不安全返回 null。 */
export function normalizeEntryPath(raw) {
  const s = String(raw ?? '').replace(/\\/g, '/');
  if (!s) return null;
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null;
  const parts = [];
  for (const p of s.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') return null;
    parts.push(p);
  }
  if (!parts.length) return null;
  return parts.join('/');
}

function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes && bytes.type === 'Buffer' && Array.isArray(bytes.data)) return Uint8Array.from(bytes.data);
  return Uint8Array.from(bytes || []);
}

function utf8(u8) {
  return new TextDecoder('utf-8').decode(u8);
}

function cstr(buf, off, len) {
  let end = off;
  const max = off + len;
  while (end < max && buf[end] !== 0) end++;
  return utf8(buf.subarray(off, end));
}

/** 识别格式：先看魔数，再看扩展名。 */
export function detectArchiveFormat(name, bytes) {
  const b = toU8(bytes);
  const lower = String(name || '').toLowerCase();
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  // TAR 的魔数在偏移 257；有些 tar 没有，退回扩展名。
  if (b.length >= 262 && cstr(b, 257, 5) === 'ustar') return 'tar';
  if (/\.(zip|jar|war|ear|apk|docx|xlsx|pptx)$/.test(lower)) return 'zip';
  if (/\.(tar)$/.test(lower)) return 'tar';
  if (/\.(gz|gzip|tgz)$/.test(lower)) return 'gzip';
  return null;
}

function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

function dosTimeToMs(date, time) {
  if (!date) return 0;
  const y = 1980 + ((date >> 9) & 0x7f);
  const mo = ((date >> 5) & 0x0f) - 1;
  const d = date & 0x1f;
  const h = (time >> 11) & 0x1f;
  const mi = (time >> 5) & 0x3f;
  const s = (time & 0x1f) * 2;
  return new Date(y, mo, d, h, mi, s).getTime();
}

/** 补上隐式父目录，保证每个条目到根的每一级都在表里。 */
export function withImplicitDirs(entries) {
  const map = new Map();
  for (const e of entries) map.set(e.path, e);
  for (const e of entries) {
    const parts = e.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join('/');
      if (!map.has(dirPath)) {
        map.set(dirPath, { path: dirPath, dir: true, size: 0, compressedSize: 0, method: 0, mtimeMs: 0 });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** 解析 ZIP 中央目录。返回 { ok, entries } ；entries 中带解压所需的 offset。 */
export function parseZip(bytes) {
  const b = toU8(bytes);
  const entries = [];
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65558); i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return { ok: false, reason: 'badZip', entries: [] };

  const count = u16le(b, eocd + 10);
  let p = u32le(b, eocd + 16);
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || b[p] !== 0x50 || b[p + 1] !== 0x4b || b[p + 2] !== 0x01 || b[p + 3] !== 0x02) {
      return { ok: false, reason: 'badCentralDirectory', entries };
    }
    const method = u16le(b, p + 10);
    const time = u16le(b, p + 12);
    const date = u16le(b, p + 14);
    const compressedSize = u32le(b, p + 20);
    const size = u32le(b, p + 24);
    const nameLen = u16le(b, p + 28);
    const extraLen = u16le(b, p + 30);
    const commentLen = u16le(b, p + 32);
    const localOffset = u32le(b, p + 42);
    const rawName = utf8(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    const rel = normalizeEntryPath(rawName);
    if (!rel) continue;
    const isDir = rawName.endsWith('/') || rawName.endsWith('\\');
    entries.push({
      path: rel, dir: isDir, size: isDir ? 0 : size, compressedSize, method,
      offset: localOffset, mtimeMs: dosTimeToMs(date, time),
    });
  }
  return { ok: true, entries: withImplicitDirs(entries) };
}

/** TAR（ustar / GNU）解析。 */
export function parseTar(bytes) {
  const b = toU8(bytes);
  const entries = [];
  let p = 0;
  let longName = null;
  while (p + 512 <= b.length) {
    const name = cstr(b, p, 100);
    if (!name) break; // 全零块 = 归档结束
    const size = parseInt(cstr(b, p + 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(b[p + 156] || 0x30);
    const mtime = (parseInt(cstr(b, p + 136, 12).trim() || '0', 8) || 0) * 1000;
    const bodyStart = p + 512;
    const nextP = bodyStart + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      // GNU 长文件名块：内容就是下一个条目的真实名字。
      longName = cstr(b, bodyStart, Math.min(size, 1024));
      p = nextP;
      continue;
    }
    if (type === 'x' || type === 'g' || type === 'K') { p = nextP; continue; } // 其余元数据块跳过

    const rawName = longName || name;
    longName = null;
    const rel = normalizeEntryPath(rawName);
    if (rel) {
      const isDir = type === '5' || rawName.endsWith('/');
      entries.push({
        path: rel, dir: isDir, size: isDir ? 0 : size,
        compressedSize: size, method: 0, mtimeMs: mtime,
        // 解压时按偏移切片，必须记录数据起点。
        offset: bodyStart,
      });
    }
    p = nextP;
  }
  return { ok: true, entries: withImplicitDirs(entries) };
}

/** 解压单个 ZIP 条目（支持 store 与 deflate；deflate 依赖浏览器内置 DecompressionStream）。 */
export async function readZipEntry(bytes, entry) {
  const b = toU8(bytes);
  const p = entry.offset;
  // 本地文件头签名：PK\x03\x04
  if (b[p] !== 0x50 || b[p + 1] !== 0x4b || b[p + 2] !== 0x03 || b[p + 3] !== 0x04) {
    return { ok: false, reason: 'badLocalHeader' };
  }
  const nameLen = u16le(b, p + 26);
  const extraLen = u16le(b, p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = b.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return { ok: true, data: raw };
  if (entry.method === 8) {
    if (!HAS_DEFLATE) return { ok: false, reason: 'noDeflate' };
    try {
      // ZIP 的 deflate 流不带 zlib 包装，对应 'deflate-raw'。
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const buf = await new Response(stream).arrayBuffer();
      return { ok: true, data: new Uint8Array(buf) };
    } catch (err) {
      return { ok: false, reason: 'inflateFailed' };
    }
  }
  return { ok: false, reason: 'unsupportedMethod:' + entry.method };
}

/**
 * 统一入口：按格式解析出条目表。
 * @returns {{ok: true, format: string, entries: Array} | {ok: false, reason: string}}
 */
export function readArchive(name, bytes) {
  const fmt = detectArchiveFormat(name, bytes);
  if (!fmt) return { ok: false, reason: 'unsupported', format: null, entries: [] };
  if (fmt === 'zip') {
    const r = parseZip(bytes);
    return r.ok ? { ok: true, format: 'zip', entries: r.entries } : { ok: false, reason: r.reason, format: fmt, entries: [] };
  }
  if (fmt === 'tar') return { ok: true, format: 'tar', entries: parseTar(bytes).entries };
  if (fmt === 'gzip') return { ok: true, format: 'gzip', entries: gzipEntries(name, bytes) };
  return { ok: false, reason: 'unsupported', format: null, entries: [] };
}

/** 解压 GZIP 流（Node 与浏览器都原生支持 DecompressionStream）。 */
export async function inflateGzip(bytes) {
  if (typeof DecompressionStream === 'undefined') return { ok: false, reason: 'noDeflate' };
  try {
    const stream = new Blob([toU8(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    return { ok: true, data: new Uint8Array(buf) };
  } catch (err) {
    return { ok: false, reason: 'inflateFailed' };
  }
}

/**
 * .gz 只有一层，拿不到内部目录信息：先看解压后是不是 TAR（.tgz），
 * 是就按 TAR 展开，否则整体当作一个文件条目。
 */
export function gzipEntries(name, bytes) {
  const inner = String(name || '').replace(/\.(tgz)$/i, '.tar').replace(/\.(gz|gzip)$/i, '');
  const isTar = /\.tar$/i.test(inner);
  return withImplicitDirs([{
    path: inner || 'archive',
    dir: false,
    size: Math.max(0, toU8(bytes).length),
    compressedSize: toU8(bytes).length,
    method: 'gzip',
    mtimeMs: 0,
    // 展开 .tgz 需要先 inflate 再 parseTar，由调用方按需处理。
    lazyTar: isTar,
  }]);
}

/** 判断某个文件名是否应被当作压缩包打开比较。 */
export function isArchiveName(name) {
  return /\.(zip|jar|war|ear|apk|docx|xlsx|pptx|tar|tgz|gz|gzip)$/i.test(String(name || ''));
}
