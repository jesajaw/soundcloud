// Jam relay: forwards "what is the host playing" (track link, position, play/pause) to guests. No audio.
// Also serves the guest page, so the invite link is just a web link:  node jam/relay.js [port]
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const rand = (n) => crypto.randomBytes(n).toString('base64url');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); // constant-time token check
const soundcloud = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)soundcloud\.com$/.test(x.hostname) ? x.origin + x.pathname : null; } catch { return null; } };

function createRelay() {
  const rooms = new Map(); // id -> { token, state, clients, at }
  const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const file = (res, name, type) => { res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); res.end(fs.readFileSync(path.join(__dirname, name))); };
  const send = (res, ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);

  const server = http.createServer((req, res) => {
    const [, a, id, c] = new URL(req.url, 'http://x').pathname.split('/');
    const room = rooms.get(id);
    const authed = room && same(req.headers.authorization || '', 'Bearer ' + room.token);
    const get = req.method === 'GET';

    if (get && a === 'guest.js') return file(res, 'guest.js', 'text/javascript');
    if (get && a === 'time') return json(res, 200, { now: Date.now() });
    if (get && a && a !== 'rooms' && !id) return rooms.has(a) ? file(res, 'guest.html', 'text/html') : json(res, 404, { error: 'no such room' });
    if (req.method === 'POST' && a === 'rooms' && !id) {
      if (rooms.size >= 50) return json(res, 503, { error: 'relay is full' });
      const rid = rand(12), r = { token: rand(24), state: null, clients: new Set(), at: Date.now() };
      rooms.set(rid, r);
      return json(res, 201, { room: rid, token: r.token });
    }
    if (a !== 'rooms' || !room) return json(res, 404, { error: 'not found' });

    if (get && c === 'events') { // guests: server-sent events
      if (room.clients.size >= 100) return json(res, 503, { error: 'room is full' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      room.clients.add(res);
      send(res, 'hello', { state: room.state });
      req.on('close', () => room.clients.delete(res));
      return;
    }
    if (!authed) return json(res, 401, { error: 'unauthorized' });
    if (req.method === 'DELETE' && !c) {
      for (const r of room.clients) { send(r, 'end', {}); r.end(); }
      rooms.delete(id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && c === 'state') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        let s; try { s = JSON.parse(body); } catch {}
        const url = s && s.track ? soundcloud(s.track.url) : null;
        if (!s || (s.track && !url) || !Number.isFinite(s.position)) return json(res, 400, { error: 'bad state' });
        const str = (v) => String(v || '').slice(0, 200);
        room.at = Date.now();
        room.state = { track: url && { url, title: str(s.track.title), artist: str(s.track.artist), duration: Number(s.track.duration) || 0 },
                       playing: s.playing === true, position: Math.max(0, s.position), serverTime: Date.now() };
        for (const r of room.clients) send(r, 'state', room.state);
        json(res, 200, { listeners: room.clients.size });
      });
      return;
    }
    json(res, 404, { error: 'not found' });
  });

  const tick = setInterval(() => { // keep connections alive, drop abandoned rooms
    for (const [id, r] of rooms) { for (const c of r.clients) c.write(': ping\n\n'); if (!r.clients.size && Date.now() - r.at > 6 * 3600e3) rooms.delete(id); }
  }, 15000);
  tick.unref();

  return {
    listen: (port = 8787, host = '0.0.0.0') => new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, () => ok(server.address().port)); }),
    close: () => new Promise((ok) => {
      clearInterval(tick);
      for (const r of rooms.values()) for (const c of r.clients) c.end();
      server.close(ok); server.closeAllConnections();
    })
  };
}

module.exports = { createRelay };

if (require.main === module) createRelay().listen(Number(process.argv[2]) || 8787).then((p) => console.log('Jam relay on port ' + p));
