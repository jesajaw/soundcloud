# SoundCloud Desktop

A minimal Electron wrapper around [soundcloud.com](https://soundcloud.com) for Linux and Windows. Unofficial, not affiliated with SoundCloud; also vibecoded...

## Features
- Own window, login is remembered, media keys and MPRIS
- Remembers window size, position and maximized state
- Downloads go to `~/Music/SoundCloud`, never overwrite, and get a `.sc.json` file when complete
- **Jam**: listen together (the host's track and position are mirrored to guests; no audio is relayed)

## Run
```bash
npm install
npm start          # normal start, closing the window quits
npm run dev        # same, plus a Debug menu and "Inspect" in the context menu
npm run dist       # build AppImage/deb (Linux) or installer/portable (Windows) into dist/
```

Flags: `--hidden` starts in the tray only, `--quit-on-close` makes closing quit instead of hiding to the tray.

## Jam
The host starts a Jam from the menu. A small relay runs inside the app and the invite link is copied to the clipboard.
- The relay listens on your local network (port `8787`, override with `JAM_PORT`) over plain HTTP, so only share the link with people you trust.
- To use an external relay instead, set `JAM_RELAY=https://...`. The relay can also run standalone: `npm run relay`.

## Privacy
Nothing is sent anywhere except to soundcloud.com (and the Jam relay while a Jam is running). Login, window state and cookies live in the app's own user-data folder, not in this repository.

## Acknowledgments
Thanks to [Claude](https://claude.ai/) for basically building everything.

## License
MIT. See [LICENSE](LICENSE).
