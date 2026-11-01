// Schlanke SoundCloud-Desktop-App: Electron-Wrapper um soundcloud.com
const {
  app, BrowserWindow, Menu, Tray, shell, nativeImage, session, screen, dialog, clipboard, Notification, ipcMain
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const { createSettings } = require('./lib/settings');
const { sanitizeFilename, uniquePath, writeSidecar } = require('./lib/downloads');
const { createLocalApi } = require('./lib/localapi');
const { createRelay } = require('./jam/relay');
const { createJamHost, parseInvite } = require('./jam/host');

const START_URL = 'https://soundcloud.com';
const ICON = path.join(__dirname, 'icon.png');
const PARTITION = 'persist:soundcloud'; // Login bleibt erhalten
const PROTOCOL = 'scjam';
// Interne Links, die in einem neuen Fenster aufgehen sollen, während Musik läuft: per History-API im
// laufenden Player navigieren statt die Seite neu zu laden (sonst reißt die Wiedergabe ab).
// Auf false setzen, falls das auf soundcloud.com nicht sauber funktioniert (dann wird normal geladen).
const SPA_NAV_WHILE_PLAYING = true;

const startHidden = process.argv.includes('--hidden'); // z. B. für Autostart oder DJ-Setup
const devMode = process.argv.includes('--dev');

// Medientasten (Play/Pause/Next/Prev) + MPRIS unter Linux (playerctl, KDE/GNOME-Mediensteuerung)
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,MediaSessionService');
// Audio darf ohne Klick starten, auch wenn das Fenster im Hintergrund ist
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let tray = null;
let quitting = false;
let cleanedUp = false;
let settings = null;
let localApi = null;
let jamHost = null;
let jamRelay = null;       // eingebauter Relay (nur solange der Host eine Jam laufen hat)
let guestWin = null;
let hiddenNoticeShown = false;
let lastJamError = '';
let saveTimer = null;
const recentDownloads = [];
let lastState = { track: null, playing: false, position: 0, source: 'none', updatedAt: null };

// ---------------------------------------------------------------- URL-Regeln
// Nur https auf soundcloud.com (+ Subdomains) gilt als "intern"; http wird auf https hochgestuft.
function normalizeInternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const h = u.hostname;
    if (h !== 'soundcloud.com' && !h.endsWith('.soundcloud.com')) return null;
    u.protocol = 'https:';
    return u.href;
  } catch { return null; }
}
// Login-Dialoge (Google/Apple/Facebook) dürfen als Popup öffnen
const AUTH_HOSTS = ['accounts.google.com', 'appleid.apple.com', 'www.facebook.com', 'secure.soundcloud.com', 'api.soundcloud.com'];
function isAuthPopup(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && AUTH_HOSTS.includes(u.hostname); } catch { return false; }
}
// Extern nur Web-/Mail-Links öffnen (keine file:-, ms-:- oder sonstigen Schemata)
function openExternalSafe(url) {
  try { if (['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)) shell.openExternal(url); } catch {}
}

function navigateInternal(target) {
  let u;
  try { u = new URL(target); } catch { return; }
  if (SPA_NAV_WHILE_PLAYING && lastState.playing && u.hostname === 'soundcloud.com') {
    const p = JSON.stringify(u.pathname + u.search + u.hash);
    win.webContents.executeJavaScript(
      `(()=>{try{history.pushState({},'',${p});window.dispatchEvent(new PopStateEvent('popstate',{state:{}}));return true}catch(e){return false}})()`
    ).then((ok) => { if (!ok) win.loadURL(target); }).catch(() => win.loadURL(target));
  } else {
    win.loadURL(target);
  }
}

// ---------------------------------------------------------------- Fensterposition/-größe
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function onScreen(b) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const ow = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const oh = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return ow >= 100 && oh >= 100;
  });
}
function loadState() {
  const def = { width: 1200, height: 800 };
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const out = { width: Math.max(600, Number(s.width) || def.width), height: Math.max(400, Number(s.height) || def.height), maximized: s.maximized === true };
    if (Number.isFinite(s.x) && Number.isFinite(s.y) && onScreen({ x: s.x, y: s.y, width: out.width, height: out.height })) { out.x = s.x; out.y = s.y; }
    return out;
  } catch { return def; }
}
function saveStateNow() {
  clearTimeout(saveTimer);
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch {}
}
// Resize/Move feuern hunderte Events - gebündelt speichern
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveStateNow, 400); }

