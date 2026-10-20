/**
 * 语法高亮：验证自动识别、token 着色、手动切换，以及 HTML 转义安全。
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-syn-'));
  const L = path.join(root, 'a.js');
  const R = path.join(root, 'b.js');
  fs.writeFileSync(L, 'const x = 1; // note\nconst s = "<b>hi</b>";\n');
  fs.writeFileSync(R, 'const x = 2; // note\nconst s = "<b>hi</b>";\n');

  await ev(`window.__diffstudio.openTab('text', window.api, ${JSON.stringify({ left: L, right: R })})`);
  for (let i = 0; i < 25; i++) {
    const ready = await ev(`(function(){ var p = document.querySelector('.view.active #tc-left'); return !!p && p.querySelectorAll('.row').length > 0; })()`);
    if (ready) break;
    await sleep(300);
  }

  const count = (cls) => ev(`document.querySelectorAll('.view.active #tc-left .${cls}').length`);
  const lang = () => ev(`document.querySelector('.view.active [data-role="syntax-lang"]').value`);

  check('syntax: language auto-detected from .js', await lang(), 'javascript');
  check('syntax: keywords highlighted', (await count('tok-keyword')) > 0, true);
  check('syntax: comment highlighted', (await count('tok-comment')) > 0, true);
  check('syntax: string highlighted', (await count('tok-string')) > 0, true);
  check('syntax: numbers highlighted', (await count('tok-number')) > 0, true);

  // 字符串里的 <b> 必须被转义，不能变成真实 DOM 元素
  check('syntax: html in string is escaped', await ev(`document.querySelectorAll('.view.active #tc-left b').length`), 0);
  check('syntax: string text preserved', await ev(`(function(){ var t = document.querySelector('.view.active #tc-left .tok-string'); return t ? t.textContent : ''; })()`), '"<b>hi</b>"');

  // 手动切到纯文本：不再有 token
  await ev(`(function(){ var s = document.querySelector('.view.active [data-role="syntax-lang"]'); s.value = 'none'; s.dispatchEvent(new Event('change')); return 'ok'; })()`);
  await sleep(900);
  check('syntax: manual switch to plain removes highlighting', await count('tok-keyword'), 0);
  check('syntax: text still rendered', await ev(`(function(){ var c = document.querySelector('.view.active #tc-left .code'); return c ? c.textContent.length > 0 : false; })()`), true);

  // 切到 python 也应生效（手动指定）
  await ev(`(function(){ var s = document.querySelector('.view.active [data-role="syntax-lang"]'); s.value = 'python'; s.dispatchEvent(new Event('change')); return 'ok'; })()`);
  await sleep(900);
  check('syntax: manual language is pinned', await lang(), 'python');

  fs.rmSync(root, { recursive: true, force: true });
  let failed = 0;
  for (const r of results) if (!r.pass) { failed++; console.log(`FAIL  ${r.n}\n        got: ${r.a}\n   expected: ${r.e}`); }
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  ws.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
