const { app, BrowserWindow, ipcMain, webContents, session, Menu, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

let mainWindow;
const STATE_FILE = () => path.join(app.getPath('userData'), 'state.json');
const registeredPartitions = new Set();

// Janelas independentes abertas via "Abrir em nova janela" (uma por conta ou
// grupo de contas selecionadas juntas).
// chave: ids das contas ordenados e unidos por vírgula (ex: "3" ou "3,7,9") -> BrowserWindow
const accountWindows = new Map();

function createWindow() {
  // Em desenvolvimento (npm start), usa build/icon.png se existir — sem quebrar
  // caso o arquivo ainda não tenha sido criado. No build final (.exe/.AppImage/.dmg)
  // quem define o ícone é a config "build" do package.json (electron-builder).
  const devIconPath = path.join(__dirname, 'build', 'icon.png');
  const devIcon = fs.existsSync(devIconPath) ? devIconPath : undefined;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#05070b',
    title: 'Idle Hub',
    icon: devIcon,
    frame: false, // usamos nossa própria titlebar em HTML — remove a barra nativa e o menu File/Edit/View...
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // remove qualquer resquício do menu padrão (File/Edit/View/Window/Help)
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Estatísticas reais de CPU/RAM
// ---------------------------------------------------------------------------
ipcMain.handle('get-process-stats', async () => {
  const metrics = app.getAppMetrics();
  return metrics.map((m) => ({
    pid: m.pid,
    type: m.type,
    cpu: m.cpu ? m.cpu.percentCPUUsage : 0,
    memoryMB: m.memory ? Math.round(m.memory.workingSetSize / 1024) : 0,
  }));
});

ipcMain.handle('get-pid-for-webcontents', (event, webContentsId) => {
  const wc = webContents.fromId(webContentsId);
  return wc ? wc.getOSProcessId() : null;
});

// ---------------------------------------------------------------------------
// Persistência (salvar/restaurar contas, workspaces e configurações)
// ---------------------------------------------------------------------------
ipcMain.handle('save-state', (event, data) => {
  try {
    fs.writeFileSync(STATE_FILE(), JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Falha ao salvar estado:', err);
    return false;
  }
});

ipcMain.handle('load-state', () => {
  try {
    if (!fs.existsSync(STATE_FILE())) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf-8'));
  } catch (err) {
    console.error('Falha ao carregar estado:', err);
    return null;
  }
});

// ---------------------------------------------------------------------------
// Credenciais de autopreenchimento (logins/senhas por conta) — criptografadas
// com safeStorage (chave por usuário/máquina no sistema), num arquivo próprio
// separado do state.json. Estrutura: { "<accountId>": [ { site, login, senha,
// autoFill, selectors } ] }. Senhas NUNCA vão para o state.json/backup.
// ---------------------------------------------------------------------------
const CREDENTIALS_FILE = () => path.join(app.getPath('userData'), 'credentials.json');

function readAllCredentials() {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE())) return {};
    const buf = fs.readFileSync(CREDENTIALS_FILE());
    const json = safeStorage.decryptString(buf);
    return JSON.parse(json);
  } catch (err) {
    console.error('Falha ao ler credenciais:', err);
    return {};
  }
}

function writeAllCredentials(data) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const encrypted = safeStorage.encryptString(JSON.stringify(data || {}));
    fs.writeFileSync(CREDENTIALS_FILE(), encrypted);
    return true;
  } catch (err) {
    console.error('Falha ao salvar credenciais:', err);
    return false;
  }
}

ipcMain.handle('save-credentials', (event, data) => {
  const all = readAllCredentials();
  const accountId = String(data && data.accountId != null ? data.accountId : '');
  const list = Array.isArray(data && data.list) ? data.list : [];
  all[accountId] = list.map((c) => ({
    site: String(c.site || '').trim(),
    login: String(c.login || '').trim(),
    senha: String(c.senha || ''),
    autoFill: c.autoFill !== false,
    selectors: {
      login: String((c.selectors && c.selectors.login) || ''),
      senha: String((c.selectors && c.selectors.senha) || ''),
    },
  }));
  return { ok: writeAllCredentials(all) };
});