// ---------------------------------------------------------------- Session (UA, Rechte, Downloads)
function setupSession() {
  const ses = session.fromPartition(PARTITION);
  // Chrome-ähnlicher User-Agent für die GANZE Session, damit auch Login-Popups ihn nutzen
  const ua = ses.getUserAgent()
    .replace(/\sElectron\/[\d.]+/, '')
    .replace(/\s?soundcloud-desktop\/[\d.]+/i, '');
  ses.setUserAgent(ua);
  app.userAgentFallback = ua;

  // Berechtigungen: nur das, was die Seite braucht, und nur für soundcloud.com
  const allowed = new Set(['notifications', 'fullscreen', 'clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => cb(allowed.has(permission) && !!normalizeInternal(details.requestingUrl)));
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && !!normalizeInternal(origin));

  ses.on('will-download', onDownload);
  return ses;
}

const downloadDir = () => settings.get().downloadDir || path.join(app.getPath('music'), 'SoundCloud');

// Downloads, die SoundCloud selbst anbietet (Button "Download file"), landen im Download-Ordner.
// Andere Programme warten auf "<datei>.sc.json" - die entsteht erst, wenn die Datei komplett ist.
function onDownload(_e, item) {
  const dir = downloadDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const filePath = uniquePath(dir, sanitizeFilename(item.getFilename()));
  item.setSavePath(filePath);
  const context = {
    pageUrl: win ? win.webContents.getURL() : null,
    pageTitle: win ? win.webContents.getTitle() : null,
    nowPlaying: lastState.track ? { title: lastState.track.title, artist: lastState.track.artist, trackUrl: lastState.track.url } : null
  };
  item.once('done', (_ev, state) => {
    const entry = { file: filePath, state, at: new Date().toISOString() };
    if (state === 'completed') {
      try { entry.sidecar = writeSidecar(filePath, context).path; } catch (err) { entry.error = String(err.message || err); }
      notify('Download fertig', path.basename(filePath));
    }
    recentDownloads.unshift(entry);
    recentDownloads.length = Math.min(recentDownloads.length, 50);
    if (localApi) localApi.emit('download', entry);
  });
}

// ---------------------------------------------------------------- Player-Status & Befehle (preload.js)
function sanitizeState(s) {
  if (!s || typeof s !== 'object') return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  let track = null;
  if (s.track && typeof s.track === 'object') {
    track = {
      url: typeof s.track.url === 'string' && normalizeInternal(s.track.url) ? s.track.url : null,
      title: str(s.track.title, 200),
      artist: str(s.track.artist, 200),
      duration: Number.isFinite(s.track.duration) ? s.track.duration : null
    };
  }
  return {
    track, playing: s.playing === true,
    position: Number.isFinite(s.position) ? Math.max(0, s.position) : 0,
    source: s.source === 'dom' || s.source === 'mediasession' ? s.source : 'none'
  };
}

const pending = new Map();
let rpcId = 0;
function rpc(channel, payload) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve({ ok: false });
    const id = ++rpcId;
    const t = setTimeout(() => { pending.delete(id); resolve({ ok: false }); }, 1500);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
    win.webContents.send(channel, { id, ...payload });
  });
}
const runPlayerCommand = async (cmd) => !!(await rpc('sc:command', { cmd })).ok;

function toJamState(s) {
  return s.track && s.track.url
    ? { track: { url: s.track.url, title: s.track.title, artist: s.track.artist, duration: s.track.duration }, playing: s.playing, position: s.position }
    : { track: null, playing: false, position: 0 };
}

