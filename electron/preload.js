const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  setProxy: (config) => ipcRenderer.invoke('set-proxy', config),
  getProxy: () => ipcRenderer.invoke('get-proxy'),
  testProxy: (config) => ipcRenderer.invoke('test-proxy', config),
  runner: {
    start: (config) => ipcRenderer.invoke('runner:start', config),
    getStatus: () => ipcRenderer.invoke('runner:getStatus'),
    testModel: (config) => ipcRenderer.invoke('runner:test-model', config),
    openWorkspace: (workspacePath) => ipcRenderer.invoke('runner:open-workspace', workspacePath),
    archiveWorkspace: (workspacePath) => ipcRenderer.invoke('runner:archive-workspace', workspacePath),
    deleteWorkspace: (workspacePath) => ipcRenderer.invoke('runner:delete-workspace', workspacePath),
  },
  mcp: {
    setConfig: (config) => ipcRenderer.invoke('mcp:setConfig', config),
    getConfig: () => ipcRenderer.invoke('mcp:getConfig'),
    pushSnapshot: (snapshot) => ipcRenderer.invoke('mcp:pushSnapshot', snapshot),
    start: () => ipcRenderer.invoke('mcp:start'),
    stop: () => ipcRenderer.invoke('mcp:stop'),
    getStatus: () => ipcRenderer.invoke('mcp:getStatus'),
  },
});
