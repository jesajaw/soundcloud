// Lokale Schnittstelle für andere Programme auf demselben Rechner (z. B. der DJ-Player).
// Nur 127.0.0.1, Bearer-Token, kein Browser-Zugriff (Origin/Host werden geprüft).
// Doku: INTEGRATION.md
const http = require('http');
const crypto = require('crypto');

function createLocalApi({ port, token, getState, runCommand, openUrl, getDownloads }) {
  const sseClients = new Set();
  const tokenHash = crypto.createHash('sha256').update(token).digest();

  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 8192) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  async function handle(req, res) {
    // DNS-Rebinding / fremde Webseiten aussperren
    const hostOk = new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(req.headers.host);
    if (!hostOk || req.headers.origin) return json(res, 403, { error: 'forbidden' });
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m || !crypto.timingSafeEqual(crypto.createHash('sha256').update(m[1]).digest(), tokenHash)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const path = new URL(req.url, 'http://x').pathname;

    if (req.method === 'GET' && path === '/v1/health') return json(res, 200, { ok: true, app: 'soundcloud-desktop' });
    if (req.method === 'GET' && path === '/v1/now-playing') return json(res, 200, getState());
    if (req.method === 'GET' && path === '/v1/downloads') return json(res, 200, { downloads: getDownloads() });

    if (req.method === 'GET' && path === '/v1/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: now-playing\ndata: ${JSON.stringify(getState())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'POST' && (path === '/v1/command' || path === '/v1/open')) {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'ungültiges JSON' }); }
      if (path === '/v1/command') {
        if (!['play', 'pause', 'toggle', 'next', 'prev'].includes(body.cmd)) return json(res, 400, { error: 'unbekannter Befehl' });
        const ok = await runCommand(body.cmd);
        return json(res, ok ? 200 : 502, { ok, cmd: body.cmd, ...(ok ? {} : { error: 'Player-Button nicht gefunden oder Seite noch nicht geladen' }) });
      }
      const ok = await openUrl(String(body.url || ''));
      return json(res, ok ? 200 : 400, { ok, ...(ok ? {} : { error: 'nur https://soundcloud.com/… erlaubt' }) });
    }
    return json(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: 'internal' }); else res.end(); });
  });

  return {
    server,
    emit(event, data) { for (const r of sseClients) r.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    }),
    close: () => new Promise((resolve) => {
      for (const r of sseClients) r.end();
      server.close(() => resolve());
      server.closeAllConnections?.();
    })
  };
}

module.exports = { createLocalApi };