function setupIpc() {
  const fromMain = (e) => win && !win.isDestroyed() && e.sender === win.webContents;
  ipcMain.on('sc:state', (e, raw) => {
    if (!fromMain(e)) return;
    const s = sanitizeState(raw);
    if (!s) return;
    lastState = { ...s, updatedAt: Date.now() };
    if (localApi) localApi.emit('now-playing', publicState());
    if (jamHost && jamHost.isRunning()) jamHost.push(toJamState(s));
  });
  const ack = (e, msg) => { if (fromMain(e) && msg && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  ipcMain.on('sc:command-ack', ack);
  ipcMain.on('sc:debug-result', ack);
}

const publicState = () => ({
  ...lastState,
  jam: { running: !!(jamHost && jamHost.isRunning()), listeners: jamHost ? jamHost.listeners() : 0 }
});

// ---------------------------------------------------------------- Lokale API für andere Programme (DJ-Player)
function startLocalApi() {
  const cfg = settings.get().localApi;
  if (!cfg.enabled) return;
  const infoFile = path.join(app.getPath('userData'), 'local-api.json');
  let token = '';
  try { token = JSON.parse(fs.readFileSync(infoFile, 'utf8')).token || ''; } catch {}
  if (!/^[a-f0-9]{64}$/.test(token)) token = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(infoFile, JSON.stringify({ port: cfg.port, token }, null, 2), { mode: 0o600 }); } catch {}
  localApi = createLocalApi({
    port: cfg.port, token,
    getState: publicState,
    runCommand: runPlayerCommand,
    openUrl: async (url) => { const t = normalizeInternal(url); if (!t || !win) return false; navigateInternal(t); return true; },
    getDownloads: () => recentDownloads
  });
  localApi.listen().catch((e) => { console.error('Lokale API nicht gestartet:', e.message); localApi = null; });
}

// ---------------------------------------------------------------- Jam
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return '127.0.0.1';
}

function notify(title, body) {
  try { if (Notification.isSupported()) new Notification({ title, body, icon: ICON, silent: true }).show(); } catch {}
}

function onJamStatus(s) {
  if (s.error && s.error !== lastJamError) notify('Jam', s.error);
  lastJamError = s.error || '';
  if (s.running === false && jamHost && !jamHost.isRunning() && s.error) stopJam();
  refreshUi();
}

async function startJam() {
  if (jamHost && jamHost.isRunning()) return;
  const cfg = settings.get().jam;
  try {
    let relayBase = cfg.relay;
    if (!relayBase) {   // kein externer Relay konfiguriert: eigenen eingebauten starten (Freunde im selben Netz)
      jamRelay = createRelay();
      const port = await jamRelay.listen(cfg.port, '0.0.0.0');
      relayBase = `http://${lanIp()}:${port}`;
    }
    jamHost = createJamHost({ relayBase, onStatus: onJamStatus });
    const invite = await jamHost.start();
    if (lastState.track && lastState.track.url) jamHost.push(toJamState(lastState));
    clipboard.writeText(invite);
    notify('Jam gestartet', 'Einladungslink liegt in der Zwischenablage.');
  } catch (e) {
    await stopJam();
    dialog.showErrorBox('Jam konnte nicht gestartet werden', String(e.message || e));
  }
  refreshUi();
}

async function stopJam() {
  const h = jamHost, r = jamRelay;
  jamHost = null; jamRelay = null;
  if (h) await h.stop();
  if (r) await r.close();
  refreshUi();
}

