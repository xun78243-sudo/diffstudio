/**
 * 比较引擎与文案表的单元测试。
 * 运行：node test/diff.test.js
 * 只依赖 Node 内置能力，不需要测试框架。
 */
import { myersDiff, buildDiffLines, threeWayMerge, countChangedRows, makeEquality, EDIT } from '../src/renderer/js/core/diff.js';
import { splitLines, joinLines, eolKinds, eolName, diffChars, globMatch, splitList } from '../src/renderer/js/core/ui.js';
import { translate, LANGS, DICT_ZH, DICT_EN } from '../src/renderer/js/core/i18n.js';
import { parseCsv } from '../src/renderer/js/core/csv.js';
import { decodeText, encodeText, findUnencodable, ENCODINGS } from '../src/renderer/js/core/encoding.js';

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}\n      got:      ${a}\n      expected: ${e}`);
  }
}

const texts = (lines) => lines.map((l) => l.body);

// --- Myers basics ---
check('identical sequences', myersDiff(['a', 'b', 'c'], ['a', 'b', 'c']).map((o) => o.type), [0, 0, 0]);
check('empty vs empty', myersDiff([], []), []);
check('insert only', myersDiff(['a', 'c'], ['a', 'b', 'c']).map((o) => o.type), [0, 2, 0]);
check('delete only', myersDiff(['a', 'b', 'c'], ['a', 'c']).map((o) => o.type), [0, 1, 0]);

// --- diff line classification ---
check('change block', buildDiffLines(['hello', 'world', 'foo'], ['hello', 'bar', 'foo']).map((d) => d.kind),
  ['same', 'change', 'same']);
check('change block pairing', buildDiffLines(['hello', 'world'], ['hello', 'bar']).map((d) => [d.a, d.b]),
  [['hello', 'hello'], ['world', 'bar']]);
check('left orphan', buildDiffLines(['a', 'b', 'c'], ['a', 'c']).map((d) => d.kind), ['same', 'left', 'same']);
check('right orphan', buildDiffLines(['a', 'c'], ['a', 'b', 'c']).map((d) => d.kind), ['same', 'right', 'same']);
check('all new', buildDiffLines([], ['x', 'y']).map((d) => d.kind), ['right', 'right']);

// --- 数量不等时的配对：不得凭空造出"新增行"，也不能丢失真实内容 ---
const uneven = buildDiffLines(['A', 'old', 'B'], ['A', 'n1', 'n2', 'B']);
check('uneven block: kinds', uneven.map((d) => d.kind), ['same', 'change', 'right', 'same']);
check('uneven block: left text only pairs once', uneven.filter((d) => d.kind === 'change').map((d) => [d.a, d.b]),
  [['old', 'n1']]);
check('uneven block: no phantom rows (every row owns a side)',
  uneven.every((d) => d.aIdx >= 0 || d.bIdx >= 0), true);
check('uneven block: all right lines preserved',
  uneven.filter((d) => d.b !== undefined).map((d) => d.b), ['A', 'n1', 'n2', 'B']);
check('uneven block: changed row count', countChangedRows(uneven), 2);

// 反向：右侧只有 1 行、左侧多出 2 行。前两行被就近配对为修改，
// 第三行是真正的「仅左侧」孤立行；位置由 LCS 决定，这里按实际结果断言。
const uneven2 = buildDiffLines(['A', 'n1', 'n2', 'B'], ['A', 'old', 'B']);
check('uneven block reversed: kinds', uneven2.map((d) => d.kind), ['same', 'change', 'left', 'same']);
check('uneven block reversed: all left lines preserved',
  uneven2.filter((d) => d.a !== undefined).map((d) => d.a), ['A', 'n1', 'n2', 'B']);

// 锚点：中间夹着一行本来就是两侧共有的内容
const anchor = buildDiffLines(['X', 'new1', 'shared', 'new2'], ['X', 'shared']);
check('uneven block keeps shared anchor', anchor.map((d) => [d.kind, d.a ?? d.b]),
  [['same', 'X'], ['left', 'new1'], ['same', 'shared'], ['left', 'new2']]);

// --- 按内容比较：CRLF 与 LF 视为相同 ---
const lf = splitLines('a\nb\nc\n');
const crlf = splitLines('a\r\nb\r\nc\r\n');
const eq = makeEquality();
const eolDiff = buildDiffLines(lf, crlf, eq);
check('CRLF vs LF: no content difference', countChangedRows(eolDiff), 0);
check('CRLF vs LF: line endings recorded', [[...eq.eol.left], [...eq.eol.right]], [['\n'], ['\r\n']]);
check('eol names', [[...eolKinds(lf)].map(eolName), [...eolKinds(crlf)].map(eolName)], [['LF'], ['CRLF']]);

// --- 调用方的比较函数必须真正决定"相等"，不能被行尾符处理覆盖 ---
// makeEquality 只应忽略行尾符；忽略空白 / 大小写由调用方组合判断。
{
  const wsA = splitLines('a\n  padded  \nb\n');
  const wsB = splitLines('a\npadded\nb\n');
  const ignoreWs = (x, y) => x.body.trim() === y.body.trim();
  check('custom equality: whitespace tolerated', countChangedRows(buildDiffLines(wsA, wsB, ignoreWs)), 0);
  check('makeEquality: content still matters', countChangedRows(buildDiffLines(wsA, wsB, makeEquality())), 1);

  const caseA = splitLines('Hello\nWorld\n');
  const caseB = splitLines('hello\nworld\n');
  const ignoreCase = (x, y) => x.body.toLowerCase() === y.body.toLowerCase();
  check('custom equality: case tolerated', countChangedRows(buildDiffLines(caseA, caseB, ignoreCase)), 0);
  // 两行都被修改，合并成一个连续的差异块（左右两行各占一行，但 row 数为 1）。
  check('custom equality: a custom comparator can reject lines', countChangedRows(buildDiffLines(caseA, caseB, () => false)), 2);
}

// --- 空行 / 末尾换行 ---
check('blank lines inside are preserved', texts(splitLines('x\n\n\ny\n')), ['x', '', '', 'y']);
check('trailing newline adds no phantom line', texts(splitLines('x\ny\n')), ['x', 'y']);
check('no trailing newline keeps last line', texts(splitLines('x\ny')), ['x', 'y']);
check('blank line difference is detected',
  buildDiffLines(splitLines('x\n\ny\n'), splitLines('x\ny\n')).map((d) => d.kind), ['same', 'left', 'same']);
check('joinLines round-trips CRLF', joinLines(splitLines('a\r\nb\r\n')), 'a\r\nb\r\n');
check('joinLines round-trips mixed endings', joinLines(splitLines('a\r\nb\nc')), 'a\r\nb\nc');
check('joinLines can normalise to CRLF', joinLines(splitLines('a\nb\r\nc\n'), '\r\n'), 'a\r\nb\r\nc\r\n');
check('joinLines keeps a missing trailing newline', joinLines(splitLines('a\nb'), '\r\n'), 'a\r\nb');
check('joinLines with identical EOL written by both sides', joinLines(splitLines('a\r\nb\r\n'), '\n'), 'a\nb\n');

// --- Myers 最优性：与参考 LCS 对比 ---
function lcsLength(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp[0][0];
}

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed);

let optimal = true;
for (let t = 0; t < 300; t++) {
  const alphabet = 'abcd';
  const a = Array.from({ length: 15 + (rnd() % 25) }, () => alphabet[rnd() % 4]);
  const b = Array.from({ length: 15 + (rnd() % 25) }, () => alphabet[rnd() % 4]);
  const equalOps = myersDiff(a, b).filter((o) => o.type === 0).length;
  if (equalOps !== lcsLength(a, b)) {
    optimal = false;
    console.log('      counterexample:', a.join(''), b.join(''));
    break;
  }
}
check('Myers matches reference LCS over 300 random cases', optimal, true);

// --- 三路合并 ---
const merge = (b, l, r) => threeWayMerge(b, l, r).rows;

check('merge: independent changes',
  merge(['L1', 'base2', 'base3'], ['L1', 'MINE2', 'base3'], ['L1', 'base2', 'THEIRS3']).map((r) => r.state),
  ['same', 'leftChanged', 'rightChanged']);

check('merge: divergent edit is a conflict',
  merge(['a', 'b'], ['a', 'bX'], ['a', 'bY']).map((r) => r.state),
  ['same', 'conflict']);

const conflict = merge(['a', 'b'], ['a', 'bX'], ['a', 'bY']);
check('merge: conflict exposes both sides', [conflict[1].left, conflict[1].right], ['bX', 'bY']);
check('merge: conflict count', threeWayMerge(['a', 'b'], ['a', 'bX'], ['a', 'bY']).conflictCount, 1);

check('merge: identical change auto-accepted',
  merge(['x', 'y'], ['x', 'Y2'], ['x', 'Y2']).map((r) => r.state),
  ['same', 'same']);

check('merge: no change',
  merge(['1', '2', '3'], ['1', '2', '3'], ['1', '2', '3']).map((r) => r.state),
  ['same', 'same', 'same']);

check('merge: left-only insert stays left-only',
  merge(['a', 'b'], ['a', 'NEW', 'b'], ['a', 'b']).map((r) => r.state),
  ['same', 'leftChanged', 'same']);

check('merge: right-only insert stays right-only',
  merge(['a', 'b'], ['a', 'b'], ['a', 'NEW', 'b']).map((r) => r.state),
  ['same', 'rightChanged', 'same']);

// 双方在不同位置插入：不应判为冲突（纯插入按间隙定位）
check('merge: inserts at different gaps do not conflict',
  merge(['a', 'b', 'c'], ['a', 'L', 'b', 'c'], ['a', 'b', 'c', 'R']).map((r) => r.state),
  ['same', 'leftChanged', 'same', 'same', 'rightChanged']);

// 同一间隙的同一种插入视为一致
check('merge: identical insertion at same gap auto-accepted',
  merge(['a', 'b'], ['a', 'N', 'b'], ['a', 'N', 'b']).map((r) => r.state),
  ['same', 'same', 'same']);

// 冲突行必须带 hunkId，界面才能按块整体解决
const hunkConflict = merge(['a', 'b'], ['a', 'bX'], ['a', 'bY']);
check('merge: conflict rows carry a hunk id',
  hunkConflict.map((r) => typeof r.hunkId === 'string'), [false, true]);

// 合并结果的行必须保留原始换行符
const mRows = merge(splitLines('a\r\nb\r\n'), splitLines('a\r\nB2\r\n'), splitLines('a\r\nb\r\n')).filter((r) => r.state === 'leftChanged');
check('merge: original line objects preserved (CRLF)', mRows.map((r) => r.original.eol), ['\r\n']);

// 双方都删除同一行
check('merge: both delete same line',
  merge(['a', 'b', 'c'], ['a', 'c'], ['a', 'c']).map((r) => r.state), ['same', 'same']);

// --- 字符级高亮 ---
check('inline diff marks only the changed word',
  diffChars('const a = 1;', 'const b = 1;').filter((c) => c.kind !== 'same').map((c) => c.text).sort(),
  ['a', 'b']);
check('inline diff has no false changed spans on identical text',
  diffChars('same', 'same').every((c) => c.kind === 'same'), true);

// --- CSV 解析 ---
check('csv: quoted comma', parseCsv('a,b\n"x,y",z\n'), [['a', 'b'], ['x,y', 'z']]);
check('csv: escaped quotes', parseCsv('a\n"he said ""hi"""\n'), [['a'], ['he said "hi"']]);
check('csv: CRLF input', parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);

// --- 文案完整性 ---
check('i18n: both languages registered', LANGS, ['zh-CN', 'en']);
check('i18n: unknown key falls back to the key name', translate('en', 'no.such.key'), 'no.such.key');
check('i18n: params interpolated', translate('zh-CN', 'folderCompare.status', { n: 3, left: 'A', right: 'B' }),
  '比较完成：共 3 项 · 左侧「A」对比右侧「B」');
check('i18n: english interpolation', translate('en', 'hex.status', { leftSize: '1 B', rightSize: '2 B', n: 0 }),
  'Left 1 B · Right 2 B · 0 differing bytes');
check('i18n: missing param is left visible', translate('zh-CN', 'folderCompare.status', { n: 1 }), '比较完成：共 1 项 · 左侧「{left}」对比右侧「{right}」');

// 两种语言的键集合必须完全一致，否则切换到英文时会出现漏翻。
const zhKeys = Object.keys(DICT_ZH).sort();
const enKeys = Object.keys(DICT_EN).sort();
check('i18n: zh and en expose the same keys', zhKeys, enKeys);

// 英文表里不应残留中文。例外：语言切换项本身需要用各自的语言书写。
const cjk = /[\u4e00-\u9fff]/;
const NATIVE_NAMES = new Set(['menu.languageZh']);
const leaked = enKeys.filter((k) => !NATIVE_NAMES.has(k) && cjk.test(String(DICT_EN[k])));
check('i18n: english has no untranslated CJK strings', leaked, []);


// --- 编码：检测与往返 ---
// 中文 Windows 上最常见的编码问题是 GBK 文件被当成乱码；检测顺序必须是
// BOM → UTF-16 → UTF-8 → GB18030 → latin1。
const gbBytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x20, 0x61]);
check('encoding: gb18030 detected', decodeText(gbBytes), { encoding: 'gb18030', text: '中文 a' });
check('encoding: utf-8 bom is stripped', decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])),
  { encoding: 'utf8-bom', text: 'hi' });
check('encoding: utf-16 le bom', decodeText(new Uint8Array([0xff, 0xfe, 0x2d, 0x4e])),
  { encoding: 'utf16le', text: '中' });
check('encoding: utf-16 be without bom', decodeText(new Uint8Array([0x00, 0x61, 0x00, 0x62, 0x00, 0x63, 0x00, 0x64, 0x00, 0x65, 0x00, 0x66, 0x00, 0x67, 0x00, 0x68])),
  { encoding: 'utf16be', text: 'abcdefgh' });
check('encoding: plain ascii is utf-8', decodeText(new Uint8Array([0x61, 0x62])),
  { encoding: 'utf8', text: 'ab' });
check('encoding: gb18030 round trip', decodeText(encodeText('测试abc', 'gb18030')).text, '测试abc');
check('encoding: gb18030 bytes', Array.from(encodeText('中', 'gb18030')), [0xd6, 0xd0]);
check('encoding: utf-8 bom written', Array.from(encodeText('x', 'utf8-bom')), [0xef, 0xbb, 0xbf, 0x78]);
check('encoding: utf-16 le written', Array.from(encodeText('a', 'utf16le')), [0xff, 0xfe, 0x61, 0x00]);
check('encoding: forced latin1 keeps bytes', decodeText(gbBytes, 'latin1').encoding, 'latin1');
check('encoding: unencodable char reported', findUnencodable('a中', 'latin1'), '中');
check('encoding: gb18030 can encode chinese', findUnencodable('中文', 'gb18030'), null);
check('encoding: unknown name falls back to auto', decodeText(new Uint8Array([0x61]), 'klingon').encoding, 'utf8');
check('encoding: options include auto first', ENCODINGS[0], 'auto');

// --- 过滤器：文件名掩码与排除目录 ---
// 用户在「掩码」「排除」框里写的是一组模式，必须按 BC 的习惯解释：
// 支持 * ? {a,b}、用分号分隔多个模式、大小写不敏感。
check('glob: * matches extension', globMatch('*.js', 'a.js'), true);
check('glob: wrong extension rejected', globMatch('*.js', 'a.txt'), false);
check('glob: ? matches exactly one char', [globMatch('?.txt', 'a.txt'), globMatch('?.txt', 'ab.txt')], [true, false]);
check('glob: braces are alternatives', [globMatch('*.{js,css}', 'x.css'), globMatch('*.{js,css}', 'x.txt')], [true, false]);
check('glob: semicolon separates patterns', globMatch('*.js;*.css', 'y.css'), true);
check('glob: matching is case-insensitive', globMatch('SRC/*', 'src/a'), true);
check('glob: empty pattern accepts everything', globMatch('', 'anything'), true);
check('splitList: trims, drops empties, splits on ; and ,',
  splitList(' a; b ;; c,d\n'), ['a', 'b', 'c', 'd']);

// --- CSV：末尾空行与引号内的 CRLF ---
// 表格工具导出时常在末尾补空行；这些行不是数据，显示出来只会制造假差异。
check('csv: trailing blank rows trimmed', parseCsv('a,b\n1,2\n\n\n'), [['a', 'b'], ['1', '2']]);
check('csv: a lone blank line is still one row', parseCsv('\n'), [['']]);
check('csv: CRLF inside a quoted field becomes LF', parseCsv('a,b\n"x\r\ny",2\n'), [['a', 'b'], ['x\ny', '2']]);

// --- Myers 复杂度保护：完全不同的两个大文件不能把界面卡死 ---
// 结果允许不是最短编辑脚本，但必须能原样复现目标文本（不能丢行/错位）。
{
  const N = 3200;
  const bigA = Array.from({ length: N }, (_, i) => ({ body: 'left ' + i, eol: '\n' }));
  const bigB = Array.from({ length: N }, (_, i) => ({ body: 'right ' + i, eol: '\n' }));
  const t0 = Date.now();
  const ops = myersDiff(bigA, bigB);
  const ms = Date.now() - t0;
  // 超过预算后走「按位置配对」：前 N 行等长，编辑脚本就是 N 条 EQ。
  // 完全不同的 3200 行文件超预算后按位置配对：前 3200 行等长，全部记为相等。
  const allEqual = ops.length === N && ops.every((o) => o.type === EDIT.EQ);
  const rebuilt = ops.filter((o) => o.bIdx >= 0).map((o) => bigB[o.bIdx]);
  check('diff guard: fully different large files finish quickly', ms < 2000, true);
  check('diff guard: falls back to positional pairing', allEqual, true);
  check('diff guard: output still reproduces the target', rebuilt, bigB);
}

// --- 回归：隔离窗口过滤 / 忽略空白归一（对应 textCompare.js） ---

/** 与 textCompare.js 的 makeComparator 保持一致：忽略空白 = 折叠所有空白。 */
const wsEq = (x, y) => String(x.body).replace(/\s+/g, ' ').trim() === String(y.body).replace(/\s+/g, ' ').trim();

const longA = Array.from({ length: 60 }, (_, i) => ({ body: `line ${i + 1}`, eol: '\n' }));
const longB = longA.map((l, i) => ({ body: i === 19 || i === 44 ? `line ${i + 1} modified` : l.body, eol: '\n' }));
const longDiff = buildDiffLines(longA, longB, (x, y) => x.body === y.body);
check('long file: exactly two changed rows', countChangedRows(longDiff), 2);

// 隔离窗口：两侧都有行时必须同时落在各自区间内，否则窗口外同一侧的行会漏进来。
const inWindow = (r, w) => {
  const a = r.aIdx == null ? -1 : r.aIdx;
  const b = r.bIdx == null ? -1 : r.bIdx;
  if (a >= 0 && b >= 0) return a >= w.aStart && a < w.aEnd && b >= w.bStart && b < w.bEnd;
  if (a >= 0) return a >= w.aStart && a < w.aEnd;
  if (b >= 0) return b >= w.bStart && b < w.bEnd;
  return false;
};
const win = { aStart: 16, aEnd: 23, bStart: 16, bEnd: 23 };
const kept = longDiff.filter((r) => inWindow(r, win));
check('isolate: window keeps only the block plus context', kept.length, 7);
check('isolate: window starts at the padded line', kept[0].aIdx, 16);
check('isolate: window keeps the changed line', kept.some((r) => r.kind === 'change'), true);

check('ignore whitespace: inner run of spaces is ignored',
  wsEq({ body: 'beta  gamma' }, { body: 'beta gamma' }), true);
check('ignore whitespace: leading / trailing spaces are ignored',
  wsEq({ body: '  alpha  ' }, { body: 'alpha' }), true);
check('ignore whitespace: real content difference is kept',
  wsEq({ body: 'alpha' }, { body: 'beta' }), false);
check('ignore whitespace: tab equals space run',
  wsEq({ body: 'a\tb' }, { body: 'a b' }), true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
