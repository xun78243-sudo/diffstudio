/**
 * 文件夹比较：查找栏（正则/全字/大小写）与「不重要文件」筛选的真实 DOM 验证。
 * 需要应用以 --remote-debugging-port=9222 启动。
 */
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
const check = (name, a, e) => results.push({ name, pass: JSON.stringify(a) === JSON.stringify(e), a: JSON.stringify(a), e: JSON.stringify(e) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));

async function main() {
  const page = (await getJson('http://127.0.0.1:9222/json')).find((t) => t.type === 'page' && /index\.html/.test(t.url));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const q = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && q.has(m.id)) { q.get(m.id)(m); q.delete(m.id); } });
  const send = (m, p) => new Promise((r) => { const i = ++id; q.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description);
    return r.result.result.value;
  };
  const active = (sel) => `document.querySelector('.view.active ' + ${JSON.stringify(sel)})`;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-fs-'));
  const L = path.join(root, 'L');
  const R = path.join(root, 'R');
  fs.mkdirSync(L);
  fs.mkdirSync(R);
  fs.mkdirSync(path.join(L, 'build'));
  fs.mkdirSync(path.join(R, 'build'));
  fs.writeFileSync(path.join(L, 'alpha.txt'), 'Foo bar\nfoo BAR\nfoobar 42\n');
  fs.writeFileSync(path.join(R, 'alpha.txt'), 'Foo bar\nfoo BAR\nfoobar 42\n');
  fs.writeFileSync(path.join(L, 'build', 'out.log'), 'log line\n');
  fs.writeFileSync(path.join(R, 'build', 'out.log'), 'log other\n');
  fs.writeFileSync(path.join(L, 'keep.txt'), 'k\n');

  await ev(`window.__diffstudio.openTab('folder', window.api, ${JSON.stringify({ left: L, right: R })})`);
  await sleep(1800);
  // e2e 等脚本会留下历史标签页，`.view.active` 可能落在别的页签上；
  // 明确把自己这一页切到前台，后续断言才有意义。
  await ev(`(function(){ var tabs = document.querySelectorAll('.tab'); if (tabs.length) tabs[tabs.length - 1].click(); return 'ok'; })()`);
  await sleep(600);

  const rows = () => ev(`Array.from(document.querySelectorAll('.view.active .tree-row[data-rel]')).map(function(r){return r.dataset.rel.replace(/\\\\/g, '/')})`);
  const setValue = (sel, value, event) => ev(`(function(){ var e = ${active(sel)}; e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event(${JSON.stringify(event || 'input')})); return 'ok'; })()`);
  // 单选框、复选框都用 change 事件：JS 改 checked 或用户点击都会触发它，
  // 统一走这一条路径可以避免「点了却没生效」。
  const setBox = (sel, on) => ev(`(function(){ var e = ${active(sel)}; if (!e) return 'missing'; e.checked = ${on ? 'true' : 'false'}; e.dispatchEvent(new Event('change')); return 'ok'; })()`);
  const click = (sel) => ev(`(function(){ var e = ${active(sel)}; if (!e) return 'missing'; e.click(); return 'ok'; })()`);
  const searchHits = () => ev(`Array.from(document.querySelectorAll('.view.active .tree-row.diff[data-rel]')).filter(function(r){var ic = r.querySelector('.ic'); return ic && /^\\d+$/.test(ic.textContent)}).map(function(r){return r.querySelector('.name').textContent})`);
  // 文件头左侧是 📄，命中行左侧是行号：用它们区分两类行。
  const searchFiles = () => ev(`Array.from(document.querySelectorAll('.view.active .tree-row')).filter(function(r){var ic = r.querySelector('.ic'); return !r.dataset.rel && ic && ic.textContent === '\u{1F4C4}'}).map(function(r){return r.querySelector('.name').textContent})`);

  // ---------- 「不重要文件」筛选 ----------
  check('unimportant: build/out.log visible initially', (await rows()).includes('build/out.log'), true);
  // 正则：只匹配该目录下的文件（`^build/.+`），不给目录自身建规则。
  await setValue('[data-role="unimportant-files"]', '^build/.+', 'change');
  await sleep(1200);
  check('unimportant: matching path hidden', (await rows()).includes('build/out.log'), false);
  check('unimportant: no file under the hidden dir', (await rows()).filter((r) => r.startsWith('build/')).length, 0);
  check('unimportant: other files still visible', (await rows()).includes('alpha.txt'), true);

  // 非法正则：提示错误，但不过滤。这里用 `[unclosed`（开括号未闭合）触发编译失败，
  // 并给足防抖时间（input 后 200ms 才提交）。
  await setValue('[data-role="unimportant-files"]', '[unclosed');  await sleep(1200);
  check('unimportant: invalid regex shows error', /正则无效/.test(await ev(`(${active('[data-role="unimportant-files-invalid"]')} || {}).textContent || ''`)), true);
  check('unimportant: invalid regex does not hide rows', (await rows()).includes('build/out.log'), true);

  // 恢复为空 = 全部可见
  await setValue('[data-role="unimportant-files"]', '', 'change');
  await sleep(400);
  check('unimportant: clearing restores rows', (await rows()).includes('build/out.log'), true);

  // ---------- 查找栏 ----------
  check('search: bar hidden by default', await ev(`${active('.search-bar')}.classList.contains('hidden')`), true);
  await click('[data-role="find-in-files"]');
  await sleep(300);
  check('search: toolbar button reveals bar', await ev(`${active('.search-bar')}.classList.contains('hidden')`), false);

  // 侧边文件夹内容相同，搜索会把两侧各算一遍：用「命中文件」数去重验证。
  const hitFiles = async () => (await searchFiles()).length;
  const runSearch = async (query, flags = {}) => {
    // 「区分大小写」默认关闭：每组用例显式复位，避免上一组状态残留。
    await setBox('[data-role="search-case"]', flags.case === true);
    await setBox('[data-role="search-word"]', flags.word === true);
    await setBox('[data-role="search-regex"]', flags.regex === true);
    await setValue('[data-role="search-query"]', query);
    await click('[data-role="search-go"]');
    await sleep(1200);
  };
  await runSearch('FOO BAR');
  check('search: plain text is case-insensitive by default', await hitFiles(), 2);

  // 区分大小写：只有 "Foo bar" 命中（"foo BAR" 大小写不符），两侧各 1 行。
  await runSearch('Foo bar', { case: true });
  check('search: match case narrows hits', (await searchHits()).length, 2);

  // 大小写敏感时只剩 "Foo bar" 一种写法命中，每侧 1 行。
  check('search: match case keeps only the capitalised line', (await searchHits())[0], 'Foo bar');
  check('search: match case excludes the lowercase variant', (await searchHits()).includes('foo BAR'), false);

  // 全字："foobar 42" 里的 "bar" 前后没有词边界，不该命中 → 每侧 2 行。
  await runSearch('bar', { word: true });
  check('search: whole word excludes the middle of "foobar"', (await searchHits()).length, 4);

  // 正则
  await runSearch('\\b42\\b', { regex: true });
  check('search: regex match works', (await searchHits()).length, 2);
  check('search: regex hit is the line with 42', (await searchHits())[0], 'foobar 42');

  // 非法正则：报错而不是静默返回空结果。
  await runSearch('[bad', { regex: true });
  check('search: invalid regex reports error', /正则|invalid/i.test(await ev(`(document.getElementById('status-text')||{}).textContent || ''`)), true);

  // 折叠查找栏后回到文件树（搜索期间树被搜索结果占用）。
  await click('[data-role="find-in-files"]');
  await sleep(600);
  check('search: collapsing the bar restores the file tree', (await rows()).includes('alpha.txt'), true);

  fs.rmSync(root, { recursive: true, force: true });
  let failed = 0;
  for (const r of results) if (!r.pass) { failed++; console.log(`FAIL  ${r.name}\n        got: ${r.a}\n   expected: ${r.e}`); }
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  ws.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
