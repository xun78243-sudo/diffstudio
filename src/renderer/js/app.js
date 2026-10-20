/**
 * DiffStudio 应用外壳。
 *
 * 负责标签页、首页、菜单栏、语言切换，以及把每个比较会话挂载到工作区。
 * Electron 桥（`window.api`）只在启动时读取一次，再通过 context 显式传给
 * 各会话，便于测试时注入替身。
 */

import { createTextCompareSession } from './views/textCompare.js';
import { createFolderCompareSession } from './views/folderCompare.js';
import { createFolderSyncSession } from './views/folderSync.js';
import { createMergeSession } from './views/textMerge.js';
import { createHexCompareSession } from './views/hexCompare.js';
import { createTableCompareSession } from './views/tableCompare.js';
import { createImageCompareSession } from './views/imageCompare.js';
import { createPatchSession } from './views/textPatch.js';
import { createAppContext } from './core/context.js';
import { setStatus } from './core/status.js';
import { LANGS, createTranslator } from './core/i18n.js';
import { icon } from './core/icons.js';

const LANG_KEY = 'diffstudio.lang';
/** 应用设置（最近打开、上次会话）在 userData/settings.json，经主进程读写。 */
const RECENT_LIMIT = 12;

const workspace = document.getElementById('workspace');
const tabbar = document.getElementById('tabbar');
const homeView = document.getElementById('home-view');
const menubar = document.getElementById('menubar');

/** 语言状态：默认简体中文，用户选择后写入 localStorage。 */
let lang = loadLang();
const t = createTranslator(() => lang);

const ctx = createAppContext(window.api, t);

function loadLang() {
  let saved = null;
  try { saved = localStorage.getItem(LANG_KEY); } catch (e) { saved = null; }
  return LANGS.includes(saved) ? saved : 'zh-CN';
}

const FACTORIES = {
  text: createTextCompareSession,
  folder: createFolderCompareSession,
  sync: createFolderSyncSession,
  merge: createMergeSession,
  hex: createHexCompareSession,
  table: createTableCompareSession,
  image: createImageCompareSession,
  patch: createPatchSession,
};

const TAB_TITLE_KEYS = {
  text: 'textCompare.tabTitle',
  folder: 'folderCompare.tabTitle',
  sync: 'folderSync.tabTitle',
  merge: 'merge.tabTitle',
  hex: 'hex.tabTitle',
  table: 'table.tabTitle',
  image: 'image.tabTitle',
  patch: 'patch.tabTitle',
};

let tabs = [];
let activeTab = null;
let nextId = 1;
/** 最近一次打开的会话句柄，只给测试钩子用。 */
let lastSession = null;

/** 状态栏最近文本，仅用于测试钩子观察短提示。 */
const statusHistory = [];
function watchStatus() {
  const node = document.getElementById('status-text');
  if (!node) return;
  const push = () => statusHistory.push(node.textContent);
  push();
  new MutationObserver(push).observe(node, { childList: true, characterData: true, subtree: true });
}

// ---------------------------------------------------------------------------
// 标签页与视图
// ---------------------------------------------------------------------------

/**
 * 视图在「用户确实打开了某个文件」时调用：更新最近打开列表与快照。
 * 命令行 / 最近列表 / 上次会话带进来的路径同样算打开，会出现在「最近打开」里。
 */
function noteSessionPaths(kind, paths) {
  for (const p of paths || []) {
    if (!p) continue;
    if (recent[0] && recent[0].path === p) continue;
    rememberPath(kind, p);
  }
}

function showHome() {
  setActiveView(homeView);
  activeTab = null;
  document.querySelectorAll('.tab').forEach((el) => el.classList.remove('active'));
  setStatus(t('common.ready'));
}

function setActiveView(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  view.classList.add('active');
}

/** 复用会话容器内的内容：重新挂载视图即等于"按当前语言重新渲染"。 */
function mount(tab) {
  tab.view.innerHTML = '';
  tab.ctx = FACTORIES[tab.kind](tab.view, ctx, tab.initial || {});
  // 视图导出了 getState 时把当前路径记为可恢复状态：重启后能还原上次
  // 比较的文件，而不只是打开一个空标签页。
  if (tab.ctx && typeof tab.ctx.getState === 'function') {
    try {
      const s = tab.ctx.getState();
      if (s && typeof s === 'object') tab.initial = s;
    } catch (e) { /* 视图状态不可序列化时保留原 initial */ }
  }
}

