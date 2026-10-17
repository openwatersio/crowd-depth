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
   reads from that instead of storing anything extra. A history plugin can
   take a while to come up, so after a restart the plugin waits up to ten
   minutes for one, recording meanwhile, before it settles on its own storage.
2. **Correct** — Soundings are adjusted for your configured transducer and
   antenna offsets, so the reported depth and position reflect the water, not
   your installation. Positions are moved from the antenna to the transducer
   using your heading, or your course over ground while you are moving at over
   about 1 knot. Soundings that can't be placed that way are not uploaded.
3. **Contribute** — Once a day, the plugin uploads your soundings to [Open
   Waters](https://openwaters.io/bathymetry/crowd-depth/), an [IHO trusted
   node](https://iho.int/en/csb-crowdsourced-bathymetry) — an organization
   authorized to submit crowdsourced bathymetry to the [IHO Data Centre for
   Digital Bathymetry](https://www.ncei.noaa.gov/maps/iho_dcdb/), hosted by
   NOAA, on behalf of mariners. From there your soundings become part of the
   public record, available to hydrographic offices, chart makers, and
   navigation apps under a [CC0 public
   domain](https://creativecommons.org/publicdomain/zero/1.0/) dedication.
   Open Waters also builds openly licensed depth products from them.
4. **See** — On a chartplotter that supports Signal K plotter extensions, such as Freeboard-SK 3.4 or later, the depths you record appear as a "My soundings" layer: a shaded surface with depth contours and shoal labels that fills in under the bow as you go. The shallowest sounding in each spot always wins, so zooming out doesn't hide a shoal, until the view is too wide for the layer to draw at all.

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
- **Offsets** — Transducer distance from the bow and from the centerline
  (positive to starboard), in meters. Both are required.
- **Below the waterline** (optional) — Transducer depth below the waterline,
  in meters. With the `belowTransducer` path, it is added to each depth so
  soundings are reported from the waterline. Leave it empty if unknown, and
  depths are reported as measured from the transducer.
- **Draft** (optional) — The vessel's draft in meters. With the `belowKeel`
  path, it is added to each depth so soundings are reported from the
  waterline. Without it, depths are reported with an unknown reference.
- **Details** (optional) — Make, model, frequency, and transducer type.
  Included in report metadata to help downstream processors assess data
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

By enabling the plugin, you agree to share your soundings and your vessel and
sensor details, and you dedicate them to the public domain under [CC0 1.0
Universal](https://creativecommons.org/publicdomain/zero/1.0/).

### Chart

- **Show my soundings on the chart** — Offer the [My soundings](#my-soundings-on-the-chart) layer to chartplotters (on by default).

## My soundings on the chart

On a chartplotter that supports Signal K plotter extensions, Crowd Depth draws the depths your boat records as a "My soundings" layer: a shaded depth surface with depth contours and labels on the shoals, which fills in under the bow as you go.

> [!WARNING]
> The layer shows raw soundings from your own sounder. They are not corrected for tide, not checked against surveys, and only as accurate as your sensor offsets. **Do not use it for navigation.**

### What you need

- A chartplotter that supports plotter extensions with image overlays, such as [Freeboard-SK](https://github.com/SignalK/freeboard-sk) 3.4.0-beta.0 or later.
- **Show my soundings on the chart** turned on in the plugin's settings. It's on by default.

### Using it

The layer appears in the chartplotter's chart list as **My soundings**, with its own show/hide and opacity controls. Open its settings from the layer's **Layer settings** row or the **My soundings** toolbar button:

| Setting          | Default | What it does                                                                   |
| ---------------- | ------- | ------------------------------------------------------------------------------ |
| Show the layer   | On      | Draws or hides the layer.                                                      |
| Shade limit      | 10 m    | The depth the shading runs to. Deeper water is left to the chart underneath.   |
| Isobath interval | 1 m     | The depth between contour lines.                                               |
| Grid cell        | 24 px   | The size of the depth circles on screen; also sets the label size.             |
| Merge band       | 15%     | Neighbouring soundings within this share of each other's depth merge into one. |
| Max depth        | 100 m   | Soundings deeper than this aren't drawn.                                       |
| Safety depth     | 3 m     | Soundings at or shallower than this are labelled individually.                 |

Depths are shown in the units you've chosen in Signal K.

### What it shows

- **Your own soundings**, placed and offset the same way as the soundings the plugin shares, so the layer shows what you contribute.
- **The shallowest reading wins.** Where soundings overlap, the shallowest is kept, and zooming out keeps the shallowest of each area, so a shoal doesn't disappear as you zoom out. At very wide views the layer draws nothing.
- **Soundings, not a survey.** Only water you've been over is drawn. Gaps between your tracks stay empty rather than being filled in.
- **History when it starts.** The first time the layer starts, it fills in the last 30 days from your recorded soundings (a History API provider such as signalk-to-influxdb2, or the plugin's own log). After that, it fills in whatever was recorded while it wasn't running, up to 30 days back.

### When it rebuilds

- Changing your **depth sounder or GPS position** on the boat rebuilds the layer from the last 30 days of recorded soundings, so old soundings don't sit beside new ones in the wrong place.
- Changing the **depth path, transducer depth or, for depth below the keel, the draft** rebuilds it from a History API provider if you have one. Without one, the layer starts afresh from that point, because the plugin's own log stores depths with the old offset.

### Who can see it

With Signal K security on, the layer needs a login or the server's read-only access, the same as your boat's position. With security off, anyone who can reach your server can see it.

### Credits

The layer's rendering is adapted from [signalk-livedepth-plugin](https://github.com/night199uk/signalk-livedepth-plugin) by Nick Roberts, under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## For developers

- Data is reported every 6 hours, at midnight, 06:00, noon and 18:00 local
  time; set a cron-style schedule in the `BATHY_DEFAULT_SCHEDULE` environment
  variable to change it.
- `BATHY_HISTORY_WAIT` sets how many seconds to wait at startup for a History
  API provider (default 600).
- `BATHY_REPORT_DELAY` sets how many seconds behind now each report ends, so
  soundings still on their way to storage go in the next report (default 300).
  Soundings that reach storage later than this after their timestamp are not
  reported. The default covers signalk-to-influxdb2's default write buffering
  and retries; raise it if you raise those.
- Reports go to `BATHY_URL` (production: `https://api.openwaters.io/bathymetry`,
  otherwise `http://localhost:3001`).
- A helper CLI `xyz-to-geojson` (installed with the package) converts XYZ
  files to GeoJSON.

See [CONTRIBUTING.md](https://github.com/openwatersio/crowd-depth/blob/main/CONTRIBUTING.md)
for repo layout, the local Signal K `npm link` workflow, testing, and
releases.
