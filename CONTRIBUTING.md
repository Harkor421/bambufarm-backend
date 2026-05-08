# Contributing to bambufarm-backend

Internal project — notes for the team and any future maintainers.

## Local setup

```bash
git clone https://github.com/Harkor421/bambufarm-backend.git
cd bambufarm-backend
npm install
cp .env.example .env  # fill in real values
npm run dev
```

Requires Node ≥ 20 and a reachable MongoDB. APNs credentials are only needed if you're testing push / Live Activities.

## Branching

- `main` is always deployable. Railway auto-deploys on every push.
- Feature work: cut a branch off `main`, open a PR.

## Pull-request checklist

- [ ] `npm run lint` clean.
- [ ] `npm test` passes.
- [ ] New helpers under `src/utils/` have unit tests.
- [ ] No real APNs keys / secrets in the diff.

## Style

- Prettier + ESLint configs live in the repo root. Run `npm run format` before pushing.
- Keep modules small. Routes are slim — heavy logic moves to `src/services/`.
- Long-running side effects (cron jobs, MQTT subscribers) are wired up from `src/index.js`.

## Tests

- Jest, `tests/unit/` directory.
- Mock at the boundary — no live MQTT / Mongo / Bambu API calls.

## Architectural notes

- `src/services/wsManager.js` owns the per-user bridge WebSocket pool and camera frame cache.
- `src/services/mqttPrinterService.js` subscribes to Bambu Cloud MQTT for state changes; emits via `eventBus`.
- The User model carries an append-only login state (`bambu_uid`, `bambu_email`, `bambu_account`, `bambu_name`). Email is captured at register time; older users get a backfill in `routes/adminMetrics.js#bootBackfillEmails` on every server boot.
- The admin metrics `/users` endpoint deduplicates by `bambu_uid` via `src/utils/userDedup.js` so multi-device users render as one row.

## Deploys

Railway auto-deploys `main`. The native bambushim binary is built by a `postinstall` script — that step is `--ignore-scripts`-skipped in CI because Linux runners can't compile the macOS plugin.
