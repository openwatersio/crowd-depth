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
.github/workflows/  # CI (test.yml, grid.yml, lockfile.yml), PR previews (preview.yml), and npm publishing (release.yml)
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
| `src/chart.ts`       | The "My soundings" chart layer: live tile writer, backfill, tile routes, and the plotter extension                                               |
| `src/tiles/`         | Shoal-biased tile pyramid of the boat's own soundings in the plugin's SQLite database (`core/` is shared with the browser)                       |
| `src/plotterext/`    | Plotter extension manifest and resource provider that offer the layer to chartplotters such as Freeboard-SK                                      |
| `web/`               | Browser code for the layer: background runtime, WebGL render worker and settings panel, bundled into `public/` by `scripts/build-web.mjs`        |
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

It also runs the end-to-end suite (below) and boots the API Worker under `wrangler dev` with production settings, failing if it crashes at startup.

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
./docker.sh                            # tests, in the same image CI uses
./docker.sh uv run ruff check          # any command, in that image
uv run pytest                          # tests on the host; those that need tippecanoe, gdal_grid or gdal_contour fail without them
uv run ruff check && uv run ruff format --check
uv run grid --store /tmp/grid ingest --prefix 2026/10/14   # one day of both sources into a local store
uv run grid --store /tmp/grid qc       # rerun QC on every ingest batch (ingest runs it as it goes)
uv run grid --store /tmp/grid tide     # tide levels for the soundings' station days (Node, Slackwater and CO-OPS)
uv run grid --store /tmp/grid calibrate --reference s102 --reference bluetopo   # vessel offsets, after sampling references at new pixels
uv run grid --store /tmp/grid cells    # rebuild every grid cell
uv run grid --store /tmp/grid cells --changed   # only the tiles a calibration or tide change made stale
uv run grid --store /tmp/grid ingest --source noaa --keys keys.txt   # only these keys (a region's, from NOAA's track index); withdraws nothing
uv run grid --store /tmp/grid cells --bbox=-77.5,36.8,-75.5,39.7      # only the 1° tiles a box touches, with = as a west longitude starts with -; overlay then waits for a full cells run
./docker.sh uv run grid --store .preview/store overlay --out .preview/out   # overlay layers and PMTiles, in the image; it mounts only packages/grid, so the store must be in it
uv run grid --store .preview/store benchmark --surface .preview/out/surface --out .preview/bench   # score a render against S-102 and BlueTopo; see Validation in docs/plans/global-grid
uv run grid --store /tmp/grid stats
uv run grid cache                      # the shared download cache's size by kind; --prune drops old releases and files past the cap
```

`grid tide` runs the Slackwater engine through Node 24: run `npm ci` in `packages/grid/slackwater` once on the host (the image has it installed already). It fetches CO-OPS gauge data per gauge and month, again on each run until a month is final 45 days after it ends, and `calibrate --reference s102` or `bluetopo` downloads NOAA's tiles it needs; a local file or directory of their rasters works too. `tide` refuses a run in which more than a tenth of the store's stations would leave (once it has 100), and `calibrate` one that would drop more than half its calibrated segments (once it has 20); `--accept-departures` and `--accept-losses` let them through once checked.

Listing the Open Waters bucket needs `S3_ENDPOINT`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` in the environment; NOAA's bucket is public. Each run caps DuckDB at `GRID_MEMORY_LIMIT` (default `4GB`) and spills past it, into a directory of its own under `GRID_TEMP_DIR` (default: the system temp directory), where downloads also wait. A store records the scheme it hashes content with, and a build with another scheme refuses it; rebuild such a store by deleting its directory or R2 prefix and ingesting again. Give it at least 500 MB; ingest peaks at about the limit plus 0.6 GB, plus track QC's arrays (below), plus about 1 GB for a run that lists all of NOAA's million files rather than one `--prefix`, since the listing and the store's file and hash indexes are held in Python. Give `grid overlay` at least 1 GB: the surface's query for a dense tile's pixels runs out of memory at 500 MB. A local `--store` directory is for one process at a time: its lock is atomic only within a process. At 500 MB, a day of NOAA and Open Waters files ingested, and the cells of a synthetic mooring cell of 80M soundings built, each under 1.1 GB. On the Chesapeake at the default 4 GB, ingesting 18,000 files peaked at 1.7 GB, and building their cells at 5.0 GB, with DuckDB itself at 3.5 GB: size a cells worker for a dense region at the limit plus about 1.1 GB. Spill uses up to about 240 bytes of disk per sounding of the largest unit of work, plus a copy of the densest tile's active points, which cells keep while they work its bands. Track QC holds each batch's soundings and one file's working arrays in Python, outside that limit, at about 200 bytes a sounding: NOAA's largest Chesapeake CSV (3.5M soundings) ingests at 1.7 GB with a 500 MB limit, and one file of 80M soundings would need about 16 GB. `grid qc` of the whole Chesapeake store (98.5M soundings) peaked at 2.0 GB at the default limit, and `grid cells` runs it first for any batch not yet QC'd at the current version. `grid overlay` also holds one tile's rasters, its pixels' aggregates and its depth areas in Python, outside that limit: the rasters alone are about 2 GB for a fully covered tile at the equator (5,400 by 5,400 pixels), and the densest Chesapeake tiles peaked at the limit plus 3.3 GB, so size an overlay worker at the limit plus about 3.5 GB. `--source noaa` limits a run to one source, and `--max-files N` bounds a run so a backfill publishes its progress as it goes. An ingest exits with status 2 when it holds withdrawals, a listing was incomplete, a file couldn't be fetched, or a key matches no known layout; `grid confirm-withdrawals SOURCE` lets held withdrawals apply once two listings agree.

