// Läuft im soundcloud.com-Fenster (sandboxed, isolierte Welt). Liest nur die sichtbare Player-Leiste
// (Titel, Link, Position, Play/Pause) - es wird kein Audio/Stream angefasst. Außerdem klickt es auf
// Player-Buttons, wenn die App Befehle schickt (Medientasten-Ersatz für die lokale API).
// Alle Selektoren stehen gesammelt in SEL: ändert SoundCloud sein Markup, ist nur das hier anzupassen.
const { ipcRenderer } = require('electron');

const SEL = {
  titleLink: ['a.playbackSoundBadge__titleLink'],
  artistLink: ['a.playbackSoundBadge__lightLink'],
  playBtn: ['.playControls__play', '.playControls .playControl'],
  nextBtn: ['.playControls__next', '.skipControl__next'],
  prevBtn: ['.playControls__prev', '.skipControl__previous'],
  progress: ['.playbackTimeline__progressWrapper'],
  timePassed: ['.playbackTimeline__timePassed'],
  duration: ['.playbackTimeline__duration']
};

const first = (list) => { for (const s of list) { const el = document.querySelector(s); if (el) return el; } return null; };
const textOf = (el) => {
  if (!el) return '';
  const vis = el.querySelector('[aria-hidden="true"]');
  return (el.getAttribute('title') || (vis || el).textContent || '').trim();
};

function parseClock(str) {            // "1:02:03" | "2:03" | "45" -> Sekunden (oder null)
  const m = /^\s*(?:(\d+):)?(\d+):(\d{1,2})\s*$|^\s*(\d+)\s*$/.exec(String(str || ''));
  if (!m) return null;
  if (m[4] !== undefined) return Number(m[4]);
  return (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
}

function readPlayerState() {
  const link = first(SEL.titleLink);
  const playBtn = first(SEL.playBtn);
  const playing = !!playBtn && (playBtn.classList.contains('playing') || /pause/i.test(playBtn.getAttribute('title') || playBtn.getAttribute('aria-label') || ''));

  const prog = first(SEL.progress);
  let position = prog ? parseFloat(prog.getAttribute('aria-valuenow')) : NaN;
  let duration = prog ? parseFloat(prog.getAttribute('aria-valuemax')) : NaN;
  if (!isFinite(position)) position = parseClock(textOf(first(SEL.timePassed)));
  if (!isFinite(duration)) duration = parseClock(textOf(first(SEL.duration)));

  let track = null;
  if (link) {
    try {
      const u = new URL(link.getAttribute('href'), location.origin);
      track = {
        url: u.origin + u.pathname,                          // ?in=… (Kontext) weglassen
        title: textOf(link),
        artist: textOf(first(SEL.artistLink)),
        duration: isFinite(duration) ? duration : null
      };
    } catch {}
  }
  let source = track ? 'dom' : 'none';
  if (!track && navigator.mediaSession && navigator.mediaSession.metadata) {   // nur zur Anzeige, ohne Link keine Jam
    const md = navigator.mediaSession.metadata;
    track = { url: null, title: md.title || '', artist: md.artist || '', duration: null };
    source = 'mediasession';
  }
  return { track, playing: track ? (source === 'mediasession' ? navigator.mediaSession.playbackState === 'playing' : playing) : false,
           position: isFinite(position) ? position : 0, source };
}

// ---- Änderungen (und alle 5 s ein Herzschlag) an den Main-Prozess melden ----
let last = null;
function tick() {
  const s = readPlayerState();
  const now = Date.now();
  const sig = (s.track ? s.track.url || s.track.title : '') + '|' + s.playing;
  let send = !last || last.sig !== sig || now - last.at >= 5000;
  if (!send) {
    const expected = last.position + (last.playing ? (now - last.at) / 1000 : 0);
    send = Math.abs(s.position - expected) > (s.playing ? 1.5 : 0.5);   // Sprung in der Zeitleiste
  }
  if (send) {
    last = { sig, at: now, position: s.position, playing: s.playing };
    ipcRenderer.send('sc:state', s);
  }
}
setInterval(tick, 500);

// ---- Befehle von der App ----
function runCommand(cmd) {
  const st = readPlayerState();
  const click = (list) => { const b = first(list); if (!b) return false; b.click(); return true; };
  switch (cmd) {
    case 'play':   return st.playing ? true : click(SEL.playBtn);
    case 'pause':  return !st.playing ? true : click(SEL.playBtn);
    case 'toggle': return click(SEL.playBtn);
    case 'next':   return click(SEL.nextBtn);
    case 'prev':   return click(SEL.prevBtn);
    default:       return false;
  }
}
ipcRenderer.on('sc:command', (_e, { id, cmd }) => {
  let ok = false;
  try { ok = runCommand(cmd); } catch {}
  ipcRenderer.send('sc:command-ack', { id, ok });
});

// Hilfe zum Prüfen der Selektoren auf dem echten SoundCloud (Menü: Debug → Scraper-Zustand)
ipcRenderer.on('sc:debug', (_e, { id }) => {
  const found = {};
  for (const [k, list] of Object.entries(SEL)) found[k] = list.find((s) => document.querySelector(s)) || null;
  ipcRenderer.send('sc:debug-result', { id, url: location.href, selectorsMatched: found, state: readPlayerState() });
});
