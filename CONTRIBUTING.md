# Contributing to Crowd Depth

Thanks for helping vessels share depth data! This doc covers how the repo is
organized, how to develop and test each piece, and how releases work.

## Repository layout

This is an npm workspaces monorepo with two packages:

```
packages/
  signalk-plugin/   # "crowd-depth" on npm — the Signal K plugin
  api/              # "crowd-depth-api" — the trusted node API (Cloudflare Worker, not published)
docs/               # CSB reference material (schemas, IHO/NOAA guidance PDFs)
.github/workflows/  # CI (test.yml) and npm publishing (release.yml)
```

### `packages/signalk-plugin` (npm: `crowd-depth`)

Runs inside a Signal K server. Collects depth + position, then reports it on a
schedule to the trusted node API.

| Path | What it does |
| --- | --- |
| `src/plugin.ts` | Plugin entry: wires config, collector, reporter, and schedule together |
| `src/config.ts` | Plugin settings JSON schema and config types |
| `src/collector.ts` | Subscribes to live deltas and writes them to storage |
| `src/sources/` | Where report data comes from: `history.ts` (Signal K History API, e.g. signalk-to-influxdb2) with `sqlite.ts` as the fallback local store |
| `src/storage.ts` | SQLite database setup (`node:sqlite`) |
| `src/streams/` | Stream pipeline: `live.ts` (deltas → `BathymetryData`), `transforms.ts` (offset correction, precision), `geojson.ts` / `xyz.ts` (output formats) |
| `src/reporters/` | Submission to the trusted node API (`noaa.ts` builds and signs the upload) |
| `src/metadata.ts` | Vessel identity (name/MMSI or anonymous UUID) persistence |
| `src/status.ts` | Plugin status messages shown in the Signal K admin UI |
| `src/fetch.ts` | HTTP helpers shared with the API package |
| `bin/xyz-to-geojson` | Helper CLI for converting XYZ files to GeoJSON |

### `packages/api` (`crowd-depth-api`, private)

A small Express app deployed as a Cloudflare Worker at
`https://depth.openwaters.io`. Receives signed GeoJSON reports, stores them in
R2, and forwards them to NOAA's CSB endpoint.

| Path | What it does |
| --- | --- |
| `src/api.ts` | Routes: `POST /identify` (JWT issuance) and `POST /geojson` (authenticated upload) |
| `src/app.ts` | Express app assembly |
| `src/worker.ts` | Cloudflare Workers entry (bridges the Express app to workerd) |
| `src/r2.ts` | R2/S3 storage of received reports |
| `src/sweep.ts` | Hourly cron (see `wrangler.jsonc` `triggers`) that re-submits stored reports to NOAA |
| `src/logger.ts` | pino logger setup |
| `wrangler.jsonc` | Worker config: R2 binding, cron trigger, custom domain |

## Development setup

Requires Node >= 22.13 (the plugin uses `node:sqlite`).

```sh
npm install       # installs all workspaces
npm run build     # tsc -b, all packages
npm test          # vitest, all packages
npm run check     # oxlint + prettier + per-package lint (what CI runs)
```

A husky pre-commit hook runs prettier and oxlint on staged files. CI
(`.github/workflows/test.yml`) runs `check`, `build`, and `test` on every push.

### Working on the plugin

```sh
npm test -w crowd-depth        # plugin tests only
npm run build -w crowd-depth
npm run dev -w crowd-depth     # tsc --watch
```

To run the plugin inside a local Signal K server:

```sh
npm link -w crowd-depth
cd ~/.signalk && npm link crowd-depth
```

Restart the Signal K server after changes (the `dev` watch rebuilds `dist/`,
but the server only loads the plugin at startup).

By default the plugin reports to `http://localhost:3001` unless
`NODE_ENV=production`; set `BATHY_URL` to override, and
`BATHY_DEFAULT_SCHEDULE` (cron syntax) to change the reporting schedule.

### Working on the API

```sh
npm start                      # wrangler dev on http://localhost:3001
npm test -w crowd-depth-api    # API tests only
```

Copy `.env.example` to configure secrets locally. See
[`packages/api/README.md`](packages/api/README.md) for the endpoint contract
and an end-to-end curl example against your local server.

Note the API depends on the plugin workspace (`crowd-depth`) for shared
submission code, so run `npm run build -w crowd-depth` first if plugin sources
changed.

## Testing

Tests live in each package's `test/` directory, mirroring `src/` (e.g.
`src/streams/xyz.ts` → `test/streams/xyz.test.ts`). Vitest is configured at
the repo root (`vitest.config.ts`); `npm test` runs everything in watch mode
locally and single-run in CI. HTTP interactions are mocked with `nock`
(plugin) and exercised with `supertest` (API) — tests never hit NOAA.

When adding a feature, put the test next to the module you touched and follow
the existing file naming.

## Releasing

### Plugin (`crowd-depth` on npm)

Releases are cut from GitHub:

1. Go to [Releases](https://github.com/openwatersio/crowd-depth/releases) →
   *Draft a new release*.
2. Create a tag `vX.Y.Z` (semver) targeting `main`, write release notes, and
   publish.
3. The [release workflow](.github/workflows/release.yml) sets the package
   version from the tag, publishes to npm via trusted publishing (OIDC — no
   tokens to manage), commits the version bump back to `main`, and re-points
   the tag at that commit.

There is no manual `npm publish` or local version bump — the tag is the
version. Signal K servers pick the new version up from npm in the AppStore.

### API (`crowd-depth-api`)

The API is not published to npm. Pushes to `main` deploy automatically through
Cloudflare Workers Builds; `npm run deploy -w crowd-depth-api` deploys
manually. Production secrets (`BATHY_JWT_SECRET`, `NOAA_CSB_TOKEN`,
`NOAA_CSB_URL`) are managed with `wrangler secret put`.

## Pull requests

- Keep changes scoped to one package where possible.
- `npm run check && npm test` should pass before pushing (CI will verify).
- Data-format changes (GeoJSON/XYZ/metadata) should cite the relevant CSB
  guidance — see the [README resources](README.md#resources) and `docs/`.
