/**
 * 单元测试：P0 新增能力（文件操作计划 / 文本搜索 / 压缩包解析 / 文件夹三路合并）。
 * 沿用 core-extra.test.js 的 check(name, actual, expected) 约定。
 */

import {
  validateName, existingNames, planRename, planMove, planNewFolder, parseTouchTime, joinPath, baseName,
} from '../src/renderer/js/core/fileOps.js';
import { escapeRegExp, buildSearchRegExp, searchText, searchFiles } from '../src/renderer/js/core/search.js';
import {
  normalizeEntryPath, withImplicitDirs, parseZip, parseTar, detectArchiveFormat, isArchiveName,
} from '../src/renderer/js/core/archive.js';
import { mergePlanes, classifyThreeWay, toPlane, planThreeWay } from '../src/renderer/js/core/folderMerge.js';

const results = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  results.push({ name, pass: a === e, a, e });
}

// ---------------- 文件操作 ----------------

check('fileOps: empty name rejected', validateName('  ').reason, 'empty');
check('fileOps: slash rejected', validateName('a/b').reason, 'illegal');
check('fileOps: dotdot rejected', validateName('..').reason, 'reserved');
check('fileOps: trailing dot rejected', validateName('x.').reason, 'trailingDotSpace');
check('fileOps: normal name ok', validateName(' report.txt ').name, 'report.txt');

check('fileOps: existingNames lowercases', [...existingNames([{ name: 'A.txt' }, 'B.md'])].sort(), ['a.txt', 'b.md']);

const taken = new Set(['a.txt', 'keep.txt']);
check('fileOps: rename clash', planRename('C:\\d', 'keep.txt', 'a.txt', taken), { ok: false, reason: 'exists' });
check('fileOps: rename ok paths', planRename('C:\\d', 'keep.txt', 'new.txt', taken), { ok: true, from: 'C:\\d\\keep.txt', to: 'C:\\d\\new.txt', name: 'new.txt' });
check('fileOps: rename same name is noop', planRename('C:\\d', 'keep.txt', 'keep.txt', taken).noop, true);

check('fileOps: move to same dir is noop', planMove('C:\\a', 'x.txt', 'C:\\a\\', null).noop, true);
check('fileOps: move clash', planMove('C:\\a', 'x.txt', 'C:\\b', new Set(['x.txt'])), { ok: false, reason: 'exists' });
check('fileOps: move ok', planMove('C:\\a', 'x.txt', 'C:\\b', new Set(['y.txt'])).to, 'C:\\b\\x.txt');

check('fileOps: new folder ok', planNewFolder('/tmp/x', 'sub', new Set()), { ok: true, path: '/tmp/x/sub', name: 'sub' });
check('fileOps: new folder exists', planNewFolder('/tmp/x', 'sub', new Set(['sub'])).reason, 'exists');

const NOW = Date.parse('2026-10-20T12:00:00Z');
check('fileOps: touch empty uses now', parseTouchTime('', NOW), NOW);
check('fileOps: touch +1h', parseTouchTime('+1h', NOW), NOW + 3600000);
check('fileOps: touch -30m', parseTouchTime('-30m', NOW), NOW - 1800000);
check('fileOps: touch +2d', parseTouchTime('+2d', NOW), NOW + 172800000);
check('fileOps: touch bad input', parseTouchTime('tomorrow', NOW), null);
check('fileOps: touch iso date', parseTouchTime('2026-10-20', NOW), Date.parse('2026-10-20'));
check('fileOps: joinPath keeps separator', joinPath('C:\\base\\', 'a/b', null), 'C:\\base\\a\\b');
check('fileOps: baseName', baseName('C:\\base\\file.txt'), 'file.txt');

// ---------------- 文本搜索 ----------------

check('search: escape regex chars', escapeRegExp('a.b*c'), 'a\\.b\\*c');
check('search: empty query rejected', buildSearchRegExp('').reason, 'empty');
check('search: invalid regex reported', buildSearchRegExp('(', { regex: true }).reason, 'invalid');
check('search: plain text is escaped', buildSearchRegExp('a.b').re.test('axb'), false);
check('search: case insensitive by default', buildSearchRegExp('Foo').re.test('foo'), true);
check('search: case sensitive option', buildSearchRegExp('Foo', { caseSensitive: true }).re.test('foo'), false);

