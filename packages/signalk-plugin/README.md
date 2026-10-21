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
4. **See** — On a chartplotter that supports Signal K plotter extensions, such as Freeboard-SK 3.4 or later, the depths you record appear as a "My soundings" layer: depth areas, contours and soundings drawn the way Open Waters' crowd depth overlay draws them, filling in under the bow as you go.

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
- **Safety depth** — Depth areas and soundings shoaler than this draw as unsafe on the layer (3 m by default).
- **Colour of my soundings** — The colour of the layer's soundings, contours and tint (violet by default).
- **Colour of my shoal soundings** — The colour of soundings shoaler than the safety depth (dark violet by default).
- **Tint over sounded water** — Off, faint, normal or strong (normal by default).
- **Draw depth contours** — Draw the layer's depth contours (on by default).

## My soundings on the chart

On a chartplotter that supports Signal K plotter extensions, Crowd Depth draws the depths your boat records as a "My soundings" layer: depth areas, contours and soundings, in the same style and by the same rules as Open Waters' crowd depth overlay. It fills in under the bow as you go.

> [!WARNING]
> The layer shows your own sounder's depths, quality checked, reduced to chart datum only with predicted tides where a station is in reach, and only as accurate as your sensor offsets. **Do not use it for navigation.**

### What you need

- A chartplotter that supports plotter extensions with data overlays, such as [Freeboard-SK](https://github.com/SignalK/freeboard-sk) 3.4.0-beta.1 or later.
- **Show my soundings on the chart** turned on in the plugin's settings. It's on by default.

### Using it

The layer appears in the chartplotter's chart list as **My soundings**, with its own show and hide and opacity controls. Its depth areas use the same colours as Open Waters' charts, and its soundings, contours and a faint tint over the water are violet, strongest where the boat sounded itself, so it stands out over a chart drawn in those colours. Soundings shoaler than the safety depth are a darker violet. In the plugin's settings you can pick other colours if your chart uses violet, make the tint fainter or stronger or turn it off, and leave out the contours. The chartplotter's opacity control applies on top. Saving the settings restarts the plugin, and the change shows the next time the chartplotter loads the layer. Depths are labelled in metres or feet, as you've chosen in the chartplotter. Soundings the boat has just recorded show as orange dots, labelled with the depth the sounder read, less the tide where there is one, before the quality checks have judged them and before the safety margin the layer's areas and soundings carry, until they're folded into the layer: usually within a minute of leaving a spot. While the layer first fills in a long stretch of history, new soundings stay orange until it's done, so older passes go in first. The layer redraws at most every 30 seconds, so it doesn't flicker as it fills in. At a mooring, where the depth holds steady, they can stay orange for up to an hour, until the checks can tell a steady depth from a stuck sounder. A sounder reading one depth for a long way is held until it has covered a kilometre, as the checks need to judge it, or until about an hour of soundings at 10 a second is waiting.

### What it shows

- **Your own soundings**, placed and offset the same way as the soundings the plugin shares, so the layer shows what you contribute.
- **Depths on chart datum, where there's a tide station.** With the [signalk-tides](https://github.com/openwatersio/signalk-tides) plugin installed, each sounding is reduced by the predicted tide at its own time and place, from the nearest tide station within 50 km, the same station and predictions the Open Waters grid uses. Depths are then below the chart's datum (mean lower low water in the US), as on a paper chart. Without signalk-tides, or more than 50 km from a station, depths stay below your waterline at the moment you sounded them, and the tiles' coverage data marks that water as not reduced for tide. With Signal K security on, the layer reads signalk-tides only with the server's read-only access turned on.
- **A shoal-biased depth.** Each spot about 20 m across keeps a running average of your passes over it, and shows that depth less a safety margin for its uncertainty, as the Open Waters overlay does. Until your boat is calibrated against the grid the margin is about 2 m, so the layer reads shallower than your sounder; tide takes about 0.15 m off it near a station.
- **Soundings, then areas.** Soundings are thinned as the overlay thins them, keeping the shoalest in each area, so zooming in shows more. Depth areas follow every track you've sounded, and fill in between tracks less than 200 m apart, never past the ends of a track.
- **Suspect readings shown, not drawn.** The same checks the Open Waters grid runs on every boat's track run on yours. A reading they doubt on the shallow side, such as a spike or a stuck sounder in shallow water, stays out of the depth areas but shows as a faint unconfirmed sounding, so you see the shoals the checks doubt rather than losing them. A stretch where the sounder zig-zags too much to trust is left out on both sides, as the Open Waters grid leaves it out. Readings that would show water deeper than it is, and bad data such as a position that jumped, are left out.
- **History when it starts.** The first time the layer starts, it fills in the last 30 days from your recorded soundings (a History API provider such as signalk-to-influxdb2, or the plugin's own log). After that, it fills in whatever was recorded while it wasn't running, up to 30 days back. If that source fails at three starts in a row, the layer gives up on that span and leaves it empty. Spots already in the layer stay, however long ago they were sounded, until something below rebuilds it.

### When it rebuilds

- Changing your **depth sounder or GPS position** on the boat, or a plugin update that changes the quality checks, the tide reduction or the size of a spot, rebuilds the layer from the last 30 days of recorded soundings, so old soundings don't sit beside new ones in the wrong place.
- **Installing, removing or turning on or off signalk-tides**, or turning on Signal K's read-only access it needs, rebuilds the layer from the last 30 days at the next start, reduced for tide or not.
- Changing the **depth path, transducer depth or, for depth below the keel, the draft** rebuilds it from a History API provider if you have one. Without one, the layer starts afresh from that point, because the plugin's own log stores depths with the old offset.

### Who can see it

With Signal K security on, the layer needs a login or the server's read-only access, the same as your boat's position. With security off, anyone who can reach your server can see it.

### Credits

The plotter extension's provider and page serving are adapted from [signalk-livedepth-plugin](https://github.com/night199uk/signalk-livedepth-plugin) by Nick Roberts, under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

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
