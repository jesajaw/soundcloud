// Runs inside soundcloud.com: reads the visible player bar (never the audio) and reports it to main.js.
const { ipcRenderer } = require('electron');
const $ = (s) => document.querySelector(s);
// Selectors of the player bar - if SoundCloud changes its markup, fix them here.
const S = { title: 'a.playbackSoundBadge__titleLink', artist: 'a.playbackSoundBadge__lightLink', play: '.playControls__play', bar: '.playbackTimeline__progressWrapper' };

function read() {
  const link = $(S.title), bar = $(S.bar), play = $(S.play), artist = $(S.artist);
  let track = null;
  if (link) {
    const u = new URL(link.getAttribute('href'), location.origin);
    track = { url: u.origin + u.pathname, title: link.title || link.textContent.trim(), artist: artist ? artist.title || artist.textContent.trim() : '',
              duration: parseFloat(bar && bar.getAttribute('aria-valuemax')) || 0 };
  }
  return { track, playing: !!track && !!play && play.classList.contains('playing'), position: parseFloat(bar && bar.getAttribute('aria-valuenow')) || 0 };
}

// Report changes and seeks right away, otherwise a heartbeat every 5 s.
let sent = null;
setInterval(() => {
  let s; try { s = read(); } catch { return; } // markup surprise: skip this tick instead of throwing every 500 ms
  const now = Date.now();
  const key = (s.track ? s.track.url : '') + s.playing;
  const expected = sent ? sent.position + (sent.playing ? (now - sent.at) / 1000 : 0) : 0;
  if (!sent || sent.key !== key || now - sent.at >= 5000 || Math.abs(s.position - expected) > 1.5) {
    sent = { key, at: now, position: s.position, playing: s.playing };
    ipcRenderer.send('sc:state', s);
  }
}, 500);