const text = 'alpha\nBeta beta\nGAMMA\nbeta';
check('search: hit lines', searchText(text, 'beta', {}).hits.map((h) => h.line), [2, 4]);
check('search: total counts all lines', searchText(text, 'beta').total, 2);
check('search: case sensitive counts only exact case', searchText(text, 'beta', { caseSensitive: true }).total, 2);
check('search: whole word excludes substring', searchText('foobar foo', 'foo', { wholeWord: true }).total, 1);
check('search: regex mode', searchText(text, 'b[a-z]+a', { regex: true }).total, 2);
check('search: long lines truncated', searchText('x'.repeat(500) + 'needle', 'needle', { maxLineLength: 10 }).hits[0].truncatedLine, true);
check('search: capped hits', searchText('a\na\na', 'a', { maxHits: 2 }).capped, true);
check('search: no hit', searchText(text, 'zzz').hits, []);

const sf = searchFiles([
  { path: '/a', rel: 'a.txt', text: 'foo\nbar' },
  { path: '/b', rel: 'b.txt', text: 'nope' },
  { path: '/c', rel: 'c.txt', text: 'foo foo' },
], 'foo');
check('search: files grouped', sf.files.map((f) => f.rel), ['a.txt', 'c.txt']);
check('search: files total counts lines', sf.total, 2);
check('search: bad regex aborts', searchFiles([{ path: '/a', rel: 'a', text: 'x' }], '(', { regex: true }).ok, false);

// ---------------- 压缩包 ----------------

check('archive: path normalized', normalizeEntryPath('./a//b/c.txt'), 'a/b/c.txt');
check('archive: traversal rejected', normalizeEntryPath('../../etc/passwd'), null);
check('archive: absolute rejected', normalizeEntryPath('/etc/passwd'), null);
check('archive: drive rejected', normalizeEntryPath('C:/x'), null);
check('archive: backslash handled', normalizeEntryPath('a\\b\\c'), 'a/b/c');

const implicit = withImplicitDirs([{ path: 'a/b/c.txt', dir: false, size: 1 }]);
check('archive: implicit parents added', implicit.map((e) => e.path), ['a', 'a/b', 'a/b/c.txt']);
check('archive: implicit parents are dirs', implicit[0].dir, true);

check('archive: zip magic detected', detectArchiveFormat('x.bin', new Uint8Array([0x50, 0x4b, 3, 4])), 'zip');
check('archive: gzip magic detected', detectArchiveFormat('x.bin', new Uint8Array([0x1f, 0x8b])), 'gzip');
check('archive: zip by extension', detectArchiveFormat('x.zip', new Uint8Array(0)), 'zip');
check('archive: unknown', detectArchiveFormat('x.txt', new Uint8Array([1, 2, 3])), null);
check('archive: isArchiveName', [isArchiveName('a.zip'), isArchiveName('b.TGZ'), isArchiveName('c.txt')], [true, true, false]);

/** 手工构造一个最小的 ZIP（store，无压缩），用于验证解析器。 */
function buildStoredZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(8, 0, true); // store
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    chunks.push(local);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    offset += local.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  for (const c of central) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

const zipBytes = buildStoredZip({ 'dir/a.txt': 'hello', 'dir/b.md': 'world', 'c.txt': 'x' });
const zr = parseZip(zipBytes);
check('archive: zip parsed', zr.ok, true);
check('archive: zip entries incl implicit dir', zr.entries.map((e) => e.path), ['c.txt', 'dir', 'dir/a.txt', 'dir/b.md']);
check('archive: zip dir flagged', zr.entries.find((e) => e.path === 'dir').dir, true);
check('archive: zip file size', zr.entries.find((e) => e.path === 'dir/a.txt').size, 5);

/** 最小 TAR（ustar）。 */
function buildTar(files) {
  const enc = new TextEncoder();
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = enc.encode(content);
    const hdr = new Uint8Array(512);
    hdr.set(enc.encode(name).subarray(0, 100), 0);
    hdr.set(enc.encode('0000644\0'), 100);
    hdr.set(enc.encode('0000000\0'), 108);
    hdr.set(enc.encode('0000000\0'), 116);
    const size = data.length.toString(8).padStart(11, '0') + '\0';
    hdr.set(enc.encode(size), 124);
    hdr.set(enc.encode('00000000000\0'), 136);
    hdr.set(enc.encode('        '), 148);
    hdr.set(enc.encode('0'), 156);
    hdr.set(enc.encode('ustar\0' + '00'), 257);
    // 校验和：先按空格计算
    let sum = 0;
    for (const byte of hdr) sum += byte;
    hdr.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
    blocks.push(hdr);
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data, 0);
    blocks.push(padded);
  }
  const end = new Uint8Array(1024);
  blocks.push(end);
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of blocks) { out.set(b, p); p += b.length; }
  return out;
}

