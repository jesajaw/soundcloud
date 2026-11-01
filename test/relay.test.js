const test = require('node:test');
const assert = require('node:assert/strict');
const { createRelay, cleanState } = require('../jam/relay');
const { createJamHost, parseInvite, buildInvite } = require('../jam/host');
const { openEvents } = require('./_helpers');

const TRACK = { url: 'https://soundcloud.com/artist/song?in=foo/sets/bar', title: 'Song', artist: 'Artist', duration: 200 };
const put = (base, room, token, body) => fetch(`${base}/rooms/${room}/state`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
});

async function withRelay(fn, opts) {
  const relay = createRelay(opts);
  const port = await relay.listen(0, '127.0.0.1');
  try { await fn(`http://127.0.0.1:${port}`, relay); } finally { await relay.close(); }
}

test('cleanState: nur https-soundcloud-Links, Query wird entfernt', () => {
  assert.equal(cleanState({ track: TRACK, playing: true, position: 12.5 }).track.url, 'https://soundcloud.com/artist/song');
  assert.equal(cleanState({ track: { url: 'https://evil.example/x' }, position: 0 }), null);
  assert.equal(cleanState({ track: { url: 'https://soundcloud.com.evil.example/x' }, position: 0 }), null);
  assert.equal(cleanState({ track: { url: 'http://soundcloud.com/a/b' }, position: 0 }), null);
  assert.equal(cleanState({ track: null, position: 'x' }), null);
  assert.equal(cleanState({ track: null, playing: true, position: 5 }).track, null);
});

test('Raum anlegen, Auth, Status, Gäste bekommen hello/state/end', async () => {
  await withRelay(async (base) => {
    const { room, hostToken } = await (await fetch(`${base}/rooms`, { method: 'POST' })).json();
    assert.ok(room.length >= 16 && hostToken.length >= 24);

    assert.equal((await put(base, room, null, { track: null, position: 0 })).status, 401);
    assert.equal((await put(base, room, 'falsch', { track: null, position: 0 })).status, 401);
    assert.equal((await put(base, room, hostToken, { track: { url: 'https://evil.example/' }, position: 0 })).status, 400);

    const guest = await openEvents(`${base}/rooms/${room}/events`);
    const hello = await guest.next('hello');
    assert.equal(hello.state, null);
    assert.equal(hello.listeners, 1);

    const r = await put(base, room, hostToken, { track: TRACK, playing: true, position: 30 });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).listeners, 1);
    const st = await guest.next('state');
    assert.equal(st.track.url, 'https://soundcloud.com/artist/song');
    assert.equal(st.playing, true);
    assert.equal(st.position, 30);
    assert.ok(st.serverTime > 0 && st.seq === 1);

    const late = await openEvents(`${base}/rooms/${room}/events`);   // später dazu: bekommt sofort den aktuellen Stand
    assert.equal((await late.next('hello')).state.position, 30);

    assert.equal((await fetch(`${base}/rooms/${room}`, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(`${base}/rooms/${room}`, { method: 'DELETE', headers: { Authorization: `Bearer ${hostToken}` } })).status, 200);
    await guest.next('end');
    assert.equal((await fetch(`${base}/rooms/${room}`)).status, 404);
    guest.close(); late.close();
  });
});

test('Limits: zu großer Body, volle Räume, Rate-Limit', async () => {
  await withRelay(async (base) => {
    const { room, hostToken } = await (await fetch(`${base}/rooms`, { method: 'POST' })).json();
    const big = await put(base, room, hostToken, { track: null, position: 0, junk: 'x'.repeat(40000) });
    assert.equal(big.status, 413);
  });
  await withRelay(async (base) => {
    assert.equal((await fetch(`${base}/rooms`, { method: 'POST' })).status, 201);
    assert.equal((await fetch(`${base}/rooms`, { method: 'POST' })).status, 503);
  }, { maxRooms: 1 });
  await withRelay(async (base) => {
    for (let i = 0; i < 10; i++) assert.equal((await fetch(`${base}/rooms`, { method: 'POST' })).status, 201);
    assert.equal((await fetch(`${base}/rooms`, { method: 'POST' })).status, 429);
  });
  await withRelay(async (base) => {
    const { room } = await (await fetch(`${base}/rooms`, { method: 'POST' })).json();
    const a = await openEvents(`${base}/rooms/${room}/events`); await a.next('hello');
    assert.equal((await fetch(`${base}/rooms/${room}/events`)).status, 503);
    a.close();
  }, { maxListeners: 1 });
});

test('Einladungslinks: bauen und parsen, Müll wird abgelehnt', () => {
  const link = buildInvite('http://192.168.1.5:8787', 'abcDEF123_-xyz');
  assert.deepEqual(parseInvite(link), { room: 'abcDEF123_-xyz', relay: 'http://192.168.1.5:8787' });
  assert.equal(parseInvite('https://example.com'), null);
  assert.equal(parseInvite('scjam://join/kurz?relay=http://x'), null);
  assert.equal(parseInvite('scjam://join/abcDEF123_-xyz?relay=javascript:alert(1)'), null);
  assert.equal(parseInvite('scjam://join/abcDEF123_-xyz'), null);
});

test('Host-Controller: start, push, Hörerzahl, stop', async () => {
  await withRelay(async (base) => {
    const seen = [];
    const host = createJamHost({ relayBase: base, onStatus: (s) => seen.push(s) });
    host.push({ track: { url: 'https://soundcloud.com/a/b', title: 'T', artist: 'A', duration: 100 }, playing: true, position: 10 }); // vor start()
    const invite = await host.start();
    const { room, relay } = parseInvite(invite);
    assert.equal(relay, base);
    const guest = await openEvents(`${relay}/rooms/${room}/events`);
    const hello = await guest.next('hello');
    // der vor start() gemeldete Stand wird direkt nach dem Anlegen nachgereicht
    const first = hello.state || await guest.next('state');
    assert.equal(first.track.url, 'https://soundcloud.com/a/b');
    assert.equal(first.playing, true);
    assert.ok(first.position >= 10);
    host.push({ track: null, playing: false, position: 0 });
    assert.equal((await guest.next('state')).track, null);
    await host.stop();
    await guest.next('end');
    assert.equal(host.isRunning(), false);
    guest.close();
  });
});
