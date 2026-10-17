# SoundCloud Desktop

Schlanker Electron-Wrapper um soundcloud.com für Linux und Windows.
Inoffiziell, nicht mit SoundCloud verbunden.

## Features
- Eigenes Fenster, Login bleibt gespeichert
- Medientasten und MPRIS-Integration (Linux: playerctl, GNOME/KDE-Mediensteuerung)
- Schließen minimiert in den Tray, Musik läuft weiter
- Fenstergröße/-position wird gemerkt
- Externe Links öffnen im Standardbrowser
- Downloads, die SoundCloud selbst anbietet, werden direkt in den Downloads-Ordner gespeichert

## Starten
    npm install
    npm start

## Pakete bauen
    npm run dist
Ergebnis in `dist/` (Linux: AppImage + .deb, Windows: Installer + portable .exe).
Alternativ per GitHub Actions: Tag `v1.0.0` pushen oder den Workflow "Build" manuell starten,
die Pakete hängen danach als Artifacts am Lauf.

## Hinweis zu Downloads
Nur Tracks, bei denen der Uploader den Download erlaubt hat, haben einen Download-Button.
Die App umgeht keine Sperren und greift nicht auf Audio-Streams zu.