const tarBytes = buildTar({ 'x.txt': 'abc', 'y/z.txt': 'defg' });
const tr = parseTar(tarBytes);
check('archive: tar parsed', tr.ok, true);
check('archive: tar entries', tr.entries.map((e) => e.path), ['x.txt', 'y', 'y/z.txt']);
check('archive: tar sizes', tr.entries.filter((e) => !e.dir).map((e) => e.size), [3, 4]);

// ---------------- 文件夹三路合并 ----------------

const mk = (rel, size, mtimeMs) => ({ rel, type: 'file', size, mtimeMs });

check('merge: both unchanged', classifyThreeWay('a', mk('a', 1, 0), mk('a', 1, 0), mk('a', 1, 0)).state, 'same');
check('merge: left only new file', classifyThreeWay('a', null, mk('a', 1, 0), null).state, 'left-only');
check('merge: right only new file', classifyThreeWay('a', null, null, mk('a', 1, 0)).state, 'right-only');
check('merge: left changed takes left', classifyThreeWay('a', mk('a', 1, 0), mk('a', 2, 0), mk('a', 1, 0)), { rel: 'a', state: 'left-changed', take: 'left' });
check('merge: right changed takes right', classifyThreeWay('a', mk('a', 1, 0), mk('a', 1, 0), mk('a', 5, 0)).take, 'right');
check('merge: both same change', classifyThreeWay('a', mk('a', 1, 0), mk('a', 9, 0), mk('a', 9, 0)).state, 'both-changed-same');
check('merge: both different change conflicts', classifyThreeWay('a', mk('a', 1, 0), mk('a', 7, 0), mk('a', 8, 0)), { rel: 'a', state: 'conflict', take: null });
check('merge: left deleted right unchanged', classifyThreeWay('a', mk('a', 1, 0), null, mk('a', 1, 0)), { rel: 'a', state: 'left-deleted', take: 'left', deleted: true });
check('merge: one side deleted other changed conflicts', classifyThreeWay('a', mk('a', 1, 0), null, mk('a', 3, 0)).state, 'conflict');

const planes = mergePlanes(
  [mk('same.txt', 1, 0), mk('lchg.txt', 1, 0), mk('conflict.txt', 1, 0), mk('gone.txt', 1, 0)],
  [mk('same.txt', 1, 0), mk('lchg.txt', 2, 0), mk('conflict.txt', 5, 0), mk('gone.txt', 1, 0), mk('new-l.txt', 1, 0)],
  [mk('same.txt', 1, 0), mk('lchg.txt', 1, 0), mk('conflict.txt', 6, 0), mk('new-r.txt', 1, 0)],
);
check('merge: row count', planes.rows.length, 6);
check('merge: same counted', planes.summary.same, 1);
check('merge: conflicts counted', planes.summary.conflict, 1);
check('merge: deleted counted', planes.summary.deleted, 1);
check('merge: left-only counted', planes.summary.leftOnly, 1);
check('merge: right-only counted', planes.summary.rightOnly, 1);
check('merge: plane excludes dirs', toPlane([{ rel: 'd', type: 'dir' }, mk('f', 1, 0)]).size, 1);

const ops = planThreeWay(planes.rows, 'left');
check('merge: plan skips conflict and same', ops.some((o) => o.rel === 'conflict.txt' || o.rel === 'same.txt'), false);
check('merge: plan copies left change into left target', ops.find((o) => o.rel === 'lchg.txt'), { action: 'copy', rel: 'lchg.txt', from: 'left', size: 2 });check('merge: plan deletes when side removed', ops.find((o) => o.rel === 'gone.txt'), { action: 'delete', rel: 'gone.txt' });

// ---------------- 汇总 ----------------

let failed = 0;
for (const r of results) {
  if (!r.pass) {
    failed++;
    console.log(`FAIL  ${r.name}\n        got: ${r.a}\n   expected: ${r.e}`);
  }
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