Downloads go to one cache that every store and worktree on the machine shares, at `GRID_CACHE_DIR` (default `$XDG_CACHE_HOME/crowd-depth-grid`, or `~/.cache/crowd-depth-grid`), so a new store or a fresh clone of one doesn't fetch them again. `./docker.sh` mounts the same directory into the container. It holds three kinds:

- `reference`: BlueTopo and S-102 rasters, downloaded whole on first use and checked against the SHA-256 their tile scheme gives. Entries are keyed by that checksum, so a new release adds entries beside the old ones. The tile schemes are kept too; when NOAA's bucket can't be listed, or its newest scheme can't be read, calibration uses the newest readable one cached, and records no pixel as uncovered from it, since a newer scheme may cover it. A cached scheme that isn't a whole database is removed. A raster that can't be downloaded whole is read over HTTP instead for the rest of the run; one downloaded whole whose checksum doesn't match its scheme is skipped, and the tiles it touches left unsampled, until a download a day or more later matches. Only a downloaded raster is checked: one read over HTTP, because the cache can't be written or the download was cut off, isn't. Calibration downloads each raster whose footprint holds a pixel it samples, whole: hundreds of MB to a few GB per 1° tile, once per release.
- `files`: NOAA's CSVs, keyed by bucket, key and ETag. Open Waters uploads aren't cached: one a contributor withdraws must leave the machine too. A new ETag replaces the key's entry. Ingest trims the kind to `GRID_CACHE_FILES_GB` (default 20), least recently used first; `0` keeps none past each 512 MB chunk. A run reads a hard link or copy of each entry under `GRID_TEMP_DIR`, so another run's trim never takes a file it is reading. Give the cache's disk that cap plus a chunk, plus whatever another user's runs keep there.
- `coops`: CO-OPS gauge months with data, once a store has made them final, 45 days after they end. A recent month, and a month CO-OPS has no data for, is fetched again by each store.

Each entry is written to a `.part` file beside it and renamed into place, so concurrent runs only ever read whole entries. A run that can't write to the cache, or remove from it, goes on without it; on Linux, entries a `./docker.sh` run wrote belong to root, so a host run can read them but not trim them, and they don't count against its cap, so the disk may hold more. A source file whose entry a run can't read is downloaded instead. `grid cache --prune` removes rasters the newest cached tile scheme no longer lists, older tile schemes, source files past the cap, and `.part` files a dead write left over a day ago. Prune while no run is going.

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
2. Create a tag `vX.Y.Z` (semver) targeting `main`.
3. Set the release title to a short headline of what changed, in sentence case with no version or closing period, and put any new requirement in it ("Requires Node 24"). Patch releases get a headline too.
4. Write the notes for boaters running the plugin, following the [release notes guidance](https://github.com/openwatersio/.github/blob/main/docs/agents/releases.md#release-notes): open with what is new and for whom, list breaking changes and upgrade steps first, then the changes people will notice with a link to each pull request. Leave out chores, CI, and dependency bumps unless they change a runtime requirement.
5. Publish. The [release workflow](.github/workflows/release.yml) builds and packs the plugin from the tag's commit with the version from the tag, publishes that tarball to npm via trusted publishing (OIDC — no tokens to manage), commits the version bump to `package.json` and `package-lock.json` back to `main`, and re-points the tag at that commit. Each step is its own job with only the permissions it needs: the job that installs dependencies and builds holds no token that can publish or push, though what it packs is what gets published. The tag must be the tip of `main` when the release runs, or the build refuses it; delete the release and tag and cut them again. Releases run one at a time, and one published while another is running is refused or cancelled, since the first one's version bump moves `main`; cut it again once the first finishes. If `main` moves after the build, the last job fails and leaves `main` and the tag as they were; the package is already on npm, so bump the version in a pull request.

There is no manual `npm publish` or local version bump — the tag is the
version. Signal K servers pick the new version up from npm in the AppStore.

### Plugin previews

Every pull request from a branch in this repository, and every push to `main`, publishes the plugin to [pkg.pr.new](https://pkg.pr.new) through the [preview workflow](.github/workflows/preview.yml). Pull requests from forks are skipped. The pkg.pr.new bot comments on the pull request with the install URL for the latest commit.

To try a preview, install it from the Signal K config directory (usually `~/.signalk`) and restart the server. Install by commit SHA, as the bot's URL does. A URL ending in the PR number instead follows each new push to the PR:

```bash
cd ~/.signalk && npm install https://pkg.pr.new/crowd-depth@<sha>
```

When you are done, go back to the released version by running this from the same directory and restarting the server. A preview that adds a database migration leaves the database at a schema the release does not know, so check the PR for migrations before going back:

```bash
cd ~/.signalk && npm install crowd-depth@latest
```

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
