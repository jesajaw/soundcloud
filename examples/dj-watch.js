// Beispiel-Client für den DJ-Player: beobachtet den Download-Ordner (.sc.json) und die lokale API.
//   node examples/dj-watch.js [ordner]
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = process.platform === 'win32'
  ? path.join(process.env.APPDATA || '', 'soundcloud-desktop')
  : path.join(os.homedir(), '.config', 'soundcloud-desktop');
const folder = process.argv[2] || path.join(os.homedir(), 'Musik', 'SoundCloud');

// ---- 1. Ordner: auf "<datei>.sc.json" warten, dann ist die Datei fertig
const seen = new Set();
function importIfReady(name) {
  if (!name || !name.endsWith('.sc.json') || seen.has(name)) return;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
    seen.add(name);
    console.log('[Ordner] fertig:', path.join(folder, meta.file), `(${meta.size} Bytes)`, meta.pageUrl || '');
    // hier: Datei in die Bibliothek aufnehmen / Deck laden
  } catch {}   // halb geschrieben gibt es nicht, aber die Datei kann gerade erst erscheinen
}
fs.mkdirSync(folder, { recursive: true });
fs.readdirSync(folder).forEach(importIfReady);
fs.watch(folder, (_ev, name) => setTimeout(() => importIfReady(name), 50));
console.log('[Ordner] beobachte', folder);

// ---- 2. Lokale API: Titel mitlesen, SoundCloud pausieren
let api;
try { api = JSON.parse(fs.readFileSync(path.join(userData, 'local-api.json'), 'utf8')); }
catch { console.log('[API] local-api.json nicht gefunden - läuft SoundCloud Desktop?'); }
if (api) {
  const base = `http://127.0.0.1:${api.port}`;
  const headers = { Authorization: `Bearer ${api.token}` };
  globalThis.pauseSoundCloud = () => fetch(`${base}/v1/command`, { method: 'POST', headers, body: JSON.stringify({ cmd: 'pause' }) }).then((r) => r.json());
  (async () => {
    const res = await fetch(`${base}/v1/events`, { headers });
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block), data = /^data: (.+)$/m.exec(block);
        if (!ev || !data) continue;
        const d = JSON.parse(data[1]);
        if (ev[1] === 'now-playing') console.log('[API] läuft:', d.playing, '|', d.track ? `${d.track.artist} - ${d.track.title}` : '-', '|', Math.round(d.position), 's');
        if (ev[1] === 'download') console.log('[API] Download:', d.state, d.file);
      }
    }
  })().catch((e) => console.log('[API] getrennt:', e.message));
  console.log('[API] verbunden mit', base, '- pauseSoundCloud() steht global zur Verfügung');
}