// ---------------------------------------------------------------------------
// 设置持久化：最近打开列表 + 上次会话快照
// ---------------------------------------------------------------------------

/** 最近打开的文件/文件夹（最新在前）。 */
let recent = [];
let savedSession = null;
/** 读设置是异步的；读完之前别保存，否则会把空设置覆盖上去。 */
let settingsLoaded = false;

async function loadSettings() {
  try {
    const data = await ctx.api.loadSettings();
    recent = Array.isArray(data.recent) ? data.recent.slice(0, RECENT_LIMIT) : [];
    const session = data.session;
    if (session && Array.isArray(session.tabs)) savedSession = session;
  } catch (e) {
    recent = [];
  } finally {
    settingsLoaded = true;
  }
}

function persistSettings() {
  if (!settingsLoaded) return;
  const session = {
    active: activeTab ? tabs.indexOf(activeTab) : -1,
    tabs: tabs.map((tab) => ({ kind: tab.kind, initial: tab.initial || null })),
  };
  try {
    ctx.api.saveSettings({ recent, session }).catch(() => {});
  } catch (e) { /* 存储失败不影响使用 */ }
}

/** 记录一次打开：用于"最近"菜单，重复项移到最前。 */
function rememberPath(kind, p) {
  if (!p) return;
  const name = p.split(/[\\/]/).filter(Boolean).pop() || p;
  recent = [{ kind, path: p, name }, ...recent.filter((x) => x.path !== p)].slice(0, RECENT_LIMIT);
  persistSettings();
}

/**
 * 重新打开一条"最近"记录：按记录类型放进对应会话的左/基础侧，
 * 用户再挑另一侧即可。
 */
function openRecent(item) {
  if (!FACTORIES[item.kind]) return;
  return openTab(item.kind, { initial: recentInitialFor(item.kind, item.path) });
}

/** 单个路径放哪一侧由会话类型决定：三路合并进"基础"，文件夹同步/比较进左侧。 */
function recentInitialFor(kind, p) {
  if (kind === 'merge') return { base: p };
  return { left: p };
}

/**
 * 两个路径装进同一个会话时的 left/right/base 分配。三路合并基础输入在左
 * （base）、版本在右（left）；其余会话左右并排。
 */
function pairInitialFor(kind, first, second) {
  if (kind === 'merge') return { base: first, left: second, right: '' };
  return { left: first, right: second };
}

/**
 * 重新打开一对文件（典型是 left/a.js 与 right/a.js）：装进同一个会话，
 * 文本/图片/十六进制/表格/文件夹放进左右两侧；三路合并的第二条当作右侧。
 */
function openRecentPair(a, b) {
  if (!a || !b || a.kind !== b.kind || a.path === b.path) return null;
  if (!FACTORIES[a.kind]) return null;
  return openTab(a.kind, { initial: pairInitialFor(a.kind, a.path, b.path) });
}

/**
 * 最近列表的同名文件（left/a.js 与 right/a.js）单看文件名分不清，
 * 所以在名字后面再带上父目录。菜单最多 8 条。
 */
function recentShortPath(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('\\') : parts.join('');
}

function recentMenuItems() {
  // 同类型里最近的另一条：点击一开始就成对打开，省得再逐个挑文件。
  const mateOf = (r) => recent.find((x) => x !== r && x.kind === r.kind && x.path !== r.path) || null;
  const items = recent.slice(0, 8).map((r) => {
    const mate = mateOf(r);
    const label = `${t(TAB_TITLE_KEYS[r.kind] || 'menu.session')} — ${recentShortPath(r.path)}`;
    return { icon: r.kind, label, action: () => (mate ? openRecentPair(r, mate) : openRecent(r)) };
  });
  if (recent.length >= 2 && recent[0].kind === recent[1].kind) {
    items.push({
      label: t('menu.reopenLatestPair'),
      action: () => openRecentPair(recent[0], recent[1]),
    });
  }
  return items;
}

