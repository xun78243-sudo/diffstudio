/**
 * 打开文件的默认比较视图。
 *
 * Beyond Compare 里「双击」总是用「正在比较的类型」打开：文件夹比较里双击
 * 一个文件，会按文件内容挑一个合适的比较窗口。这里把判断独立成一个纯函数，
 * 便于单测，也避免各视图各写一份扩展名表。
 *
 * 规则（与 BC 的 Session Settings 默认值一致）：
 *   - 图片扩展名            → image（像素比较）
 *   - CSV/TSV               → table（表格比较）
 *   - 文本 / 源码扩展名      → text
 *   - 其他（二进制）         → hex（按字节比较）
 */

/** 按图片解码器处理的扩展名（与主进程 nativeImage 支持的格式一致）。 */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'ico']);

/** 按表格解析的扩展名。CSV 解析器同样接受制表符分隔的文件。 */
const TABLE_EXT = new Set(['csv', 'tsv']);

/**
 * 常见文本 / 源码扩展名。列表不求全：未列出的文件会按内容是否可解码
 * 再判定一次（见 isProbablyBinary），避免把 .log、.md 之类误送进十六进制。
 */
const TEXT_EXT = new Set((
  'txt text log md markdown rst adoc ini cfg conf properties env yml yaml toml ' +
  'json json5 jsonc xml html htm xhtml css scss sass less vue svelte astro ' +
  'js jsx mjs cjs ts tsx coffee bat cmd ps1 psm1 sh bash zsh fish ' +
  'c h cc cpp cxx hpp hh cs java kt kts scala groovy go rs rb php py pyw ' +
  'pl pm lua r swift m mm sql graphql gql proto gradle makefile mk ' +
  'diff patch'
).split(/\s+/));

/** 取小写扩展名（不含点）；没有扩展名时返回空串。 */
export function extensionOf(filePath) {
  const name = String(filePath ?? '').split(/[\\/]/).pop() || '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 根据扩展名判断双击时应打开哪个比较视图。
 *
 * @param {string} filePath
 * @returns {'image'|'table'|'text'|'hex'}
 */
export function viewerFor(filePath) {
  const ext = extensionOf(filePath);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TABLE_EXT.has(ext)) return 'table';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'hex';
}

/**
 * 显示用的视图名称（用于"最近打开"与状态提示）。
 */
export function viewerKey(kind) {
  return kind || 'text';
}
