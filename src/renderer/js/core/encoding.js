/**
 * 文本编码的检测与编解码（纯函数，漫游于主进程与渲染进程）。
 *
 * 与 Beyond Compare 一样，文本比较需要知道文件用的是什么编码，否则中文
 * Windows 上常见的 GBK 文件会被当成乱码。输入输出统一用 Uint8Array，
 * 不依赖 Buffer，便于在浏览器侧单测。
 */

/** 编码下拉框里的选项；`auto` 表示按内容自动检测。 */
export const ENCODINGS = ['auto', 'utf8', 'utf8-bom', 'utf16le', 'utf16be', 'gb18030', 'latin1'];

const BOM_FOR = {
  'utf8-bom': [0xef, 0xbb, 0xbf],
  utf16le: [0xff, 0xfe],
  utf16be: [0xfe, 0xff],
};

const LABEL_FOR = {
  utf8: 'utf-8',
  'utf8-bom': 'utf-8',
  utf16le: 'utf-16le',
  utf16be: 'utf-16be',
  latin1: 'latin1',
};

export function normalizeEncoding(name) {
  return ENCODINGS.includes(name) ? name : 'auto';
}

export function toBytes(input) {
  if (!input) return new Uint8Array(0);
  if (input instanceof Uint8Array) return input;
  if (input.type === 'Buffer' && Array.isArray(input.data)) return Uint8Array.from(input.data);
  if (Array.isArray(input)) return Uint8Array.from(input);
  return new Uint8Array(0);
}

function hasBom(buf, bytes) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}

/** 严格解码：非法序列返回 null，而不是静默替换成 U+FFFD。 */
function strictDecode(buf, label) {
  try {
    return new TextDecoder(label, { fatal: true }).decode(buf);
  } catch (err) {
    return null;
  }
}

/**
 * 无 BOM 的 UTF-16 BE 启发式：UTF-16 BE 的高字节在前，所以零字节落在偶数偏移。
 * 纯 ASCII 文件完全没有零字节，这个比例天然把它排除。
 */
function looksLikeUtf16Be(buf) {
  const n = Math.min(buf.length, 4096) & ~1;
  if (n < 8) return false;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0) evenZero++;
    if (buf[i + 1] === 0) oddZero++;
  }
  const pairs = n / 2;
  if (evenZero / pairs <= 0.5) return false;
  if (oddZero / pairs > 0.1) return false;
  let good = 0;
  for (let i = 0; i < n; i += 2) {
    const c = (buf[i] << 8) | buf[i + 1];
    if (c >= 0x20 && c < 0xd800) good++;
    else if (c === 9 || c === 10 || c === 13) good++;
  }
  return good / pairs > 0.95;
}


/**
 * 检测并解码。
 * @param {Uint8Array|number[]} input 文件字节
 * @param {string} [forced='auto'] 用户指定的编码
 * @returns {{ encoding: string, text: string }} encoding 是实际使用的编码
 */
export function decodeText(input, forced = 'auto') {
  const buf = toBytes(input);
  const choice = normalizeEncoding(forced);

  if (choice !== 'auto') {
    const bom = BOM_FOR[choice];
    const body = bom && hasBom(buf, bom) ? buf.subarray(bom.length) : buf;
    if (choice === 'latin1') {
      let s = '';
      for (let i = 0; i < body.length; i++) s += String.fromCharCode(body[i]);
      return { encoding: 'latin1', text: s };
    }
    const label = choice === 'gb18030' ? 'gb18030' : LABEL_FOR[choice];
    return { encoding: choice, text: new TextDecoder(label).decode(body) };
  }

  // --- 自动检测（顺序很重要：BOM 最可靠）---
  // 无 BOM 的 UTF-16 BE 只能靠「零字节在偶数位」判断，必须排在任何按字节
  // 判断之前：含零字节的 UTF-16 会被当成二进制，或被 UTF-8 解成一串 NUL。
  if (looksLikeUtf16Be(buf)) {
    // 奇数尾部字节不成对，截掉后再解码。
    return { encoding: 'utf16be', text: new TextDecoder('utf-16be').decode(buf.subarray(0, buf.length & ~1)) };
  }
  if (hasBom(buf, BOM_FOR['utf8-bom'])) {
    return { encoding: 'utf8-bom', text: new TextDecoder('utf-8').decode(buf.subarray(3)) };
  }
  if (hasBom(buf, BOM_FOR.utf16le)) {
    return { encoding: 'utf16le', text: new TextDecoder('utf-16le').decode(buf.subarray(2)) };
  }
  if (hasBom(buf, BOM_FOR.utf16be)) {
    return { encoding: 'utf16be', text: new TextDecoder('utf-16be').decode(buf.subarray(2)) };
  }
  const utf8 = strictDecode(buf, 'utf-8');
  if (utf8 !== null) return { encoding: 'utf8', text: utf8 };

  // 非 UTF-8：优先尝试中文编码。严格的 GB18030 解码失败（或出现孤立
  // 控制字符）时才退回 latin1，后者能解码一切但不保证可读。
  const gb = strictDecode(buf, 'gb18030');
  if (gb !== null && !hasStrayControls(gb)) return { encoding: 'gb18030', text: gb };

  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return { encoding: 'latin1', text: s };
}

