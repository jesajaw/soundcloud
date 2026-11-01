// Host-Seite der Jam: legt einen Raum auf dem Relay an und meldet den Status des eigenen Players.
// Der Host hört ganz normal in seinem Hauptfenster; die Jam läuft parallel und ist jederzeit beendbar.
const ROOM_RE = /^[A-Za-z0-9_-]{8,64}$/;

function buildInvite(relayBase, room) {
  return `scjam://join/${room}?relay=${encodeURIComponent(relayBase)}`;
}

function parseInvite(text) {
  try {
    const u = new URL(String(text).trim());
    if (u.protocol !== 'scjam:' || u.hostname !== 'join') return null;
    const room = u.pathname.replace(/^\//, '');
    const relay = u.searchParams.get('relay') || '';
    const r = new URL(relay);
    if (!ROOM_RE.test(room) || !/^https?:$/.test(r.protocol)) return null;
    return { room, relay: r.origin + r.pathname.replace(/\/+$/, '') };
  } catch { return null; }
}

function createJamHost({ relayBase, onStatus = () => {} }) {
  const base = relayBase.replace(/\/+$/, '');
  let room = null, token = null, running = false;
  let latest = null, latestAt = 0, inFlight = false, dirty = false;
  let failures = 0, listeners = 0, hb = null, lastSend = 0, wake = null;

  const status = (extra = {}) => onStatus({ running, listeners, room, failures, ...extra });

  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(4000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
  }

  async function flush() {
    if (!running || !latest) return;
    if (inFlight) { dirty = true; return; }
    inFlight = true; dirty = false;
    // Position auf "jetzt" hochrechnen, falls der letzte Scrape schon etwas her ist
    const elapsed = latest.playing ? (Date.now() - latestAt) / 1000 : 0;
    const payload = { ...latest, position: latest.position + elapsed };
    try {
      const r = await call('PUT', `/rooms/${room}/state`, payload);
      failures = 0; listeners = r.listeners; lastSend = Date.now();
      status();
    } catch (e) {
      failures += 1;
      if (e.status === 404) { running = false; clearInterval(hb); status({ error: 'Raum existiert nicht mehr (Relay neu gestartet?)' }); }
      else status({ error: failures >= 3 ? 'Verbindung zum Relay verloren' : undefined });
    } finally {
      inFlight = false;
      if (dirty && running) setTimeout(flush, 250);
    }
  }

  return {
    async start() {
      const r = await call('POST', '/rooms');
      room = r.room; token = r.hostToken; running = true; failures = 0;
      hb = setInterval(flush, 5000); hb.unref?.();
      status();
      if (latest) flush();
      return buildInvite(base, room);
    },
    // vom Scraper aufgerufen, bei jeder relevanten Änderung und als Heartbeat
    push(state) {
      latest = state; latestAt = Date.now();
      if (!running) return;
      const wait = Math.max(0, 250 - (Date.now() - lastSend)); // höchstens ~4 Updates/s
      clearTimeout(wake); wake = setTimeout(flush, wait);
    },
    async stop() {
      if (!running && !room) return;
      running = false; clearInterval(hb); clearTimeout(wake);
      try { await call('DELETE', `/rooms/${room}`); } catch {}
      room = null; token = null; listeners = 0; latest = null;
      status();
    },
    isRunning: () => running,
    invite: () => (room ? buildInvite(base, room) : null),
    listeners: () => listeners
  };
}

module.exports = { createJamHost, buildInvite, parseInvite };
