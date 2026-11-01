// Reine Sync-Logik (ohne DOM/Electron), damit sie testbar ist. Läuft in Node und im Browser (window.JamSync).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JamSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DRIFT_SECONDS = 1.5;      // ab dieser Abweichung wird nachgesprungen
  const SEEK_COOLDOWN_MS = 4000;  // nach einem Sprung kurz Ruhe, damit sich nichts aufschaukelt

  // Uhr-Versatz Gast <-> Relay (NTP-Mittelwert): t0 = Anfrage gesendet, t1 = Antwort erhalten (Gast-Uhr)
  function clockOffset(t0, serverTime, t1) { return serverTime - (t0 + t1) / 2; }

  // Wo müsste der Gast jetzt sein? serverNow = Relay-Zeit "jetzt" (ms)
  function expectedPosition(state, serverNow) {
    if (!state.playing) return state.position;
    const pos = state.position + Math.max(0, (serverNow - state.serverTime) / 1000);
    const dur = state.track && state.track.duration;
    return dur ? Math.min(pos, dur) : pos;
  }

  // host: Status vom Relay; guest: { url, playing, position, lastSeekAt }; now: Gast-Uhr (ms)
  // Rückgabe: Liste von Aktionen in Ausführungsreihenfolge.
  function plan(host, guest, serverNow, now, opts = {}) {
    const drift = opts.driftSeconds ?? DRIFT_SECONDS;
    const cooldown = opts.seekCooldownMs ?? SEEK_COOLDOWN_MS;
    if (!host || !host.track) return guest.playing ? [{ type: 'pause' }] : [];

    const target = expectedPosition(host, serverNow);
    if (guest.url !== host.track.url) {
      return [{ type: 'load', url: host.track.url, position: target, play: host.playing }];
    }

    const actions = [];
    const off = Math.abs(guest.position - target);
    const mayJump = !host.playing || now - (guest.lastSeekAt || 0) > cooldown;
    if (off > drift && mayJump) actions.push({ type: 'seek', position: target });
    else if (!host.playing && off > 0.5 && guest.playing === false) actions.push({ type: 'seek', position: target });
    if (host.playing && !guest.playing) actions.push({ type: 'play' });
    if (!host.playing && guest.playing) actions.push({ type: 'pause' });
    return actions;
  }

  return { plan, expectedPosition, clockOffset, DRIFT_SECONDS, SEEK_COOLDOWN_MS };
});
