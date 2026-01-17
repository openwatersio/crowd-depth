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
1. If no History API is available, the plugin will store depth/position data locally in a SQLite database.
1. **Reporting** - Data will be reported on a schedule to the API. Each report signs the vessel identity and uploads a GeoJSON file to the trusted node API.
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
