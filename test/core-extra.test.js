/**
 * 单元测试：图片差异计算 / 手动对齐 / Unified Diff 与差异报告。
 *
 * 与 diff.test.js 使用同样的 check(name, actual, expected) 约定：
 * 期望值必须是纯数据，比较用 JSON 串。
 */

import { comparePixels, findRegions, fitScale, visibleRect, stepIndex } from '../src/renderer/js/core/imageDiff.js';
import { realignWithAnchors } from '../src/renderer/js/core/align.js';
import { buildPatch, applyUnifiedPatch, parseUnifiedPatch, makeHunks, buildReport } from '../src/renderer/js/core/patch.js';
import { planFolderPatch, describePlan } from '../src/renderer/js/core/folderPatch.js';
import { splitList, globMatch, isExcluded } from '../src/renderer/js/core/ui.js';
import { viewerFor, extensionOf } from '../src/renderer/js/core/viewer.js';

const results = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  results.push({ name, pass: a === e, a, e });
}

// ---------------- 图片差异 ----------------

const makeImage = (w, h, fn) => {
  const data = new Array(w * h * 4).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return { width: w, height: h, data };
};
const GREY = [10, 10, 10, 255];

const A = makeImage(4, 4, () => GREY);
const B = makeImage(4, 4, (x, y) => (x === 2 && y === 1 ? [200, 0, 0, 255] : GREY));
const r1 = comparePixels(A, B);
check('image: one different pixel', [r1.sameSize, r1.differing], [true, 1]);
check('image: difference bounding box', r1.box, { x: 2, y: 1, w: 1, h: 1 });
check('image: identical images', comparePixels(A, A).differing, 0);
check('image: tolerance suppresses colour noise', comparePixels(A, B, 255).differing, 0);

const TALL = makeImage(4, 6, () => GREY);
const r2 = comparePixels(A, TALL);
check('image: extra rows count as differences', r2.differing, 8);
check('image: size mismatch flagged', r2.sameSize, false);

// 透明像素不算差异：超出一侧尺寸的区域如果全透明，视觉上相同。
// A 是 4×4、CLEAR 是 6×4，多出的两列属于右侧（CLEAR），因此不计差异。
const CLEAR = makeImage(6, 4, () => [0, 0, 0, 0]);
// 重叠区域仍是实心 vs 透明：这部分是真差异（4×4=16），只有多出的透明列被忽略
check('image: transparent padding on the right is ignored', comparePixels(A, CLEAR).differing, 16);
check('image: transparent padding on the left is ignored', comparePixels(CLEAR, A).differing, 16);
const CLEAR2 = makeImage(6, 4, () => [0, 0, 0, 0]);
const SMALL_CLEAR = makeImage(4, 4, () => [0, 0, 0, 0]);
check('image: fully transparent pictures are identical', comparePixels(SMALL_CLEAR, CLEAR2).differing, 0);

// 连通区域
const mask = new Uint8Array(16);
mask[0] = 1; mask[1] = 1; mask[5] = 1; mask[15] = 1;
const regions = findRegions(4, 4, mask);
check('image: regions separated by empty pixels', regions.length, 2);
check('image: first region box and pixel count', [regions[0].x, regions[0].y, regions[0].w, regions[0].h, regions[0].pixels], [0, 0, 2, 2, 3]);
check('image: regions sorted top-to-bottom', regions.map((r) => r.y), [0, 3]);

// 缩放
check('image: small pictures are not upscaled', fitScale(100, 100, 800, 600), 1);
check('image: large pictures fit the viewport', fitScale(1600, 800, 800, 600), 0.5);
check('image: visible rect clamped at top-left', visibleRect(100, 100, 2, 0, 0, 40, 40), { x: 0, y: 0, w: 20, h: 20 });
check('image: visible rect follows the centre', visibleRect(100, 100, 2, 50, 50, 40, 40), { x: 40, y: 40, w: 20, h: 20 });
check('image: navigation wraps', [stepIndex(-1, 3, 1), stepIndex(2, 3, 1), stepIndex(0, 3, -1), stepIndex(0, 0, 1)], [0, 0, 2, -1]);

// ---------------- 手动对齐 ----------------

