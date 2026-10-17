# Contributing to Crowd Depth

Thanks for helping vessels share depth data! This doc covers how the repo is
organized, how to develop and test each piece, and how releases work.

## Repository layout

This is an npm workspaces monorepo with two npm packages and one Python project:

```
packages/
  signalk-plugin/   # "crowd-depth" on npm — the Signal K plugin
  api/              # "crowd-depth-api" — the trusted node API (Cloudflare Worker, not published)
  grid/             # Python (uv): the global depth grid pipeline, see docs/plans/global-grid
docs/               # CSB reference material (schemas, IHO/NOAA guidance PDFs)
.github/workflows/  # CI (test.yml, grid.yml) and npm publishing (release.yml)
```

### `packages/signalk-plugin` (npm: `crowd-depth`)

Runs inside a Signal K server. Collects depth + position, then reports it on a
schedule to the trusted node API.

| Path                 | What it does                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/plugin.ts`      | Plugin entry: wires config, collector, reporter, and schedule together                                                                           |
| `src/config.ts`      | Plugin settings JSON schema and config types                                                                                                     |
| `src/collector.ts`   | Subscribes to live deltas and writes them to storage                                                                                             |
| `src/sources/`       | Where report data comes from: `history.ts` (Signal K History API, e.g. signalk-to-influxdb2) with `sqlite.ts` as the fallback local store        |
| `src/storage.ts`     | SQLite database setup (`node:sqlite`)                                                                                                            |
| `src/streams/`       | Stream pipeline: `live.ts` (deltas → `BathymetryData`), `transforms.ts` (offset correction, precision), `geojson.ts` / `xyz.ts` (output formats) |
| `src/reporters/`     | Submission to the trusted node API (`noaa.ts` builds and signs the upload)                                                                       |
| `src/metadata.ts`    | Vessel identity (name/MMSI or anonymous UUID) persistence                                                                                        |
| `src/status.ts`      | Plugin status messages shown in the Signal K admin UI                                                                                            |
| `src/fetch.ts`       | HTTP helpers shared with the API package                                                                                                         |
| `bin/xyz-to-geojson` | Helper CLI for converting XYZ files to GeoJSON                                                                                                   |

### `packages/api` (`crowd-depth-api`, private)

A small Express app deployed as a Cloudflare Worker at
`https://depth.openwaters.io`. Receives signed GeoJSON reports, stores them in
R2, and forwards them to NOAA's CSB endpoint.

| Path             | What it does                                                                         |
| ---------------- | ------------------------------------------------------------------------------------ |
| `src/api.ts`     | Routes: `POST /identify` (JWT issuance) and `POST /geojson` (authenticated upload)   |
| `src/app.ts`     | Express app assembly                                                                 |
| `src/worker.ts`  | Cloudflare Workers entry (bridges the Express app to workerd)                        |
| `src/r2.ts`      | R2/S3 storage of received reports                                                    |
| `src/sweep.ts`   | Hourly cron (see `wrangler.jsonc` `triggers`) that re-submits stored reports to NOAA |
| `src/logger.ts`  | pino logger setup                                                                    |
| `wrangler.jsonc` | Worker config: R2 binding, cron trigger, custom domain                               |

## Development setup

Requires Node >= 24. Local development and CI read the tested Node version from `mise.toml`; `mise install` installs it locally.

```sh
npm ci            # installs all workspaces from package-lock.json
npm run build     # tsc -b, all packages
npm test          # vitest, all packages
npm run check     # oxlint + prettier + per-package lint
npm run format    # auto-fix lint and formatting issues
```

A husky pre-commit hook runs prettier and oxlint on staged files.

### Checks

CI (`.github/workflows/test.yml`) runs these on every push:

```sh
npm ci
npm run check
npm run build
npm run test
npm pack --dry-run -w crowd-depth
```

### Working on the plugin

```sh
npm test -- --project crowd-depth   # plugin tests only
npm run build -w crowd-depth
npm run dev -w crowd-depth     # tsc --watch
```

The end-to-end suite boots a real Signal K server with the built plugin,
feeds it soundings over the WebSocket API and through a stand-in History API
provider, and checks the uploads against the CSB schema. It needs a
signalk-server install and is skipped without one, except under CI:

