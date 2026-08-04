const { app, BrowserWindow, Menu, shell, globalShortcut, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const isDev = process.env.NODE_ENV === 'development';
const { createMcpLocalServer } = require('./mcpLocalServer');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      // Production: keep same-origin + block mixed content. Local files load via loadFile.
      // Dev may relax for Vite HMR / local services if needed later — keep secure by default.
      webSecurity: true,
      allowRunningInsecureContent: false,
      // 生产环境也放开 DevTools（菜单 toggleDevTools role 可作为入口）
      devTools: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '../build/icon.png'),
    titleBarStyle: 'default', // 使用默认标题栏，避免重叠问题
    show: false,
    // Windows/Linux 隐藏原生顶部菜单栏（Edit/View/Window），按 Alt 可临时呼出；
    // 应用菜单仍通过 Menu.setApplicationMenu 安装，role 快捷键（Ctrl+C/V、Ctrl+Shift+I 等）照常生效。
    // macOS 顶部菜单为系统级常驻，保持可见。
    autoHideMenuBar: process.platform === 'darwin' ? false : true,
    frame: true, // 保持窗口框架
    backgroundColor: '#ffffff', // 设置背景色，避免白屏闪烁
    titleBarOverlay: false, // 禁用标题栏覆盖
    trafficLightPosition: { x: 20, y: 20 } // macOS 交通灯按钮位置
  });

  // 添加错误处理和加载事件（fallback 只尝试一次，避免 did-fail-load 死循环）
  let fallbackAttempted = false;
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('Failed to load:', errorCode, errorDescription, validatedURL);
    const fallbackPath = path.join(__dirname, '../dist/index.html');
    const alreadyOnFallback =
      typeof validatedURL === 'string' &&
      (validatedURL.includes('/dist/index.html') || validatedURL.endsWith('dist/index.html'));
    if (!fallbackAttempted && !alreadyOnFallback && fs.existsSync(fallbackPath)) {
      fallbackAttempted = true;
      console.log('Loading fallback page:', fallbackPath);
      mainWindow.loadFile(fallbackPath);
    }
  });

  mainWindow.webContents.on('dom-ready', () => {
    if (isDev) console.log('DOM ready');
    // 注入一些基础样式，防止白屏
    mainWindow.webContents.insertCSS('body { background-color: #ffffff; }');
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (isDev) console.log('Page finished loading');
    // 页面加载完成后显示窗口
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // 生产环境：尝试多个可能的路径
    const possiblePaths = [
      path.join(__dirname, '../dist/index.html'),
      path.join(process.resourcesPath, 'app.asar/dist/index.html'),
      path.join(process.resourcesPath, 'app/dist/index.html'),
      path.join(process.resourcesPath, 'dist/index.html'),
      path.join(__dirname, '../build/index.html')
    ];

    let indexPath = null;
    for (const testPath of possiblePaths) {
      try {
        if (fs.existsSync(testPath)) {
          indexPath = testPath;
          break;
        }
      } catch (error) {
        // 忽略文件系统错误，继续尝试下一个路径
        continue;
      }
    }

    if (indexPath) {
      console.log('Loading application from:', indexPath);
      mainWindow.loadFile(indexPath).catch(error => {
        console.error('Failed to load file:', error);
        // 加载失败时显示错误页面
        mainWindow.loadURL('data:text/html,<h1>Application Load Error</h1><p>Could not load the main application. Please restart the app.</p>');
      });
    } else {
      console.error('Could not find index.html in any expected location');
      console.log('Checked paths:', possiblePaths);
      console.log('Current directory:', __dirname);
      console.log('Process resources path:', process.resourcesPath);
      // 显示详细的错误信息
      const errorHtml = '<h1>Application Not Found</h1><p>Could not locate the application files.</p><p>Please reinstall the application.</p>';
      mainWindow.loadURL('data:text/html,' + encodeURIComponent(errorHtml));
    }
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 提供稳定的菜单与编辑快捷键（生产环境）
  const menuTemplate = process.platform === 'darwin' ? [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' }
      ]
    }
  ] : [
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const PROXY_CONFIG_PATH = path.join(app.getPath('userData'), 'proxy-config.json');

function loadProxyConfig() {
  try {
    if (fs.existsSync(PROXY_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(PROXY_CONFIG_PATH, 'utf-8'));
    }
  } catch (e) { console.error('Failed to load proxy config:', e); }
  return { enabled: false, type: 'http', host: '', port: 7890 };
}

function saveProxyConfig(config) {
  fs.writeFileSync(PROXY_CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function applyProxy(config) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (config.enabled && config.host && config.port) {
    let auth = '';
    if (config.username) {
      auth = config.password
        ? encodeURIComponent(config.username) + ':' + encodeURIComponent(config.password) + '@'
        : encodeURIComponent(config.username) + '@';
    }
    const proxyUrl = config.type === 'socks5'
      ? 'socks5://' + auth + config.host + ':' + config.port
      : 'http://' + auth + config.host + ':' + config.port;
    await mainWindow.webContents.session.setProxy({
      proxyRules: proxyUrl,
      proxyBypassRules: '<local>;localhost;127.0.0.1'
    });
    // Never log credentials embedded in proxy URLs
    const redactedProxyUrl = proxyUrl.replace(/\/\/[^@/]+@/, '//***:***@');
    console.log('[Proxy] Applied:', redactedProxyUrl);
  } else {
    await mainWindow.webContents.session.setProxy({ proxyRules: 'direct://' });
    console.log('[Proxy] Disabled, using direct connection');
  }
}

ipcMain.handle('set-proxy', async (event, config) => {
  saveProxyConfig(config);
  await applyProxy(config);
  return { success: true };
});

ipcMain.handle('get-proxy', () => {
  return loadProxyConfig();
});

ipcMain.handle('test-proxy', async (event, config) => {
  const net = require('net');
  const connectToProxy = () => new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.setTimeout(5000);
    socket.on('connect', () => resolve(socket));
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Connection timeout')); });
    socket.on('error', (err) => reject(err));
    socket.connect(config.port, config.host);
  });
  try {
    if (config.type === 'socks5') {
      const socket = await connectToProxy();
      return await new Promise((resolve) => {
        const greeting = config.username
          ? Buffer.from([0x05, 0x02, 0x00, 0x02])
          : Buffer.from([0x05, 0x01, 0x00]);
        socket.setTimeout(5000);
        socket.write(greeting);
        let step = 0;
        let buffered = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          buffered = Buffer.concat([buffered, chunk]);
          if (step === 0) {
            if (buffered.length < 2) return;
            const data = buffered;
            if (data[0] !== 0x05) { socket.destroy(); resolve({ success: false, error: 'Invalid SOCKS5 version' }); return; }
            if (data[1] === 0xFF) { socket.destroy(); resolve({ success: false, error: 'No acceptable auth method' }); return; }
            if (data[1] === 0x02 && config.username && config.password) {
              step = 1;
              buffered = Buffer.alloc(0);
              const userBuf = Buffer.from(config.username, 'utf8');
              const passBuf = Buffer.from(config.password, 'utf8');
              const authReq = Buffer.alloc(3 + userBuf.length + passBuf.length);
              authReq[0] = 0x01; authReq[1] = userBuf.length;
              userBuf.copy(authReq, 2);
              authReq[2 + userBuf.length] = passBuf.length;
              passBuf.copy(authReq, 3 + userBuf.length);
              socket.write(authReq);
            } else { socket.destroy(); resolve({ success: true }); }
          } else if (step === 1) {
            if (buffered.length < 2) return;
            const data = buffered;
            socket.destroy();
            resolve(data[0] === 0x01 && data[1] === 0x00
              ? { success: true }
              : { success: false, error: 'SOCKS5 authentication failed' });
          }
        });
        socket.on('timeout', () => { socket.destroy(); resolve({ success: false, error: 'SOCKS5 handshake timeout' }); });
        socket.on('error', (err) => resolve({ success: false, error: err.message }));
      });
    } else {
      const socket = await connectToProxy();
      return await new Promise((resolve) => {
        socket.setTimeout(5000);
        const authHeader = config.username && config.password
          ? 'Proxy-Authorization: Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64') + '\r\n'
          : '';
        socket.write('CONNECT httpbin.org:443 HTTP/1.1\r\nHost: httpbin.org:443\r\n' + authHeader + '\r\n');
        let responseData = '';
        socket.on('data', (data) => {
          responseData += data.toString();
          if (responseData.includes('\r\n\r\n')) {
            socket.destroy();
            if (responseData.includes('200')) resolve({ success: true });
            else if (responseData.includes('407')) resolve({ success: false, error: 'Proxy authentication required' });
            else resolve({ success: false, error: 'Proxy rejected: ' + (responseData.split('\r\n')[0] || 'Unknown') });
          }
        });
        socket.on('timeout', () => { socket.destroy(); resolve({ success: false, error: 'HTTP proxy handshake timeout' }); });
        socket.on('error', (err) => resolve({ success: false, error: err.message }));
      });
    }
  } catch (e) { return { success: false, error: e.message }; }
});