function openGuestWindow({ relay, room }) {
  if (guestWin && !guestWin.isDestroyed()) guestWin.close();
  runPlayerCommand('pause');   // nicht doppelt Musik hören
  guestWin = new BrowserWindow({
    width: 760, height: 640, minWidth: 420, minHeight: 480,
    title: 'SoundCloud Jam', icon: ICON, backgroundColor: '#121212',
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  guestWin.setMenu(null);
  guestWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  guestWin.webContents.on('will-navigate', (e) => e.preventDefault());
  guestWin.loadFile(path.join(__dirname, 'jam', 'guest.html'), { query: { relay, room } });
}

function handleInvite(text) {
  const inv = parseInvite(text);
  if (!inv) { dialog.showErrorBox('Ungültiger Jam-Link', 'Erwartet wird ein Link der Form scjam://join/…'); return false; }
  openGuestWindow(inv);
  return true;
}
const joinFromClipboard = () => handleInvite(clipboard.readText());

// ---------------------------------------------------------------- Fenster
function createWindow() {
  const state = loadState();
  win = new BrowserWindow({
    ...state,
    show: false,
    minWidth: 600,
    minHeight: 400,
    title: 'SoundCloud',
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: '#121212',
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false      // Musik läuft im Hintergrund ohne Ruckeln weiter
    }
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });

  win.loadURL(START_URL);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAuthPopup(url)) return { action: 'allow' };
    const internal = normalizeInternal(url);
    if (internal) navigateInternal(internal);
    else openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const internal = normalizeInternal(url);
    if (!internal) { e.preventDefault(); openExternalSafe(url); }
    else if (internal !== url) { e.preventDefault(); win.loadURL(internal); }   // http -> https
  });
  win.webContents.on('context-menu', (_e, p) => {
    const items = [];
    if (p.linkURL) {
      items.push(
        { label: 'Link im Browser öffnen', click: () => openExternalSafe(p.linkURL) },
        { label: 'Link-Adresse kopieren', click: () => clipboard.writeText(p.linkURL) }
      );
    }
    if (p.isEditable) {
      if (items.length) items.push({ type: 'separator' });
      items.push(
        { role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy },
        { role: 'paste', enabled: p.editFlags.canPaste }, { role: 'selectAll' }
      );
    } else if (p.selectionText) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ role: 'copy' });
    }
    if (!items.length) {
      const nav = win.webContents.navigationHistory;
      items.push(
        { label: 'Zurück', enabled: nav.canGoBack(), click: () => nav.goBack() },
        { label: 'Vor', enabled: nav.canGoForward(), click: () => nav.goForward() },
        { label: 'Neu laden', click: () => win.webContents.reload() }
      );
    }
    if (devMode) items.push({ type: 'separator' }, { label: 'Element untersuchen', click: () => win.webContents.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);

  // Schließen = in den Tray ausblenden, damit die Musik weiterspielt - aber nur, wenn es einen Tray
  // gibt und die Einstellung aktiv ist. Sonst würde das Fenster ohne Weg zurück verschwinden.
  win.on('close', (e) => {
    saveStateNow();
    if (quitting) return;
    if (tray && settings.get().closeToTray) {
      e.preventDefault();
      win.hide();
      if (!hiddenNoticeShown) {
        hiddenNoticeShown = true;
        notify('SoundCloud läuft weiter', 'Im Tray-Symbol oder durch erneutes Starten der App wieder öffnen.');
      }
    }
  });
  win.on('closed', () => { win = null; if (!quitting) app.quit(); });
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
const toggleWindow = () => (win && win.isVisible() ? win.hide() : showWindow());

// ---------------------------------------------------------------- Menüs
function jamItems() {
  const running = !!(jamHost && jamHost.isRunning());
  return [
    running
      ? { label: `Jam beenden (${jamHost.listeners()} Hörer)`, click: stopJam }
      : { label: 'Jam starten (ich bin Host)', click: startJam },
    { label: 'Einladungslink kopieren', enabled: running, click: () => clipboard.writeText(jamHost.invite()) },
    { label: 'Jam aus Zwischenablage beitreten', click: joinFromClipboard }
  ];
}

function buildMenu() {
  const nav = () => win && win.webContents.navigationHistory;
  return Menu.buildFromTemplate([
    { label: 'Datei', submenu: [
      { label: 'Download-Ordner öffnen', click: () => { try { fs.mkdirSync(downloadDir(), { recursive: true }); } catch {} shell.openPath(downloadDir()); } },
      { label: 'Download-Ordner wählen …', click: async () => {
        const r = await dialog.showOpenDialog({ defaultPath: downloadDir(), properties: ['openDirectory', 'createDirectory'] });
        if (!r.canceled && r.filePaths[0]) settings.update({ downloadDir: r.filePaths[0] });
      } },
      { type: 'separator' },
      { label: 'Beenden', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } }
    ] },
    { label: 'Ansicht', submenu: [
      { role: 'reload' }, { type: 'separator' },
      { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' },
      { role: 'togglefullscreen' }
    ] },
    { label: 'Navigation', submenu: [
      { label: 'Zurück', accelerator: 'Alt+Left', click: () => nav() && nav().canGoBack() && nav().goBack() },
      { label: 'Vor', accelerator: 'Alt+Right', click: () => nav() && nav().canGoForward() && nav().goForward() },
      { label: 'Startseite', click: () => win && win.loadURL(START_URL) }
    ] },
    { label: 'Jam', submenu: jamItems() },
    { label: 'Einstellungen', submenu: [
      { label: 'Schließen blendet ins Tray aus', type: 'checkbox', checked: settings.get().closeToTray,
        click: (i) => { settings.update({ closeToTray: i.checked }); refreshUi(); } },
      { label: 'Lokale API für andere Programme (Neustart nötig)', type: 'checkbox', checked: settings.get().localApi.enabled,
        click: (i) => { settings.update({ localApi: { enabled: i.checked } }); refreshUi(); } }
    ] },
    { label: 'Debug', submenu: [
      { label: 'Scraper-Zustand in Zwischenablage', click: async () => {
        const r = await rpc('sc:debug', {});
        clipboard.writeText(JSON.stringify(r.ok === false && !r.state ? { error: 'keine Antwort vom Player' } : r, null, 2));
        notify('Debug', 'Scraper-Zustand liegt in der Zwischenablage.');
      } },
      { role: 'toggleDevTools' }
    ] }
  ]);
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Anzeigen / Verbergen', click: toggleWindow },
    { type: 'separator' },
    ...jamItems(),
    { type: 'separator' },
    { label: 'Beenden', click: () => { quitting = true; app.quit(); } }
  ]);
}