```sh
npm install --prefix /tmp/signalk --no-save signalk-server@2.33.0
npm run build
SIGNALK_SERVER_DIR=/tmp/signalk/node_modules/signalk-server npm run test:e2e
```

To run the plugin inside a local Signal K server:

```sh
npm link -w crowd-depth
cd ~/.signalk && npm link crowd-depth
```

Restart the Signal K server after changes (the `dev` watch rebuilds `dist/`,
but the server only loads the plugin at startup).

If your Signal K server runs in Docker, don't bind-mount the plugin inside
`node_modules` — the AppStore reifies that tree with npm and can't rename a
mount point (`EBUSY`), which breaks every plugin install/update. Mount it
outside `node_modules` and reference it with a `file:` dependency instead.

By default the plugin reports to `http://localhost:3001` unless
`NODE_ENV=production`; set `BATHY_URL` to override, and
`BATHY_DEFAULT_SCHEDULE` (cron syntax) to change the reporting schedule.
Each report leaves out the last `BATHY_REPORT_DELAY` seconds (default 300);
set it to `0` to report soundings as soon as they're recorded.

### Working on the API

```sh
npm start                      # wrangler dev on http://localhost:3001
npm test -- --project crowd-depth-api   # API tests only
```

Copy `.env.example` to configure secrets locally. See
[`packages/api/README.md`](packages/api/README.md) for the endpoint contract
and an end-to-end curl example against your local server.

Note the API depends on the plugin workspace (`crowd-depth`) for shared
submission code, so run `npm run build -w crowd-depth` first if plugin sources
changed.

### Working on the grid

`packages/grid` is a Python project managed with [uv](https://docs.astral.sh/uv/), outside the npm workspaces, so `npm` commands skip it. It builds the point store described in [the global grid plan](docs/plans/global-grid/README.md).

```sh
cd packages/grid
uv run pytest                          # tests
uv run ruff check && uv run ruff format --check
uv run grid --store /tmp/grid ingest --prefix 2026/10/14   # one day of both sources into a local store
uv run grid --store /tmp/grid qc       # rerun QC on every ingest batch (ingest runs it as it goes)
uv run grid --store /tmp/grid cells    # rebuild every grid cell
uv run grid --store /tmp/grid stats
```

Listing the Open Waters bucket needs `S3_ENDPOINT`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` in the environment; NOAA's bucket is public. Each run caps DuckDB at `GRID_MEMORY_LIMIT` (default `4GB`) and spills past it, into a directory of its own under `GRID_TEMP_DIR` (default: the system temp directory), where downloads also wait. A store records the scheme it hashes content with, and a build with another scheme refuses it; rebuild such a store by deleting its directory or R2 prefix and ingesting again. Give it at least 500 MB; the process peaks at about the limit plus 0.6 GB. At 500 MB, a day of NOAA and Open Waters files, NOAA's largest CSV (495 MB, 3M soundings) and a synthetic mooring cell of 80M soundings each ingested or built under 1.1 GB. Spill uses up to about 240 bytes of disk per sounding of the largest unit of work. `--source noaa` limits a run to one source, and `--max-files N` bounds a run so a backfill publishes its progress as it goes. An ingest exits with status 2 when it holds withdrawals, a listing was incomplete, a file couldn't be fetched, or a key matches no known layout; `grid confirm-withdrawals SOURCE` lets held withdrawals apply once two listings agree.

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
   _Draft a new release_.
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

## Release preparation

Before cutting a release, review the specs and plans touched since the previous
one, plus anything carried forward:

- [ ] Preserve lasting API contracts, constraints, and operational guidance in
      the maintained docs; record user-facing changes in the release notes.
- [ ] Delete specs and plans whose implementation is complete and merged. Git
      history keeps them.
- [ ] Trim roadmaps to remaining work, linking the relevant issues. Carry
      unfinished plans forward.
- [ ] Put the deletions in a pull request a human reviews before publishing.

## Pull requests

- Keep changes scoped to one package where possible.
- `npm run check && npm test` should pass before pushing (CI will verify).
- Commit `package-lock.json` alongside any dependency change.
- Data-format changes (GeoJSON/XYZ/metadata) should cite the relevant CSB
  guidance — see the [README resources](README.md#resources) and `docs/`.
