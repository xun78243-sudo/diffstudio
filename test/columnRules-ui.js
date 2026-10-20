/**
 * 列规则：在真实应用里验证数值比较、忽略列、正则取子串。
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-col-'));
  const L = path.join(root, 'l.csv');
  const R = path.join(root, 'r.csv');
  // price 列写法不同但数值相等；ts 列时间不同；name 列大小写不同
  fs.writeFileSync(L, 'id,name,price,ts\n1,Alice,1.0,2020-01-01 10:00\n2,Bob,2.50,2020-01-01 11:00\n');
  fs.writeFileSync(R, 'id,name,price,ts\n1,Alice,1,2024-12-31 23:00\n2,bob,3.00,2020-01-01 12:00\n');

  await ev(`window.__diffstudio.openTab('table', window.api, ${JSON.stringify({ left: L, right: R })})`);
  for (let i = 0; i < 25; i++) {
    const ready = await ev(`document.querySelectorAll('.view.active table').length > 0`);
    if (ready) break;
    await sleep(300);
  }

  const diffCells = () => ev(`document.querySelectorAll('.view.active td.diff').length`);
  const setRules = async (v) => {
    await ev(`(function(){ var i = document.querySelector('.view.active [data-role="column-rules"]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
    await sleep(1500);
  };

  const baseline = await diffCells();
  check('columns: baseline has differences', baseline > 0, true);

  // 数值列：1.0 == 1，2.50 != 3.00 → price 列差异从 2 处降到 1 处
  await setRules('price:numeric');
  const afterNumeric = await diffCells();
  check('columns: numeric rule reduces differences', afterNumeric < baseline, true);

  // 忽略时间列 + 名称忽略大小写：应当只剩 price 一处差异
  await setRules('price:numeric\nts:ignore\nname:case');
  check('columns: only price differs now', await diffCells(), 2); // 左右两侧各标一个单元格

  // 非法规则要提示且不影响原有比较
  await setRules('price:bogus');
  check('columns: invalid rule flagged', await ev(`(function(){ var i = Array.from(document.querySelectorAll('.view.active [data-role="column-rules"]')).pop(); return i.classList.contains('invalid'); })()`), true);
  check('columns: note reports invalid', /无效|Invalid/.test(await ev(`Array.from(document.querySelectorAll('.view.active [data-role="column-rules-note"]')).pop().textContent`) || ''), true);
  check('columns: view survives invalid rule', (await diffCells()) > 0, true);

  fs.rmSync(root, { recursive: true, force: true });
  let failed = 0;
  for (const r of results) if (!r.pass) { failed++; console.log(`FAIL  ${r.n}\n        got: ${r.a}\n   expected: ${r.e}`); }
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  ws.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