function restoreSession() {
  const session = savedSession;
  if (!session) return false;
  const list = session.tabs.filter((tab) => FACTORIES[tab.kind]);
  if (!list.length) return false;
  const created = list.map((tab) => {
    const init = tab.initial || null;
    const ok = init && (init.left || init.base);
    return openTab(tab.kind, { activate: false, initial: ok ? init : null });
  });
  const idx = Number.isInteger(session.active) ? session.active : created.length - 1;
  const active = created[idx] || created[created.length - 1];
  if (active) activateTab(active);
  // 全部重建完成后再把这份（与新状态一致的）快照写回，避免恢复中途留下
  // 只开了一半的会话。
  persistSettings();
  return true;
}

/**
 * 会话内容发生变化（打开/更换文件）后刷新快照：视图的 getState 只有
 * 在重新挂载时才被读取，所以这里主动问一次当前活动标签页。
 */
function refreshActiveSnapshot() {
  if (!activeTab || !activeTab.ctx || typeof activeTab.ctx.getState !== 'function') return;
  try {
    const st = activeTab.ctx.getState();
    if (st && typeof st === 'object') activeTab.initial = st;
  } catch (e) { /* 视图状态不可序列化时忽略 */ }
  persistSettings();
}

function openTab(kind, { activate = true, initial = null } = {}) {
  if (!FACTORIES[kind]) return null;
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.kind = kind;

  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  nameEl.textContent = t(TAB_TITLE_KEYS[kind]);
  const closeEl = document.createElement('span');
  closeEl.className = 'close';
  closeEl.textContent = '✕';
  closeEl.title = t('menu.closeTab');
  tabEl.append(nameEl, closeEl);

  const viewEl = document.createElement('section');
  viewEl.className = 'view';
  workspace.appendChild(viewEl);

  const tab = { id: nextId++, kind, view: viewEl, el: tabEl, nameEl, ctx: null, initial };
  tabs.push(tab);

  tabEl.addEventListener('click', (e) => {
    if (e.target === closeEl) closeTab(tab);
    else activateTab(tab);
  });

  tabbar.appendChild(tabEl);
  mount(tab);
  lastSession = tab.ctx;
  if (activate) activateTab(tab);
  // 视图在用户真正打开文件后会通过 ctx.notePaths 上报路径；
  // 这里只保存「开了一个空会话」这件事。
  refreshActiveSnapshot();
  persistSettings();
  return tab;
}

function activateTab(tab) {
  activeTab = tab;
  setActiveView(tab.view);
  document.querySelectorAll('.tab').forEach((el) => el.classList.remove('active'));
  tab.el.classList.add('active');
  refreshActiveSnapshot();
  persistSettings();
}

function closeTab(tab) {
  const idx = tabs.indexOf(tab);
  if (idx >= 0) tabs.splice(idx, 1);
  tab.el.remove();
  tab.view.remove();
  if (tab.ctx && tab.ctx.destroy) tab.ctx.destroy();
  if (activeTab === tab) {
    if (tabs.length > 0) activateTab(tabs[tabs.length - 1]);
    else showHome();
  }
  persistSettings();
}

// ---------------------------------------------------------------------------
// 静态文案绑定：带 data-i18n / data-i18n-title 属性的元素在切换语言时更新。
// ---------------------------------------------------------------------------

function applyStaticText() {
  document.documentElement.lang = lang;
  document.title = t('app.title');

  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((node) => {
    node.title = t(node.dataset.i18nTitle);
  });

  tabs.forEach((tab) => {
    tab.nameEl.textContent = t(TAB_TITLE_KEYS[tab.kind]);
    tab.el.querySelector('.close').title = t('menu.closeTab');
  });
}

function setLanguage(next) {
  if (!LANGS.includes(next) || next === lang) return;
  lang = next;
  try { localStorage.setItem(LANG_KEY, next); } catch (e) { /* 忽略存储失败 */ }

  applyStaticText();
  // 重建所有会话视图，让运行时生成的文案也切换到新语言。
  tabs.forEach((tab) => {
    const isActive = activeTab === tab;
    mount(tab);
    if (isActive) activateTab(tab);
  });

  // 菜单栏顶部标签（会话 / 视图 / 语言 / 帮助）必须同步换语言，
  // 否则整个界面都变成英文，只有菜单栏还是中文。
  refreshMenuLabels();
  if (openMenuKey) renderMenu(openMenuKey);
  setStatus(t('common.ready'));
}