function refreshUi() {
  if (!settings) return;
  Menu.setApplicationMenu(buildMenu());
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
    const running = jamHost && jamHost.isRunning();
    tray.setToolTip(running ? `SoundCloud – Jam: ${jamHost.listeners()} Hörer` : 'SoundCloud');
  }
}

function createTray() {
  const img = nativeImage.createFromPath(ICON);
  if (img.isEmpty()) return;   // ohne Icon kein Tray - dann schließt der Schließen-Button die App wirklich
  const size = process.platform === 'win32' ? 16 : 22;
  tray = new Tray(img.resize({ width: size, height: size }));
  tray.setToolTip('SoundCloud');
  tray.on('click', toggleWindow);   // unter Linux wird "click" oft nicht geliefert - dort gilt das Kontextmenü
}

// ---------------------------------------------------------------- Start / Ende
async function cleanup() {
  try { await stopJam(); } catch {}
  try { if (localApi) await localApi.close(); } catch {}
}

function inviteFromArgv(argv) { return (argv || []).find((a) => typeof a === 'string' && a.startsWith(`${PROTOCOL}://`)); }

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (process.defaultApp) {
    if (process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
  app.on('second-instance', (_e, argv) => {
    const link = inviteFromArgv(argv);
    if (link) handleInvite(link); else showWindow();
  });
  app.on('open-url', (e, url) => { e.preventDefault(); if (app.isReady()) handleInvite(url); });

  app.whenReady().then(() => {
    settings = createSettings(path.join(app.getPath('userData'), 'settings.json'));
    setupSession();
    setupIpc();
    createWindow();
    createTray();
    refreshUi();
    startLocalApi();
    const link = inviteFromArgv(process.argv);
    if (link) handleInvite(link);
  });
  app.on('before-quit', (e) => {
    quitting = true;
    saveStateNow();
    if (!cleanedUp) {   // Jam sauber beenden (Raum auf dem Relay löschen), höchstens 1,5 s warten
      e.preventDefault();
      cleanedUp = true;
      Promise.race([cleanup(), new Promise((r) => setTimeout(r, 1500))]).finally(() => app.quit());
    }
  });
  app.on('activate', showWindow);
}
