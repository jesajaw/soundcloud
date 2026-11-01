// Kleiner SSE-Client für die Tests
async function openEvents(url, headers = {}) {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal, headers });
  const events = []; const waiters = [];
  const flush = () => {
    for (const w of [...waiters]) {
      const i = events.findIndex((e) => e.event === w.name);
      if (i >= 0) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(events.splice(i, 1)[0].data); }
    }
  };
  if (!res.body) return { res, close: () => ctrl.abort() };
  (async () => {
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block), da = /^data: (.+)$/m.exec(block);
          if (ev && da) { events.push({ event: ev[1], data: JSON.parse(da[1]) }); flush(); }
        }
      }
    } catch {}
    events.push({ event: '__closed', data: null }); flush();
  })();
  return {
    res,
    next: (name, ms = 2000) => new Promise((resolve, reject) => {
      const w = { name, resolve, t: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`Timeout: ${name}`)); }, ms) };
      waiters.push(w); flush();
    }),
    close: () => ctrl.abort()
  };
}
module.exports = { openEvents };