ipcMain.handle('delete-credentials', (event, accountId) => {
  const all = readAllCredentials();
  delete all[String(accountId)];
  return { ok: writeAllCredentials(all) };
});

ipcMain.handle('load-credentials', () => readAllCredentials());

// ---------------------------------------------------------------------------
// Limpar dados de sessão (cookies/localStorage/cache) de uma partição
// ---------------------------------------------------------------------------
ipcMain.handle('clear-partition', async (event, partition) => {
  try {
    await session.fromPartition(partition).clearStorageData();
    return true;
  } catch (err) {
    console.error('Falha ao limpar partição:', err);
    return false;
  }
});

// ---------------------------------------------------------------------------
// Configurações: versões, iniciar com o sistema, exportar/importar, downloads
// ---------------------------------------------------------------------------
ipcMain.handle('get-versions', () => ({
  app: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
}));

ipcMain.handle('get-login-item', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('set-login-item', (event, enabled) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    return true;
  } catch (err) {
    console.error('Falha ao configurar início automático:', err);
    return false;
  }
});

ipcMain.handle('choose-downloads-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('export-state', async (event, data) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'multi-conta-manager-backup.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false };
  try {
    fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf-8');
    return { ok: true, path: result.filePath };
  } catch (err) {
    console.error('Falha ao exportar:', err);
    return { ok: false };
  }
});

ipcMain.handle('import-state', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  try {
    return JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8'));
  } catch (err) {
    console.error('Falha ao importar:', err);
    return null;
  }
});

// Downloads dentro das <webview>: cada conta usa sua própria partição/sessão,
// então registramos o listener de download nela assim que a conta é criada.
function handleDownload(event, item, webContents) {
  const downloadId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const send = (payload) => { if (mainWindow) mainWindow.webContents.send('download-event', { id: downloadId, ...payload }); };
  send({ state: 'started', filename: item.getFilename(), url: item.getURL(), startTime: Date.now() });

  try {
    let settings = {};
    if (fs.existsSync(STATE_FILE())) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf-8'));
      settings = raw.settings || {};
    }
    const folder = settings.downloadsPath || app.getPath('downloads');
    if (settings.perguntarOndeSalvar !== false) {
      const chosen = dialog.showSaveDialogSync(mainWindow, { defaultPath: path.join(folder, item.getFilename()) });
      if (chosen) item.setSavePath(chosen);
      else { item.cancel(); send({ state: 'cancelled' }); return; }
    } else {
      item.setSavePath(path.join(folder, item.getFilename()));
    }
  } catch (err) {
    console.error('Erro ao tratar download:', err);
  }

  item.on('updated', (e, state) => {
    if (state === 'progressing') {
      send({ state: 'progressing', receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() });
    } else if (state === 'interrupted') {
      send({ state: 'interrupted' });
    }
  });
  item.once('done', (e, state) => {
    send({ state: state === 'completed' ? 'completed' : 'cancelled', savePath: item.getSavePath() });
  });
}

function ensurePartitionDownloads(partition) {
  if (!partition || registeredPartitions.has(partition)) return;
  registeredPartitions.add(partition);
  session.fromPartition(partition).on('will-download', handleDownload);
}

ipcMain.on('register-partition-downloads', (event, partition) => {
  ensurePartitionDownloads(partition);
});

// ---------------------------------------------------------------------------
// Abrir uma ou mais contas em uma janela própria (fora do grid) — carrega a
// MESMA UI do Idle Hub (index.html), só que em "modo standalone": um novo
// grid com essas contas pré-carregadas. Cada conta usa a MESMA
// partition/sessão do painel no grid principal — cookies/login continuam
// sincronizados, é a mesma conta sendo exibida em duas janelas, não uma
// cópia. A combinação exata de contas só abre uma janela: pedir de novo com
// o mesmo grupo apenas foca a existente em vez de abrir outra.
// ---------------------------------------------------------------------------
function windowKeyFor(ids) {
  return ids.map(String).sort().join(',');
}