// ── Local deployment Runner ──
let runnerProcess = null;
let runnerWorkspaceRoot = null;

function runnerScript(name) {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'runner') : path.join(__dirname, '..', 'runner');
  return path.join(base, name);
}

function runnerStateDir() {
  return path.join(app.getPath('userData'), 'runner');
}

function runnerWorkspaceConfigPath() {
  return path.join(runnerStateDir(), 'workspace.json');
}

function getRunnerWorkspaceRoot() {
  if (runnerWorkspaceRoot) return runnerWorkspaceRoot;
  try {
    const saved = JSON.parse(fs.readFileSync(runnerWorkspaceConfigPath(), 'utf8'));
    if (typeof saved.workspaceRoot === 'string') runnerWorkspaceRoot = path.resolve(saved.workspaceRoot);
  } catch {
    // No local Runner workspace has been configured yet.
  }
  return runnerWorkspaceRoot;
}

function safeWorkspacePath(value) {
  const root = getRunnerWorkspaceRoot();
  if (!root || typeof value !== 'string' || !value.trim()) return null;
  const candidate = path.resolve(value);
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? candidate : null;
}

function isLocalBackendUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname) && url.pathname.startsWith('/api');
  } catch {
    return false;
  }
}

function runNodeScript(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `Runner 注册退出，code=${code}`)));
  });
}

