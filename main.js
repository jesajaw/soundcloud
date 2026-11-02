// Minimal SoundCloud desktop app: an Electron wrapper around soundcloud.com
const { app, BrowserWindow, Menu, Tray, shell, nativeImage, session, screen, clipboard, Notification, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createRelay } = require('./jam/relay');

const START_URL = 'https://soundcloud.com';
const ICON = path.join(__dirname, 'icon.png');
const PARTITION = 'persist:soundcloud'; // keeps you logged in
const AUTH_HOSTS = ['accounts.google.com', 'appleid.apple.com', 'www.facebook.com', 'secure.soundcloud.com', 'api.soundcloud.com'];
const quitOnClose = process.argv.includes('--quit-on-close'); // closing the window quits (used by npm start)
const startHidden = process.argv.includes('--hidden');        // start in the tray only
const dev = process.argv.includes('--dev');

app.setAppUserModelId('local.soundcloud.desktop'); // Windows: needed for notifications and the taskbar
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,MediaSessionService'); // media keys + MPRIS
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win, tray, jam, quitting = false, cleaned = false, saveTimer;
let last = { track: null, playing: false, position: 0, at: 0 }; // what the player bar currently shows

// Dark scrollbars (user-origin + !important so they also beat the site's own styles)
const DARK_SCROLLBARS = '::-webkit-scrollbar{width:12px!important;height:12px!important;background:#121212!important}'
  + '::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:#121212!important}'
  + '::-webkit-scrollbar-thumb{background:#4a4a4a!important;border:2px solid #121212!important;border-radius:6px!important}'
  + '::-webkit-scrollbar-thumb:hover{background:#6a6a6a!important}';

// ---- URLs: only https on soundcloud.com stays in the app (http is upgraded), everything else opens in the browser
function internal(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || !/(^|\.)soundcloud\.com$/.test(u.hostname)) return null;
    u.protocol = 'https:';
    return u.href;
  } catch { return null; }
}
function external(url) {
  try { if (['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)) shell.openExternal(url); } catch {}
}
const isAuthPopup = (url) => { try { const u = new URL(url); return u.protocol === 'https:' && AUTH_HOSTS.includes(u.hostname); } catch { return false; } };
const notify = (title, body) => { try { if (Notification.isSupported()) new Notification({ title, body, icon: ICON, silent: true }).show(); } catch {} };

// ---- Window size/position (saved with a delay, ignored if the monitor is gone)
const stateFile = () => path.join(app.getPath('userData'), 'window.json');
function loadBounds() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const out = { width: Number(s.width) || 1200, height: Number(s.height) || 800, maximized: s.maximized === true };
    const visible = screen.getAllDisplays().some(({ workArea: a }) => s.x < a.x + a.width - 100 && s.x + out.width > a.x + 100 && s.y < a.y + a.height - 100 && s.y + out.height > a.y + 100);
    return visible ? { ...out, x: s.x, y: s.y } : out;
  } catch { return { width: 1200, height: 800 }; }
}
function saveNow() {
  clearTimeout(saveTimer);
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch {}
}
const saveLater = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); };

