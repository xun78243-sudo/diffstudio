/**
 * 单元测试：替换规则。
 */
import {
  compileReplacements,
  applyReplacements,
  replaceLines,
  countAffected,
} from '../src/renderer/js/core/replacement.js';

const results = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  results.push({ name, pass: a === e, a, e });
}
const bodies = (lines) => lines.map((l) => l.body);

// ---- 编译 ----
check('compile: empty yields no rules', compileReplacements('').rules.length, 0);
check('compile: multiline', compileReplacements('a=>b\nc=>d').rules.length, 2);
check('compile: semicolon separated', compileReplacements('a=>b;c=>d').rules.length, 2);
check('compile: missing arrow is invalid', compileReplacements('just-a-pattern').reason, 'invalid');
check('compile: bad regex is invalid', compileReplacements('/[a-/=>x').reason, 'invalid');
check('compile: literal pattern escaped', compileReplacements('1.0=>2.0').rules[0].re.test('1x0'), false);
check('compile: regex form honoured', compileReplacements('/v\\d+/=>V').rules[0].re.test('v12'), true);
check('compile: empty replacement allowed', compileReplacements('/x/=>').rules[0].to, '');
check('compile: global by default', compileReplacements('ab=>x').rules[0].re.flags.includes('g'), true);
// 正则里自带 `=>` 或被转义的 `/` 时不能被误切
check('compile: regex containing arrow', compileReplacements('/a(?=>)b/=>Z').rules[0].to, 'Z');
check('compile: escaped slash inside regex', compileReplacements('/a\\/b/=>Z').rules[0].re.test('a/b'), true);
check('compile: flags preserved', compileReplacements('/x/mi=>y').rules[0].re.flags.includes('m'), true);

// ---- 应用 ----
const r1 = compileReplacements('/\\s+/=> ').rules;
check('apply: rule keeps trailing-space replacement', r1[0].to, ' ');
check('apply: collapses whitespace', applyReplacements('a   b\t\tc', r1), 'a b c');
check('apply: replaces all occurrences', applyReplacements('abab', compileReplacements('ab=>x').rules), 'xx');
check('apply: deletion', applyReplacements('foo.dates.log', compileReplacements('/\\.dates/=>').rules), 'foo.log');
check('apply: literal mode needs no escaping', applyReplacements('a.b', compileReplacements('a.b=>x').rules), 'x');
check('apply: no rules returns input', applyReplacements('abc', []), 'abc');

// 大小写敏感：不带 i 时不匹配大写
const ci = compileReplacements('foo=>bar').rules;
check('apply: case sensitive by default', applyReplacements('FOO foo', ci), 'FOO bar');
check('apply: explicit i flag', applyReplacements('FOO foo', compileReplacements('/foo/i=>bar').rules), 'bar bar');

// ---- 按行替换 ----
const lines = [
  { body: 'build 2020-01-01 ok', eol: '\n' },
  { body: 'value 1', eol: '\n' },
];
const dateRules = compileReplacements('/\\d{4}-\\d{2}-\\d{2}/=>').rules;
const rl = replaceLines(lines, dateRules);
check('replaceLines: changed flag', rl.changed, true);
check('replaceLines: line count preserved', rl.lines.length, 2);
check('replaceLines: date stripped for comparison', bodies(rl.lines), ['build  ok', 'value 1']);
check('replaceLines: eol preserved', rl.lines[0].eol, '\n');

const same = replaceLines(lines, compileReplacements('/zzz/=>y').rules);
check('replaceLines: untouched returns same ref', same.lines === lines, true);
check('replaceLines: untouched changed=false', same.changed, false);

// 替换吞掉换行符：两行合并，行数变化要如实反映
const join = replaceLines(lines, compileReplacements('/\\n/=>|').rules);
check('replaceLines: newline eaten merges lines', bodies(join.lines), ['build 2020-01-01 ok|value 1|']);

// ---- 计数 ----
check('countAffected: counts matching lines', countAffected(lines, dateRules), 1);
check('countAffected: no match', countAffected(lines, compileReplacements('/zzz/=>y').rules), 0);
check('countAffected: no rules', countAffected(lines, []), 0);
check('countAffected: one line counted once with two rules', countAffected([{ body: 'a1' }], compileReplacements('/a/=>b;\n/1/=>2').rules), 1);

let failed = 0;
for (const r of results) {
  if (!r.pass) { failed++; console.log(`FAIL  ${r.name}\n        got: ${r.a}\n   expected: ${r.e}`); }
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
