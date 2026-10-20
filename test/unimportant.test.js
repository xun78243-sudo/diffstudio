/**
 * 单元测试：重�?/ 不重要规则�? */
import { compileRules, stripUnimportant, isUnimportantPair, markUnimportant, countUnimportant, isUnimportantPath } from '../src/renderer/js/core/unimportant.js';
import { buildDiffLines } from '../src/renderer/js/core/diff.js';

const results = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  results.push({ name, pass: a === e, a, e });
}

// ---- 规则编译 ----
check('rules: empty text yields no rules', compileRules('').rules.length, 0);
check('rules: newline separated', compileRules('a\nb').rules.length, 2);
check('rules: semicolon separated', compileRules('a;b').rules.length, 2);
check('rules: invalid regex reported', compileRules('(').reason, 'invalid');
check('rules: literal mode escapes', compileRules('a.b', { literal: true }).rules[0].re.test('axb'), false);
check('rules: regex mode', compileRules('b[a-z]+a').rules[0].re.test('beta'), true);
check('rules: case insensitive default', compileRules('foo').rules[0].re.test('FOO'), true);
check('rules: case sensitive option', compileRules('foo', { caseSensitive: true }).rules[0].re.test('FOO'), false);

// ---- 剥离 ----
const dateRules = compileRules('\\d{4}-\\d{2}-\\d{2}').rules;
check('strip: removes dates', stripUnimportant('build 2026-10-20 ok', dateRules), 'build  ok');
check('strip: keeps text without date', stripUnimportant('build ok', dateRules), 'build ok');

const pair = { left: 'id: 1 date 2020-01-01', right: 'id: 1 date 2024-12-31' };
check('pair: only date differs is unimportant', isUnimportantPair(pair, dateRules), true);
check('pair: other text differs is important', isUnimportantPair({ left: 'a date 2020-01-01', right: 'b date 2024-12-31' }, dateRules), false);
check('pair: identical lines are not unimportant', isUnimportantPair({ left: 'x 2020-01-01', right: 'x 2020-01-01' }, dateRules), false);
check('pair: no rules never unimportant', isUnimportantPair(pair, []), false);

// ---- 后处�?----
const left = ['keep', 'stamp 2020-01-01', 'value 1', 'tail'];
const right = ['keep', 'stamp 2024-12-31', 'value 2', 'tail'];
const dl = buildDiffLines(left, right);
const marked = markUnimportant(dl, dateRules);
check('mark: date-only change downgraded', marked.filter((r) => r.kind === 'unimportant').length, 1);
check('mark: real change stays change', marked.filter((r) => r.kind === 'change').length, 1);
check('mark: same rows untouched', marked.filter((r) => r.kind === 'same').length, 2);
check('mark: count helper', countUnimportant(marked), 1);

// 整行只被忽略文本占据 �?孤立行也不算差异
const dl2 = buildDiffLines(['a', '2020-01-01'], ['a']);
const marked2 = markUnimportant(dl2, dateRules);
check('mark: orphan line that is only a date', marked2.filter((r) => r.kind === 'unimportant').length, 1);

// 没有规则时原样返回（同一个数组引用，避免无谓分配�?check('mark: no rules returns input', markUnimportant(dl, []), dl);

// ---- 路径规则 ----
check('path: matches build artefacts', isUnimportantPath('dist/app.js', compileRules('^dist/').rules), true);
check('path: ignores others', isUnimportantPath('src/app.js', compileRules('^dist/').rules), false);

let failed = 0;
for (const r of results) {
  if (!r.pass) { failed++; console.log(`FAIL  ${r.name}\n        got: ${r.a}\n   expected: ${r.e}`); }
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
