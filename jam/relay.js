// Jam-Relay: verteilt den Wiedergabestatus (Track-Link, Position, Play/Pause) vom Host an die Gäste.
// Es wird KEIN Audio übertragen - jeder Gast spielt den Track über seinen eigenen SoundCloud-Zugang.
// Keine Abhängigkeiten (nur Node-http, Server-Sent-Events). Läuft eingebettet in der App oder allein:
//   node jam/relay.js --port 8787 --host 0.0.0.0
const http = require('http');
const crypto = require('crypto');

const MAX_BODY = 16 * 1024;

const isScHost = (h) => h === 'soundcloud.com' || h.endsWith('.soundcloud.com');

// Prüft/säubert den vom Host gemeldeten Status. Gibt null bei ungültigen Daten zurück.
function cleanState(b) {
  if (!b || typeof b !== 'object') return null;
  const num = (v, max) => (typeof v === 'number' && isFinite(v) ? Math.min(Math.max(v, 0), max) : null);
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  let track = null;
  if (b.track != null) {
    if (typeof b.track !== 'object') return null;
    let u;
    try { u = new URL(String(b.track.url)); } catch { return null; }
    if (u.protocol !== 'https:' || !isScHost(u.hostname) || u.pathname.length > 300) return null;
    track = {
      url: u.origin + u.pathname,           // Query/Hash bewusst weg
      title: str(b.track.title, 200),
      artist: str(b.track.artist, 200),
      duration: num(b.track.duration, 86400)
    };
  }
  const position = num(b.position, 86400);
  if (position === null) return null;
  return { track, playing: b.playing === true, position };
}

function createRelay(opts = {}) {
  const maxRooms = opts.maxRooms ?? 100;
  const maxListeners = opts.maxListeners ?? 50;
  const idleMs = opts.idleMs ?? 6 * 3600 * 1000;
  const rooms = new Map();         // id -> {hostHash, state, seq, listeners:Set<res>, touched}
  const createLog = new Map();     // ip -> [timestamps] (Rate-Limit für neue Räume)

  const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  };
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
    res.end(JSON.stringify(obj));
  };
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (room, event, data) => { for (const r of room.listeners) send(r, event, data); };

  const authed = (req, room) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return !!m && crypto.timingSafeEqual(hash(m[1]), room.hostHash);
  };

  function readBody(req, res) {
    return new Promise((resolve, reject) => {
      let size = 0, tooBig = false; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (tooBig) return;
        if (size > MAX_BODY) {
          tooBig = true; chunks.length = 0;
          // erst antworten, dann die Verbindung kappen
          res.once('finish', () => req.destroy());
          res.setHeader('Connection', 'close');
          reject(Object.assign(new Error('too large'), { code: 413 }));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function closeRoom(id, reason) {
    const room = rooms.get(id);
    if (!room) return;
    broadcast(room, 'end', { reason });
    for (const r of room.listeners) r.end();
    rooms.delete(id);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://relay.local');
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, rooms: rooms.size });
    if (req.method === 'GET' && url.pathname === '/time') return json(res, 200, { now: Date.now() });

    if (req.method === 'POST' && url.pathname === '/rooms') {
      const ip = req.socket.remoteAddress || '?';
      const now = Date.now();
      const log = (createLog.get(ip) || []).filter((t) => now - t < 60000);
      if (log.length >= 10) return json(res, 429, { error: 'zu viele Räume, bitte kurz warten' });
      if (rooms.size >= maxRooms) return json(res, 503, { error: 'Relay ist voll' });
      log.push(now); createLog.set(ip, log);
      const id = crypto.randomBytes(12).toString('base64url');
      const hostToken = crypto.randomBytes(24).toString('base64url');
      rooms.set(id, { hostHash: hash(hostToken), state: null, seq: 0, listeners: new Set(), touched: now });
      return json(res, 201, { room: id, hostToken });
    }

    if (parts[0] !== 'rooms' || !parts[1]) return json(res, 404, { error: 'not found' });
    const id = parts[1];
    const room = rooms.get(id);
    if (!room) return json(res, 404, { error: 'Raum existiert nicht (mehr)' });

    if (req.method === 'GET' && parts.length === 2) return json(res, 200, { room: id, listeners: room.listeners.size, live: !!room.state });

    if (req.method === 'GET' && parts[2] === 'events') {
      if (room.listeners.size >= maxListeners) return json(res, 503, { error: 'Raum ist voll' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...cors
      });
      res.write('retry: 3000\n\n');
      room.listeners.add(res);
      send(res, 'hello', { state: room.state, listeners: room.listeners.size, serverTime: Date.now() });
      broadcast(room, 'listeners', { listeners: room.listeners.size });
      req.on('close', () => {
        room.listeners.delete(res);
        broadcast(room, 'listeners', { listeners: room.listeners.size });
      });
      return;
    }

    if (req.method === 'PUT' && parts[2] === 'state') {
      if (!authed(req, room)) return json(res, 401, { error: 'unauthorized' });
      let body;
      try { body = JSON.parse(await readBody(req, res)); }
      catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: 'ungültiger Body' }); }
      const clean = cleanState(body);
      if (!clean) return json(res, 400, { error: 'ungültiger Status' });
      room.seq += 1;
      room.touched = Date.now();
      room.state = { ...clean, seq: room.seq, serverTime: Date.now() };
      broadcast(room, 'state', room.state);
      return json(res, 200, { listeners: room.listeners.size, serverTime: room.state.serverTime });
    }

    if (req.method === 'DELETE' && parts.length === 2) {
      if (!authed(req, room)) return json(res, 401, { error: 'unauthorized' });
      closeRoom(id, 'host-closed');
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: 'internal' }); else res.end(); });
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms) {
      for (const r of room.listeners) r.write(': ping\n\n');
      if (!room.listeners.size && now - room.touched > idleMs) rooms.delete(id);
    }
    for (const [ip, log] of createLog) if (!log.some((t) => now - t < 60000)) createLog.delete(ip);
  }, 15000);
  heartbeat.unref();

  return {
    server,
    rooms,
    listen: (port = 8787, host = '0.0.0.0') => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); });
    }),
    close: () => new Promise((resolve) => {
      clearInterval(heartbeat);
      for (const id of [...rooms.keys()]) closeRoom(id, 'relay-closed');
      server.close(() => resolve());
      server.closeAllConnections?.();
    })
  };
}

module.exports = { createRelay, cleanState };

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
  const relay = createRelay();
  relay.listen(Number(arg('--port', 8787)), arg('--host', '0.0.0.0'))
    .then((p) => console.log(`Jam-Relay läuft auf Port ${p}`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