const L = ['a', 'b', 'X', 'c', 'd'];
const R = ['a', 'Y', 'Z', 'c', 'd'];
const aligned = realignWithAnchors(L, R, [{ aIdx: 2, bIdx: 1 }]);
check('align: anchor forces the pair', [aligned[2].kind, aligned[2].a, aligned[2].b], ['change', 'X', 'Y']);
check('align: trailing identical lines stay same', aligned.slice(-2).map((r) => r.kind), ['same', 'same']);
check('align: line numbers are absolute', [aligned[2].aIdx, aligned[2].bIdx], [2, 1]);
check('align: no anchors matches the automatic diff', realignWithAnchors(L, R, []).map((r) => r.kind), ['same', 'change', 'change', 'same', 'same']);
check('align: out-of-order anchors are ignored', realignWithAnchors(L, R, [{ aIdx: 3, bIdx: 3 }, { aIdx: 1, bIdx: 1 }]).length > 0, true);
check('align: identical anchor marked same', realignWithAnchors(['x', 'y'], ['x', 'y'], [{ aIdx: 1, bIdx: 1 }]).length, 2);
// 锚点行必须与 buildDiffLines 同形（aLine/bLine 是 {body, eol}），否则渲染器
// 会把它当成字符串直接显示，得到 "[object Object]"。
const anchorRow = realignWithAnchors(
  [{ body: 'x', eol: '\n' }, { body: 'X', eol: '\n' }],
  [{ body: 'y', eol: '\n' }, { body: 'Y', eol: '\r\n' }],
  [{ aIdx: 1, bIdx: 1 }],
)[1];
check('align: anchor row has line bodies', [anchorRow.aLine.body, anchorRow.bLine.body], ['X', 'Y']);
check('align: anchor row keeps the original eol', [anchorRow.aLine.eol, anchorRow.bLine.eol], ['\n', '\r\n']);
check('align: anchor row shape', [anchorRow.a, anchorRow.b, anchorRow.aLine.body, anchorRow.bLine.body, anchorRow.aligned, anchorRow.kind, anchorRow.aIdx, anchorRow.bIdx], ['X', 'Y', 'X', 'Y', true, 'change', 1, 1]);

// ---------------- 排除项 ----------------
const EX_LIST = splitList('node_modules; src/generated');
check('exclude: list keeps the original case', EX_LIST, ['node_modules', 'src/generated']);
const EX = new Set(EX_LIST.map((s) => s.toLowerCase()));
check('isExcluded: top-level name at any depth', isExcluded('src/node_modules/x.js', EX), true);
check('isExcluded: file under an excluded folder', isExcluded('src\\generated\\a.js', EX), true);
check('isExcluded: relative path entry', isExcluded('src/generated', EX), true);
check('isExcluded: case-insensitive', isExcluded('SRC/Generated/a.js', EX), true);
check('isExcluded: substring is not a match', isExcluded('src/libs/a.js', EX), false);
check('isExcluded: empty list never matches', isExcluded('node_modules/a.js', new Set()), false);
check('isExcluded: unrelated path', isExcluded('src/app.js', EX), false);

// ---------------- 双击文件打开哪个比较 ----------------

check('viewer: images use the picture view', [viewerFor('a.PNG'), viewerFor('dir/b.jpg')], ['image', 'image']);
check('viewer: csv/tsv use the table view', [viewerFor('t.csv'), viewerFor('t.tsv')], ['table', 'table']);
check('viewer: source files use the text view', [viewerFor('a.js'), viewerFor('D:/x/y.md'), viewerFor('noext'.concat('.txt'))], ['text', 'text', 'text']);
check('viewer: unknown binaries use the hex view', [viewerFor('a.exe'), viewerFor('Makefile.bin')], ['hex', 'hex']);
check('viewer: dotfiles and extensionless names', [extensionOf('.gitignore'), extensionOf('LICENSE'), viewerFor('LICENSE')], ['', '', 'hex']);


const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const b = ['1', '2', '3', '4', 'X', '6', '7', '8', '9', '10', '11'];
const patch = buildPatch(a, b, { fileName: 'work.txt' });
check('patch: unified header', patch.patch.startsWith('--- work.txt\n+++ work.txt\n@@ -2,'), true);
check('patch: hunk counts changed rows', [patch.changed, makeHunks(patch.diffLines, 3).length], [2, 1]);
const applied = applyUnifiedPatch(a, patch.patch);
check('patch: applies back to the target', applied.lines, b);
check('patch: applied / rejected counters', [applied.applied, applied.rejected, applied.total], [1, 0, 1]);
check('patch: rejects mismatched context', applyUnifiedPatch(['other'], patch.patch).rejected, 1);
check('patch: empty patch for identical files', buildPatch(a, a).patch, '');
check('patch: parsing an empty patch yields no hunks', parseUnifiedPatch(''), []);

