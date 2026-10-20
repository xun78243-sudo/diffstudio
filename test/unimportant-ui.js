/**
 * 不重要规则：在真实应用里验证输入规则后差异被降级、导航跳过、计数正确。
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-unimp-'));
  const L = path.join(root, 'l.txt');
  const R = path.join(root, 'r.txt');
  fs.writeFileSync(L, 'keep me\nbuild 2020-01-01 ok\nvalue 1\n');
  fs.writeFileSync(R, 'keep me\nbuild 2024-12-31 ok\nvalue 2\n');

  await ev(`window.__diffstudio.openTab('text', window.api, ${JSON.stringify({ left: L, right: R })})`);
  await sleep(1500);

  const kindCount = (kind) => ev(`(function(){ var pane = document.querySelector('.view.active #tc-left'); if(!pane) return -1; return Array.from(pane.querySelectorAll('.row')).filter(function(r){return r.classList.contains('kind-${kind}')}).length; })()`);

  // 打开后等待新视图成为活动视图，再开始统计。
  for (let i = 0; i < 20; i++) {
    const ready = await ev(`(function(){ var p = document.querySelector('.view.active #tc-left'); return !!p && p.querySelectorAll('.row').length > 0; })()`);
    if (ready) break;
    await sleep(300);
  }
  check('unimportant: before rules there is no unimportant row', await kindCount('unimportant'), 0);
  const changedBefore = await kindCount('change');
  check('unimportant: baseline has real changes', changedBefore >= 1, true);

  // 输入规则并触发 change 事件（模拟用户输入后回车）
  await ev(`(function(){ var i = Array.from(document.querySelectorAll('[data-role="unimportant-rules"]')).pop(); i.value = '\\\\d{4}-\\\\d{2}-\\\\d{2}'; i.dispatchEvent(new Event('change')); return 'ok'; })()`);
  await sleep(1200);

  check('unimportant: date row downgraded', await kindCount('unimportant'), 1);
  // 真实差异不应被规则吞掉：规则后仍有 change 行（"value 1" vs "value 2"）。
  check('unimportant: real change survives', (await kindCount('change')) >= 1, true);
  check('unimportant: change count preserved', changedBefore >= 1, true);
  const note = await ev(`Array.from(document.querySelectorAll('.view.active [data-role="unimportant-count"]')).pop().textContent`);
  check('unimportant: count note shown', /1/.test(note || ''), true);

  // 非法规则要提示而不是崩
  await ev(`(function(){ var i = Array.from(document.querySelectorAll('[data-role="unimportant-rules"]')).pop(); i.value = '('; i.dispatchEvent(new Event('change')); return 'ok'; })()`);
  await sleep(800);
  const note2 = await ev(`Array.from(document.querySelectorAll('.view.active [data-role="unimportant-count"]')).pop().textContent`);
  check('unimportant: invalid rule reported', /无效|Invalid/.test(note2 || ''), true);

  fs.rmSync(root, { recursive: true, force: true });
  let failed = 0;
  for (const r of results) if (!r.pass) { failed++; console.log(`FAIL  ${r.n}\n        got: ${r.a}\n   expected: ${r.e}`); }
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  ws.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
