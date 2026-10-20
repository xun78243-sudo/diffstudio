/**
 * P0 新功能端到端检查：文件操作 IPC + 三路合并视图渲染。
 * 需要应用以 `--remote-debugging-port=9222` 启动。
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const results = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  results.push({ name, pass: a === e, a, e });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

async function main() {
  const targets = await getJson('http://127.0.0.1:9222/json');
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error('app page not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };

  // ---- 准备三方目录 ----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-merge-'));
  const mk = (dir, files) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const p = path.join(dir, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  };
  const base = path.join(root, 'base');
  const left = path.join(root, 'left');
  const right = path.join(root, 'right');
  mk(base, { 'same.txt': 'a', 'onlyleft.txt': 'b', 'conflict.txt': 'c' });
  mk(left, { 'same.txt': 'a', 'onlyleft.txt': 'b', 'conflict.txt': 'LEFT', 'newleft.txt': 'n' });
  mk(right, { 'same.txt': 'a', 'conflict.txt': 'RIGHT' });
  // 让目录比较不受时间戳容差干扰
  for (const f of ['same.txt', 'conflict.txt']) {
    const t = new Date('2026-01-01T00:00:00Z');
    for (const d of [base, left, right]) {
      const p = path.join(d, f);
      if (fs.existsSync(p)) fs.utimesSync(p, t, t);
    }
  }

  const j = (s) => JSON.stringify(s);

  // ---- 1. 文件操作 API ----
  const apiOk = await evaluate('typeof window.api.rename + "," + typeof window.api.move + "," + typeof window.api.touch + "," + typeof window.api.readRaw');
  check('api: new file ops exposed', apiOk, 'function,function,function,function');

  const renameSrc = path.join(root, 'rename-me.txt');
  fs.writeFileSync(renameSrc, 'x');
  const r1 = await evaluate(`window.api.rename(${j(renameSrc)}, ${j(path.join(root, 'renamed.txt'))})`);
  check('api: rename ok', r1.ok, true);
  check('api: rename moved file', fs.existsSync(path.join(root, 'renamed.txt')), true);

  const r2 = await evaluate(`window.api.rename(${j(path.join(root, 'renamed.txt'))}, ${j(path.join(root, 'renamed.txt') + '.dup')})`);
  check('api: rename to free name ok', r2.ok, true);
  // 再改回来，后续步骤仍用 renamed.txt
  await evaluate(`window.api.rename(${j(path.join(root, 'renamed.txt') + '.dup')}, ${j(path.join(root, 'renamed.txt'))})`);
  const r2b = await evaluate(`window.api.rename(${j(path.join(root, 'renamed.txt'))}, ${j(path.join(root, 'left', 'same.txt'))})`);
  check('api: rename refuses to overwrite', r2b.ok, false);
  check('api: rename existing reason', r2b.reason, 'exists');

  const r3 = await evaluate(`window.api.touch(${j(path.join(root, 'renamed.txt'))}, Date.parse('2020-05-05T00:00:00Z'))`);
  check('api: touch ok', r3.ok, true);
  check('api: touch applied', fs.statSync(path.join(root, 'renamed.txt')).mtime.getUTCFullYear(), 2020);

  const moveDest = path.join(root, 'moved');
  fs.mkdirSync(moveDest, { recursive: true });
  const r4 = await evaluate(`window.api.move(${j(path.join(root, 'renamed.txt'))}, ${j(path.join(moveDest, 'renamed.txt'))})`);
  check('api: move ok', r4.ok, true);
  check('api: move removed source', fs.existsSync(path.join(root, 'renamed.txt')), false);

  // 相对路径必须被拒绝
  const r5 = await evaluate(`window.api.rename('relative.txt', ${j(path.join(root, 'x.txt'))}).then(()=>'ok', e=>'rejected')`);
  check('api: relative path rejected', r5, 'rejected');

  // ---- 2. 三路合并视图 ----
  await evaluate(`window.__diffstudio.openTab('folder-merge', window.api, ${j({ base, left, right })})`);
  await new Promise((r) => setTimeout(r, 1200));
  const rows = await evaluate(`Array.from(document.querySelectorAll('[data-role="merge-tree"]')).pop().querySelectorAll('.tree-row[data-rel]').length`);
  check('merge: view renders rows', rows >= 3, true);
  const conflictRows = await evaluate(`Array.from(Array.from(document.querySelectorAll('[data-role="merge-tree"]')).pop().querySelectorAll('.tree-row[data-rel]')).map(r => r.dataset.rel + '|' + r.className.replace('tree-row ',''))`);
  check('merge: conflict row marked', conflictRows.some((r) => r.startsWith('conflict.txt|conflict')), true);
  const summary = await evaluate(`Array.from(document.querySelectorAll('[data-role="merge-summary"]')).pop().textContent`);
  check('merge: summary rendered', /\d/.test(summary || ''), true);
  const tabTitle = await evaluate(`document.querySelector('.tab.active .tab-title, .tab.active') ? document.querySelector('.tab.active').textContent : ''`);
  check('merge: tab title present', /三路合并|3-Way/.test(tabTitle || ''), true);

  // ---- 3. 文件夹比较新控件 ----
  await evaluate(`window.__diffstudio.openTab('folder', window.api, ${j({ left, right })})`);
  await new Promise((r) => setTimeout(r, 1200));
  const roles = await evaluate(`['rename','new-folder','touch','move','find-in-files','archive-left','archive-right'].map(r => Array.from(document.querySelectorAll('[data-role="'+r+'"]')).pop() ? r : 'MISSING:' + r)`);
  check('folder: all new controls present', roles, ['rename', 'new-folder', 'touch', 'move', 'find-in-files', 'archive-left', 'archive-right']);

  let failed = 0;
  for (const r of results) {
    if (!r.pass) { failed++; console.log(`FAIL  ${r.name}\n        got: ${r.a}\n   expected: ${r.e}`); }
  }
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  fs.rmSync(root, { recursive: true, force: true });
  ws.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
