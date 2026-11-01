# SoundCloud Desktop

Schlanker Electron-Wrapper um soundcloud.com für Linux und Windows.
Inoffiziell, nicht mit SoundCloud verbunden.

## Features
- Eigenes Fenster, Login bleibt gespeichert
- Medientasten und MPRIS-Integration (Linux: playerctl, GNOME/KDE-Mediensteuerung)
- Schließen blendet ins Tray aus, Musik läuft weiter (abschaltbar; ohne Tray schließt die App wirklich)
- Fenstergröße, -position und Maximiert-Zustand werden gemerkt (auch wenn ein Monitor fehlt)
- Rechtsklick-/Langdruck-Menü (Link kopieren, Kopieren/Einfügen, Zurück/Vor/Neu laden), Zoom, Navigation
- Externe Links öffnen im Standardbrowser (nur http/https/mailto)
- Downloads, die SoundCloud selbst anbietet, landen in `~/Musik/SoundCloud` (änderbar), überschreiben nie etwas
  und bekommen eine `.sc.json`-Datei als "fertig"-Signal für andere Programme
- **Jam**: Musik gemeinsam hören, siehe unten
- **Lokale API** für andere Programme (z. B. dein DJ-Player), siehe [INTEGRATION.md](INTEGRATION.md)

## Starten
    npm install
    npm start          # npm run dev: mit Entwicklerwerkzeugen im Rechtsklick-Menü
    npm test           # Relay, Sync-Logik, Downloads, lokale API
    npm start -- --hidden   # ohne Fenster starten (nur Tray), z. B. neben dem DJ-Player

## Jam (gemeinsam hören)
Wie bei Spotify Jam: Du hörst ganz normal in deinem Fenster, und **parallel** läuft ein Raum, dem andere folgen.

1. Menü **Jam → Jam starten** (oder im Tray-Menü). Der Einladungslink (`scjam://join/…`) liegt in der Zwischenablage.
2. Gäste kopieren den Link und wählen **Jam → Jam aus Zwischenablage beitreten**
   (oder öffnen den Link, falls die App als `scjam://`-Handler registriert ist). Es öffnet sich ein Gastfenster.
3. Das Gastfenster folgt deinem Track, Play/Pause und Zeitsprüngen (Abweichung > 1,5 s wird korrigiert).
   Pausiert ein Gast selbst, steigt er aus dem Sync aus und holt sich mit „Neu synchronisieren“ den Stand zurück.
4. **Jam beenden** schließt den Raum für alle. Die Hörerzahl steht im Tray-Tooltip und im Menü.

So funktioniert es, und das sind die Grenzen:
- Es wird **kein Audio** übertragen, nur Track-Link, Position und Play/Pause. Jeder Gast spielt den Track über den
  offiziellen SoundCloud-Embed-Player mit seinem eigenen Zugang. Nicht einbettbare Tracks lassen sich im Gastfenster nicht abspielen,
  und was jemand ohne Login/Go+ hören darf, bestimmt SoundCloud.
- Der Host-Status wird aus der sichtbaren Player-Leiste gelesen (`preload.js`, Selektoren oben in `SEL`).
  Ändert SoundCloud sein Markup, ist nur diese Liste anzupassen. **Debug → Scraper-Zustand in Zwischenablage** zeigt, was greift.
- Ohne weitere Einstellung startet der Host einen eingebauten Relay (Port 8787) und der Link zeigt auf seine LAN-Adresse:
  das reicht für alle im selben Netz. Für Gäste im Internet entweder den Port weiterleiten oder einen Relay irgendwo betreiben
  (`node jam/relay.js --port 8787`, keine Abhängigkeiten) und seine URL in `settings.json` eintragen: `{"jam": {"relay": "https://relay.example.org"}}`.
  Der Relay-Verkehr ist unverschlüsselt, solange kein HTTPS-Proxy davorsteht; wer den Link kennt, kann zuhören.

## Einstellungen
`settings.json` im userData-Ordner (Linux: `~/.config/soundcloud-desktop/`, Windows: `%APPDATA%\soundcloud-desktop\`):

    {
      "closeToTray": true,
      "downloadDir": null,
      "localApi": { "enabled": true, "port": 17876 },
      "jam": { "relay": "", "port": 8787 }
    }

## Pakete bauen
    npm run dist
Ergebnis in `dist/` (Linux: AppImage + .deb, Windows: Installer + portable .exe).
Alternativ per GitHub Actions: Tag `v1.1.0` pushen oder den Workflow "Build" manuell starten,
die Pakete hängen danach als Artifacts am Lauf. `package-lock.json` bitte einchecken (`npm install` erzeugt sie).
Hinweis Ubuntu 24.04: AppImages brauchen dort wegen der AppArmor-Beschränkung für User-Namespaces `--no-sandbox`;
das .deb-Paket hat dieses Problem nicht.

## Hinweis zu Downloads
Nur Tracks, bei denen der Uploader den Download erlaubt hat, haben einen Download-Button.
Die App umgeht keine Sperren und greift nicht auf Audio-Streams zu.
