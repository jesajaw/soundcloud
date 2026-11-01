const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../jam/sync');

const host = (o = {}) => ({ track: { url: 'https://soundcloud.com/a/b', duration: 200 }, playing: true, position: 50, serverTime: 1_000_000, ...o });
const guest = (o = {}) => ({ url: 'https://soundcloud.com/a/b', playing: true, position: 50, lastSeekAt: 0, ...o });

test('Position wird nach Server-Zeit hochgerechnet, nie über die Länge', () => {
  assert.equal(S.expectedPosition(host(), 1_004_000), 54);
  assert.equal(S.expectedPosition(host({ playing: false }), 1_004_000), 50);
  assert.equal(S.expectedPosition(host({ position: 199 }), 1_010_000), 200);
});

test('Uhr-Versatz (NTP-Mittelwert)', () => {
  assert.equal(S.clockOffset(1000, 5100, 1200), 5100 - 1100);
});

test('im Takt: nichts tun; Drift: nachspringen; Cooldown verhindert Springen im Kreis', () => {
  assert.deepEqual(S.plan(host(), guest({ position: 50.4 }), 1_000_000, 10_000), []);
  const a = S.plan(host(), guest({ position: 40 }), 1_000_000, 10_000);
  assert.deepEqual(a, [{ type: 'seek', position: 50 }]);
  assert.deepEqual(S.plan(host(), guest({ position: 40, lastSeekAt: 9_000 }), 1_000_000, 10_000), []);
});

test('anderer Track: laden (mit Zielposition), kein Track: pausieren', () => {
  const g = guest({ url: 'https://soundcloud.com/x/y' });
  assert.deepEqual(S.plan(host(), g, 1_002_000, 0), [{ type: 'load', url: 'https://soundcloud.com/a/b', position: 52, play: true }]);
  assert.deepEqual(S.plan({ track: null, playing: false, position: 0, serverTime: 1 }, guest(), 2, 0), [{ type: 'pause' }]);
  assert.deepEqual(S.plan(null, guest({ playing: false }), 2, 0), []);
});

test('Play/Pause folgt dem Host', () => {
  assert.deepEqual(S.plan(host(), guest({ playing: false }), 1_000_000, 0), [{ type: 'play' }]);
  assert.deepEqual(S.plan(host({ playing: false }), guest(), 1_000_000, 0), [{ type: 'pause' }]);
  assert.deepEqual(S.plan(host({ playing: false, position: 80 }), guest({ playing: true, position: 50 }), 1_000_000, 0),
    [{ type: 'seek', position: 80 }, { type: 'pause' }]);
});
