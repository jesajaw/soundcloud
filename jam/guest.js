// Guest page: follows the host's track, position and play/pause through SoundCloud's official embed player.
const $ = (id) => document.getElementById(id);
const room = location.pathname.slice(1);
let host, widget, ready, url, offset = 0, follow = true, lastSeek = 0, busy = false, timer;
const ask = (fn) => new Promise((r) => widget[fn](r));

async function apply() {
  if (busy || !follow || !host) return;
  busy = true;
  try {
    const t = host.track;
    $('title').textContent = t ? `${t.artist} – ${t.title}` : 'The host is not playing';
    if (!t) return ready && widget.pause();
    if (!widget) { // first track: create the embed player
      const f = document.createElement('iframe');
      f.allow = 'autoplay';
      f.src = 'https://w.soundcloud.com/player/?visual=false&url=' + encodeURIComponent(t.url);
      $('box').append(f);
      url = t.url;
      widget = SC.Widget(f);
      return widget.bind(SC.Widget.Events.READY, () => { ready = true; apply(); });
    }
    if (!ready) return;
    if (url !== t.url) { // track changed: load it, the next apply() seeks into position
      url = t.url; ready = false; lastSeek = 0;
      return widget.load(t.url, { auto_play: host.playing, callback: () => { ready = true; apply(); } });
    }
    const want = host.position + (host.playing ? (Date.now() + offset - host.serverTime) / 1000 : 0);
    const [pos, paused] = [await ask('getPosition'), await ask('isPaused')];
    if (Math.abs(pos / 1000 - want) > 1.5 && (!host.playing || Date.now() - lastSeek > 4000)) { lastSeek = Date.now(); widget.seekTo(want * 1000); }
    if (host.playing && paused) widget.play();
    if (!host.playing && !paused) widget.pause();
  } finally { busy = false; }
}

$('join').onclick = async () => { // a click is needed anyway: browsers only allow audio after a gesture
  $('join').hidden = true; $('follow').hidden = false;
  const t0 = Date.now();
  offset = (await (await fetch('/time')).json()).now - (t0 + Date.now()) / 2; // clock difference to the relay
  const es = new EventSource(`/rooms/${room}/events`);
  es.addEventListener('hello', (e) => { host = JSON.parse(e.data).state; $('status').textContent = 'live'; apply(); });
  es.addEventListener('state', (e) => { host = JSON.parse(e.data); apply(); });
  es.addEventListener('end', () => { es.close(); clearInterval(timer); $('status').textContent = 'ended'; widget && widget.pause(); });
  es.onerror = () => { $('status').textContent = 'reconnecting...'; };
  timer = setInterval(apply, 2000); // drift check between host updates
};
$('follow').onclick = () => { follow = !follow; $('follow').textContent = follow ? 'Following' : 'Not following - click to follow'; apply(); };
