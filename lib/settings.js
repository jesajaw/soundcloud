// Kleine JSON-Einstellungsdatei in userData (kein extra Paket nötig)
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  closeToTray: true,          // Schließen-Button blendet das Fenster nur aus (nur wenn ein Tray existiert)
  downloadDir: null,          // null = <Musik>/SoundCloud
  localApi: { enabled: true, port: 17876 },
  jam: { relay: '', port: 8787 } // relay '' = eingebauten Relay im Host-Modus starten
};

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? merge(base[k], v) : v;
  }
  return out;
}

function createSettings(file) {
  let data = DEFAULTS;
  try { data = merge(DEFAULTS, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
  return {
    get: () => data,
    update(patch) {
      data = merge(data, patch);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, file);
      } catch {}
      return data;
    }
  };
}

module.exports = { createSettings, DEFAULTS, merge };
