/**
 * 菜单图标自测：逐个打开下拉菜单，检查图标数量与菜单项是否一致，
 * 并保存截图供人工核对（输出目录由环境变量 SHOT_DIR 指定，默认 ./shots）。
 *
 * 用法：先以 --remote-debugging-port=9222 启动应用，再：
 *   node test/menu-icons.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.CDP_PORT || 9222;
const OUT = process.env.SHOT_DIR || path.join(__dirname, '..', 'shots');
const getJSON = (u) => new Promise((res, rej) => {
  http.get(u, (r) => {
    let d = '';
    r.on('data', (c) => (d += c));
    r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej);
});

(async () => {
  const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target; start Electron with --remote-debugging-port=' + PORT);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 2e8 });
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Page.enable');
  fs.mkdirSync(OUT, { recursive: true });

  const keys = ['session', 'view', 'language', 'help'];
  let failed = 0;
  for (const key of keys) {
    await evaluate(`
      (() => {
        if (document.querySelector('.dropdown')) document.getElementById('menubar').click();
        document.querySelector('#menubar .menu-item[data-menu="${key}"]').click();
        return true;
      })()
    `);
    const rows = await evaluate(`
      [...document.querySelectorAll('.dropdown .mi')].map((mi) => ({
        label: mi.querySelector('.mi-label').textContent,
        icon: !!mi.querySelector('.lead .mi-icon svg path'),
        check: !!mi.querySelector('.lead .lead-check'),
        disabled: mi.classList.contains('disabled'),
      }))
    `);
    const file = path.join(OUT, `menu-${key}.png`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result && shot.result.data) fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    const withIcon = rows.filter((r) => r.icon).length;
    const checks = rows.filter((r) => r.check).length;
    console.log(`${key}: ${rows.length} items, ${withIcon} with icons, ${checks} checked`);
    if (key === 'session' && withIcon < 8) { failed++; console.log('  FAIL: expected icons on all 8 session types'); }
    if (key === 'language' && checks !== 1) { failed++; console.log('  FAIL: expected exactly one checked language'); }
    await evaluate(`document.getElementById('menubar').click(); true`);
  }
  console.log(failed ? `${failed} failure(s)` : 'menu icons OK (screenshots in ' + OUT + ')');
  ws.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
