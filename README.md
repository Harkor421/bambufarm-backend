# BambuFarm Server

Node.js backend for the BambuFarm app. Handles real-time printer monitoring via MQTT, push notifications, Live Activities, and camera relay.

## Architecture

```
Bambu Cloud MQTT ──► mqttPrinterService ──► APNs (push + Live Activities)
                                         ──► WebSocket (camera relay)
                                         ──► REST API (app queries)
```

### Core Services

| Service | File | Purpose |
|---------|------|---------|
| **MQTT** | `src/services/mqttPrinterService.js` | Connects to Bambu Cloud MQTT broker for real-time printer state (gcode_state, progress, temps). Source of truth for all status. |
| **APNs** | `src/services/apnsSender.js` | Sends iOS push notifications and Live Activity updates via Apple Push Notification service. |
| **Push** | `src/services/pushSender.js` | Sends Expo push notifications to registered devices. |
| **Poller** | `src/services/poller.js` | Lightweight fallback — token refresh + printer discovery every 30 min. MQTT handles all real-time. |
| **WebSocket** | `src/services/wsManager.js` | Manages bridge connections (camera relay) and app WebSocket connections. |
| **Token Refresh** | `src/services/tokenRefresh.js` | Refreshes Bambu access tokens when they expire. |
| **HMS Errors** | `src/utils/hmsErrors.js` | Decodes Bambu HMS error codes into human-readable descriptions. |

### Routes

| Route | File | Purpose |
|-------|------|---------|
| `/api/register` | `src/routes/register.js` | Device registration, push token sync, activity token sync |
| `/api/health` | `src/routes/health.js` | Health check endpoint |
| `/api/printer/*` | `src/routes/printerControl.js` | MQTT state queries, light control |
| `/ws/bridge` | `src/services/wsManager.js` | Bridge WebSocket (camera relay) |
| `/ws/app` | `src/services/wsManager.js` | App WebSocket (camera frames) |
| `/api/admin/broadcast` | `src/routes/register.js` | Admin push notification broadcast |

### Database (MongoDB)

| Model | File | Purpose |
|-------|------|---------|
| **User** | `src/db/models/User.js` | Device registration, Bambu tokens, push tokens, activity tokens |
| **PrinterState** | `src/db/models/PrinterState.js` | Persisted printer state for MQTT reconnect recovery |

## MQTT Flow

1. On boot, connects to `us.mqtt.bambulab.com:8883` for each registered user
2. Subscribes to `device/{dev_id}/report` for all printers
3. Sends `pushall` every 60s for full state refresh
4. Detects `gcode_state` transitions → sends push notifications + Live Activity updates
5. Detects `mc_percent` changes → sends Live Activity progress updates

### State Transitions Handled

| Transition | Action |
|------------|--------|
| → RUNNING (from IDLE/FINISH/FAILED/PREPARE) | Push "started printing" + push-to-start LA |
| RUNNING → PAUSE | Push "paused" + LA update (with HMS reason) |
| PAUSE → RUNNING | Push "resumed" + LA update |
| → FINISH/IDLE (from RUNNING/PAUSE/PREPARE) | Push "finished"/"cancelled" + end LA |
| → FAILED (from RUNNING/PAUSE/PREPARE) | Push "failed" + end LA |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGO_URI` | Yes | MongoDB connection string |
| `API_KEY` | Yes | API key for authenticated endpoints |
| `APNS_KEY_ID` | Yes | Apple APNs key ID |
| `APNS_TEAM_ID` | Yes | Apple team ID |
| `APNS_KEY_CONTENTS` | Yes | APNs private key (PEM format) |
| `APNS_HOST` | No | APNs host (default: `api.push.apple.com`) |
| `POLL_INTERVAL_MS` | No | Poller interval (default: 1800000 / 30 min) |
| `PUBLIC_CAMERA_UID` | No | Bambu UID for public camera demo |

## Development

```bash
npm install
npm run dev  # starts with --watch
```

## Deployment

Deployed on Railway. Deploy from this directory:

```bash
railway up --detach
```
