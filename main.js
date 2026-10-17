// Schlanke SoundCloud-Desktop-App: Electron-Wrapper um soundcloud.com
const { app, BrowserWindow, Menu, Tray, shell, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');

const START_URL = 'https://soundcloud.com';
const ICON = path.join(__dirname, 'icon.png');

// Medientasten (Play/Pause/Next/Prev) + MPRIS unter Linux (playerctl, KDE/GNOME-Mediensteuerung)
app.commandLine.appendSwitch(
  'enable-features',
  'HardwareMediaKeyHandling,MediaSessionService'
);
// Audio darf ohne Klick starten, auch wenn das Fenster im Hintergrund ist
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let tray = null;
let quitting = false;

// ---- Fensterposition/-größe merken ----
const stateFile = path.join(app.getPath('userData'), 'window-state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch { return { width: 1200, height: 800 }; }
}
function saveState() {
  if (!win || win.isMinimized() || win.isMaximized()) return;
  try { fs.writeFileSync(stateFile, JSON.stringify(win.getBounds())); } catch {}
}

function createWindow() {
  const state = loadState();
  win = new BrowserWindow({
    ...state,
    minWidth: 600,
    minHeight: 400,
    title: 'SoundCloud',
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: '#121212',
    webPreferences: {
      partition: 'persist:soundcloud', // Login bleibt erhalten
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false      // Musik läuft im Hintergrund ohne Ruckeln weiter
    }
  });

  // Chrome-ähnlicher User-Agent, damit SoundCloud/Login keine Probleme macht
  const ua = win.webContents.getUserAgent()
    .replace(/\sElectron\/[\d.]+/, '')
    .replace(/\s?soundcloud-desktop\/[\d.]+/i, '');
  win.webContents.setUserAgent(ua);


  // Downloads, die SoundCloud selbst anbietet (Button "Download file" bei Tracks,
  // die der Uploader freigegeben hat), landen im Downloads-Ordner.
  const ses = session.fromPartition('persist:soundcloud');
  ses.on('will-download', (_e, item) => {
    item.setSavePath(path.join(app.getPath('downloads'), item.getFilename()));
  });

  win.loadURL(START_URL);

  const isInternal = (url) => {
    try {
      const h = new URL(url).hostname;
      return h === 'soundcloud.com' || h.endsWith('.soundcloud.com');
    } catch { return false; }
  };
  // Login-Dialoge (Google/Apple/Facebook) dürfen als Popup öffnen, alles andere extern
  const authHosts = ['accounts.google.com', 'appleid.apple.com', 'www.facebook.com', 'secure.soundcloud.com', 'api.soundcloud.com'];
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const h = new URL(url).hostname;
      if (authHosts.includes(h)) return { action: 'allow' };
      if (isInternal(url)) { win.loadURL(url); return { action: 'deny' }; }
    } catch {}
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isInternal(url)) { e.preventDefault(); shell.openExternal(url); }
  });

  win.on('resize', saveState);
  win.on('move', saveState);

  // Schließen = in den Tray minimieren, damit die Musik weiterspielt
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

function showWindow() {
  if (!win) return createWindow();
  win.show();
  win.focus();
}

function createTray() {
  const img = nativeImage.createFromPath(ICON);
  if (img.isEmpty()) return; // ohne Icon kein Tray
  tray = new Tray(img.resize({ width: 22, height: 22 }));
  tray.setToolTip('SoundCloud');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Anzeigen', click: showWindow },
    { type: 'separator' },
    { label: 'Beenden', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', () => (win && win.isVisible() ? win.hide() : showWindow()));
}

// Nur eine Instanz
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    createWindow();
    createTray();
    Menu.setApplicationMenu(null);
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('activate', showWindow);
}
