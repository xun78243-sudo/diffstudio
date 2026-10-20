// CDP end-to-end verification for DiffStudio.
// Sessions are created through the app's test hook with an injected fake
// bridge, because the contextBridge object exposed by preload is immutable.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('C:\\Users\\14710\\Documents\\Default Project\\node_modules\\ws');

const T = path.resolve(__dirname, 'fixtures');
const tmpFiles = [];
/** Write a scratch file for a single check and remember it for cleanup. */
function tmpFile(name, content) {
  const p = path.join(os.tmpdir(), 'diffstudio-e2e-' + name);
  fs.writeFileSync(p, content, 'utf8');
  tmpFiles.push(p);
  return p;
}
const P = (s) => T + '\\' + s;
const j = (v) => JSON.stringify(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails.exception?.description || JSON.stringify(msg.params.exceptionDetails));
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg.error ? { __error: msg.error } : msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.__error) throw new Error('CDP: ' + JSON.stringify(r.__error));
    if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
    return r.result.value;
  }
}

(async () => {
  const targets = await getJSON('http://127.0.0.1:9222/json/list');
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 2e8 });
  await new Promise((r) => ws.on('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');

  const results = [];
  const log = (name, pass, detail) => {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + detail : ''}`);
  };

  // 假桥：文件对话框结果来自队列；文件系统调用转发给真桥。
  await cdp.eval(`
    (() => {
      const real = window.api;
      window.__q = { files: [], dirs: [], savePath: null, calls: [], statuses: [] };
      window.__fakeApi = {
        async openFiles() { window.__q.calls.push('openFiles'); return window.__q.files.shift() ?? null; },
        async openDirectory() { window.__q.calls.push('openDirectory'); return window.__q.dirs.shift() ?? null; },
        async saveFile() { return window.__q.savePath; },
        async readText(p) { return real.readText(p); },
        async readBinary(p, n) { return real.readBinary(p, n); },
        async listDir(p, base) { return real.listDir(p, base); },
        async readFileForCompare(p, n) { return real.readFileForCompare(p, n); },
        async writeText(p, c) { window.__q.calls.push('writeText:' + p); return real.writeText(p, c); },
        async writeBinary(p, b) { window.__q.calls.push('writeBinary:' + p); return real.writeBinary(p, b); },
        async copy(a, b) { return real.copy(a, b); },
        async delete(a) { return real.delete(a); },
        async mkdir(a) { return real.mkdir(a); },
        async exists(a) { return real.exists(a); },
        async getHome() { return real.getHome(); },
        async reveal() {},
        async readImage(p) { return real.readImage(p); },
        async savePng(p, w, h, d) { window.__q.calls.push('savePng:' + p); return true; },
        async loadSettings() { return {}; },
        async saveSettings(data) { window.__q.calls.push('saveSettings'); return true; },
        async notePaths() {},
        async cliTargets() { return null; },
      };
      // 记录每一次状态栏文本变化，便于验证提示信息
      const el = document.getElementById('status-text');
      new MutationObserver(() => {
        if (window.__q && window.__q.statuses) window.__q.statuses.push(el.textContent);
      }).observe(el, { childList: true, characterData: true, subtree: true });
      return true;
    })()
  `);

  const startSession = async (kind) => {
    await cdp.eval(`window.__diffstudio.openTab(${j(kind)}, window.__fakeApi); true`);
    await sleep(250);
  };

  const clickOpens = async (count) => {
    await cdp.eval(`
      (async () => {
        const view = document.querySelector('.view.active');
        const btns = [...view.querySelectorAll('.session-toolbar .icon-btn')].filter(b => ['open-left','open-right','open-base'].includes(b.dataset.role));
        for (const b of btns.slice(0, ${count})) { b.click(); await new Promise(r => setTimeout(r, 350)); }
        return true;
      })()
    `);
    await sleep(900);
  };

  const pickFolders = async () => {
    await cdp.eval(`
      (async () => {
        const view = document.querySelector('.view.active');
        const btns = [...view.querySelectorAll('.session-toolbar .icon-btn')].filter(b => ['pick-left','pick-right'].includes(b.dataset.role));
        btns[0].click(); await new Promise(r => setTimeout(r, 350));
        btns[1].click(); await new Promise(r => setTimeout(r, 1500));
        return true;
      })()
    `);
    await sleep(700);
  };

  const reset = async () => {
    await cdp.eval(`window.__diffstudio.closeAll(); window.__q.calls = []; window.__q.statuses = []; true`);
    await sleep(150);
  };

  const status = () => cdp.eval(`document.getElementById('status-text').textContent`);

  // 语言固定为中文，避免上一次运行留下的偏好影响断言
  await cdp.eval(`window.__diffstudio.setLanguage('zh-CN'); true`);
  await reset();

  // ---------- 1. 首页与菜单栏 ----------
  const cards = await cdp.eval(`[...document.querySelectorAll('.home-card')].map(c => c.dataset.launch)`);
  const homeCards = await cdp.eval(`[...document.querySelectorAll('.home-card')].map(c => c.dataset.launch)`);
  log('Home: every module has a card', homeCards.length === 8 && homeCards.includes('patch'), homeCards.join(','));

  const menus = await cdp.eval(`[...document.querySelectorAll('#menubar .menu-item')].map(x => x.textContent)`);
  log('Menu: language switch lives in the menu bar', menus.includes('语言'), menus.join(' | '));

  // 菜单图标：新建会话的 8 个类型都带图标；图标栏宽度一致，文字左边缘因此对齐。
  const menuIcons = await cdp.eval(`
    (() => {
      const item = [...document.querySelectorAll('#menubar .menu-item')].find(x => x.textContent === '会话');
      item.click();
      const rows = [...document.querySelectorAll('.dropdown .mi')];
      const session = rows.slice(0, 8);
      const leads = rows.map(r => r.querySelector('.lead'));
      return {
        icons: session.filter(r => r.querySelector('.lead .mi-icon svg path')).length,
        leadWidths: [...new Set(leads.map(l => Math.round(l.getBoundingClientRect().width)))],
        labelLefts: [...new Set(rows.map(r => Math.round(r.querySelector('.mi-label').getBoundingClientRect().left)))].length,
        labels: session.map(r => r.querySelector('.mi-label').textContent),
      };
    })()
  `);
  log('Menu: every session type has an icon', menuIcons.icons === 8, 'icons=' + menuIcons.icons);
  log('Menu: icon column has one fixed width', menuIcons.leadWidths.length === 1 && menuIcons.leadWidths[0] === 16, menuIcons.leadWidths.join(','));
  log('Menu: menu labels share one left edge', menuIcons.labelLefts === 1, 'distinct-lefts=' + menuIcons.labelLefts);
  log('Menu: icon does not leak into label text', menuIcons.labels.every(l => !l.includes('\uFFFD') && l.length > 0), menuIcons.labels.join(','));
  await cdp.eval(`document.getElementById('menubar').click(); true`);

  // ---------- 2. 从菜单新建比较会话 ----------
  await cdp.eval(`
    (() => {
      const item = [...document.querySelectorAll('#menubar .menu-item')].find(x => x.textContent === '会话');
      item.click();
      const mi = [...document.querySelectorAll('.dropdown .mi')].find(x => x.textContent.includes('文件夹比较'));
      mi.click();
      return true;
    })()
  `);
  await sleep(300);
  const menuOpen = await cdp.eval(`window.__diffstudio.tabCount()`);
  log('Menu: session menu opens a tab', menuOpen === 1, 'tabs=' + menuOpen);
  const tabLabel = await cdp.eval(`document.querySelector('.tab .name')?.textContent`);
  log('Menu: tab title is localised', tabLabel === '文件夹比较', tabLabel);

  // ---------- 3. 文本比较 ----------
  await reset();
  await cdp.eval(`window.__q.files = [${j([P('left\\a.js')])}, ${j([P('right\\a.js')])}]; true`);
  await startSession('text');
  await clickOpens(2);
  const text = await cdp.eval(`
    (() => {
      const rows = [...document.querySelectorAll('#tc-left .row')];
      const kinds = {};
      rows.forEach(r => { const k = [...r.classList].filter(c => c.startsWith('kind-')).join(',') || '?'; kinds[k] = (kinds[k]||0)+1; });
      return {
        rows: rows.length, kinds,
        inline: document.querySelectorAll('#tc-left .del-w').length + document.querySelectorAll('#tc-right .add-w').length,
        status: document.getElementById('status-text').textContent,
      };
    })()
  `);
  log('Text: rows rendered (8 lines incl. the extra right-hand line)', text.rows === 8, 'rows=' + text.rows);
  log('Text: unchanged rows present', (text.kinds['kind-same'] || 0) > 0, JSON.stringify(text.kinds));
  log('Text: modified rows present', (text.kinds['kind-change'] || 0) > 0, 'change=' + (text.kinds['kind-change'] || 0));
  log('Text: inline character highlight', text.inline > 0, 'spans=' + text.inline);
  log('Text: status reports changes', /差异行/.test(text.status), text.status);

  // 行尾符不同但内容相同：不应算作差异，但要有提示
  const crlf = tmpFile('crlf.txt', 'alpha\r\nbeta\r\ngamma\r\n');
  const lf = tmpFile('lf.txt', 'alpha\nbeta\ngamma\n');
  await reset();
  await cdp.eval(`window.__q.files = [${j([crlf])}, ${j([lf])}]; true`);
  await startSession('text');
  await clickOpens(2);
  const eol = await cdp.eval(`
    (() => ({
      changed: document.querySelectorAll('#tc-left .row:not(.kind-same)').length,
      note: document.querySelector('.legend-note')?.textContent || '',
    }))()
  `);
  log('Text: CRLF vs LF counts as no change', eol.changed === 0, 'changedRows=' + eol.changed);
  log('Text: line-ending difference is flagged', /CRLF/.test(eol.note) && /LF/.test(eol.note), eol.note);

  // 空行必须被渲染出来，且不能多出"幽灵行"
  const blanks = tmpFile('blanks.txt', 'x\n\n\ny\n');
  const noBlanks = tmpFile('noblanks.txt', 'x\ny\n');
  await reset();
  await cdp.eval(`window.__q.files = [${j([blanks])}, ${j([noBlanks])}]; true`);
  await startSession('text');
  await clickOpens(2);
  const blankRows = await cdp.eval(`
    (() => ({
      left: document.querySelectorAll('#tc-left .row').length,
      leftOnly: document.querySelectorAll('#tc-left .row.kind-left').length,
      placeholders: document.querySelectorAll('#tc-left .code.empty-line').length,
    }))()
  `);
  log('Text: blank lines rendered without phantom rows',
    blankRows.left === 4 && blankRows.leftOnly === 2, JSON.stringify(blankRows));
  log('Text: empty lines get a placeholder', blankRows.placeholders >= 2, 'placeholders=' + blankRows.placeholders);

  // --- 3b. 差异导航 / 忽略选项 / 查找 / 复制到另一侧 / 书签 ---
  const navL = tmpFile('nav-l.txt', 'one\nTWO\nthree\nfour\nFIVE\nsix\n');
  const navR = tmpFile('nav-r.txt', 'one\n2\nthree\nfour\n5\nsix\n');
  await reset();
  await cdp.eval(`window.__q.files = [${j([navL])}, ${j([navR])}]; true`);
  await startSession('text');
  await clickOpens(2);
  const nav = await cdp.eval(`
    (() => {
      const v = document.querySelector('.view.active');
      const label = () => v.querySelector('[data-role="nav-status"]').textContent;
      const sel = () => v.querySelector('#tc-left .row.selected')?.dataset.row ?? null;
      const next = v.querySelector('[data-role="next-diff"]');
      const prev = v.querySelector('[data-role="prev-diff"]');
      next.click();
      const first = { label: label(), row: sel() };
      next.click();
      const second = { label: label(), row: sel() };
      next.click();
      const wrapped = { label: label(), row: sel() };   // 应当回绕到第一处
      prev.click();
      const back = { label: label(), row: sel() };       // 应当回绕到最后一处
      return { first, second, wrapped, back };
    })()
  `);
  log('Text: next difference steps through both hunks',
    nav.first.row === '1' && nav.second.row === '4', JSON.stringify(nav));
  log('Text: difference navigation wraps both ways',
    nav.wrapped.row === '1' && nav.back.row === '4', JSON.stringify(nav));
  log('Text: navigation shows current position of total',
    /\u5dee\u5f02 2 \u5904/.test(nav.first.label) && /\u5f53\u524d\u7b2c 1 \u5904/.test(nav.first.label), nav.first.label);

  // 忽略空白：只差空白的行不再是差异
  const wsL = tmpFile('ws-l.txt', 'a\n  padded  \nb\n');
  const wsR = tmpFile('ws-r.txt', 'a\npadded\nb\n');
  await reset();
  await cdp.eval(`window.__q.files = [${j([wsL])}, ${j([wsR])}]; true`);
  await startSession('text');
  await clickOpens(2);
  const wsBefore = await cdp.eval(`document.querySelectorAll('#tc-left .row:not(.kind-same)').length`);
  await cdp.eval(`document.querySelector('.view.active [data-role="ignore-whitespace"]').click(); true`);
  await sleep(120);
  const wsAfter = await cdp.eval(`document.querySelectorAll('.view.active #tc-left .row:not(.kind-same)').length`);
  log('Text: ignore whitespace collapses whitespace-only changes', wsBefore > 0 && wsAfter === 0, 'before=' + wsBefore + ' after=' + wsAfter);

  // 编码：GBK 文件自动识别后不应是乱码，两侧内容相同即无差异。
  const gbL = tmpFile('gb-l.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]));
  const gbR = tmpFile('gb-r.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]));
  await reset();
  await cdp.eval(`window.__q.files = [${j([gbL])}, ${j([gbR])}]; true`);
  await startSession('text');
  await clickOpens(2);
  const gb = await cdp.eval(`
    (() => {
      const v = document.querySelector('.view.active');
      return {
        text: v.querySelector('#tc-left .row')?.textContent || '',
        changed: v.querySelectorAll('#tc-left .row:not(.kind-same)').length,
        title: v.querySelector('[data-role="encoding"]').title,
        options: v.querySelectorAll('[data-role="encoding"] option').length,
      };
    })()
  `);
  log('Text: GBK file is decoded, not garbled', gb.text.includes('中文'), gb.text);
  log('Text: identical GBK files show no difference', gb.changed === 0, 'changedRows=' + gb.changed);
  log('Text: detected encoding is reported', /GB18030/.test(gb.title), gb.title);

  log('Text: encoding picker lists every option', gb.options === 7, 'options=' + gb.options);

  // 查找：命中差异行并选中它
  await reset();
  await cdp.eval(`window.__q.files = [${j([navL])}, ${j([navR])}]; true`);
  await startSession('text');
  await clickOpens(2);
  const found = await cdp.eval(`
    (() => {
      const v = document.querySelector('.view.active');
      const input = v.querySelector('[data-role="find-input"]');
      input.value = 'FIVE';
      v.querySelector('[data-role="find-next"]').click();
      const hit = v.querySelector('#tc-left .row.selected')?.dataset.row ?? null;
      input.value = 'not-present-anywhere';
      v.querySelector('[data-role="find-next"]').click();
      return { hit, status: document.getElementById('status-text').textContent };
    })()
  `);
  log('Text: find selects the matching row', found.hit === '4', JSON.stringify(found));
  log('Text: find reports a miss', /not-present-anywhere/.test(found.status), found.status);

  // 复制到另一侧：未进入编辑模式时拒绝，进入编辑模式后生效
  const copyBefore = await cdp.eval(`
    (() => {
      const v = document.querySelector('.view.active');
      // 先用一次无差异的文件重置状态栏，避免读到上一步「查找未命中」的残留提示。
      v.querySelector('#tc-left .row[data-row="1"]').click();
      // 不能用 textContent 清空状态栏：视图里缓存了状态文本，setStatus 会以为没变而跳过写 DOM。
      document.getElementById('status-text').textContent = 'sentinel';
      // 快捷键监听绑在视图根节点（container）上，事件必须从视图内部冒泡上去。
      v.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      return document.getElementById('status-text').textContent;
    })()
  `);
  const copyAfter = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      v.querySelector('[data-role="edit"]').click();
      v.querySelector('#tc-left .row[data-row="1"]').click();
      v.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await new Promise(r => setTimeout(r, 100));
      return {
        right: [...document.querySelectorAll('#tc-right .row')].map(r => r.querySelector('.code').textContent)[1],
        changed: document.querySelectorAll('#tc-left .row:not(.kind-same)').length,
        status: document.getElementById('status-text').textContent,
      };
    })()
  `);
  log('Text: copy is blocked while editing is off', /\u7f16\u8f91/.test(copyBefore), copyBefore);
  // 行 1 是「TWO / 2」的修改行：复制后右侧变成 TWO，但还有一处差异（FIVE / 5）。
  log('Text: copy to the other side applies in edit mode',
    copyAfter.right === 'TWO' && copyAfter.changed === 1, JSON.stringify(copyAfter));

  // 书签
  const bookmark = await cdp.eval(`
    (() => {
      const v = document.querySelector('.view.active');
      v.querySelector('[data-role="edit"]').click();           // 退出编辑模式
      v.querySelector('#tc-left .row[data-row="2"]').click();
      v.querySelector('[data-role="bookmark-toggle"]').click();
      v.querySelector('#tc-left .row[data-row="5"]').click();
      v.querySelector('[data-role="bookmark-toggle"]').click();
      const marked = v.querySelectorAll('.row.bookmarked').length;
      v.querySelector('[data-role="bookmark-prev"]').click();
      return { marked, at: v.querySelector('#tc-left .row.selected')?.dataset.row, status: document.getElementById('status-text').textContent };
    })()
  `);
  log('Text: bookmarks are marked on both panes and navigable',
    bookmark.marked >= 2 && bookmark.at === '2', JSON.stringify(bookmark));

  // ---------- 4. 文件夹比较 ----------
  await reset();
  await cdp.eval(`window.__q.dirs = [${j(P('left'))}, ${j(P('right'))}]; true`);
  await startSession('folder');
  await pickFolders();
  const folder = await cdp.eval(`
    (() => {
      const rows = [...document.querySelectorAll('.view.active .tree-row')];
      return { n: rows.length,
        classes: rows.map(r => [...r.classList].filter(c => c !== 'tree-row').join(',')),
        status: document.getElementById('status-text').textContent,
        legend: [...document.querySelectorAll('.view.active .legend .it')].length };
    })()
  `);
  log('Folder: tree rendered', folder.n >= 5, 'rows=' + folder.n);
  log('Folder: left-only file classified', folder.classes.some((c) => c.includes('left-orphan')), '');
  log('Folder: both orphan statuses classify', folder.classes.filter((c) => c.indexOf('orphan') >= 0).length >= 2, JSON.stringify(folder.classes));
  log('Folder: status', /比较完成/.test(folder.status), folder.status);
  log('Folder: legend fully populated', folder.legend === 6, 'items=' + folder.legend);
  const names = await cdp.eval(`[...document.querySelectorAll('.view.active .tree-row .name')].map(n => n.textContent)`);
  log('Folder: filenames render correctly', ['a.js','b.txt','t.csv','only-left.txt','only-right.txt'].every(n => names.includes(n)), names.join(','));
  log('Folder: no empty names', names.every(n => n.length > 0), JSON.stringify(names));

  // 双击文件按扩展名打开对应比较窗口（a.js → 文本，t.csv → 表格，bin.dat → 十六进制）
  const dblKind = async (name) => {
    const before = await cdp.eval(`document.querySelectorAll('.tab').length`);
    await cdp.eval(`
      (() => {
        const row = [...document.querySelectorAll('.view.active .tree-row')]
          .find(r => (r.querySelector('.name')?.textContent || '') === ${j(name)});
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return true;
      })()
    `);
    await sleep(900);
    return cdp.eval(`
      (() => {
        const tabs = [...document.querySelectorAll('.tab')];
        const last = tabs[tabs.length - 1];
        return { kind: last ? last.dataset.kind : '', opened: tabs.length > ${before} };
      })()
    `);
  };
  const reopenFolder = async () => {
    await reset();
    await cdp.eval(`window.__q.dirs = [${j(P('left'))}, ${j(P('right'))}]; true`);
    await startSession('folder');
    await pickFolders();
  };
  const kindText = await dblKind('a.js');
  await reopenFolder();
  const kindTable = await dblKind('t.csv');
  await reopenFolder();
  const kindHex = await dblKind('bin.dat');
  log('Folder: double-click opens the matching view',
    kindText.opened && kindTable.opened && kindHex.opened
      && kindText.kind === 'text' && kindTable.kind === 'table' && kindHex.kind === 'hex',
    JSON.stringify({ kindText, kindTable, kindHex }));

  // 按内容比较：内容相同但时间戳不同的文件应判为「相同」
  const sameA = path.join(T, 'left', 'a.js');
  const sameB = path.join(T, 'right', 'a.js');
  await reset();
  await cdp.eval(`window.__q.dirs = [${j(P('left'))}, ${j(P('right'))}]; true`);
  await startSession('folder');
  await cdp.eval(`
    (() => {
      const btn = document.querySelector('.view.active [data-role="toggle-content"]');
      btn.click();
      return btn.classList.contains('active');
    })()
  `);
  await pickFolders();
    const contentMode = await cdp.eval(`
    (() => {
      const rows = [...document.querySelectorAll('.view.active .tree-row')];
      const row = rows.find(r => (r.querySelector('.name')?.textContent || '') === 'a.js');
      return { cls: row ? [...row.classList].filter(c => c !== 'tree-row') : [], btnActive: document.querySelector('.view.active [data-role="toggle-content"]').classList.contains('active') };
    })()
  `);
  log('Folder: content mode is visibly active', contentMode.btnActive, '');
  log('Folder: content comparison classifies a.js as different', contentMode.cls.includes('diff'), JSON.stringify(contentMode.cls));
  void sameA; void sameB;

  // ---------- 5. 十六进制比较 ----------
  await reset();
  await cdp.eval(`window.__q.files = [${j([P('left\\bin.dat')])}, ${j([P('right\\bin.dat')])}]; true`);
  await startSession('hex');
  await clickOpens(2);
  const hex = await cdp.eval(`
    (() => ({
      rows: document.querySelectorAll('.view.active .hex-row').length,
      diff: document.querySelectorAll('.view.active .hex-byte.diff').length,
      status: document.getElementById('status-text').textContent,
    }))()
  `);
  log('Hex: 8 rows total (4 per pane for 64 bytes)', hex.rows === 8, 'rows=' + hex.rows);
  log('Hex: differing bytes highlighted (2 per side)', hex.diff === 4, 'diffCells=' + hex.diff);
  log('Hex: status', /差异字节 2 处/.test(hex.status), hex.status);

  // 长度不同的两个文件：多出来的字节也必须标为差异
  const shortBin = tmpFile('short.bin', 'ABCD');
  const longBin = tmpFile('long.bin', 'ABCDEFGH');
  await reset();
  await cdp.eval(`window.__q.files = [${j([shortBin])}, ${j([longBin])}]; true`);
  await startSession('hex');
  await clickOpens(2);
  const hexLen = await cdp.eval(`
    (() => ({
      leftDiff: document.querySelectorAll('.view.active .pane:first-child .hex-byte.diff').length,
      rightDiff: document.querySelectorAll('.view.active .pane:last-child .hex-byte.diff').length,
      status: document.getElementById('status-text').textContent,
    }))()
  `);
  log('Hex: extra bytes on the longer side are highlighted', hexLen.rightDiff === 4 && hexLen.leftDiff === 0, JSON.stringify(hexLen));
  log('Hex: trailing-length difference counted', /差异字节 4 处/.test(hexLen.status), hexLen.status);

  // 十六进制编辑：偏移:字节 改写一个字节，差异随之减少，保存后磁盘上的字节也变了。
  const editLeft = tmpFile('hex-edit-l.bin', 'ABCD');
  const editRight = tmpFile('hex-edit-r.bin', 'AXCD');
  await reset();
  await cdp.eval(`window.__q.files = [${j([editLeft])}, ${j([editRight])}]; true`);
  await startSession('hex');
  await clickOpens(2);
  const beforeEdit = await cdp.eval(`document.querySelectorAll('.view.active .hex-byte.diff').length`);
  const editResult = await cdp.eval(`
    (async () => {
      const input = document.querySelector('.view.active [data-role="hex-edit"]');
      input.value = '1:58';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise(r => setTimeout(r, 120));
      const status = document.getElementById('status-text').textContent;
      document.querySelector('.view.active [data-role="save"]').click();
      await new Promise(r => setTimeout(r, 1200));
      return {
        diff: document.querySelectorAll('.view.active .hex-byte.diff').length,
        status,
        saveStatus: document.getElementById('status-text').textContent,
      };
    })()
  `);
  const leftBytesAfter = fs.readFileSync(editLeft, 'latin1');
  log('Hex: 1 differing byte before the edit', beforeEdit === 2, 'diff=' + beforeEdit);
  log('Hex: edit removes the difference', editResult.diff === 0, 'diff=' + editResult.diff);
  log('Hex: edit reports the written byte', /58/.test(editResult.status), editResult.status);
  log('Hex: save writes the byte to disk', leftBytesAfter === 'AXCD', JSON.stringify(leftBytesAfter));

  const badEdit = await cdp.eval(`
    (async () => {
      const input = document.querySelector('.view.active [data-role="hex-edit"]');
      input.value = 'zz';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
      return document.getElementById('status-text').textContent;
    })()
  `);
  log('Hex: malformed edit is rejected', /格式不正确/.test(badEdit), badEdit);

  // ---------- 6. 表格比较 ----------
  await reset();
  await cdp.eval(`window.__q.files = [${j([P('left\\t.csv')])}, ${j([P('right\\t.csv')])}]; true`);
  await startSession('table');
  await clickOpens(2);
  const table = await cdp.eval(`
    (() => ({
      tables: document.querySelectorAll('.view.active table.data-table').length,
      diff: document.querySelectorAll('.view.active td.diff').length,
      rightOnly: document.querySelectorAll('.view.active td.only-right').length,
      status: document.getElementById('status-text').textContent,
    }))()
  `);
  log('Table: two tables rendered', table.tables === 2, '');
  log('Table: differing cells highlighted', table.diff > 0, 'cells=' + table.diff);
  log('Table: right-only row marked', table.rightOnly === 3, 'cells=' + table.rightOnly);
  log('Table: status', /差异单元格/.test(table.status), table.status);
  log('Table: status reports both row counts',
    /3 数据行/.test(table.status) && /4 数据行/.test(table.status), table.status);

  // 插入一行不应让后面所有行都变红
  const insL = tmpFile('ins-l.csv', 'a,b\n1,x\n2,y\n3,z\n');
  const insR = tmpFile('ins-r.csv', 'a,b\n1,x\n9,w\n2,y\n3,z\n');
  await reset();
  await cdp.eval(`window.__q.files = [${j([insL])}, ${j([insR])}]; true`);
  await startSession('table');
  await clickOpens(2);
  const tableIns = await cdp.eval(`
    (() => ({
      diff: document.querySelectorAll('.view.active td.diff').length,
      rightOnly: document.querySelectorAll('.view.active td.only-right').length,
      status: document.getElementById('status-text').textContent,
    }))()
  `);
  log('Table: inserted row does not shift the rest', tableIns.diff === 0 && tableIns.rightOnly === 2, JSON.stringify(tableIns));

  // 列顺序不同但表头一致：按表头名称对齐，不应全部判为差异
  const colL = tmpFile('col-l.csv', 'a,b\n1,x\n2,y\n');
  const colR = tmpFile('col-r.csv', 'b,a\nx,1\ny,2\n');
  await reset();
  await cdp.eval(`window.__q.files = [${j([colL])}, ${j([colR])}]; true`);
  await startSession('table');
  await clickOpens(2);
  const tableCols = await cdp.eval(`
    (() => ({
      diff: document.querySelectorAll('.view.active td.diff').length,
      headers: [...document.querySelectorAll('.view.active .pane:last-child th')].map(th => th.textContent),
    }))()
  `);
  log('Table: columns aligned by header name', tableCols.diff === 0, 'diffCells=' + tableCols.diff);
  // 两个窗格必须使用同一套列顺序，否则同一个字段在左右两侧落在不同列，
  // 用户无法横向扫视；右表的 b,a 会被重排成 a,b，对应值也随之重排。
  log('Table: both panes share one column order', tableCols.headers.join(',') === 'a,b', tableCols.headers.join(','));

  // ---------- 7. 三路合并 ----------
  await reset();
  await cdp.eval(`window.__q.files = [${j([P('left\\b.txt')])}, ${j([P('left\\b.txt')])}, ${j([P('right\\b.txt')])}]; true`);
  await startSession('merge');
  await clickOpens(3);
  const merge = await cdp.eval(`
    (() => {
      const v = document.querySelector('.view.active');
      return {
        rows: v.querySelectorAll('.panes.three-way .pane:first-child .row').length,
        rightChanged: v.querySelectorAll('.panes.three-way .kind-right').length,
        outRows: v.querySelectorAll('.panes.output-pane .row').length,
        status: document.getElementById('status-text').textContent,
      };
    })()
  `);
  log('Merge: rows rendered', merge.rows >= 4, 'rows=' + merge.rows);
  log('Merge: right-side change detected', merge.rightChanged > 0, 'rightChanged=' + merge.rightChanged);
  log('Merge: output pane built', merge.outRows >= 4, 'outRows=' + merge.outRows);
  log('Merge: status', /合并就绪/.test(merge.status), merge.status);

  // 冲突：未解决时不允许保存
  await reset();
  await cdp.eval(`window.__q.files = [${j([P('base\\m.txt')])}, ${j([P('left\\m.txt')])}, ${j([P('right\\m.txt')])}]; true`);
  await startSession('merge');
  await clickOpens(3);
  const conflict = await cdp.eval(`
    (() => {
      const v = document.querySelector('.view.active');
      return {
        rows: v.querySelectorAll('.panes.three-way .kind-conflict').length,
        tags: v.querySelectorAll('.panes.output-pane .kind-conflict').length,
      };
    })()
  `);
  log('Merge: conflict detected on divergent sides', conflict.rows === 3, 'conflictRows=' + conflict.rows);
  // 未解决的冲突在输出面板展开成冲突标记：<<<<<<< / 我方内容 / ======= / 对方内容 / >>>>>>>
  log('Merge: unresolved conflict shown with markers', conflict.tags === 5, 'outConflictRows=' + conflict.tags);

  const saveBlocked = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      const save = [...v.querySelectorAll('.session-toolbar .icon-btn')].find(b => b.textContent.includes('保存'));
      save.click();
      await new Promise(r => setTimeout(r, 200));
      return document.getElementById('status-text').textContent;
    })()
  `);
  log('Merge: saving is blocked while conflicts remain', /冲突/.test(saveBlocked) && /未|先/.test(saveBlocked), saveBlocked);

  const resolved = await cdp.eval(`
    (() => {
      const v = document.querySelector('.view.active');
      const first = v.querySelector('.panes.three-way .pane:first-child .row.kind-conflict');
      if (!first) return { ok: false, reason: 'no conflict rows' };
      // 点选冲突块 → 确认选中 → 点「取对方」，每一步都重新查一次 DOM，
      // 因为每次点击都会整块重绘视图。
      first.click();
      const selected = v.querySelectorAll('.panes.three-way .row.selected').length;
      const takeRight = [...v.querySelectorAll('.merge-actions .icon-btn')].find(b => b.dataset.role === 'take-right');
      takeRight.click();
      return {
        ok: true,
        selected,
        resolvedRows: v.querySelectorAll('.panes.output-pane .kind-resolved').length,
        remainingConflicts: v.querySelectorAll('.panes.three-way .kind-conflict').length,
        status: document.getElementById('status-text').textContent,
      };
    })()
  `);
  log('Merge: clicking a conflict selects the whole hunk', resolved.selected === 3, JSON.stringify(resolved));
  log('Merge: take-right resolves the whole hunk', resolved.ok && resolved.resolvedRows === 1, JSON.stringify(resolved));
  log('Merge: remaining conflicts reported in status', /待解决/.test(resolved.status), resolved.status);

  // 全部解决后可以保存，且输出使用统一的换行风格
  const savePath = path.join(os.tmpdir(), 'diffstudio-e2e-merged.txt');
  tmpFiles.push(savePath);
  const saved = await cdp.eval(`
    (async () => {
      window.__q.savePath = ${j(savePath)};
      const v = document.querySelector('.view.active');
      // 解决剩余所有冲突：每次都重新查询按钮，避免持有已从 DOM 移除的节点
      for (let i = 0; i < 10; i++) {
        const row = v.querySelector('.panes.three-way .row.kind-conflict');
        if (!row) break;
        row.click();
        v.querySelector('.merge-actions [data-role="take-right"]').click();
        await new Promise(r => setTimeout(r, 50));
      }
      const save = [...v.querySelectorAll('.session-toolbar .icon-btn')].find(b => b.dataset.role === 'save');
      save.click();
      await new Promise(r => setTimeout(r, 400));
      return document.getElementById('status-text').textContent;
    })()
  `);
  const savedText = fs.existsSync(savePath) ? fs.readFileSync(savePath, 'utf8') : '';
  log('Merge: all conflicts resolved then saved', /已保存/.test(saved), saved);
  const onlyLf = !savedText.includes('\r') && savedText.split('\n').slice(0, -1).length > 0;
  log('Merge: saved output uses a single consistent EOL style', onlyLf && savedText.endsWith('\n'), JSON.stringify(savedText));

// ---------- 8. 文件夹同步 ----------
  await reset();
  await cdp.eval(`window.__q.dirs = [${j(P('left'))}, ${j(P('right'))}]; true`);
  // 删除用例会真的删掉左边这份 fixture，先备份，用例结束后放回，
  // 否则后面的文件夹补丁 / 报告用例会看不到「左侧独有」。
  // 同步用例的「执行」会把建议的复制一并做完：右侧独有、左侧没有的 lf.txt /
  // only-right.txt 会被复制到左侧，「删除」会拿走 only-left.txt。同步前给 left 目录
  // 拍快照，用例后整体还原，否则同一进程里再跑一遍时「独有」的文件就对不上了。
  const onlyLeftPath = path.join(T, 'left', 'only-left.txt');
  const onlyLeftBackup = fs.readFileSync(onlyLeftPath);
  const onlyLeftTime = fs.statSync(onlyLeftPath).mtime;
  const leftSnapshotDir = path.join(T, 'snapshot-left');
  fs.rmSync(leftSnapshotDir, { recursive: true, force: true });
  fs.mkdirSync(leftSnapshotDir, { recursive: true });
  for (const name of fs.readdirSync(path.join(T, 'left'))) {
    fs.copyFileSync(path.join(T, 'left', name), path.join(leftSnapshotDir, name));
  }
  await startSession('sync');
  await pickFolders();
  const sync = await cdp.eval(`
    (() => {
      const sels = [...document.querySelectorAll('.view.active .tree-row select')];
      const counts = {};
      sels.forEach(s => counts[s.value] = (counts[s.value] || 0) + 1);
      return { n: sels.length, counts, status: document.getElementById('status-text').textContent };
    })()
  `);
  log('Sync: per-item actions listed', sync.n >= 5, 'rows=' + sync.n);
  log('Sync: copy actions proposed', (sync.counts['copy-lr'] || 0) + (sync.counts['copy-rl'] || 0) > 0, JSON.stringify(sync.counts));
  log('Sync: status', /\u5206\u6790\u5b8c\u6210/.test(sync.status), sync.status);
  const syncNames = await cdp.eval(`[...document.querySelectorAll('.view.active .tree-row .name')].map(n => n.textContent)`);
  log('Sync: no empty item names', syncNames.every(n => n.length > 0), JSON.stringify(syncNames));

  // 删除是破坏性操作：必须先确认。取消时必须保留文件并把该行恢复为建议操作，
  // 否则下一次点「执行」会把用户已经放弃的删除重新提交一遍。
  const delAborted = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      const row = [...v.querySelectorAll('.tree-row')].find(r => (r.querySelector('.name')?.textContent || '') === 'only-left.txt');
      if (!row) return { error: 'row not found' };
      const sel = row.querySelector('select');
      sel.value = 'del-l';
      sel.dispatchEvent(new Event('change'));
      window.confirm = () => false;
      const run = [...v.querySelectorAll('.session-toolbar .icon-btn')].find(b => b.dataset.role === 'run');
      run.click();
      await new Promise(r => setTimeout(r, 600));
      const stillThere = await window.api.exists(${JSON.stringify(P('left\\only-left.txt'))});
      return { stillThere, op: sel.value, status: document.getElementById('status-text').textContent };
    })()
  `);
  log('Sync: cancelling the confirm keeps the file and resets the row', delAborted.stillThere === true && delAborted.op === 'copy-lr' && /\u53d6\u6d88/.test(delAborted.status), JSON.stringify(delAborted));

  const delRun = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      const row = [...v.querySelectorAll('.tree-row')].find(r => (r.querySelector('.name')?.textContent || '') === 'only-left.txt');
      if (!row) return 'row not found';
      const sel = row.querySelector('select');
      sel.value = 'del-l';
      sel.dispatchEvent(new Event('change'));
      window.confirm = () => true;
      const run = [...v.querySelectorAll('.session-toolbar .icon-btn')].find(b => b.dataset.role === 'run');
      run.click();
      await new Promise(r => setTimeout(r, 1200));
      return document.getElementById('status-text').textContent;
    })()
  `);
  const delGone = await cdp.eval(`window.api.exists(${JSON.stringify(P('left\\only-left.txt'))})`);
  // 失败时把真实的删除错误写进日志：只看到「成功 0 / 失败 4」很难定位。
  const delProbe = delGone === false
    ? 'n/a'
    : await cdp.eval(`(async () => { try { await window.api.delete(${JSON.stringify(P('left\\\\only-left.txt'))}); return 'ipc ok'; } catch (e) { return 'ipc error: ' + e.message; } })()`);
  log('Sync: confirmed delete removes the file and is reported', /\u5220\u9664 1 \u9879/.test(delRun) && delGone === false, delRun + ' exists=' + delGone + ' probe=' + delProbe);
  for (const name of fs.readdirSync(path.join(T, 'left'))) {
    if (!fs.existsSync(path.join(leftSnapshotDir, name))) fs.rmSync(path.join(T, 'left', name), { force: true });
  }
  for (const name of fs.readdirSync(leftSnapshotDir)) {
    const dest = path.join(T, 'left', name);
    // only-left.txt 由下面的 writeFileSync 还原到原始内容与时间戳。
    if (name !== 'only-left.txt' && !fs.existsSync(dest)) fs.copyFileSync(path.join(leftSnapshotDir, name), dest);
  }
  fs.rmSync(leftSnapshotDir, { recursive: true, force: true });
  // only-left.txt 用最初的字节与修改时间还原：复制会改时间戳，影响「相同」判定。
  fs.writeFileSync(onlyLeftPath, onlyLeftBackup);
  fs.utimesSync(onlyLeftPath, onlyLeftTime, onlyLeftTime);


  // 语言项带地球图标，同时用右上角小勾标出当前语言。
  await cdp.eval(`
    (() => {
      const item = [...document.querySelectorAll('#menubar .menu-item')].find(x => x.textContent === '语言');
      item.click();
      return true;
    })()
  `);
  const langChecks = await cdp.eval(`
    [...document.querySelectorAll('.dropdown .mi')].map(r => ({
      text: r.querySelector('.mi-label').textContent,
      icon: !!r.querySelector('.lead .mi-icon svg'),
      check: !!r.querySelector('.lead .lead-check'),
    }))
  `);
  const zhRow = langChecks.find(r => r.text.includes('简体'));
  log('Menu: language rows have an icon', langChecks.length === 2 && langChecks.every(r => r.icon), JSON.stringify(langChecks));
  log('Menu: current language keeps its tick on top of the icon', !!zhRow && zhRow.check && langChecks.filter(r => r.check).length === 1, JSON.stringify(langChecks));
  await cdp.eval(`document.getElementById('menubar').click(); true`);

  // ---------- 9. 语言切换 ----------
  const langSwitched = await cdp.eval(`
    (async () => {
      const item = [...document.querySelectorAll('#menubar .menu-item')].find(x => x.textContent === '语言');
      item.click();
      const en = [...document.querySelectorAll('.dropdown .mi')].find(x => x.textContent.includes('English'));
      en.click();
      await new Promise(r => setTimeout(r, 100));
      return {
        menu: [...document.querySelectorAll('#menubar .menu-item')].map(x => x.textContent),
        title: document.querySelector('#home-view h1').textContent,
        subtitle: document.querySelector('.home-card[data-launch="text"] .d').textContent,
        status: document.getElementById('status-text').textContent,
      };
    })()
  `);
  log('Language: menu bar switches to English', langSwitched.menu.includes('Language'), langSwitched.menu.join(' | '));
  log('Language: home view is translated', /File Compare/.test(langSwitched.title), langSwitched.title);
  log('Language: card descriptions translated', /comparison/i.test(langSwitched.subtitle), langSwitched.subtitle);
  log('Language: status bar translated', langSwitched.status === 'Ready', langSwitched.status);

  // 打开一个会话，确认会话内部的文案也切换
  await reset();
  await cdp.eval(`window.__q.files = [${j([P('left\\a.js')])}, ${j([P('right\\a.js')])}]; true`);
  await startSession('text');
  await clickOpens(2);
  const enSession = await cdp.eval(`
    (() => ({
      tab: document.querySelector('.tab .name')?.textContent,
      legend: [...document.querySelectorAll('.view.active .legend .it')].map(x => x.textContent),
      status: document.getElementById('status-text').textContent,
      placeholders: [...document.querySelectorAll('.view.active .path-input')].map(i => i.placeholder),
    }))()
  `);
  log('Language: session tab title translated', enSession.tab === 'Text Compare', enSession.tab);
  log('Language: session legend translated', enSession.legend.some(t => /Left only/.test(t)), JSON.stringify(enSession.legend));
  log('Language: session status translated', /Left .* Right .* differing rows/.test(enSession.status), enSession.status);
  log('Language: input placeholders translated', /Left file/.test(enSession.placeholders[0] || ''), JSON.stringify(enSession.placeholders));

  // 重新挂载后的会话依然可用（语言切换会重建视图）
  const enReopen = await cdp.eval(`
    (async () => {
      window.__q.files = [${j([P('left\\a.js')])}, ${j([P('right\\a.js')])}];
      const v = document.querySelector('.view.active');
      for (const b of [...v.querySelectorAll('[data-role="open-left"],[data-role="open-right"]')]) {
        b.click(); await new Promise(r => setTimeout(r, 350));
      }
      await new Promise(r => setTimeout(r, 600));
      return document.querySelectorAll('#tc-left .row').length;
    })()
  `);
  log('Language: rebuilt session still compares files', enReopen === 8, 'rows=' + enReopen);

  // 切回中文并确认偏好被记住
  const back = await cdp.eval(`
    (() => {
      window.__diffstudio.setLanguage('zh-CN');
      return {
        lang: window.__diffstudio.getLanguage(),
        stored: localStorage.getItem('diffstudio.lang'),
        title: document.querySelector('#home-view h1').textContent,
      };
    })()
  `);
  log('Language: switching back restores Chinese', back.lang === 'zh-CN' && /文件比较/.test(back.title), JSON.stringify(back));
  log('Language: choice persisted to localStorage', back.stored === 'zh-CN', back.stored);

  // ---------- 文本比较：新增动作（交换 / 对齐 / 替换 / 导出补丁） ----------
  await reset();
  await startSession('text');
  await cdp.eval(`window.__q.files = [${j([P('left\\a.js')])}, ${j([P('right\\a.js')])}]; true`);
  await clickOpens(2);
  const textBase = await cdp.eval(`document.querySelectorAll('#tc-left .row').length`);
  log('Text: baseline rows', textBase > 0, 'rows=' + textBase);

  const swapped = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      const before = [...v.querySelectorAll('.path-input')].map(i => i.value);
      v.querySelector('[data-role="swap"]').click();
      await new Promise(r => setTimeout(r, 700));
      const after = [...v.querySelectorAll('.path-input')].map(i => i.value);
      return { before, after, rows: document.querySelectorAll('#tc-left .row').length };
    })()
  `);
  log('Text: swap exchanges both sides', swapped.after[0] === swapped.before[1] && swapped.after[1] === swapped.before[0], JSON.stringify(swapped.after));
  log('Text: swap keeps a rendered comparison', swapped.rows > 0, 'rows=' + swapped.rows);

  const align = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      // 选中第一处差异中的某一行再对齐
      const rows = [...v.querySelectorAll('#tc-left .row')];
      const target = rows.find(r => /kind-(change|left|right)/.test(r.className));
      if (!target) return { ok: false, reason: 'no diff row' };
      target.click();
      v.querySelector('[data-role="align"]').click();
      await new Promise(r => setTimeout(r, 60));
      return { ok: true, status: document.getElementById('status-text').textContent, rows: rows.length };
    })()
  `);
  log('Text: align accepts the selected row as anchor', align.ok && /对齐/.test(align.status || ''), align.status);

  const isolate = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      const before = document.querySelectorAll('#tc-left .row').length;
      v.querySelector('[data-role="isolate"]').click();
      await new Promise(r => setTimeout(r, 60));
      const during = document.querySelectorAll('#tc-left .row').length;
      v.querySelector('[data-role="isolate"]').click();
      await new Promise(r => setTimeout(r, 60));
      return { before, during, after: document.querySelectorAll('#tc-left .row').length };
    })()
  `);
  log('Text: isolate narrows then restores the view', isolate.during <= isolate.before && isolate.after === isolate.before, JSON.stringify(isolate));

  const replaceLocked = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      v.querySelector('[data-role="find-input"]').value = 'function';
      v.querySelector('[data-role="replace-input"]').value = 'let';
      v.querySelector('[data-role="replace-all"]').click();
      await new Promise(r => setTimeout(r, 60));
      return document.getElementById('status-text').textContent;
    })()
  `);
  log('Text: replace is refused outside edit mode', /编辑/.test(replaceLocked), replaceLocked);

  const replaced = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      v.querySelector('[data-role="edit"]').click();
      v.querySelector('[data-role="replace-all"]').click();
      await new Promise(r => setTimeout(r, 80));
      return {
        status: document.getElementById('status-text').textContent,
        hasVar: [...document.querySelectorAll('#tc-left .row .code, #tc-right .row .code')].some(c => c.textContent.includes('var ')),
      };
    })()
  `);
  log('Text: replace all rewrites both sides', /已替换/.test(replaced.status) && !replaced.hasVar, replaced.status);

  const patchFile = tmpFile('out.patch.txt', '');
  tmpFiles.pop();
  const patchOut = await cdp.eval(`
    (async () => {
      window.__q.savePath = ${j(patchFile)};
      const v = document.querySelector('.view.active');
      v.querySelector('[data-role="export-patch"]').click();
      await new Promise(r => setTimeout(r, 400));
      return document.getElementById('status-text').textContent;
    })()
  `);
  const patchText = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  log('Text: export patch writes a unified diff', /^--- /m.test(patchText) && /^\+\+\+ /m.test(patchText), patchOut);
  fs.unlinkSync(patchFile);

  const wrap = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      v.querySelector('[data-role="word-wrap"]').click();
      v.querySelector('[data-role="tabs-to-spaces"]').click();
      await new Promise(r => setTimeout(r, 60));
      const on = [v.querySelector('.pane.wrap') != null, v.querySelector('.row .code').style.tabSize];
      v.querySelector('[data-role="word-wrap"]').click();
      v.querySelector('[data-role="tabs-to-spaces"]').click();
      return { on, off: !v.querySelector('.pane.wrap') };
    })()
  `);
  log('Text: word wrap and tab width toggle', wrap.on[0] && wrap.on[1] === '4' && wrap.off, JSON.stringify(wrap));

  // ---------- 文件夹比较：交换 / 撤销 / 报告 ----------
  // 复制到临时目录再操作，避免往 test/fixtures 里写文件
  const tmpL = path.join(os.tmpdir(), 'diffstudio-e2e-swapL-' + Date.now());
  const tmpR = path.join(os.tmpdir(), 'diffstudio-e2e-swapR-' + Date.now());
  fs.mkdirSync(path.join(tmpL, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(tmpR, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tmpL, 'only-left.txt'), 'L', 'utf8');
  fs.writeFileSync(path.join(tmpR, 'only-right.txt'), 'R', 'utf8');
  fs.writeFileSync(path.join(tmpL, 'sub', 'same.txt'), 'same', 'utf8');
  fs.writeFileSync(path.join(tmpR, 'sub', 'same.txt'), 'same', 'utf8');
  await reset();
  await startSession('folder');
  await cdp.eval(`window.__q.dirs = [${j(tmpL)}, ${j(tmpR)}]; true`);
  await pickFolders();
  const folderRows = await cdp.eval(`document.querySelectorAll('.tree-row[data-rel]').length`);
  log('Folder: baseline tree', folderRows > 0, 'rows=' + folderRows);

  const folderSwap = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      const before = [...v.querySelectorAll('.path-input')].map(i => i.value);
      v.querySelector('[data-role="swap"]').click();
      await new Promise(r => setTimeout(r, 1200));
      return { before, after: [...v.querySelectorAll('.path-input')].map(i => i.value), rows: document.querySelectorAll('.tree-row[data-rel]').length };
    })()
  `);
  log('Folder: swap exchanges roots and rebuilds tree', folderSwap.after[0] === folderSwap.before[1] && folderSwap.rows > 0, JSON.stringify(folderSwap.after));

  const undoNone = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      v.querySelector('[data-role="undo"]').click();
      await new Promise(r => setTimeout(r, 60));
      return document.getElementById('status-text').textContent;
    })()
  `);
  log('Folder: undo keeps the swapped tree', /撤销/.test(undoNone), undoNone);
  // 交换后右侧（原左）只有 only-left.txt：复制到左侧 → 再撤销
  const undoCopy = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      const row = () => [...v.querySelectorAll('.tree-row[data-rel]')].find(r => r.dataset.rel === 'only-left.txt');
      if (!row()) return { ok: false, reason: 'row missing' };
      row().querySelector('[data-role="copy-left"]').click();
      await new Promise(r => setTimeout(r, 500));
      const afterCopy = row()?.className || '';
      v.querySelector('[data-role="undo"]').click();
      await new Promise(r => setTimeout(r, 1200));
      return {
        ok: true,
        afterCopy,
        afterUndo: row()?.className || '',
        leftDir: v.querySelectorAll('.path-input')[0].value,
      };
    })()
  `);
  log('Folder: undo restores the pre-copy status', undoCopy.ok && /same/.test(undoCopy.afterCopy) && /right-orphan/.test(undoCopy.afterUndo), JSON.stringify(undoCopy));
  log('Folder: undo deletes the file it created', !fs.existsSync(path.join(undoCopy.leftDir || tmpL, 'only-left.txt')), undoCopy.leftDir);


  const reportPath = path.join(os.tmpdir(), 'diffstudio-e2e-folder-report.html');
  const folderReport = await cdp.eval(`
    (async () => {
      window.__q.savePath = ${j(reportPath)};
      document.querySelector('.view.active [data-role="export-report"]').click();
      await new Promise(r => setTimeout(r, 400));
      return document.getElementById('status-text').textContent;
    })()
  `);
  const reportHtml = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '';
  log('Folder: export report writes HTML', /<table>/.test(reportHtml), folderReport);
  if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);

  // ---------- 图片比较：像素比较 / 区域导航 / 容差 ----------
  await reset();
  await startSession('image');
  const img = await cdp.eval(`
    (() => {
      const mk = (w, h, fn) => {
        const data = new Array(w * h * 4).fill(0);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const c = fn(x, y);
          const i = (y * w + x) * 4;
          data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
        }
        return { width: w, height: h, data, size: 100 };
      };
      const left = mk(8, 6, () => [20, 40, 60]);
      const right = mk(8, 6, (x, y) => ((x === 1 && y === 1) || (x === 6 && y === 4) ? [200, 0, 0] : [20, 40, 60]));
      const view = document.querySelector('.view.active');
      // 通过测试钩子直接注入像素，避免依赖磁盘上的图片文件
      const session = window.__diffstudio.lastSession;
      session.__load(left, right);
      const st = session.__state;
      return {
        regions: st.regions.length,
        differing: st.result.differing,
        info: document.querySelector('[data-role="image-info"]').textContent,
      };
    })()
  `);
  log('Image: differing pixels grouped into regions', img.differing === 2 && img.regions === 2, JSON.stringify(img));

  const imgNav = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      v.querySelector('[data-role="next-diff"]').click();
      await new Promise(r => setTimeout(r, 80));
      return document.querySelector('[data-role="nav-status"]').textContent;
    })()
  `);
  log('Image: next difference updates the navigation label', /1|第 1|1 of/.test(imgNav), imgNav);

  const imgTol = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      const tol = v.querySelector('[data-role="tolerance"]');
      tol.value = '255';
      tol.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 120));
      return window.__diffstudio.lastSession.__state.result.differing;
    })()
  `);
  log('Image: tolerance hides colour differences', imgTol === 0, 'differing=' + imgTol);

  // ---------- 文本补丁 ----------
  await reset();
  const patchA = tmpFile('patch-a.txt', 'one\ntwo\nthree\nfour\nfive\n');
  const patchB = tmpFile('patch-b.txt', 'one\ntwo changed\nthree\nfour\nsix\nseven\n');
  await startSession('patch');
  const patchMade = await cdp.eval(`
    (async () => {
      const ds = window.__diffstudio;
      ds.closeAll();
      ds.openTab('patch', window.__fakeApi, { left: ${j(patchA)}, right: ${j(patchB)} });
      await new Promise(r => setTimeout(r, 900));
      const s = ds.lastSession;
      return {
        patch: s ? s.patch : null,
        lines: s ? s.patchLines : 0,
        rows: document.querySelectorAll('.view.active .patch-row').length,
      };
    })()
  `);
  log('Patch: two files produce a unified diff', /^--- /.test(patchMade.patch || '') && /@@ -\d+,\d+ \+\d+,\d+ @@/.test(patchMade.patch || ''), JSON.stringify((patchMade.patch || '').split('\n').slice(0, 3)));
  log('Patch: the preview renders each patch line', patchMade.rows === patchMade.lines && patchMade.lines > 0, `rows=${patchMade.rows} lines=${patchMade.lines}`);

  const patchApplied = await cdp.eval(`
    (async () => {
      document.querySelector('.view.active [data-role="apply-patch"]').click();
      await new Promise(r => setTimeout(r, 700));
      const undo = document.querySelector('.view.active [data-role="undo-patch"]');
      const after = await window.api.readText(${j(patchA)});
      return { text: after.text, undo: undo.disabled };
    })()
  `);
  log('Patch: applying rewrites the original file', patchApplied.text === 'one\ntwo changed\nthree\nfour\nsix\nseven\n', j(patchApplied.text));
  const patchUndone = await cdp.eval(`
    (async () => {
      document.querySelector('.view.active [data-role="undo-patch"]').click();
      await new Promise(r => setTimeout(r, 700));
      const after = await window.api.readText(${j(patchA)});
      return { text: after.text, undo: document.querySelector('.view.active [data-role="undo-patch"]').disabled };
    })()
  `);
  log('Patch: undo restores the original file', patchUndone.text === 'one\ntwo\nthree\nfour\nfive\n' && patchUndone.undo === true, j(patchUndone.text));

  // ---------- 文件夹补丁（只做预览，不动磁盘） ----------
  await reset();
  await cdp.eval(`window.__q.dirs = [${j(P('left'))}, ${j(P('right'))}]; true`);
  await startSession('folder');
  await pickFolders();
  const folderPatch = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      const waitFor = async (fn, ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 100)); }
        return false;
      };
      const btn = v.querySelector('[data-role="folder-patch-btn"]');
      const ready = await waitFor(() => btn.disabled === false, 8000);
      btn.click();
      await new Promise(r => setTimeout(r, 300));
      const panel = v.querySelector('[data-role="folder-patch-body"]');
      const rows = [...v.querySelectorAll('.folder-patch-rows .patch-row')].map(r => r.textContent.trim());
      const summary = v.querySelector('[data-role="folder-patch-summary"]');
      return { hidden: panel.hidden, rows, ready, summary: summary.textContent };
    })()
  `);
  log('Folder patch: a plan is previewed without touching disk', folderPatch.hidden === false && (folderPatch.rows || []).length > 0, j(folderPatch));
  log('Folder patch: the plan includes the left-only file', /only-left/.test(folderPatch.rows.join('|')), j(folderPatch.summary));
  const folderPatchClose = await cdp.eval(`
    (async () => {
      document.querySelector('.view.active [data-role="folder-patch-close"]').click();
      await new Promise(r => setTimeout(r, 120));
      return document.querySelector('.view.active [data-role="folder-patch-body"]').hidden;
    })()
  `);
  log('Folder patch: closing the preview hides it', folderPatchClose === true, String(folderPatchClose));
  const patchUntouched = await cdp.eval(`window.api.exists(${j(P('right/only-left.txt'))})`);
  log('Folder patch: the preview copies nothing', patchUntouched === false, 'right/only-left.txt');

  // ---------- 会话恢复与最近打开 ----------
  // 会话快照：openTab 之后应已写入包含两侧路径的 tab 状态
  const snapshot = await cdp.eval(`
    (() => {
      const ds = window.__diffstudio;
      return ds.sessionSnapshot();
    })()
  `);
  log('Session: snapshot keeps one entry per open tab', snapshot.tabs.length === 1 && snapshot.tabs[0].kind === 'folder', JSON.stringify(snapshot.tabs));

  // 恢复逻辑：用假设置重建会话
  // 注意：不能用 .view.active 取行——语言切换会用 openTab 重建视图，
  // 那时活动标签页可能指向别的会话；直接取文本比较的窗格 id。
  const restored = await cdp.eval(`
    (async () => {
      window.__diffstudio.closeAll();
      window.__diffstudio.restoreForTest({
        active: 1,
        // 文件夹会话排在前面：以前排在后面时，它会在文本视图还没跑完时重建视图，
        // 把文本窗格的行清空。先等文本会话就绪，再切到文件夹页签。
        tabs: [{ kind: 'folder', initial: null }, { kind: 'text', initial: { left: ${j(P('left/a.js'))}, right: ${j(P('right/a.js'))} } }],
      });
      await new Promise(r => setTimeout(r, 800));
      const textTab = [...document.querySelectorAll('.tab')].find(t => t.dataset.kind === 'text');
      textTab.click();
      await new Promise(r => setTimeout(r, 600));
      return {
        tabs: window.__diffstudio.tabCount(),
        active: document.querySelector('.tab.active')?.dataset.kind,
        rows: document.querySelectorAll('#tc-left .row').length,
      };
    })()
  `);
  // 上面为了确认文本窗格有行切到了文本页签；切回恢复时激活的文件夹页签再断言。
  const restoredActive = await cdp.eval(`
    (async () => {
      const tab = [...document.querySelectorAll('.tab')].find(t => t.dataset.kind === 'folder');
      tab.click();
      await new Promise(r => setTimeout(r, 200));
      return document.querySelector('.tab.active')?.dataset.kind;
    })()
  `);
  restored.active = restoredActive;
  log('Session: restore reopens saved tabs and files', restored.tabs === 2 && restored.rows > 0, JSON.stringify(restored));
  log('Session: restore activates the saved active tab', restored.active === 'folder', restored.active);

  // ---------- 回归：本轮修复的缺陷 ----------
  // 1) 隔离视图：长文件里只保留当前差异块（60 行折叠成 7 行），退出后恢复。
  const isoA = tmpFile('iso-a.txt', Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  const isoB = tmpFile('iso-b.txt', Array.from({ length: 60 }, (_, i) => (i === 19 ? 'line 20 modified' : i === 44 ? 'line 45 modified' : `line ${i + 1}`)).join('\n') + '\n');
  await reset();
  await cdp.eval(`window.__q.files = [${j([isoA])}, ${j([isoB])}]; true`);
  await startSession('text');
  await clickOpens(2);
  const iso = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      const n = () => v.querySelector('#tc-left').children.length;
      const btn = v.querySelector('[data-role="isolate"]');
      v.querySelector('[data-role="next-diff"]').click();
      await new Promise(r => setTimeout(r, 120));
      const all = n();
      const selBefore = v.querySelector('#tc-left .row.selected .gutter')?.textContent;
      btn.click();
      await new Promise(r => setTimeout(r, 250));
      const block = {
        rows: n(),
        first: v.querySelector('#tc-left .row .gutter')?.textContent,
        sel: v.querySelector('#tc-left .row.selected .gutter')?.textContent,
        active: btn.classList.contains('active'),
      };
      btn.click();
      await new Promise(r => setTimeout(r, 250));
      return { all, selBefore, block, back: n(), activeAfter: btn.classList.contains('active') };
    })()
  `);
  log('Text: isolate keeps only the current block', iso.all === 60 && iso.block.rows === 7 && iso.block.first === '17', JSON.stringify(iso));
  log('Text: isolate keeps the selected line in place', iso.block.sel === iso.selBefore && iso.selBefore === '20', JSON.stringify(iso.block));
  log('Text: isolate toggles off and restores the whole file', iso.back === 60 && iso.activeAfter === false, 'back=' + iso.back + ' active=' + iso.activeAfter);

  // 2) 忽略空白：行内连续空格也算空白差异（以前只 trim，行内空隙仍判为不同）。
  const innerL = tmpFile('inner-l.txt', 'alpha\nbeta  gamma\nDelta\n');
  const innerR = tmpFile('inner-r.txt', 'alpha\nbeta gamma\ndelta\n');
  await reset();
  await cdp.eval(`window.__q.files = [${j([innerL])}, ${j([innerR])}]; true`);
  await startSession('text');
  await clickOpens(2);
  const inner = await cdp.eval(`
    (async () => {
      const v = document.querySelector('.view.active');
      const left = () => v.querySelectorAll('#tc-left .row:not(.kind-same)').length;
      const out = { c0: left() };
      v.querySelector('[data-role="ignore-case"]').click();
      await new Promise(r => setTimeout(r, 250));
      out.c1 = left();
      v.querySelector('[data-role="ignore-whitespace"]').click();
      await new Promise(r => setTimeout(r, 250));
      out.c2 = left();
      return out;
    })()
  `);
  log('Text: ignore whitespace also collapses inner space runs', inner.c0 === 2 && inner.c1 === 1 && inner.c2 === 0, JSON.stringify(inner));

  // 3) 带路径打开的会话（最近列表 / 命令行 / 恢复）要写进「最近打开」。
  const recentPaths = await cdp.eval(`
    (async () => {
      await new Promise(r => setTimeout(r, 300));
      const s = await window.api.loadSettings();
      return (s.recent || []).map(x => x.path);
    })()
  `);
  log('Recent: a session opened with paths is remembered',
    recentPaths.some((p) => /inner-l\.txt$/.test(p)) && recentPaths.some((p) => /inner-r\.txt$/.test(p)),
    JSON.stringify(recentPaths.slice(0, 4)));

  // 4) 反复开关文本标签页不应叠加键盘监听：未选中任何差异时按一次 Alt+↓ 只应到第 1 处。
  const leak = await cdp.eval(`
    (async () => {
      for (let i = 0; i < 5; i++) {
        window.__diffstudio.closeAll();
        window.__diffstudio.openTab('text', null, { left: ${j(P('left/a.js'))}, right: ${j(P('right/a.js'))} });
        await new Promise(r => setTimeout(r, 300));
      }
      const v = document.querySelector('.view.active');
      const label = () => v.querySelector('[data-role="nav-status"]').textContent;
      const sel = () => {
        const rows = [...v.querySelectorAll('#tc-left .row')];
        return rows.findIndex((r) => r.classList.contains('selected'));
      };
      const before = label();
      v.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 150));
      return { before, after: label(), row: sel(), changeRows: [...v.querySelectorAll('#tc-left .row')].map((r, i) => (r.classList.contains('kind-change') ? i : -1)).filter((i) => i >= 0) };
    })()
  `);
  // 标签里的数字用码点取位，避免终端渲染与编码影响比对；选中行必须落在第一处差异上。
  const navNum = (s) => {
    const cps = [...s].map((c) => c.codePointAt(0));
    const i = cps.lastIndexOf(0x7b2c); // 「第」
    return i < 0 ? NaN : Number(String.fromCodePoint(cps[i + 2]));
  };
  log('Text: Alt+Down reaches the first block after five tab cycles',
    navNum(leak.after) === 1 && leak.row === leak.changeRows[0], JSON.stringify(leak));

  log('No uncaught page exceptions', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== ${results.length - failed.length}/${results.length} checks passed =====`);
  ws.close();
  for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E fatal:', e.message);
  for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (err) { /* ignore */ } }
  process.exit(2);
});
