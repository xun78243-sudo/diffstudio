/**
 * 三路合并的执行与撤销：通过 UI 按钮真实写盘。
 */
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
const check = (n, a, e) => results.push({ n, pass: JSON.stringify(a) === JSON.stringify(e), a: JSON.stringify(a), e: JSON.stringify(e) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));

(async () => {
  const page = (await getJson('http://127.0.0.1:9222/json')).find((t) => t.type === 'page' && /index\.html/.test(t.url));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const q = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && q.has(m.id)) { q.get(m.id)(m); q.delete(m.id); } });
  const send = (m, p) => new Promise((r) => { const i = ++id; q.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description);
    return r.result.result.value;
  };
  const status = () => ev(`(document.getElementById('status-text')||{}).textContent`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mg-'));
  const D = (n) => path.join(root, n);
  for (const d of ['base', 'left', 'right']) fs.mkdirSync(D(d));
  const T = new Date('2026-01-01T00:00:00Z');
  const w = (dir, name, content) => { const p = path.join(D(dir), name); fs.writeFileSync(p, content); fs.utimesSync(p, T, T); };
  w('base', 'same.txt', 'a');
  w('left', 'same.txt', 'a');
  w('right', 'same.txt', 'a');
  w('base', 'changed.txt', 'old');
  w('left', 'changed.txt', 'old');
  w('right', 'changed.txt', 'new-from-right');
  w('base', 'conflict.txt', 'base');
  w('left', 'conflict.txt', 'left-val');
  w('right', 'conflict.txt', 'right-val');

  await ev(`window.confirm = function(){ return true; }; 'ok'`);
  await ev(`window.__diffstudio.openTab('folder-merge', window.api, ${JSON.stringify({ base: D('base'), left: D('left'), right: D('right') })})`);
  await sleep(1500);
  check('merge: conflict not auto-taken', fs.readFileSync(path.join(D('left'), 'conflict.txt'), 'utf8'), 'left-val');

  // 默认写入左侧，执行合并
  await ev(`Array.from(document.querySelectorAll('[data-role="apply"]')).pop().click(); 'ok'`);
  await sleep(2000);
  check('merge: auto change applied to left', fs.readFileSync(path.join(D('left'), 'changed.txt'), 'utf8'), 'new-from-right');
  check('merge: conflict left untouched', fs.readFileSync(path.join(D('left'), 'conflict.txt'), 'utf8'), 'left-val');
  check('merge: status reports applied', /合并完成/.test(await status()), true);

  // 撤销
  await ev(`Array.from(document.querySelectorAll('[data-role="undo"]')).pop().click(); 'ok'`);
  await sleep(2000);
  check('merge: undo restored left', fs.readFileSync(path.join(D('left'), 'changed.txt'), 'utf8'), 'old');

  fs.rmSync(root, { recursive: true, force: true });
  let failed = 0;
  for (const r of results) if (!r.pass) { failed++; console.log(`FAIL  ${r.n}\n        got: ${r.a}\n   expected: ${r.e}`); }
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  ws.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