/** 解码结果里出现 C1 控制字符（0x80-0x9F）通常说明用错了编码。 */
function hasStrayControls(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x80 && c <= 0x9f) return true;
  }
  return false;
}

/**
 * 编码为字节（保存时使用），按需加 BOM。
 * 无法用目标编码表示的字符会被替换成 '?'——调用方应先用 canEncode 检查。
 */
export function encodeText(text, encoding = 'utf8') {
  const choice = normalizeEncoding(encoding);
  const str = String(text ?? '');
  const utf8 = new TextEncoder().encode(str);

  if (choice === 'auto' || choice === 'utf8') return utf8;
  if (choice === 'utf8-bom') return withBom(BOM_FOR['utf8-bom'], utf8);

  if (choice === 'latin1') {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      out[i] = c <= 0xff ? c : 0x3f;
    }
    return out;
  }

  if (choice === 'utf16le' || choice === 'utf16be') {
    const body = new Uint8Array(str.length * 2);
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      body[i * 2] = choice === 'utf16le' ? code & 0xff : code >> 8;
      body[i * 2 + 1] = choice === 'utf16le' ? code >> 8 : code & 0xff;
    }
    return withBom(BOM_FOR[choice], body);
  }

  // GB18030：Chromium 没有对应的编码器，用反查表自己编。
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) { out.push(code); continue; }
    const pair = gbLookup(String.fromCharCode(code));
    if (pair) out.push(pair[0], pair[1]);
    else out.push(0x3f);
  }
  return Uint8Array.from(out);
}

/** 目标编码能否完整表示这段文本；不能时返回第一个不可表示的字符。 */
export function findUnencodable(text, encoding) {
  const choice = normalizeEncoding(encoding);
  const str = String(text ?? '');
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (choice === 'latin1' && code > 0xff) return str[i];
    if (choice === 'gb18030' && code >= 0x80 && !gbLookup(str[i])) return str[i];
  }
  return null;
}

function withBom(bom, body) {
  const out = new Uint8Array(bom.length + body.length);
  out.set(bom, 0);
  out.set(body, bom.length);
  return out;
}

let gbReverse = null;

function gbLookup(ch) {
  if (!gbReverse) gbReverse = buildGbReverse();
  return gbReverse.get(ch) || null;
}

/**
 * 构建 GB18030 双字节反查表。
 * 一次扫描 0x81-0xFE × 0x40-0xFE（跳过 0x7F），用 TextDecoder 解码后
 * 记录单字符映射；CJK 等常用字符全部落在这个区里。
 */
function buildGbReverse() {
  const map = new Map();
  const decoder = new TextDecoder('gb18030');
  const pair = new Uint8Array(2);
  for (let hi = 0x81; hi <= 0xfe; hi++) {
    for (let lo = 0x40; lo <= 0xfe; lo++) {
      if (lo === 0x7f) continue;
      pair[0] = hi;
      pair[1] = lo;
      const text = decoder.decode(pair);
      if (text.length === 1 && text.charCodeAt(0) >= 0x80 && !map.has(text)) {
        map.set(text, [hi, lo]);
      }
    }
  }
  return map;
}
