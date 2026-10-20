const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 编码检测/编解码与渲染进程共用一份实现（纯函数，可单测）。
// main.js 是 CommonJS，ES 模块要用动态 import。
let decodeText = (buf) => ({ encoding: 'utf8', text: Buffer.from(buf).toString('utf8') });
let encodeText = (text) => Buffer.from(String(text), 'utf8');
const encReady = import('./src/renderer/js/core/encoding.js')
  .then((m) => {
    decodeText = m.decodeText;
    encodeText = m.encodeText;
    return m;
  })
  .catch(() => null);


// 移除 Electron 默认的原生菜单（File / Edit / View / Window / Help）。
// 应用自身的菜单由页面内的 HTML 菜单栏提供，避免出现两套菜单。
Menu.setApplicationMenu(null);

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#ffffff',
    title: 'DiffStudio',
    // Windows 打包后图标已内嵌进 exe；开发时显式指定，任务栏才不会是 Electron 默认图标。
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染进程不直接接触 Node；需要的能力全部经 preload 暴露的受限 API 调用。
      sandbox: true,
    },
  });

  // 不自动打开外部页面：比较会话只读取本地文件。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  return win;
}

// ---- IPC handlers ----

// Open a file picker (single or multiple)
ipcMain.handle('dialog:open-files', async (e, opts = {}) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])],
    filters: opts.filters,
  });
  return result.canceled ? null : result.filePaths;
});