// ---------------------------------------------------------------------------
// 菜单栏
// ---------------------------------------------------------------------------

function menuModel() {
  return {
    session: {
      label: t('menu.session'),
      items: [
        { icon: 'text', label: t('textCompare.tabTitle'), action: () => openTab('text') },
        { icon: 'folder', label: t('folderCompare.tabTitle'), action: () => openTab('folder') },
        { icon: 'sync', label: t('folderSync.tabTitle'), action: () => openTab('sync') },
        { icon: 'merge', label: t('merge.tabTitle'), action: () => openTab('merge') },
        { icon: 'hex', label: t('hex.tabTitle'), action: () => openTab('hex') },
        { icon: 'table', label: t('table.tabTitle'), action: () => openTab('table') },
        { icon: 'image', label: t('image.tabTitle'), action: () => openTab('image') },
        { icon: 'patch', label: t('patch.tabTitle'), action: () => openTab('patch') },
        { sep: true },
        ...(recent.length
          ? [
            { label: t('menu.recent'), disabled: true },
            ...recentMenuItems(),
            { label: t('menu.clearRecent'), action: () => { recent = []; persistSettings(); } },
          ]
          : [{ label: t('menu.noRecent'), disabled: true }]),
        { sep: true },
        { icon: 'close', label: t('menu.closeTab'), action: () => activeTab && closeTab(activeTab), disabled: !activeTab },
        { icon: 'close', label: t('menu.closeAllTabs'), action: () => [...tabs].forEach(closeTab), disabled: tabs.length === 0 },
      ],
    },
    view: {
      label: t('menu.view'),
      items: [
        { icon: 'home', label: t('menu.home'), action: () => showHome() },
      ],
    },
    language: {
      label: t('menu.language'),
      items: [
        { icon: 'language', label: t('menu.languageZh'), checked: lang === 'zh-CN', action: () => setLanguage('zh-CN') },
        { icon: 'language', label: t('menu.languageEn'), checked: lang === 'en', action: () => setLanguage('en') },
      ],
    },
    help: {
      label: t('menu.help'),
      items: [
        { icon: 'help', label: t('menu.about'), action: () => setStatus(t('about')) },
      ],
    },
  };
}

let openDropdown = null;
let openMenuKey = null;

function closeDropdown() {
  if (!openDropdown) return;
  openDropdown.remove();
  openDropdown = null;
  openMenuKey = null;
  menubar.querySelectorAll('.menu-item.open').forEach((m) => m.classList.remove('open'));
}

function renderMenu(key) {
  const menuEl = menubar.querySelector(`.menu-item[data-menu="${key}"]`);
  if (!menuEl) return;
  const menu = menuModel()[key];
  if (!menu) return;

  if (openDropdown) openDropdown.remove();

  const dd = document.createElement('div');
  dd.className = 'dropdown';
  dd.setAttribute('role', 'menu');
  for (const item of menu.items || []) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'sep';
      dd.append(sep);
      continue;
    }
    const mi = document.createElement('div');
    mi.className = 'mi' + (item.disabled ? ' disabled' : '') + (item.checked ? ' checked' : '');
    mi.setAttribute('role', 'menuitem');
    if (item.checked) mi.dataset.checked = 'true';
    // 图标栏固定占位（含勾选符号），有没有图标都不影响文字对齐。
    const lead = document.createElement('span');
    lead.className = 'lead';
    const ico = item.icon ? icon(item.icon) : null;
    if (ico) lead.append(ico);
    // 有图标时，当前语言/选项仍用右上角小勾标出。
    if (item.checked && ico) {
      const check = document.createElement('span');
      check.className = 'lead-check';
      check.textContent = '✓';
      lead.append(check);
    } else if (item.checked) {
      lead.textContent = '✓';
    }
    const label = document.createElement('span');
    label.className = 'mi-label';
    label.textContent = item.label;
    mi.append(lead, label);
    mi.addEventListener('click', () => {
      if (item.disabled) return;
      closeDropdown();
      item.action();
    });
    dd.append(mi);
  }

  const rect = menuEl.getBoundingClientRect();
  dd.style.left = rect.left + 'px';
  dd.style.top = rect.bottom + 'px';
  document.body.append(dd);
  menuEl.classList.add('open');
  openDropdown = dd;
  openMenuKey = key;
}