ipcMain.handle('runner:start', async (_event, input = {}) => {
  if (runnerProcess && !runnerProcess.killed) return { success: false, alreadyRunning: true, error: '已有本机测试正在执行，请等待其完成后再启动新的测试。' };
  const backendUrl = typeof input.backendUrl === 'string' ? input.backendUrl : '';
  if (!isLocalBackendUrl(backendUrl)) {
    return { success: false, error: 'Runner 仅允许连接本机 /api 后端。' };
  }
  const runnerFile = runnerScript('runner.mjs');
  const registerFile = runnerScript('register.mjs');
  if (!fs.existsSync(runnerFile) || !fs.existsSync(registerFile)) {
    return { success: false, error: '未找到 Runner 文件。请重新安装桌面版。' };
  }
  const stateDir = runnerStateDir();
  fs.mkdirSync(stateDir, { recursive: true });
  const workspaceRoot = typeof input.workspaceRoot === 'string' && input.workspaceRoot.trim() ? input.workspaceRoot.trim() : path.join(stateDir, 'workspace');
  const taskIds = Array.isArray(input.taskIds) ? input.taskIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()) : [];
  if (taskIds.length === 0) return { success: false, error: '请先在项目库中选择要测试的项目。' };
  runnerWorkspaceRoot = path.resolve(workspaceRoot);
  fs.writeFileSync(runnerWorkspaceConfigPath(), JSON.stringify({ workspaceRoot: runnerWorkspaceRoot }, null, 2));
  const env = {
    BACKEND_URL: backendUrl,
    AGENT: ['opencode', 'claude-code', 'codex', 'manual'].includes(input.agent) ? input.agent : 'opencode',
    RUNNER_STATE_FILE: path.join(stateDir, 'runner.json'),
    WORKSPACE_ROOT: runnerWorkspaceRoot,
    ...(typeof input.runnerName === 'string' && input.runnerName.trim() ? { RUNNER_NAME: input.runnerName.trim() } : {}),
    ...(typeof input.model === 'string' && input.model.trim() ? { AGENT_MODEL: input.model.trim() } : {}),
    ...(input.autoApprove === true ? { AGENT_AUTO_APPROVE: '1' } : {}),
    ...(input.pureMode === true ? { AGENT_PURE_MODE: '1' } : {}),
    TASK_IDS: taskIds.join(','),
  };
  try {
    await runNodeScript(registerFile, env);
    runnerProcess = spawn(process.execPath, [runnerFile], {
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: false,
    });
    runnerProcess.on('exit', () => { runnerProcess = null; });
    runnerProcess.on('error', () => { runnerProcess = null; });
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('runner:getStatus', () => ({ running: !!runnerProcess && !runnerProcess.killed }));

ipcMain.handle('runner:open-workspace', async (_event, workspacePath) => {
  const safePath = safeWorkspacePath(workspacePath);
  if (!safePath || !fs.existsSync(safePath)) return { success: false, error: '工作区路径不存在或不属于当前本机 Runner。' };
  const error = await shell.openPath(safePath);
  return error ? { success: false, error } : { success: true };
});

ipcMain.handle('runner:delete-workspace', async (_event, workspacePath) => {
  const safePath = safeWorkspacePath(workspacePath);
  if (!safePath || !fs.existsSync(safePath)) return { success: false, error: '工作区路径不存在或不属于当前本机 Runner。' };
  try {
    fs.rmSync(safePath, { recursive: true, force: true });
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('runner:archive-workspace', async (_event, workspacePath) => {
  const safePath = safeWorkspacePath(workspacePath);
  if (!safePath || !fs.existsSync(safePath)) return { success: false, error: '工作区路径不存在或不属于当前本机 Runner。' };
  const selected = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'], title: '选择测试文件迁移目录' });
  if (selected.canceled || !selected.filePaths[0]) return { success: false, error: '已取消选择迁移目录。' };
  const targetPath = path.join(selected.filePaths[0], path.basename(safePath));
  if (fs.existsSync(targetPath)) return { success: false, error: `目标目录已存在：${targetPath}` };
  try {
    try {
      fs.renameSync(safePath, targetPath);
    } catch (error) {
      if (error && error.code !== 'EXDEV') throw error;
      fs.cpSync(safePath, targetPath, { recursive: true, errorOnExist: true });
      fs.rmSync(safePath, { recursive: true, force: true });
    }
    return { success: true, targetPath };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('runner:test-model', async (_event, input = {}) => {
  const agent = ['opencode', 'claude-code', 'codex'].includes(input.agent) ? input.agent : 'opencode';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const prompt = 'Reply with exactly: HOTCHASING_MODEL_OK';
  const args = agent === 'opencode'
    ? [...(model ? ['--model', model] : []), 'run', prompt]
    : agent === 'claude-code'
      ? ['-p', ...(model ? ['--model', model] : []), prompt]
      : ['exec', '--full-auto', ...(model ? ['--model', model] : []), prompt];
  return new Promise((resolve) => {
    const child = spawn(agent === 'claude-code' ? 'claude' : agent === 'codex' ? 'codex' : 'opencode', args, { windowsHide: true });
    let output = '';
    const append = (chunk) => { output = (output + String(chunk)).slice(-4000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve({ success: false, error: '模型测试超时', output }); }, 60_000);
    child.on('error', (error) => { clearTimeout(timer); resolve({ success: false, error: error.message, output }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ success: code === 0 && output.includes('HOTCHASING_MODEL_OK'), error: code === 0 ? undefined : `CLI 退出 code=${code}`, output }); });
  });
});


// ── MCP local server (read-only tools for agents) ──
let mcpConfig = {
  enabled: false,
  host: '127.0.0.1',
  port: 3927,
  token: '',
};
let mcpSnapshot = null;
const mcpServer = createMcpLocalServer(() => ({
  config: mcpConfig,
  snapshot: mcpSnapshot,
}));

/** Desktop MCP must only bind loopback. */
function normalizeMcpHost(_rawHost) {
  return '127.0.0.1';
}

ipcMain.handle('mcp:setConfig', async (_e, config) => {
  const previousHost = mcpConfig.host;
  const previousPort = mcpConfig.port;
  mcpConfig = {
    enabled: !!config?.enabled,
    host: normalizeMcpHost(config?.host),
    port:
      typeof config?.port === 'number' && config.port >= 1 && config.port <= 65535
        ? config.port
        : 3927,
    token: typeof config?.token === 'string' ? config.token : '',
  };
  const addressChanged = mcpConfig.host !== previousHost || mcpConfig.port !== previousPort;
  if (!mcpConfig.enabled || addressChanged) {
    await mcpServer.stop();
  }
  return { success: true };
});

ipcMain.handle('mcp:getConfig', async () => mcpConfig);

ipcMain.handle('mcp:pushSnapshot', async (_e, snapshot) => {
  mcpSnapshot = snapshot || null;
  return { success: true };
});

ipcMain.handle('mcp:start', async () => {
  try {
    return await mcpServer.start();
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('mcp:stop', async () => mcpServer.stop());

ipcMain.handle('mcp:getStatus', async () => mcpServer.getStatus());

app.whenReady().then(() => {
  createWindow();
  const savedProxy = loadProxyConfig();
  if (savedProxy.enabled && savedProxy.host && savedProxy.port) {
    applyProxy(savedProxy);
  }
  // DevTools shortcut only in development
  if (isDev) {
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && !focused.isDestroyed()) {
        focused.webContents.toggleDevTools();
      }
    });
  }
});

app.on('window-all-closed', () => {
  void mcpServer.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  runnerProcess?.kill();
  globalShortcut.unregisterAll();
  void mcpServer.stop();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