ipcMain.handle('open-account-window', (event, data) => {
  const list = Array.isArray(data && data.accounts) ? data.accounts : [];
  const valid = list
    .filter((a) => a && a.id != null && String(a.partition || '').trim() && /^https?:\/\//i.test(String(a.url || '')))
    .map((a) => ({
      id: a.id,
      name: String(a.name || 'Conta'),
      url: String(a.url).trim(),
      partition: String(a.partition).trim(),
      colorIdx: a.colorIdx || 0,
      iconKey: a.iconKey || 'apps',
      muted: !!a.muted,
      zoomFactor: a.zoomFactor || 1,
    }));
  if (!valid.length) return { ok: false, error: 'invalid-args' };

  const key = windowKeyFor(valid.map((a) => a.id));
  const existing = accountWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return { ok: true, focused: true };
  }

  const windowTitle = valid.length > 1 ? `Idle Hub — ${valid.length} contas` : valid[0].name;

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 420,
    backgroundColor: '#05070b',
    title: windowTitle,
    frame: false, // mesma titlebar custom em HTML do index.html (não a nativa)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
    },
  });

  valid.forEach((a) => ensurePartitionDownloads(a.partition));

  win.on('closed', () => accountWindows.delete(key));
  accountWindows.set(key, win);

  win.loadFile('index.html', {
    query: { standalone: '1', accounts: JSON.stringify(valid) },
  });
  return { ok: true, focused: false };
});

// Fecha a(s) janela(s) própria(s) que contêm essa conta, se existir (usado ao
// fechar/excluir a conta ou limpar seus dados a partir do painel principal).
// Também cobre janelas com várias contas agrupadas.
ipcMain.handle('close-account-window', (event, accountId) => {
  let closed = false;
  for (const [key, win] of accountWindows) {
    if (key.split(',').includes(String(accountId)) && win && !win.isDestroyed()) {
      win.close();
      closed = true;
    }
  }
  return closed;
});

// ---------------------------------------------------------------------------
// Controles de janela custom
// ---------------------------------------------------------------------------
ipcMain.on('win-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});
ipcMain.on('win-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

ipcMain.handle('toggle-fullscreen', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  const next = !win.isFullScreen();
  win.setFullScreen(next);
  return next;
});
ipcMain.handle('is-fullscreen', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win ? win.isFullScreen() : false;
});

ipcMain.handle('open-external', (event, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'idle-hub-update-check', Accept: 'application/vnd.github+json' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
  });
}

// Verificação de atualização via um Gist do GitHub contendo um JSON simples
// tipo { "version": "1.3.0", "url": "...", "message": "..." }. Compara com a
// versão real do app (package.json) — SEM baixar/instalar nada, só avisa.
ipcMain.handle('check-for-updates', async (event, gistUrl) => {
  try {
    const match = String(gistUrl || '').match(/gist\.github(?:usercontent)?\.com\/[^/]+\/([a-f0-9]+)/i);
    const gistId = match ? match[1] : null;
    if (!gistId) return { ok: false, error: 'invalid-url' };

    const data = await fetchJson(`https://api.github.com/gists/${gistId}`);
    if (!data || !data.files) return { ok: false, error: 'gist-error' };

    const fileKeys = Object.keys(data.files);
    const fileKey = fileKeys.find((k) => k.toLowerCase().endsWith('.json')) || fileKeys[0];
    if (!fileKey || !data.files[fileKey] || typeof data.files[fileKey].content !== 'string') {
      return { ok: false, error: 'no-file' };
    }

    let remote;
    try { remote = JSON.parse(data.files[fileKey].content); }
    catch (err) { return { ok: false, error: 'bad-json' }; }
    if (!remote || !remote.version) return { ok: false, error: 'no-version-field' };

    const localVersion = app.getVersion();
    return {
      ok: true,
      upToDate: String(remote.version) === String(localVersion),
      remoteVersion: remote.version,
      localVersion,
      updateUrl: remote.url || null,
      message: remote.message || null,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});