// ---- Session: browser-like user agent (also for login popups), minimal permissions, downloads
function setupSession() {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(ses.getUserAgent().replace(/\sElectron\/[\d.]+/, '').replace(/\s?soundcloud-desktop\/[\d.]+/i, ''));
  const allowed = ['notifications', 'fullscreen', 'clipboard-sanitized-write'];
  ses.setPermissionRequestHandler((_wc, perm, cb, d) => cb(allowed.includes(perm) && !!internal(d.requestingUrl)));
  ses.setPermissionCheckHandler((_wc, perm, origin) => allowed.includes(perm) && !!internal(origin));

  // Downloads go to ~/Music/SoundCloud and never overwrite. Once a file is complete, "<file>.sc.json" appears next to it:
  // that is the "ready" signal for other programs (e.g. your DJ app); until then the file is "<file>.crdownload".
  ses.on('will-download', (_e, item) => {
    const dir = path.join(app.getPath('music'), 'SoundCloud');
    fs.mkdirSync(dir, { recursive: true });
    const name = path.basename(item.getFilename().replace(/\\/g, '/')).replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '') || 'download';
    const ext = path.extname(name);
    let file = path.join(dir, name);
    for (let i = 1; fs.existsSync(file) || fs.existsSync(file + '.crdownload'); i++) file = path.join(dir, `${name.slice(0, name.length - ext.length)} (${i})${ext}`);
    item.setSavePath(file);
    const info = { page: win ? win.webContents.getURL() : '', pageTitle: win ? win.webContents.getTitle() : '', nowPlaying: last.track };
    item.once('done', (_ev, state) => {
      if (state !== 'completed') return;
      try {
        fs.writeFileSync(file + '.sc.json.tmp', JSON.stringify({ file: path.basename(file), ...info, downloadedAt: new Date().toISOString() }, null, 1));
        fs.renameSync(file + '.sc.json.tmp', file + '.sc.json'); // atomic: never half-written
      } catch (e) { notify('Download finished, but the marker file failed', String(e.message)); return; }
      notify('Download finished', path.basename(file));
    });
  });
}

// ---- Player state from preload.js
function setupIpc() {
  ipcMain.on('sc:state', (e, s) => {
    if (!win || e.sender !== win.webContents || !s) return;
    const t = s.track && typeof s.track === 'object' ? { url: String(s.track.url), title: String(s.track.title).slice(0, 200), artist: String(s.track.artist).slice(0, 200), duration: Number(s.track.duration) || 0 } : null;
    last = { track: t && internal(t.url) ? t : null, playing: s.playing === true, position: Math.max(0, Number(s.position) || 0), at: Date.now() };
    pushJam();
  });
}

