# SoundCloud Desktop

A minimal Electron wrapper around [soundcloud](https://soundcloud.com) for Linux and Windows. Unofficial, not affiliated with SoundCloud; also vibecoded...

## Features
- Own window, login is remembered, media keys and MPRIS
- Remembers window size, position and maximized state
- Downloads go to `~/Music/SoundCloud`, never overwrite, and get a `.sc.json` file when complete
- **Jam**: listen together

## Run
```bash
npm install
npm start
npm run dev
```

Flags: `--hidden` starts in the tray only, `--quit-on-close` makes closing quit.

## Acknowledgments
Thanks to [Claude](https://claude.ai/) for basically building everything.

## License
Distributed under the MIT License. See [LICENSE](LICENSE) for more information.