function topMenuText(label) {
  return label;
}

/** 只更新菜单栏顶部标签的文字，不重建 DOM（不打断当前展开状态）。 */
function refreshMenuLabels() {
  const model = menuModel();
  for (const item of menubar.querySelectorAll('.menu-item')) {
    const menu = model[item.dataset.menu];
    if (menu) item.textContent = menu.label;
  }
}

function buildMenubar() {
  menubar.innerHTML = '';
  for (const key of Object.keys(menuModel())) {
    const item = document.createElement('div');
    item.className = 'menu-item';
    item.dataset.menu = key;
    item.textContent = menuModel()[key].label;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openMenuKey === key) closeDropdown();
      else renderMenu(key);
    });
    item.addEventListener('mouseenter', () => {
      if (openDropdown) renderMenu(key);
    });
    menubar.append(item);
  }
}

document.addEventListener('click', closeDropdown);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDropdown();
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

homeView.querySelectorAll('.home-card').forEach((btn) => {
  btn.addEventListener('click', () => openTab(btn.dataset.launch));
});

document.getElementById('btn-new-compare').addEventListener('click', () => openTab('text'));

buildMenubar();
applyStaticText();
watchStatus();
showHome();

// 会话可以请求打开另一个会话（例如文件夹比较双击文件 → 文本比较）。
// 在这里注入，避免视图反过来 import app.js 造成循环依赖。
ctx.openSession = (kind, initial) => openTab(kind, { initial });
// 视图在用户真的打开文件后上报路径（"最近打开"与重启恢复都靠它）。
ctx.notePaths = (kind, paths) => noteSessionPaths(kind, paths);

/**
 * 启动顺序：先读设置，再按优先级打开
 *   1. 命令行参数（diffstudio a.txt b.txt）
 *   2. 上次会话
 *   3. 首页
 * 读设置/参数失败不能阻塞启动，因此每一步单独 try。
 *
 * 延迟到首帧之后执行：启动阶段还没有标签页，立即 persistSettings
 * 会把"空会话"写回去，覆盖掉正要恢复的上次会话。
 */
setTimeout(async () => {
  try {
    await loadSettings();
  } catch (e) { /* 设置不可用就当首次启动 */ }

  let fromCli = null;
  try {
    fromCli = await ctx.api.cliTargets();
  } catch (e) { fromCli = null; }

  if (fromCli && fromCli.paths && fromCli.paths.length) {
    const [l, r] = fromCli.paths;
    const initial = fromCli.kind === 'merge'
      ? { base: l, left: fromCli.paths[1], right: fromCli.paths[2] }
      : { left: l, right: r };
    openTab(fromCli.kind, { initial });
    setStatus(t('app.openedFromCli', { path: fromCli.paths.join('  ↔  ') }));
    return;
  }
  if (!restoreSession()) showHome();
}, 0);

// 测试钩子：允许外部进程用注入的桥打开会话，并读取当前标签页数量。
window.__diffstudio = {
  openTab: (kind, apiOverride, initial) => {
    const saved = ctx.api;
    if (apiOverride) ctx.api = apiOverride;
    try {
      const tab = openTab(kind, { initial: initial || null });
      lastSession = tab ? tab.ctx : null;
      return tab;
    } finally {
      ctx.api = saved;
    }
  },
  closeAll: () => {
    [...tabs].forEach(closeTab);
  },
  getLanguage: () => lang,
  setLanguage: (next) => setLanguage(next),
  tabCount: () => tabs.length,
  /** 最近一次被打开的会话句柄（测试注入像素、直接读取状态用）。 */
  get lastSession() { return lastSession; },
  /** 最近若干次状态栏文本（测试用：短提示可能已被后续操作覆盖）。 */
  statusHistory: () => statusHistory.slice(),
  /** 读取当前标签页的会话快照（与写入磁盘的结构相同）。 */
  sessionSnapshot: () => ({
    active: activeTab ? tabs.indexOf(activeTab) : -1,
    tabs: tabs.map((tab) => ({ kind: tab.kind, initial: tab.initial || null })),
  }),
  /** 用给定的快照走一遍恢复流程（与启动时相同）。 */
  restoreForTest: (snapshot) => {
    savedSession = snapshot;
    return restoreSession();
  },
};
