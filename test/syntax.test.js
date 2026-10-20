/**
 * 单元测试：语法高亮词法。
 */
import {
  getLanguage,
  detectLanguage,
  tokenizeLine,
  LANGUAGES,
} from '../src/renderer/js/core/syntax.js';

const results = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  results.push({ name, pass: a === e, a, e });
}
const types = (line, lang) => tokenizeLine(line, lang).map((t) => `${t.type}:${t.text}`);
// token 必须完整还原原文，不能丢字符
const rebuild = (line, lang) => tokenizeLine(line, lang).map((t) => t.text).join('');

// ---- 语言识别 ----
check('detect: js', detectLanguage('a/b.js'), 'javascript');
check('detect: tsx', detectLanguage('x.tsx'), 'typescript');
check('detect: py', detectLanguage('m.py'), 'python');
check('detect: unknown falls back to none', detectLanguage('data.bin'), 'none');
check('detect: no extension', detectLanguage('Makefile'), 'none');
check('lang: none has no keywords', LANGUAGES.none.keywords.length, 0);
check('lang: typescript inherits javascript keywords', getLanguage('typescript').keywords.includes('const'), true);
check('lang: sql case insensitive flag', getLanguage('sql').caseInsensitive, true);

// ---- 基本着色 ----
check('js: keyword + number', types('const x = 42;', 'javascript'), ['keyword:const', 'plain: x = ', 'number:42', 'plain:;']);
check('js: string literal', types('let s = "hi";', 'javascript'), ['keyword:let', 'plain: s = ', 'string:"hi"', 'plain:;']);
check('js: line comment swallows keywords', types('// const return', 'javascript'), ['comment:// const return']);
check('js: keyword inside string is not a keyword', types('x = "return 1"', 'javascript'), ['plain:x = ', 'string:"return 1"']);
check('js: block comment on one line', types('a /* b */ c', 'javascript'), ['plain:a ', 'comment:/* b */', 'plain: c']);

// ---- 边界情况：必须完整还原 ----
check('rebuild: js line', rebuild('function f(a){ return "x" + 1 }', 'javascript'), 'function f(a){ return "x" + 1 }');
check('rebuild: unclosed string', rebuild('x = "oops', 'javascript'), 'x = "oops');
check('rebuild: comment at end', rebuild('x // tail', 'javascript'), 'x // tail');
check('rebuild: empty line', rebuild('', 'javascript'), '');
check('rebuild: python', rebuild('def f(x): return x # note', 'python'), 'def f(x): return x # note');
check('rebuild: sql', rebuild("SELECT * FROM t WHERE a='b'", 'sql'), "SELECT * FROM t WHERE a='b'");
check('rebuild: xml', rebuild('<a href="x">t</a>', 'xml'), '<a href="x">t</a>');

// ---- 具体语言 ----
check('python: comment with hash', types('# def', 'python'), ['comment:# def']);
check('python: hash inside string is not a comment', types('s = "#x"', 'python'), ['plain:s = ', 'string:"#x"']);
check('sql: keyword is case insensitive', types('SELECT 1', 'sql').some((t) => t === 'keyword:SELECT'), true);
check('xml: tag attributes are strings', types('<a b="c">', 'xml').filter((t) => t.startsWith('string:')), ['string:"c"']);
check('plain: no highlighting', types('const x = 1', 'none'), ['plain:const x = 1']);
check('c: preprocessor-ish line still reconstructed', rebuild('int main(void) { /* c */ return 0; }', 'c'), 'int main(void) { /* c */ return 0; }');

// ---- 性能与鲁棒性 ----
const longLine = '"' + 'a'.repeat(2000) + '"';
check('robust: long string rebuild', rebuild(longLine, 'javascript'), longLine);
check('robust: many quotes terminate', rebuild('a"b"c"d', 'javascript'), 'a"b"c"d');
check('robust: backslash escape', rebuild('"a\\"b"', 'javascript'), '"a\\"b"');
check('robust: unknown language object', tokenizeLine('x', { keywords: [] }).length, 1);

let failed = 0;
for (const r of results) {
  if (!r.pass) { failed++; console.log(`FAIL  ${r.name}\n        got: ${r.a}\n   expected: ${r.e}`); }
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
