# Crowd Depth

**Help improve nautical charts by sharing depth data from your vessel.**

Most of the world's coastal waters have never been surveyed, or were last
surveyed decades ago. Every time you cruise, your depth sounder measures water
depths that could fill those gaps. Crowd Depth collects those soundings —
depth, position, and time — and contributes them to [crowdsourced
bathymetry](https://openwaters.io/bathymetry/crowd-depth/) programs, where
they help identify uncharted hazards, update charts with recent depth changes,
and make navigation safer for everyone.

## How it works

1. **Collect** — The plugin runs quietly in your Signal K server, recording
   depth soundings with GPS coordinates and timestamps as you navigate. If you
   already log data with a History API plugin (like
   [signalk-to-influxdb2](https://github.com/tkurki/signalk-to-influxdb2)), it
   reads from that instead of storing anything extra.
2. **Correct** — Soundings are adjusted for your configured transducer and
   antenna offsets, so the reported depth and position reflect the water, not
   your installation.
3. **Contribute** — Once a day, the plugin uploads your soundings to [Open
   Waters](https://openwaters.io/bathymetry/crowd-depth/), an [IHO trusted
   node](https://iho.int/en/csb-crowdsourced-bathymetry) — an organization
   authorized to submit crowdsourced bathymetry to the [IHO Data Centre for
   Digital Bathymetry](https://www.ncei.noaa.gov/maps/iho_dcdb/), hosted by
   NOAA, on behalf of mariners. From there your soundings become part of the
   public record, available to hydrographic offices, chart makers, and
   navigation apps under a [CC0 public
   domain](https://creativecommons.org/publicdomain/zero/1.0/) dedication.

You stay in control: sharing can be anonymous (a random UUID instead of your
vessel name and MMSI), and you can disable the plugin at any time.

## Installation

- Install the `crowd-depth` plugin from the Signal K server AppStore.
- Enable the plugin and open its settings.

## Configuration

Accurate offsets are what turn raw sounder readings into chart-quality data —
take a few minutes to measure them. Where your vessel already reports
`sensors.*` and `design.*` paths, the plugin pre-fills the defaults.

### Depth

- **Path** — Which depth path to report (`belowSurface`, `belowTransducer`,
  or `belowKeel`), depending on what your instruments provide. Defaults to
  the first one with data.

### Depth Sounder

- **Depth source** — The sensor to record when more than one reports depth,
  so soundings stay pinned to a single transducer.
- **Offsets** (required) — Transducer distance from the bow, from the
  centerline (positive to starboard), and below the waterline, in meters.
- **Details** (optional) — Draft, make, model, frequency, and transducer
  type. Included in report metadata to help downstream processors assess data
  quality.

### GPS Receiver

- **Position source** — The receiver to record when more than one reports
  position, so all soundings share one antenna location.
- **Offsets** (required) — Antenna distance from the bow, from the centerline
  (positive to starboard), and above the waterline, in meters.
- **Details** (optional) — Make and model.

### Data Sharing

- **Share data anonymously** — Withhold your vessel name and MMSI and report
  under a randomly generated UUID instead.

By enabling the plugin, you agree to share your position and depth data with
the IHO data collection service under CC0.

## For developers

- Data is reported daily at midnight local time; set a cron-style schedule in
  the `BATHY_DEFAULT_SCHEDULE` environment variable to change it.
- Reports go to `BATHY_URL` (production: `https://depth.openwaters.io`,
  otherwise `http://localhost:3001`).
- A helper CLI `xyz-to-geojson` (installed with the package) converts XYZ
  files to GeoJSON.

See [CONTRIBUTING.md](https://github.com/openwatersio/crowd-depth/blob/main/CONTRIBUTING.md)
for repo layout, the local Signal K `npm link` workflow, testing, and
releases.
