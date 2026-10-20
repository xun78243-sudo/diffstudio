/**
 * 通过真实 DOM 交互验证新增控件：重命名、新建文件夹、查找文本。
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
  const status = () => ev(`(document.getElementById('status-text')||{}).textContent`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-ui2-'));
  const L = path.join(root, 'L');
  const R = path.join(root, 'R');
  fs.mkdirSync(L);
  fs.mkdirSync(R);
  fs.writeFileSync(path.join(L, 'alpha.txt'), 'needle here\nother');
  fs.writeFileSync(path.join(R, 'beta.txt'), 'nothing\nneedle too');
  fs.writeFileSync(path.join(L, 'only-left.txt'), 'x');

  await ev(`window.prompt = function(){ return window.__answers.shift(); }; window.__answers = []; 'ok'`);
  await ev(`window.__diffstudio.openTab('folder', window.api, ${JSON.stringify({ left: L, right: R })})`);
  await sleep(1500);

  const clickLast = (role) => ev(`Array.from(document.querySelectorAll('[data-role="${role}"]')).pop().click(); 'ok'`);
  const selectRow = (rel) => ev(`(function(){ var r = Array.from(document.querySelectorAll('.tree-row[data-rel]')).filter(function(x){return x.dataset.rel==='${rel}'}).pop(); r.click(); return 'ok'; })()`);

  // ---- 重命名 ----
  await selectRow('only-left.txt');
  await ev(`window.__answers.push('renamed-left.txt'); 'ok'`);
  await clickLast('rename');
  await sleep(1500);
  check('ui: rename created new name', fs.existsSync(path.join(L, 'renamed-left.txt')), true);
  check('ui: rename removed old name', fs.existsSync(path.join(L, 'only-left.txt')), false);
  check('ui: rename status', /renamed-left\.txt/.test(await status()), true);

  // ---- 非法名称被拒绝 ----
  await selectRow('renamed-left.txt');
  await ev(`window.__answers.push('bad/name.txt'); 'ok'`);
  await clickLast('rename');
  await sleep(800);
  check('ui: illegal name rejected', fs.existsSync(path.join(L, 'renamed-left.txt')), true);

  // ---- 新建文件夹 ----
  await ev(`window.__answers.push('created-dir'); 'ok'`);
  await clickLast('new-folder');
  await sleep(1500);
  check('ui: new folder exists', fs.existsSync(path.join(L, 'created-dir')) || fs.existsSync(path.join(R, 'created-dir')), true);

  // ---- 查找文本 ----
  // 查找栏现在需要先展开，再输入关键字后执行（原先用 window.prompt）。
  await clickLast('find-in-files');
  await sleep(300);
  await ev(`(function(){ var e = document.querySelector('.view.active [data-role="search-query"]'); e.value = 'needle'; return 'ok'; })()`);
  await clickLast('search-go');
  await sleep(2500);
  const st = await status();
  check('ui: find reports hits', /找到/.test(st) && /2/.test(st), true);
  const hitRows = await ev(`document.querySelectorAll('.tree-row.diff').length`);
  check('ui: find rendered hit rows', hitRows >= 2, true);

  fs.rmSync(root, { recursive: true, force: true });
  let failed = 0;
  for (const r of results) if (!r.pass) { failed++; console.log(`FAIL  ${r.name}\n        got: ${r.a}\n   expected: ${r.e}`); }
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  ws.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
