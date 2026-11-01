const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { sanitizeFilename, uniquePath, writeSidecar } = require('../lib/downloads');

test('Dateinamen werden gesäubert', () => {
  assert.equal(sanitizeFilename('track.mp3'), 'track.mp3');
  assert.equal(sanitizeFilename('../../.bashrc'), 'bashrc');
  assert.equal(sanitizeFilename('a/b/c.wav'), 'c.wav');
  assert.equal(sanitizeFilename('..\\..\\evil.exe'), 'evil.exe');
  assert.equal(sanitizeFilename('we:ird*na?me.mp3'), 'we_ird_na_me.mp3');
  assert.equal(sanitizeFilename(''), 'download');
  assert.ok(sanitizeFilename('x'.repeat(500) + '.mp3').length <= 200);
});

test('nie überschreiben; Sidecar entsteht atomar und erst auf Wunsch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-'));
  const a = uniquePath(dir, 'song.mp3'); assert.equal(path.basename(a), 'song.mp3');
  fs.writeFileSync(a, 'x');
  const b = uniquePath(dir, 'song.mp3'); assert.equal(path.basename(b), 'song (1).mp3');
  fs.writeFileSync(b + '.crdownload', 'x');   // laufender Download blockiert den Namen ebenfalls
  assert.equal(path.basename(uniquePath(dir, 'song (1).mp3')), 'song (1) (1).mp3');

  assert.equal(fs.existsSync(a + '.sc.json'), false);
  const side = writeSidecar(a, { pageUrl: 'https://soundcloud.com/x/y', pageTitle: 'T', nowPlaying: { title: 'N' } });
  const j = JSON.parse(fs.readFileSync(side.path, 'utf8'));
  assert.equal(j.file, 'song.mp3'); assert.equal(j.size, 1); assert.equal(j.pageUrl, 'https://soundcloud.com/x/y'); assert.equal(j.nowPlaying.title, 'N');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  fs.rmSync(dir, { recursive: true });
});
