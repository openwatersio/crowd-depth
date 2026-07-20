# Crowd Depth Signal K Plugin

Collect depth and position data from a Signal K server and periodically submit to a trusted node API.

## Installation

- Install the `crowd-depth` plugin from the Signal K server AppStore.
- Enable the plugin and open its settings.

## Configuration

Configuring the plugin correctly is essential for accurate depth reporting.

- **Path**: Choose which depth path to use (`belowSurface`, `belowTransducer`, or `belowKeel`) depending on what is reported in your environment.
- **Depth sounder offsets**: Required `x`, `y`, `z`; optional `draft`, `make`, `model`, `frequency`, `transducer`.
- **GNSS offsets**: Required `x`, `y`, `z`; optional `make`, `model`.
- **Sharing**: Set `anonymous` to hide vessel name/ID; data is still tied to a unique UUID.

## How it works

1. **Collection** - Data is collected in one of two ways:
   1. If you're using a plugin that offers a History API (like [signalk-to-influxdb2](https://github.com/tkurki/signalk-to-influxdb2)), this plugin will not store any additional data, but will query the history API for depth/position data when it's time to report. Your historical data will also be reported.
   2. If no History API is available, the plugin will store depth/position data locally in a SQLite database.
2. **Reporting** - Data will be reported on a schedule to the API. Each report signs the vessel identity and uploads a GeoJSON file to the trusted node API.
   1. Data is reported every day at midnight in your local timezone, but can be changed by setting a cron-style schedule in `BATHY_DEFAULT_SCHEDULE="0 0 * * *"` environment variable).
   2. The target endpoint defaults to `BATHY_URL` (production: `https://depth.openwaters.io`, otherwise `http://localhost:3001`). Override via environment variables on the Signal K host.

## Contributing

From the root of the monorepo:

- Build: `npm run build -w crowd-depth`
- Tests: `npm test -w crowd-depth`
- Install the plugin into a local Signal K server for development:
  ```
  cd packages/signalk-plugin
  npm link -w crowd-depth
  cd ~/.signalk
  npm link crowd-depth
  ```
- Watch for changes to the plugin: `npm run dev -w crowd-depth`
- Restart the Signal K server whenever the plugin changes.

## Notes

- The plugin corrects depth positions using configured sensor offsets and marks data as unprocessed for tides/vertical datums.
- Includes a helper CLI `xyz-to-geojson` (installed with the package) for converting XYZ files to GeoJSON.

## Importing Raymarine GPX tracks

The `crowd-depth-import` CLI imports Raymarine GPX trackpoints whose extensions
contain `WaterDepth`. It uses the same `BathymetryData`, GeoJSON metadata,
precision transform, identity, and upload reporter as the Signal K plugin.
Namespace prefixes are ignored, so both `raymarine:WaterDepth` and an equivalent
prefix work.

From a development checkout:

```sh
npm run crowd-depth-import -- ./track.gpx \
  --depth-reference belowTransducer \
  --transducer-depth 0.45 \
  --started-at 2025-07-12T08:30:00+02:00 \
  --interval 1s \
  --dry-run
```

Installed packages also expose the `crowd-depth-import` executable. Preview is
the default, and **nothing is uploaded unless `--upload` is explicitly passed**.
`--dry-run` merely makes that intention explicit. Use `--out result.geojson` to
write the generated GeoJSON locally.

### Required time information

Times embedded in GPX trackpoints are preserved. If any imported point lacks a
time, both `--started-at` (an ISO timestamp with offset) and `--interval` (for
example `500ms`, `1s`, or `2m`) are mandatory. Synthetic times follow file
order. The importer never silently invents timestamps.

### Required depth reference

`--depth-reference` is always mandatory:

- `belowWaterline`: `WaterDepth` already measures from the waterline and is kept unchanged.
- `belowTransducer`: also requires `--transducer-depth`; that positive waterline-to-transducer offset is added.
- `belowKeel`: also requires `--draft`; that positive waterline-to-keel offset is added.

All output is therefore waterline-referenced, matching the existing reporter's
metadata. No tidal or vertical-datum correction is performed. Verify the GPX
source setting and vessel offsets before upload; an incorrect reference cannot
be recovered from the file itself.

### Upload identity and duplicate protection

Upload reuses the existing identity JSON (`uuid` and `token`). The default path
is `~/.signalk/plugin-data/crowd-depth/identity.json`; override it with
`--identity-file`. Override the normal plugin endpoint with `--api-base-url`.

After a successful upload, a SHA-256 key covering the file and conversion
options is recorded in `.crowd-depth-import-ledger.json`. Repeating the same
upload is rejected. Use `--ledger-file` to place the ledger elsewhere. Preview
and `--out` do not modify the ledger.

Optional controls include `--dedupe-distance-meters` (off by default) and
`--max-points` for probe imports. Dedupe only compares consecutive positions.
`WaterTemp` is currently ignored. Missing heading is valid, so GNSS/sounder
position correction is not applied to GPX imports.
