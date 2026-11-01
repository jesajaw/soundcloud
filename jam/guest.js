// Gast-Seite der Jam: folgt dem Status des Hosts über den offiziellen SoundCloud-Widget-Player.
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const room = params.get('room') || '';
  let relay = '';
  try {
    const u = new URL(params.get('relay') || '');
    if (/^https?:$/.test(u.protocol)) relay = u.origin + u.pathname.replace(/\/+$/, '');
  } catch {}
  const setStatus = (text, cls) => { const s = $('status'); s.textContent = text; s.className = 'pill ' + (cls || ''); };
  if (!relay || !/^[A-Za-z0-9_-]{8,64}$/.test(room)) { setStatus('ungültiger Einladungslink', 'bad'); return; }

  const WIDGET_BASE = 'https://w.soundcloud.com/player/?';
  const WIDGET_OPTS = { auto_play: false, visual: false, show_comments: false, hide_related: true, show_user: true };
  const optsQuery = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('&');
  const isScUrl = (s) => { try { const u = new URL(s); return u.protocol === 'https:' && (u.hostname === 'soundcloud.com' || u.hostname.endsWith('.soundcloud.com')); } catch { return false; } };

  let offset = 0;              // Relay-Zeit minus Gast-Zeit (ms)
  let host = null;             // letzter Status vom Relay
  let widget = null, ready = false;
  let currentUrl = null, lastSeekAt = 0, ignoreUntil = 0;
  let following = true, applying = false, again = false, ended = false;
  const serverNow = () => Date.now() + offset;
  const wcall = (fn) => new Promise((res) => widget[fn](res));

  async function syncClock() {
    let best = null;
    for (let i = 0; i < 3; i++) {
      try {
        const t0 = Date.now();
        const d = await (await fetch(relay + '/time', { cache: 'no-store' })).json();
        const t1 = Date.now();
        if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, off: JamSync.clockOffset(t0, d.now, t1) };
      } catch {}
    }
    if (best) offset = best.off;
  }

  function showHost() {
    $('title').textContent = host && host.track ? (host.track.title || host.track.url) : 'Der Host spielt gerade nichts';
    $('artist').textContent = host && host.track ? host.track.artist || '' : '';
  }

  function createWidget(url) {
    const f = document.createElement('iframe');
    f.allow = 'autoplay';
    f.title = 'SoundCloud-Player';
    f.src = WIDGET_BASE + 'url=' + encodeURIComponent(url) + '&' + optsQuery(WIDGET_OPTS);
    $('playerbox').appendChild(f);
    currentUrl = url;
    widget = SC.Widget(f);
    widget.bind(SC.Widget.Events.READY, () => { ready = true; widget.setVolume(Number($('vol').value)); apply(); });
    widget.bind(SC.Widget.Events.ERROR, () => { $('msg').textContent = 'Dieser Track lässt sich nicht einbetten – der Host hört etwas, das hier nicht abspielbar ist.'; });
    widget.bind(SC.Widget.Events.PAUSE, () => {
      // Manuelles Pausieren (nicht von uns ausgelöst) = Gast steigt aus dem Sync aus
      if (!following || !host || !host.playing || Date.now() < ignoreUntil) return;
      setTimeout(async () => {
        if (following && host && host.playing && Date.now() >= ignoreUntil && await wcall('isPaused')) {
          following = false; setStatus('nicht synchron', 'bad'); $('msg').textContent = 'Pausiert – „Neu synchronisieren“ holt dich zurück zum Host.';
        }
      }, 700);
    });
  }

  async function apply() {
    if (applying) { again = true; return; }
    applying = true;
    try {
      do {
        again = false;
        showHost();
        if (!host || !host.track) { if (ready) { ignoreUntil = Date.now() + 1500; widget.pause(); } continue; }
        if (!isScUrl(host.track.url)) continue;
        if (!widget) { createWidget(host.track.url); continue; }   // READY ruft apply() erneut auf
        if (!ready || !following) continue;
        const [posMs, paused] = [await wcall('getPosition'), await wcall('isPaused')];
        const guest = { url: currentUrl, playing: !paused, position: posMs / 1000, lastSeekAt };
        const target = JamSync.expectedPosition(host, serverNow());
        $('drift').textContent = `Abweichung zum Host: ${(guest.position - target >= 0 ? '+' : '') + (guest.position - target).toFixed(1)} s`;
        for (const a of JamSync.plan(host, guest, serverNow(), Date.now())) {
          ignoreUntil = Date.now() + 1500;
          if (a.type === 'load') {
            currentUrl = a.url; ready = false; $('msg').textContent = '';
            widget.load(a.url, { ...WIDGET_OPTS, auto_play: a.play, callback: () => {
              ready = true; widget.setVolume(Number($('vol').value));
              if (a.position > 1) { lastSeekAt = Date.now(); widget.seekTo(a.position * 1000); }
              apply();
            } });
            break;                                                  // nach dem Laden wird neu geplant
          }
          if (a.type === 'seek') { lastSeekAt = Date.now(); widget.seekTo(a.position * 1000); }
          if (a.type === 'play') widget.play();
          if (a.type === 'pause') widget.pause();
        }
      } while (again);
    } finally { applying = false; }
  }

  $('resync').addEventListener('click', () => {
    following = true; lastSeekAt = 0; $('msg').textContent = ''; setStatus('synchron', 'ok'); syncClock().then(apply);
  });
  $('vol').addEventListener('input', () => {
    const v = Number($('vol').value);
    if (ready) widget.setVolume(v);
    try { localStorage.setItem('jamVolume', String(v)); } catch {}
  });
  try { const v = localStorage.getItem('jamVolume'); if (v !== null) $('vol').value = v; } catch {}

  const es = new EventSource(`${relay}/rooms/${room}/events`);
  const onState = (e) => { host = JSON.parse(e.data); apply(); };
  es.addEventListener('hello', async (e) => {
    const d = JSON.parse(e.data);
    $('listeners').textContent = `${d.listeners} Hörer`;
    await syncClock();
    setStatus(following ? 'synchron' : 'nicht synchron', following ? 'ok' : 'bad');
    host = d.state; apply();
  });
  es.addEventListener('state', onState);
  es.addEventListener('listeners', (e) => { $('listeners').textContent = `${JSON.parse(e.data).listeners} Hörer`; });
  es.addEventListener('end', () => { ended = true; es.close(); setStatus('beendet', 'bad'); $('msg').textContent = 'Der Host hat die Jam beendet.'; if (ready) widget.pause(); });
  es.onerror = () => { if (!ended) setStatus('Verbindung unterbrochen – versuche erneut …', 'bad'); };
  setInterval(() => { if (!ended && host) apply(); }, 2000);   // Drift-Kontrolle zwischen den Host-Updates
  setInterval(() => { if (!ended) syncClock(); }, 60000);
})();
