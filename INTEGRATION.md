# Zusammenarbeit mit dem DJ-Player

Beide Programme laufen unabhängig nebeneinander und tauschen sich über zwei Wege aus.
Der Ordner funktioniert immer; die lokale API ist die Komfortschicht obendrauf.

## 1. Gemeinsamer Ordner (Dateien)

Standard: `~/Musik/SoundCloud` (Windows: `Musik\SoundCloud`), änderbar über Datei → Download-Ordner wählen.

Der DJ-Player beobachtet den Ordner und importiert nur, wenn die **Sidecar-Datei** `<name>.sc.json` erscheint:

- Während des Downloads schreibt Chromium in `<name>.crdownload` - ignorieren.
- Erst wenn die Datei komplett ist, entsteht `<name>.sc.json` (atomar per Umbenennen, nie halb geschrieben).
- Existierende Dateien werden nie überschrieben, es gibt `name (1).mp3` usw.

Inhalt der Sidecar-Datei:

    {
      "version": 1,
      "app": "soundcloud-desktop",
      "file": "track.mp3",
      "size": 8123456,
      "downloadedAt": "2026-11-01T18:30:00.000Z",
      "pageUrl": "https://soundcloud.com/artist/track",   // Seite, auf der der Download-Button geklickt wurde
      "pageTitle": "Stream Track by Artist | …",
      "nowPlaying": { "title": "…", "artist": "…", "trackUrl": "…" }  // was gerade im Player lief, kann ein anderer Track sein
    }

Für Titel/Künstler/BPM im DJ-Player bitte die ID3-Tags der Datei bevorzugen; die Sidecar-Daten sind Beiwerk.

## 2. Lokale API (laufende Steuerung)

Nur `127.0.0.1`, Standardport `17876`. Zugangsdaten stehen in `local-api.json` im userData-Ordner
(Linux `~/.config/soundcloud-desktop/`, Windows `%APPDATA%\soundcloud-desktop\`): `{ "port": 17876, "token": "…" }`.
Jede Anfrage braucht `Authorization: Bearer <token>`. Anfragen mit `Origin`-Header (Browser) oder fremdem `Host` werden abgelehnt.

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/v1/now-playing` | `{ track:{url,title,artist,duration}\|null, playing, position, source, updatedAt, jam:{running,listeners} }` |
| GET | `/v1/events` | Server-Sent-Events: `now-playing` (Änderungen + Heartbeat alle 5 s) und `download` (fertig/abgebrochen) |
| POST | `/v1/command` | `{ "cmd": "play" \| "pause" \| "toggle" \| "next" \| "prev" }` → `200 {ok:true}` oder `502`, wenn der Player-Button nicht gefunden wurde |
| POST | `/v1/open` | `{ "url": "https://soundcloud.com/…" }` lädt die Seite im SoundCloud-Fenster (ohne es in den Vordergrund zu holen) |
| GET | `/v1/downloads` | die letzten 50 Downloads dieser Sitzung |

Typische Abläufe für den DJ-Player (Touch-Oberfläche):
- **Deck startet → SoundCloud pausieren:** `POST /v1/command {"cmd":"pause"}`.
- **"SoundCloud"-Kachel:** `GET /v1/now-playing` bzw. `/v1/events` für Titel und Position, Buttons für Play/Pause/Next.
- **Neuer Download:** auf `download`-Event oder `.sc.json` reagieren und den Track in die Bibliothek aufnehmen.
- **Suche/Playlist öffnen:** `POST /v1/open` mit `https://soundcloud.com/search?q=…`, das SoundCloud-Fenster bleibt im Hintergrund.

Zum Zusammenleben auf dem Touchscreen: `npm start -- --hidden` (bzw. Autostart mit `--hidden`) startet SoundCloud nur im Tray,
gesteuert wird dann über die API; das Fenster holt `Anzeigen / Verbergen` im Tray oder ein erneuter Start der App nach vorn.
Auf Linux funktioniert zusätzlich `playerctl` (MPRIS), unabhängig von dieser API.

Ein lauffähiges Beispiel (Node, ohne Abhängigkeiten) liegt in `examples/dj-watch.js`.