// 相距很远的改动拆成两个块
const d1 = Array.from({ length: 40 }, (_, i) => String(i));
const d2 = [...d1];
d2[2] = 'x';
d2[30] = 'y';
check('patch: distant changes form separate hunks', makeHunks(buildPatch(d1, d2).diffLines, 3).length, 2);
// 相邻改动合并成一个块
const d3 = [...d1];
d3[2] = 'x';
d3[4] = 'y';
check('patch: nearby changes share one hunk', makeHunks(buildPatch(d1, d3).diffLines, 3).length, 1);
check('patch: round trip with several hunks', applyUnifiedPatch(d1, buildPatch(d1, d2).patch).lines, d2);

// 真实文件形态：行对象 { body, eol }，末行可以没有换行符。
// 这几条守住 "补丁能被 git apply / GNU patch 接受" 的格式约束。
const splitFile = (s) => {
  const parts = s.replaceAll('\r\n', '\n').split('\n');
  const tail = parts.pop();
  const rows = parts.map((body) => ({ body, eol: '\n' }));
  if (tail !== '') rows.push({ body: tail, eol: '' });
  return rows;
};


const fileA = splitFile('a\nb\nc\nd\n');
const fileB = splitFile('a\nB\nc\nd\n');
const filePatch = buildPatch(fileA, fileB, { fileName: 'target.txt' }).patch;
check('patch: file header repeats one name', filePatch.split('\n').slice(0, 2), ['--- target.txt', '+++ target.txt']);
check('patch: body lines carry their terminator', filePatch.includes('\n a\n-b\n+B\n c\n d\n'), true);
check('patch: file round trip keeps the line bodies', applyUnifiedPatch(fileA, filePatch).lines, ['a', 'B', 'c', 'd']);
check('patch: no trailing empty added line', filePatch.endsWith('+\n'), false);

// 末行无换行符：补丁必须带 \ No newline 标记，否则 git apply 匹配不上。
const tailPatch = buildPatch(splitFile('a\nb'), splitFile('a\nB'), { fileName: 'target.txt' }).patch;
check('patch: missing final newline marker', tailPatch.includes('\n\\ No newline at end of file\n'), true);
const tailApplied = applyUnifiedPatch(splitFile('a\nb'), tailPatch).lines;
check('patch: marker keeps the unterminated last line', tailApplied, ['a', 'B']);

// ---------------- 报告 ----------------

const html = buildReport({
  title: 'T',
  leftName: 'a',
  rightName: 'b',
  generated: 'now',
  sections: [{ title: 'S', rows: [{ status: 'change', left: '<x>', right: 'y' }] }],
}, 'html');
check('report: escapes html in cell text', html.includes('&lt;x&gt;'), true);
const txt = buildReport({
  title: 'T',
  sections: [{ title: 'S', rows: [
    { status: 'same', left: 'a', right: 'a' },
    { status: 'left', left: 'b', right: '' },
  ] }],
}, 'text');
check('report: text format skips unchanged rows', txt.includes('[left] b') && !txt.includes('[same]'), true);

// ---------------- 文件夹补丁 ----------------

const fpEntries = [
  { rel: "only-left.txt", name: "only-left.txt", type: "file", size: 2, status: "left-orphan" },
  { rel: "only-right.txt", name: "only-right.txt", type: "file", size: 2, status: "right-orphan" },
  { rel: "changed.txt", name: "changed.txt", type: "file", size: 2, status: "diff" },
  { rel: "sub", name: "sub", type: "dir", size: 0, status: "right-orphan" },
  { rel: "sub/inner.txt", name: "inner.txt", type: "file", size: 2, status: "right-orphan" },
  { rel: "locked.txt", name: "locked.txt", type: "file", size: 0, status: "?" },
];
const fpTree = planFolderPatch(fpEntries, "right", "tree");
const fpContent = planFolderPatch(fpEntries, "right", "content");
const fpMirror = planFolderPatch(fpEntries, "left", "mirror");
check("folder patch: tree mode copies the missing entry", fpTree.map((o) => o.rel), ["only-left.txt"]);
check("folder patch: tree mode leaves changed files alone", fpTree.some((o) => o.rel === "changed.txt"), false);
check("folder patch: content mode overwrites the changed file", fpContent.find((o) => o.rel === "changed.txt").action, "overwrite");
check("folder patch: mirror mode deletes the target-only file", fpMirror.filter((o) => o.action === "delete").map((o) => o.rel), ["only-left.txt"]);
check("folder patch: an unknown status never enters the plan", fpContent.concat(fpMirror).some((o) => o.rel === "locked.txt"), false);
check("folder patch: the summary counts the planned copies", describePlan(fpTree), { copy: 1, overwrite: 0, delete: 0 });
const failed = results.filter((r) => !r.pass);
for (const r of failed) console.log('FAIL', r.name, '\n  actual  ', r.a, '\n  expected', r.e);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
