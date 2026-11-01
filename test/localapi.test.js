const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const http = require('http');
const { createLocalApi } = require('../lib/localapi');
const { openEvents } = require('./_helpers');

function freePort() { return new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }

test('lokale API: Token, Host-/Origin-Prüfung, Befehle, Events', async () => {
  const port = await freePort(); const token = 'a'.repeat(64);
  const cmds = []; const opened = [];
  const state = { track: { title: 'T' }, playing: true };
  const api = createLocalApi({
    port, token, getState: () => state,
    runCommand: async (c) => { cmds.push(c); return c !== 'next'; },
    openUrl: async (u) => { opened.push(u); return u.startsWith('https://soundcloud.com/'); },
    getDownloads: () => [{ file: '/x.mp3' }]
  });
  await api.listen();
  const base = `http://127.0.0.1:${port}`; const auth = { Authorization: `Bearer ${token}` };
  try {
    assert.equal((await fetch(`${base}/v1/now-playing`)).status, 401);
    assert.equal((await fetch(`${base}/v1/now-playing`, { headers: { Authorization: 'Bearer falsch' } })).status, 401);
    assert.equal((await fetch(`${base}/v1/now-playing`, { headers: { ...auth, Origin: 'https://evil.example' } })).status, 403);
    // fetch() darf den Host-Header nicht setzen -> Rebinding-Angriff mit rohem http.request nachstellen
    const rebinding = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/v1/now-playing', headers: { ...auth, Host: 'evil.example' } },
        (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.equal(rebinding, 403);

    assert.deepEqual(await (await fetch(`${base}/v1/now-playing`, { headers: auth })).json(), state);
    assert.deepEqual((await (await fetch(`${base}/v1/downloads`, { headers: auth })).json()).downloads, [{ file: '/x.mp3' }]);

    const post = (p, b) => fetch(base + p, { method: 'POST', headers: auth, body: JSON.stringify(b) });
    assert.equal((await post('/v1/command', { cmd: 'pause' })).status, 200);
    assert.equal((await post('/v1/command', { cmd: 'next' })).status, 502);   // Button nicht gefunden
    assert.equal((await post('/v1/command', { cmd: 'rm -rf' })).status, 400);
    assert.equal((await post('/v1/open', { url: 'https://soundcloud.com/a/b' })).status, 200);
    assert.equal((await post('/v1/open', { url: 'https://evil.example' })).status, 400);
    assert.deepEqual(cmds, ['pause', 'next']);

    const ev = await openEvents(`${base}/v1/events`, auth);
    assert.deepEqual(await ev.next('now-playing'), state);
    api.emit('download', { file: '/y.mp3' });
    assert.deepEqual(await ev.next('download'), { file: '/y.mp3' });
    ev.close();
  } finally { await api.close(); }
});
