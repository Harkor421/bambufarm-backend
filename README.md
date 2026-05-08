# BambuFarm Server

[![CI](https://github.com/Harkor421/bambufarm-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/Harkor421/bambufarm-backend/actions/workflows/ci.yml)

Node.js backend for the [BambuFarm](https://github.com/Harkor421/BambuFarm) iOS app. Subscribes to Bambu Cloud MQTT for real-time printer state, dispatches push notifications + Live Activity updates via APNs, relays camera streams from per-user bridges, and serves a small REST API for the app.

**Production**: deployed on Railway, ~1,600 active users, ~470 concurrent MQTT connections.

---

## Quick start

```bash
# 1. Install
npm install

# 2. Copy env template + fill in your values
cp .env.example .env

# 3. Run with watch mode
npm run dev
```

Requires Node ≥ 20 and a reachable MongoDB instance. Set `MONGO_URI=mongodb://localhost:27017/bambufarm` for local dev.

---

## Architecture

```
                  ┌──────────────────────────┐
  Bambu Cloud ───►│ mqttPrinterService       │── state changes ──┐
  MQTT (TLS)      │  (one TCP per user × 1)  │                   │
                  └──────────────────────────┘                   ▼
                                                       ┌─────────────────┐
  iOS apps  ◄──── push notifications ──────────────────│ pushSender      │
  (1.6k)    ◄──── Live Activity updates ──────────────►│ apnsSender      │
                                                       └─────────────────┘
                  ┌──────────────────────────┐
  iOS apps  ◄────►│ wsManager (WebSocket)    │◄──── camera frames ────┐
                  │  /ws/app  /ws/bridge     │                        │
                  └──────────────────────────┘                        │
                                                       ┌─────────────────────┐
  iOS apps  ◄──── REST GET /api/admin/...  ────────────│ Express routes      │
            ──── REST POST /api/register ───────────►  │  (validated, auth'd)│
                                                       └─────────────────────┘
```

### Code layout

```
src/
├── index.js              Entry point — boot order: db → mqtt → ws → http
├── app.js                Express app factory (route mounting, middleware)
├── config.js             Centralized env-var reads + defaults
├── routes/               HTTP handlers (one file per resource)
│   ├── adminMetrics.js   Admin dashboard endpoints
│   ├── register.js       Device registration, push token sync
│   ├── printerControl.js Printer commands (pause/resume/stop/light)
│   └── …
├── services/             Long-lived processes
│   ├── mqttPrinterService.js  Bambu MQTT client per user
│   ├── apnsSender.js          APNs HTTP/2 client (Live Activities)
│   ├── pushSender.js          Expo push client
│   ├── wsManager.js           WebSocket server (camera relay)
│   ├── tokenRefresh.js        Bambu OAuth refresh
│   └── eventBus.js            In-process event emitter (decouples services)
├── db/
│   └── models/           Mongoose schemas (User, PrinterState, BridgeSession)
├── middleware/           Express middleware (admin auth, rate-limit, …)
├── utils/                Pure helpers (hmsErrors, normalizers, validators)
└── __tests__/            Jest unit + integration tests (99+ tests)
```

---

## Routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/health` | GET | none | Liveness check (uptime, MQTT counts) |
| `/api/register` | POST | none | Register device, push token, activity tokens |
| `/api/printer/control` | POST | api key | Pause / resume / stop a print |
| `/api/printer/light` | POST | api key | Toggle chamber light |
| `/api/admin/metrics/overview` | GET | admin | Dashboard summary |
| `/api/admin/metrics/printers` | GET | admin | All printers + state |
| `/api/admin/broadcast` | POST | admin | Send a push to all users |
| `/ws/bridge` | WS | uid query | LAN bridge connection (camera publisher) |
| `/ws/app` | WS | uid query | App connection (camera subscriber + MQTT pushes) |

Full API contract: see route handlers — each file has top-of-file JSDoc with payload shapes.

---

## MQTT flow

1. On boot, `mqttPrinterService` opens one TLS TCP per registered user → `us.mqtt.bambulab.com:8883`
2. Subscribes to `device/{dev_id}/report` for all printers owned by the user
3. Sends a `pushall` every 60s as a heartbeat + full-state refresh
4. Each incoming message is normalized → diff'd against last-known state → triggers events:

| Transition | Action |
|---|---|
| → RUNNING (from IDLE/FINISH/FAILED/PREPARE) | Push "started" + start Live Activity (push-to-start) |
| RUNNING → PAUSE | Push "paused" + LA update (with HMS reason) |
| PAUSE → RUNNING | Push "resumed" + LA update |
| → FINISH/IDLE (from RUNNING/PAUSE/PREPARE) | Push "finished" / "cancelled" + end LA |
| → FAILED (from RUNNING/PAUSE/PREPARE) | Push "failed" + end LA |
| Any progress / temp / layer change | LA progress update (debounced) |

State changes also fan out via `eventBus` (`printer:stateChange`) so other services (admin metrics, training data capture) can react without coupling.

---

## Environment variables

All env vars read in `src/config.js`. See [`.env.example`](./.env.example) for the canonical list with comments.

### Required

| Variable | Notes |
|---|---|
| `MONGO_URI` | MongoDB connection string |
| `API_KEY` | Shared key for app → server authenticated endpoints |
| `ADMIN_PASSWORD` | Admin endpoint password (set via Railway env) |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_CONTENTS` (or `APNS_KEY_PATH`) | APNs auth |

### Optional

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `APNS_HOST` | `api.push.apple.com` | Use `api.sandbox.push.apple.com` for dev builds |
| `POLL_INTERVAL_MS` | `30000` | Token refresh / printer discovery cadence |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `NODE_ENV` | `development` | `production` enables stricter behavior |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT` | — | Cloudflare R2 for training-data captures |
| `TECNOPRINTS_UID`, `TECNOPRINTS_URL` | — | External broadcast integration |
| `PUBLIC_CAMERA_UID` | — | Demo camera UID |
| `VISION_ENABLED`, `VISION_INTERVAL_MS`, `VISION_TARGET_UID` | — | Print-vision experimental feature |
| `ANTHROPIC_API_KEY` | — | (reserved) |

---

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Production server (no watch) |
| `npm run dev` | `node --watch` (auto-reload) |
| `npm test` | Jest — runs all `__tests__/` |
| `npm test -- --watch` | Interactive |
| `npm run lint` | ESLint |
| `npm run postinstall` | Builds the (legacy) Bambu plugin shim if Linux |

---

## Tests

99+ tests in `src/__tests__/` covering critical logic:
- MQTT message parsing + state-change rules
- APNs token utilities, sender retry logic
- Input validation
- Training data capture format

```bash
npm test
```

CI: `.github/workflows/ci.yml` runs `npm test` on every PR + push to `main`. A pre-push git hook (in the parent repo) ALSO runs server tests before allowing a push.

---

## Deployment

Auto-deploys to Railway on push to `main`.

- **Builder**: Nixpacks (auto-detected; configured via `nixpacks.toml`)
- **Start command**: `npm start`
- **Health check**: `GET /api/health` — Railway uses this to gate traffic onto a new deploy
- **Migrations**: Mongoose schemas auto-create on first connect; no migration step needed

Manual deploy (rare):

```bash
railway up --detach
```

Rollback:

```bash
railway redeploy --previous
```

---

## Observability

- **Logs**: structured via `src/utils/logger.js` — written to stdout, captured by Railway
- **Metrics**: in-process counters at `GET /api/admin/metrics/overview` (admin auth)
- **Errors**: caught + logged. No third-party error reporting service wired up yet (was considered, decided against for now to keep the dependency surface small)

---

## License

MIT — see [LICENSE](./LICENSE).
