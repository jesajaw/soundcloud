// Download-Übergabe an andere Programme (z. B. den DJ-Player):
//  - Dateiname säubern, nie überschreiben
//  - Erst NACH Abschluss des Downloads entsteht die Sidecar-Datei "<datei>.sc.json".
//    Sie ist das "fertig"-Signal; Chromium schreibt vorher in "<datei>.crdownload".
const fs = require('fs');
const path = require('path');

const SIDECAR_SUFFIX = '.sc.json';

function sanitizeFilename(name) {
  let base = path.basename(String(name || '').replace(/\\/g, '/'));
  base = base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/^\.+/, '').trim();
  if (!base) base = 'download';
  if (base.length > 200) {
    const ext = path.extname(base).slice(0, 20);
    base = base.slice(0, 200 - ext.length) + ext;
  }
  return base;
}

function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  for (let i = 1; fs.existsSync(candidate) || fs.existsSync(candidate + '.crdownload'); i++) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

function writeSidecar(filePath, info) {
  const side = filePath + SIDECAR_SUFFIX;
  const body = {
    version: 1,
    app: 'soundcloud-desktop',
    file: path.basename(filePath),
    size: (() => { try { return fs.statSync(filePath).size; } catch { return null; } })(),
    downloadedAt: new Date().toISOString(),
    pageUrl: info.pageUrl || null,        // Seite, auf der der Download-Button geklickt wurde (meist die Track-Seite)
    pageTitle: info.pageTitle || null,
    nowPlaying: info.nowPlaying || null   // was zu Download-Beginn im Player lief (kann ein anderer Track sein!)
  };
  const tmp = side + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
  fs.renameSync(tmp, side); // atomar: der Beobachter sieht die Datei nie halb geschrieben
  return { path: side, ...body };
}

module.exports = { sanitizeFilename, uniquePath, writeSidecar, SIDECAR_SUFFIX };