// ---- Jam: the host keeps listening normally; a room on the relay mirrors the player state to guests
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}
async function startJam() {
  if (jam) return;
  let relay = null, base = process.env.JAM_RELAY; // JAM_RELAY=https://... to use an external relay, otherwise a built-in one runs for your LAN
  try {
    if (!base) { relay = createRelay(); base = `http://${lanIp()}:${await relay.listen(Number(process.env.JAM_PORT) || 8787)}`; }
    const r = await fetch(base + '/rooms', { method: 'POST', signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('relay answered HTTP ' + r.status);
    const { room, token } = await r.json();
    jam = { base, relay, room, token, link: `${base}/${room}` };
    clipboard.writeText(jam.link);
    notify('Jam started', 'Invite link copied to the clipboard.');
    pushJam();
  } catch (e) { if (relay) relay.close(); notify('Jam failed', String(e.message)); }
  refresh();
}
function pushJam() {
  if (!jam) return;
  const j = jam, t = last.track;
  const position = t ? last.position + (last.playing ? (Date.now() - last.at) / 1000 : 0) : 0;
  fetch(`${j.base}/rooms/${j.room}/state`, { method: 'PUT', headers: { Authorization: 'Bearer ' + j.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ track: t, playing: !!t && last.playing, position }), signal: AbortSignal.timeout(4000) })
    .then((r) => r.json()).then((r) => { if (tray && r.listeners !== undefined) tray.setToolTip(`SoundCloud - Jam: ${r.listeners} listening`); }).catch(() => {});
}
async function stopJam() {
  const j = jam;
  jam = null;
  if (!j) return;
  await fetch(`${j.base}/rooms/${j.room}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + j.token }, signal: AbortSignal.timeout(2000) }).catch(() => {});
  if (j.relay) await j.relay.close();
  if (tray) tray.setToolTip('SoundCloud');
  refresh();
}

// ---- Window
function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    ...b, show: false, minWidth: 600, minHeight: 400, title: 'SoundCloud', icon: ICON, autoHideMenuBar: true, backgroundColor: '#121212',
    webPreferences: { partition: PARTITION, preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
                      backgroundThrottling: false } // music keeps playing smoothly in the background
  });
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  win.loadURL(START_URL).catch(() => {}); // failures are handled in did-fail-load
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => { // offline at start: retry instead of staying on an error page
    if (!isMain || code === -3 || !win) return; // -3 = aborted (a redirect or newer navigation)
    setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(internal(url) || START_URL).catch(() => {}); }, 5000);
  });
  win.webContents.on('dom-ready', () => win.webContents.insertCSS(DARK_SCROLLBARS, { cssOrigin: 'user' }));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAuthPopup(url)) return { action: 'allow' }; // social logins need a real popup
    const target = internal(url);
    if (target) win.loadURL(target); else external(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const target = internal(url);
    if (target === url) return;
    e.preventDefault();
    if (target) win.loadURL(target); else external(url);
  });
  win.webContents.on('context-menu', (_e, p) => { // right-click / long-press
    const nav = win.webContents.navigationHistory, items = [];
    if (p.linkURL) items.push({ label: 'Open link in browser', click: () => external(p.linkURL) }, { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) });
    if (p.isEditable) items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { role: 'selectAll' });
    else if (p.selectionText) items.push({ role: 'copy' });
    if (!items.length) items.push({ label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() }, { label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() }, { role: 'reload' });
    if (dev) items.push({ type: 'separator' }, { label: 'Inspect', click: () => win.webContents.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, saveLater);
  win.on('close', (e) => { // hide to the tray so music keeps playing - but only if there is a tray to get back from
    saveNow();
    if (quitting || quitOnClose || !tray) return;
    e.preventDefault();
    win.hide();
  });
  win.on('closed', () => { win = null; if (!quitting) app.quit(); });
}
function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---- Menus
const quit = () => { quitting = true; app.quit(); };
const jamItems = () => [
  jam ? { label: 'Stop Jam', click: stopJam } : { label: 'Start Jam (I am the host)', click: startJam },
  { label: 'Copy invite link', enabled: !!jam, click: () => clipboard.writeText(jam.link) },
  { label: 'Join Jam from clipboard (opens browser)', click: () => { const l = clipboard.readText().trim(); if (/^https?:\/\//.test(l)) external(l); } }
];
function refresh() {
  const nav = () => (win ? win.webContents.navigationHistory : { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Open download folder', click: () => { const d = path.join(app.getPath('music'), 'SoundCloud'); fs.mkdirSync(d, { recursive: true }); shell.openPath(d); } },
      { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: quit } ] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }] },
    { label: 'Go', submenu: [
      { label: 'Back', accelerator: 'Alt+Left', click: () => nav().canGoBack() && nav().goBack() },
      { label: 'Forward', accelerator: 'Alt+Right', click: () => nav().canGoForward() && nav().goForward() } ] },
    { label: 'Jam', submenu: jamItems() },
    ...(dev ? [{ label: 'Debug', submenu: [ // only with --dev
      { label: 'Copy player state (check the scraper)', click: () => clipboard.writeText(JSON.stringify(last, null, 1)) },
      { role: 'toggleDevTools' } ] }] : [])
  ]));
  if (tray) tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide', click: () => (win && win.isVisible() ? win.hide() : showWindow()) },
    ...jamItems(), { type: 'separator' }, { label: 'Quit', click: quit }
  ]));
}
function createTray() {
  const img = nativeImage.createFromPath(ICON);
  if (img.isEmpty()) return; // no icon, no tray - then closing the window really quits
  tray = new Tray(img.resize({ width: process.platform === 'win32' ? 16 : 22, height: process.platform === 'win32' ? 16 : 22, quality: 'best' }));
  tray.setToolTip('SoundCloud');
  tray.on('click', () => (win && win.isVisible() ? win.hide() : showWindow())); // not delivered on Linux: use the menu there
}

// ---- Start
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', (e) => {
    quitting = true;
    saveNow();
    if (jam && !cleaned) { // close the Jam room properly, wait at most 1.5 s
      e.preventDefault();
      cleaned = true;
      Promise.race([stopJam(), new Promise((r) => setTimeout(r, 1500))]).finally(() => app.quit());
    }
  });
  app.whenReady().then(() => { setupSession(); setupIpc(); createWindow(); createTray(); refresh(); });
  process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e)); // a stray network error must not kill the app
}
