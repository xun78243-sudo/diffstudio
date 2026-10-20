const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe, minimal API surface to the renderer.
contextBridge.exposeInMainWorld('api', {
  openFiles: (opts) => ipcRenderer.invoke('dialog:open-files', opts),
  openDirectory: () => ipcRenderer.invoke('dialog:open-directory'),
  readText: (filePath, encoding) => ipcRenderer.invoke('fs:read-text', filePath, encoding),
  readBinary: (filePath, maxBytes) => ipcRenderer.invoke('fs:read-binary', filePath, maxBytes),
  listDir: (dirPath, base) => ipcRenderer.invoke('fs:list-dir', dirPath, base),
  readFileForCompare: (filePath, maxBytes) => ipcRenderer.invoke('fs:read-file-for-compare', filePath, maxBytes),
  writeText: (filePath, content, encoding) =>
    ipcRenderer.invoke('fs:write-text', filePath, content, encoding),
  writeBinary: (filePath, bytes) => ipcRenderer.invoke('fs:write-binary', filePath, bytes),
  copy: (src, dest) => ipcRenderer.invoke('fs:copy', src, dest),
  delete: (target) => ipcRenderer.invoke('fs:delete', target),
  mkdir: (dirPath) => ipcRenderer.invoke('fs:mkdir', dirPath),
  rename: (from, to) => ipcRenderer.invoke('fs:rename', from, to),
  move: (from, to) => ipcRenderer.invoke('fs:move', from, to),
  touch: (target, timeMs) => ipcRenderer.invoke('fs:touch', target, timeMs),
  readRaw: (filePath, maxBytes) => ipcRenderer.invoke('fs:read-raw', filePath, maxBytes),
  exists: (target) => ipcRenderer.invoke('fs:exists', target),
  getHome: () => ipcRenderer.invoke('app:get-home'),
  reveal: (target) => ipcRenderer.invoke('app:reveal', target),
  saveFile: (opts) => ipcRenderer.invoke('dialog:save-file', opts),
  readImage: (filePath) => ipcRenderer.invoke('fs:read-image', filePath),
  savePng: (filePath, width, height, data) =>
    ipcRenderer.invoke('fs:save-png', filePath, width, height, data),
  loadSettings: () => ipcRenderer.invoke('app:load-settings'),
  saveSettings: (data) => ipcRenderer.invoke('app:save-settings', data),
  cliTargets: () => ipcRenderer.invoke('app:cli-targets'),
});
