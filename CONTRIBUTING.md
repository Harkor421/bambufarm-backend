# Contributing to BambuFarm Server

## Setup

```bash
git clone https://github.com/Harkor421/bambufarm-backend.git
cd bambufarm-backend
npm install
cp .env.example .env       # fill in your values
npm run dev                # starts with --watch
```

Requires Node ≥ 20 and a reachable MongoDB instance.

## Branching & PRs

- Branch from `main`: `fix/`, `feat/`, `refactor/`, `docs/`, `chore/`
- One logical change per PR
- CI must pass (lint + 105 tests)
- Use the PR template — fill in the test plan

## Style

- ESLint + Prettier enforce style
  - `npm run lint:fix` to auto-fix
  - `npm run format` to format
- 2-space indent, double quotes, trailing commas (ES5)

## Tests

```bash
npm test                # all 105 tests
npm test -- --watch
npm run test:cov        # with coverage
```

We test:
- MQTT message parsing + state-change rules
- APNs token utilities + sender retry
- Input validation
- Pure utilities

We don't test:
- Mongoose models against a real DB (use the production replica)
- Express routes via supertest beyond smoke tests (cost > value at this scale)

## Releases / deploys

Auto-deploy: push to `main` → Railway redeploys.

There is no manual release step. The server is "live" with each merge. CI gates this — failed tests mean Railway never sees the bad commit.

Rollback: `railway redeploy --previous` from the Railway dashboard or CLI.

## Commit messages

```
fix: mqtt reconnect storm on token refresh
feat: add admin endpoint for force-reconnect
docs: update env-var inventory
chore: bump mqtt to 5.16
refactor: extract APNs retry policy into module
```