// Open a directory picker
ipcMain.handle('dialog:open-directory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

/**
 * 路径校验：所有文件操作只接受绝对路径字符串。
 *
 * 这些接口最终都会碰到文件系统，传入相对路径会相对「进程当前工作目录」
 * 解析——那可能是安装目录，删错东西的风险不可接受。这里统一拒绝。
 */
function assertAbs(target) {
  if (typeof target !== 'string' || !target) {
    throw new Error('A path string is required');
  }
  if (!path.isAbsolute(target)) {
    throw new Error('Only absolute paths are allowed: ' + target);
  }
  return target;
}

// Read a text file.
// `encoding` 缺省为 auto：按 BOM / UTF-8 / UTF-16 / GB18030 顺序检测。
// 二进制判定不能只看零字节——UTF-16 文本天然含零字节，只有带 UTF-16 BOM 的
// 才放行；其余含零字节的文件仍按二进制处理。
ipcMain.handle('fs:read-text', async (e, filePath, encoding = 'auto') => {
  await encReady;
  const buf = fs.readFileSync(assertAbs(filePath));
  // 含零字节就没有「行」可言，文本比较没有意义；UTF-16 带 BOM 的除外。
  if (buf.includes(0) && !hasUtf16Bom(buf)) {
    return { binary: true, size: buf.length };
  }
  const decoded = decodeText(buf, encoding);
  return { binary: false, size: buf.length, text: decoded.text, encoding: decoded.encoding };
});

function hasUtf16Bom(buf) {
  return (
    buf.length >= 2 &&
    ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
  );
}

// Read file bytes (for hex view), capped to a max size
ipcMain.handle('fs:read-binary', async (e, filePath, maxBytes = 1024 * 1024) => {
  const fd = fs.openSync(assertAbs(filePath), 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return { size, data: buf };
  } finally {
    fs.closeSync(fd);
  }
});

// Recursively list a directory. Returns immediate children with metadata and
// the path *relative to `base`*, which is used as the stable tree key.
ipcMain.handle('fs:list-dir', async (e, dirPath, base) => {
  const dir = assertAbs(dirPath);
  const root = base ? assertAbs(base) : dir;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .map((d) => {
      const full = path.join(dir, d.name);
      let size = 0;
      let mtimeMs = 0;
      let type = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file';
      try {
        // statSync 会跟随符号链接，指向目录的链接也能正确识别。
        const st = fs.statSync(full);
        size = st.size;
        mtimeMs = st.mtimeMs;
        type = st.isDirectory() ? 'dir' : 'file';
      } catch (err) {
        /* 断开的链接 / 无权限：保留条目，元数据留空 */
      }
      return {
        name: d.name,
        path: full,
        rel: path.relative(root, full),
        type,
        size,
        mtimeMs,
      };
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
});

// Read file contents for a folder-compare content comparison.
// The default limit is deliberately generous: these are only held transiently
// for a byte comparison, and a lower cap silently turns every large file into
// "differs", which then makes the patch planner copy it.
ipcMain.handle('fs:read-file-for-compare', async (e, filePath, maxBytes = 256 * 1024 * 1024) => {
  const file = assertAbs(filePath);
  const st = fs.statSync(file);
  if (st.size > maxBytes) return { tooBig: true, size: st.size };
  const buf = fs.readFileSync(file);
  return { tooBig: false, size: st.size, buffer: buf };
});

// Write text to a file (used by sync, merge save and the text editor).
// `encoding` defaults to utf8; pass the encoding the file was read with so a
// GBK or UTF-16 file is written back in its own encoding.
ipcMain.handle('fs:write-text', async (e, filePath, content, encoding = 'utf8') => {
  await encReady;
  const file = assertAbs(filePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = encodeText(content, encoding);
  fs.writeFileSync(file, Buffer.from(bytes));
  return true;
});

// Write raw bytes to a file (hex editor save).
ipcMain.handle('fs:write-binary', async (e, filePath, bytes) => {
  const file = assertAbs(filePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(Uint8Array.from(bytes)));
  return true;
});

// Copy a file (for sync operations). Directories are created by the caller.
ipcMain.handle('fs:copy', async (e, src, dest) => {
  const from = assertAbs(src);
  const to = assertAbs(dest);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return true;
});

// Delete a file/dir (recursive for dirs)
ipcMain.handle('fs:delete', async (e, target) => {
  const t = assertAbs(target);
  const st = fs.lstatSync(t);
  if (st.isDirectory()) {
    fs.rmSync(t, { recursive: true, force: true });
  } else {
    fs.unlinkSync(t);
  }
  return true;
});

// Create a directory
ipcMain.handle('fs:mkdir', async (e, dirPath) => {
  fs.mkdirSync(assertAbs(dirPath), { recursive: true });
  return true;
});

/**
 * 重命名：只在同一目录内改名。
 *
 * 目标已存在时直接失败，不覆盖——BC 的重命名同样如此，覆盖是独立的破坏性操作。
 */
ipcMain.handle('fs:rename', async (e, from, to) => {
  const src = assertAbs(from);
  const dest = assertAbs(to);
  if (fs.existsSync(dest)) return { ok: false, reason: 'exists' };
  fs.renameSync(src, dest);
  return { ok: true };
});

/**
 * 移动：允许跨目录、跨盘。跨盘时 renameSync 会抛 EXDEV，
 * 这种情况退回"复制 + 删除源"。
 */
ipcMain.handle('fs:move', async (e, from, to) => {
  const src = assertAbs(from);
  const dest = assertAbs(to);
  if (fs.existsSync(dest)) return { ok: false, reason: 'exists' };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
  return { ok: true };
});

/** 修改时间戳（Touch）：只动 mtime，不碰内容。 */
ipcMain.handle('fs:touch', async (e, target, timeMs) => {
  const t = assertAbs(target);
  const ms = Number(timeMs);
  if (!Number.isFinite(ms)) throw new Error('A numeric timestamp is required');
  const date = new Date(ms);
  fs.utimesSync(t, date, date);
  return { ok: true };
});

/** 读取任意大小文件的原始字节：压缩包解析需要完整内容，256 MB 上限够用。 */
ipcMain.handle('fs:read-raw', async (e, filePath, maxBytes = 256 * 1024 * 1024) => {
  const file = assertAbs(filePath);
  const st = fs.statSync(file);
  if (st.size > maxBytes) return { tooBig: true, size: st.size };
  return { tooBig: false, size: st.size, data: fs.readFileSync(file) };
});

/** 检查路径存在与否，供界面在"复制/删除"后判断条目是否已消失。 */
ipcMain.handle('fs:exists', async (e, target) => {
  try {
    fs.statSync(assertAbs(target));
    return true;
  } catch (err) {
    return false;
  }
});

// Get user home directory / default compare roots
ipcMain.handle('app:get-home', async () => {
  return { home: os.homedir(), sep: path.sep, tmp: os.tmpdir() };
});

// Reveal a path in the OS file manager
ipcMain.handle('app:reveal', async (e, target) => {
  shell.showItemInFolder(assertAbs(target));
});

// Save a file via save dialog
ipcMain.handle('dialog:save-file', async (e, opts = {}) => {
  const result = await dialog.showSaveDialog({
    title: opts.title,
    defaultPath: opts.defaultPath,
  });
  return result.canceled ? null : result.filePath;
});

/**
 * 读取图片并解码成 RGBA 像素。
 *
 * 解码用 Electron 自带的 nativeImage，不引入额外依赖；PNG/JPEG/BMP 都由它处理。
 * 像素数组必须是普通数组——structured clone 能传 Uint8ClampedArray，但
 * 经 IPC 后不再是类型化数组，这里直接用 Array 避免调用方误判。
 */
ipcMain.handle('fs:read-image', async (e, filePath) => {
  const file = assertAbs(filePath);
  const st = fs.statSync(file);
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) {
    return { ok: false, error: 'unsupported', size: st.size };
  }
  const size = img.getSize();
  const bmp = img.toBitmap(); // BGRA, 未预乘 alpha
  const data = new Array(bmp.length);
  // BGRA -> RGBA
  for (let i = 0; i < bmp.length; i += 4) {
    data[i] = bmp[i + 2];
    data[i + 1] = bmp[i + 1];
    data[i + 2] = bmp[i];
    data[i + 3] = bmp[i + 3];
  }
  return { ok: true, width: size.width, height: size.height, data, size: st.size };
});

/** 把 RGBA 像素写回 PNG（图片比较的"另存差异图"用）。 */
ipcMain.handle('fs:save-png', async (e, filePath, width, height, data) => {
  const file = assertAbs(filePath);
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i++) buf[i] = data[i];
  // toBitmap 期望 BGRA
  for (let i = 0; i < buf.length; i += 4) {
    const r = buf[i];
    buf[i] = buf[i + 2];
    buf[i + 2] = r;
  }
  const img = nativeImage.createFromBitmap(buf, { width, height });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, img.toPNG());
  return true;
});

/**
 * 应用级设置（保存的会话、最近打开列表等）。
 *
 * 放在 userData 下的单个 JSON 文件里，读写都容错：文件损坏就当作空设置，
 * 不能让一个坏文件导致应用打不开。
 */
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

ipcMain.handle('app:load-settings', async () => {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch (err) {
    return {};
  }
});

ipcMain.handle('app:save-settings', async (e, data) => {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 先写临时文件再改名，避免写到一半崩溃留下半截 JSON。
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data ?? {}, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return true;
});

/**
 * 命令行参数 → 要打开的比较。
 *
 * 支持 `diffstudio a.txt b.txt`、`diffstudio dir1 dir2`，
 * 以及 `diffstudio merge base mine theirs`。路径不存在时跳过。
 */
function parseCliTargets(argv) {
  const args = argv.slice(1).filter((a) => !a.startsWith('-'));
  if (!args.length) return null;
  const targets = [];
  for (const a of args) {
    const abs = path.resolve(a);
    try {
      const st = fs.statSync(abs);
      targets.push({
        path: abs,
        isDir: st.isDirectory(),
        name: path.basename(abs),
      });
    } catch (err) {
      /* 不存在的路径直接忽略 */
    }
  }
  if (!targets.length) return null;
  if (args[0] === 'merge' && targets.length >= 3) {
    return { kind: 'merge', paths: targets.slice(1, 4).map((x) => x.path) };
  }
  if (targets.length >= 2) {
    const kind = targets[0].isDir || targets[1].isDir ? 'folder' : 'text';
    return { kind, paths: [targets[0].path, targets[1].path] };
  }
  return { kind: targets[0].isDir ? 'folder' : 'text', paths: [targets[0].path] };
}

let pendingCli = null;

ipcMain.handle('app:cli-targets', async () => {
  const out = pendingCli;
  pendingCli = null;
  return out;
});

app.whenReady().then(() => {
  // 开发时 argv 形如 [electron, '.', 'a.txt', 'b.txt']，第二项是应用目录，
  // 直接丢掉；打包后 argv 以 exe 路径开头。
  const raw = process.argv[0] === process.execPath && !app.isPackaged
    ? [path.basename(process.argv[0]), ...process.argv.slice(2)]
    : process.argv;
  createWindow();
  pendingCli = parseCliTargets(raw);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
