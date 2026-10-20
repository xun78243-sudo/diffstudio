/**
 * 单元测试：表格列规则。
 */
import {
  compileColumnRules,
  columnOptions,
  normalizeCell,
  cellsEqual,
} from '../src/renderer/js/core/columnRules.js';

const results = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  results.push({ name, pass: a === e, a, e });
}
const optsFor = (text, column, ordinal = 1) => {
  const c = compileColumnRules(text);
  if (!c.ok) return { ok: false, reason: c.reason };
  return columnOptions(column, c.rules, ordinal);
};

// ---- 编译 ----
check('compile: empty', compileColumnRules('').rules.length, 0);
check('compile: multiline', compileColumnRules('a:numeric\nb:ignore').rules.length, 2);
check('compile: semicolon separated', compileColumnRules('a:numeric;b:ignore').rules.length, 2);
check('compile: unknown option invalid', compileColumnRules('a:frobnicate').reason, 'invalid');
check('compile: bad regex invalid', compileColumnRules('a:regex:(').reason, 'invalid');
check('compile: empty selector invalid', compileColumnRules(':numeric').reason, 'invalid');
check('compile: index selector', compileColumnRules('#2:ignore').rules[0].sel.kind, 'index');
check('compile: all selector', compileColumnRules('*:trim').rules[0].sel.kind, 'all');

// ---- 选项解析 ----
check('opts: default none', optsFor('', { label: 'a' }, 1), { ignore: false, caseInsensitive: false, trim: false, numeric: false, regex: null });
check('opts: numeric by name (case-insensitive)', optsFor('AMOUNT:numeric', { label: 'amount' }, 1).numeric, true);
check('opts: by index', optsFor('#2:ignore', { label: 'x' }, 2).ignore, true);
check('opts: index does not leak to other column', optsFor('#2:ignore', { label: 'x' }, 3).ignore, false);
check('opts: all applies everywhere', optsFor('*:trim', { label: 'anything' }, 7).trim, true);
check('opts: column overrides all', optsFor('*:numeric\nid:ignore', { label: 'id' }, 1).ignore, true);
check('opts: options combine', optsFor('name:case:trim', { label: 'name' }, 1).caseInsensitive, true);
// 视图里的 label 可能带「仅左」后缀，匹配必须用原始表头名
check('opts: matches rawName despite decorated label', optsFor('name:case', { label: 'name仅左', rawName: 'name' }, 1).caseInsensitive, true);
check('opts: matches rightName', optsFor('ts:ignore', { label: 'ts', rightName: 'ts' }, 1).ignore, true);

// ---- 规范化 / 比较 ----
const trimOpts = optsFor('*:trim', { label: 'x' }, 1);
check('cell: trim makes padded equal', cellsEqual(' a ', 'a', trimOpts), true);
check('cell: without trim unequal', cellsEqual(' a ', 'a', { ...trimOpts, trim: false }), false);

const numOpts = optsFor('price:numeric', { label: 'price' }, 1);
check('cell: numeric 1.0 == 1', cellsEqual('1.0', '1', numOpts), true);
check('cell: numeric 1e3 == 1000', cellsEqual('1e3', '1000', numOpts), true);
check('cell: numeric falls back to text', cellsEqual('abc', 'abd', numOpts), false);
check('cell: numeric empty stays text', normalizeCell('', numOpts), '');

const caseOpts = optsFor('name:case', { label: 'name' }, 1);
check('cell: case insensitive', cellsEqual('Alice', 'alice', caseOpts), true);
check('cell: case sensitive by default', cellsEqual('Alice', 'alice', optsFor('', { label: 'name' }, 1)), false);

const ignoreOpts = optsFor('ts:ignore', { label: 'ts' }, 1);
check('cell: ignored column always equal', cellsEqual('2020-01-01', '2024-12-31', ignoreOpts), true);
check('cell: ignored differs from empty normalize', normalizeCell('x', ignoreOpts) === normalizeCell('', ignoreOpts), true);

const regexOpts = optsFor('ts:regex:\\d{4}-\\d{2}-\\d{2}', { label: 'ts' }, 1);
check('cell: regex keeps matching part', cellsEqual('at 2020-01-01 10:00', 'at 2020-01-01 23:59', regexOpts), true);
check('cell: regex different date unequal', cellsEqual('at 2020-01-01', 'at 2024-01-01', regexOpts), false);
const colonRe = ['t:regex:', '\\d{2}', ':', '\\d{2}'].join('');
// 正则保留到「时:分」，所以秒级不同仍算相等。
check('cell: regex with colon in pattern', cellsEqual('t 12:30:05', 't 12:30:59', optsFor(colonRe, { label: 't' }, 1)), true);
check('cell: regex with colon detects minute change', cellsEqual('t 12:30', 't 12:31', optsFor(colonRe, { label: 't' }, 1)), false);
let failed = 0;
for (const r of results) {
  if (!r.pass) { failed++; console.log(`FAIL  ${r.name}\n        got: ${r.a}\n   expected: ${r.e}`); }
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
