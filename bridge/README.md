# BambuFarm Bridge

Desktop app that runs on your PC (same network as printers) to relay camera feeds to the cloud. Built with Electron.

## How It Works

```
Bambu Printers (LAN) ──TLS:6000──► Bridge ──WebSocket──► BambuFarm Server ──► App
```

1. User logs in with Bambu Lab account
2. Bridge auto-discovers printers on the local network
3. Connects to each printer's camera via TLS on port 6000
4. Relays JPEG frames to the BambuFarm server via WebSocket
5. Server forwards frames to connected app clients

## Architecture

| File | Purpose |
|------|---------|
| `electron-main.js` | Electron main process — creates window, tray, starts web UI |
| `index.js` | Core bridge logic — web UI server, bridge start/stop, camera management |
| `bambuCloud.js` | Bambu Cloud API client — login, token refresh, device listing |
| `cameraStream.js` | TLS camera connection per printer — authenticates and streams JPEG frames |
| `wsClient.js` | WebSocket client to BambuFarm server — sends auth, receives demand updates, relays frames |
| `networkScanner.js` | LAN printer discovery — scans network for Bambu printers on port 6000 |

## Camera Protocol

1. TLS connect to `printer_ip:6000`
2. Send 80-byte auth packet: `cmd=0x40, proto=0x3000, user="bblp", pass=access_code`
3. Receive JPEG frames (each prefixed with a 16-byte header containing frame size)

## Building

### Signed + Notarized macOS DMG

```bash
APPLE_ID="your@email.com" \
APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx" \
APPLE_TEAM_ID="YOUR_TEAM_ID" \
npm run dist:mac
```

### Windows Installer

```bash
npm run dist:win
```

### Linux AppImage + Deb

```bash
npm run dist:linux
```

### All Platforms

```bash
npm run dist:all
```

## Development

```bash
npm install
npm run electron  # run without packaging
```

## Configuration

Config stored at `~/.bambubridge/bridge.config.json`:
- `bambuTokens` — Bambu Cloud access/refresh tokens
- `printers` — discovered printers (IP, dev_id, access_code)

## Code Signing

The macOS build is signed with a Developer ID Application certificate and notarized by Apple. Requires:
- Developer ID Application certificate in keychain
- App-specific password stored via `xcrun notarytool store-credentials`
