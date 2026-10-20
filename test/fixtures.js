/**
 * 测试数据生成：运行 `node test/fixtures.js`（`npm test` 与 `npm run test:e2e` 都会先调用它）。
 *
 * 三个必须守住的约束：
 * 1. 文本一律写成「无 BOM 的 UTF-8」，且用显式的 `\n` / `\r\n` 拼接。
 *    用 PowerShell 的 `Out-File -Encoding UTF8` 生成会带 BOM，BOM 会被当作
 *    正文内容，导致「左侧」和「右侧」看起来完全一样。
 * 2. 每个文件只写一次。重复写同一路径容易让上一次的旧内容残留（曾经出现过
 *    left/m.txt 被写成了 right/m.txt 的内容）。
 * 3. 写完立刻回读校验，内容不符就直接报错，而不是让测试在后续环节莫名其妙地失败。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'fixtures');

/** 强制写出无 BOM 的 UTF-8，并回读校验。 */
function write(rel, text) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  const buf = fs.readFileSync(p);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    throw new Error('BOM leaked into ' + rel);
  }
  if (buf.toString('utf8') !== text) {
    throw new Error('write verification failed for ' + rel);
  }
}

/** 清理历史遗留的错误文件。 */
function remove(rel) {
  fs.rmSync(path.join(ROOT, rel), { force: true });
}

// 清理历史上写错位置 / 重复的文件，避免旧内容残留
remove('left/lf.txt');
remove('right/crlf.txt');

// --- 文本比较：左侧 8 行，右侧 9 行（多一行尾部注释）---
write('left/a.js', [
  '// demo module',
  'export function greet(name) {',
  "  const greeting = 'Hello';",
  '  return `${greeting}, ${name}`;',
  '}',
  '',
  "export const VERSION = '1.0.0';",
  '',
].join('\n'));
write('right/a.js', [
  '// demo module',
  'export function greet(name) {',
  "  const greeting = 'Hi';",
  '  return `${greeting}, ${name}`;',
  '}',
  '',
  "export const VERSION = '1.0.1';",
  '// trailing comment',
  '',
].join('\n'));

// --- 三路合并：第 2 行双方改成不同内容 → 冲突 ---
write('base/m.txt', 'L1\ncommon2\ncommon3\ncommon4\n');
write('left/m.txt', 'L1\nLEFT2\ncommon3\ncommon4\n');
write('right/m.txt', 'L1\nRIGHT2\ncommon3\ncommon4\n');

// 双方改动相同：应自动合并，不算冲突
write('base/same.txt', 's1\ns2\n');
write('left/same.txt', 's1\nSAME\n');
write('right/same.txt', 's1\nSAME\n');

// 单侧新增 + 单侧修改（常规合并用例）
write('left/b.txt', 'alpha\nbeta\ngamma\ndelta\n');
write('right/b.txt', 'alpha\nBETA\ngamma\ndelta\nepsilon\n');

// --- 行尾符：内容相同，换行风格不同 ---
write('left/crlf.txt', 'alpha\r\nbeta\r\ngamma\r\n');
write('right/lf.txt', 'alpha\nbeta\ngamma\n');

// --- 表格：右侧 age 改动 + 多一行 ---
write('left/t.csv', 'id,name,age\n1,Alice,30\n2,Bob,25\n3,Carol,40\n');
write('right/t.csv', 'id,name,age\n1,Alice,31\n2,Bob,25\n3,Carol,40\n4,Dave,22\n');

// --- 只在一侧存在的文件 ---
write('left/only-left.txt', 'only on the left\n');
write('right/only-right.txt', 'only on the right\n');

// --- 二进制：左侧 byte 5 = 0xFF、byte 20 = 0x00，与右侧不同 ---
const bin = Buffer.alloc(64);
for (let i = 0; i < 64; i++) bin[i] = i;
const binLeft = Buffer.from(bin);
binLeft[5] = 0xff;
binLeft[20] = 0x00;
fs.writeFileSync(path.join(ROOT, 'left/bin.dat'), binLeft);
fs.writeFileSync(path.join(ROOT, 'right/bin.dat'), bin);

// 最终一致性校验：左右两侧的关键夹具必须不同
const leftM = fs.readFileSync(path.join(ROOT, 'left/m.txt'), 'utf8');
const rightM = fs.readFileSync(path.join(ROOT, 'right/m.txt'), 'utf8');
if (leftM === rightM) {
  throw new Error('left/m.txt and right/m.txt must differ (three-way merge conflict fixture)');
}
const leftA = fs.readFileSync(path.join(ROOT, 'left/a.js'), 'utf8');
const rightA = fs.readFileSync(path.join(ROOT, 'right/a.js'), 'utf8');
if (leftA === rightA) {
  throw new Error('left/a.js and right/a.js must differ (text compare fixture)');
}

console.log('fixtures written and verified (UTF-8 without BOM)');
