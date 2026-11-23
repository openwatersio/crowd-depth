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
   reads from that instead of storing anything extra. Without one, it keeps
   every sounding in its own log, about 2 GB a year for a sounder that reads
   once a second around the clock. A history plugin can
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
4. **See** — On a chartplotter that supports Signal K plotter extensions, such as Freeboard-SK 3.4 or later, the depths you record appear as a "My soundings" layer: depth areas, contours and soundings in the same colours as Open Waters' crowd depth overlay, with finer contours zoomed in, filling in under the bow as you go.

You stay in control: sharing can be anonymous (a random UUID instead of your
vessel name and MMSI), and you can disable the plugin at any time.

## Installation

- Install the `crowd-depth` plugin from the Signal K server AppStore.
- Enable the plugin and open its settings.

## Configuration

Accurate offsets are what turn raw sounder readings into chart-quality data —
take a few minutes to measure them. Where your vessel already reports
`sensors.*` and `design.*` paths, the plugin pre-fills the defaults.

### Automatic depth path

The plugin chooses a depth path for the selected sounder at startup, using live
source information and recorded history. It prefers `belowTransducer`, then
`belowSurface`, then `belowKeel`. An existing saved Path is preserved to keep previously recorded depths and report references consistent; if that path is unavailable, startup waits rather than changing reference. Only paths
reported by that source qualify; `derived-data` is excluded. If the source is
not known yet, the plugin waits until it appears rather than guessing a path.
The chosen path stays fixed until the plugin restarts so recording, corrections,
and report references remain consistent.

### Depth Sounder

- **Depth source** — Follow Signal K’s preferred source (the default), or pin a specific transducer even when another is preferred.
- **Offsets** — Transducer distance from the bow and from the centerline
  (positive to starboard), in meters. Both are required.
- **Below the waterline** (optional) — Transducer depth below the waterline,
  in meters. With the `belowTransducer` path, it is added to each depth so
  soundings are reported from the waterline. Leave it empty if unknown, and
  depths are reported as measured from the transducer.
- **Draft** (optional) — The vessel's draft in meters. With the `belowKeel`
  path, it is added to each depth so soundings are reported from the
  waterline. Without it, depths are reported with an unknown reference.
- **Details** (optional) — Make and model show detected values as placeholders. Leave
  them blank for automatic detection, or enter a value to override it.
  Frequency (Hz) and transducer type remain manual; standard device information
  does not provide them. All are included in report metadata.

### GPS Receiver

- **Position source** — Follow Signal K’s preferred source (the default), including failover, or pin a specific receiver. Explicit selection never substitutes another receiver when it is missing or stale.
- **Offsets** (required) — Antenna distance from the bow, from the centerline
  (positive to starboard), and above the waterline, in meters.
- **Details** (optional) — Make and model.

### Detected sensor identities

The Make and Model fields show optional hints from the selected NMEA 2000
source. GPSD’s Garmin binary drivers can also identify Garmin receivers; a GPSD driver
name is not assumed to be a retail model or receiver manufacturer. In particular, a u-blox driver identifies a chipset, so its manufacturer hint stays blank. Unknown or ambiguous devices leave the
hints blank. Detection uses the configured GPSD endpoint. Lookups run in the background with a two-second timeout; opening the plugin list never waits for GPSD. Results, including failures, are cached for one minute. The first load or a refresh can show blank hints; reload after the lookup completes. Concurrent requests share one lookup.

These placeholders do not save an override or change existing settings. Reports use detected identities unless a manual entry identifies different equipment. Hints describe the saved source and depth path; unsaved edits do not refresh them. Save and reload the form to update hints. Report-time detection cannot reconstruct historical sensor changes.

### Data Sharing

- **Share data anonymously** — Withhold your vessel name and MMSI and report
  under a randomly generated UUID instead. Hardware serial numbers and CAN
  identities are also omitted.

By enabling the plugin, you agree to share your soundings and your vessel and
sensor details, and you dedicate them to the public domain under [CC0 1.0
Universal](https://creativecommons.org/publicdomain/zero/1.0/).

### Detected sensor metadata

At report time, the plugin reads device information for each selected source
from Signal K. Alongside the CSB 3.1 sensor make and model, a `nmea2000`
extension includes product code and, for identified reports, model and software
versions. Hardware serial fields and CAN identities are omitted. Manual entries
that identify different equipment replace the detected identity and its extensions.
Reload the settings form after changing sources to refresh detected placeholders.

The sensor descriptions follow the [CSB 3.1 schema](../../docs/CSB-schema-3_1_0-2024-04.json);
`nmea2000` and `transducer` are additional metadata preserved in the uploaded
GeoJSON. Device details must still be available in Signal K; discovering a
source in history does not recover its historical hardware identity. For
historical reports, these details describe the currently known device at that
source, not a snapshot taken with each sounding. Use stable CAN-name source
references where supported, especially when devices are replaced.

### GPS identity and fix quality in reports

For a GPSD-backed source, the plugin queries its configured daemon with the
read-only [`?DEVICES` command](https://gpsd.io/gpsd_json.html). A `gpsd` sensor
extension preserves driver and update cycle. Identified reports may also include
free-form subtype/hardware/firmware strings, which can contain serial identifiers;
anonymous reports omit these strings. Local device paths are never included.
Only Garmin binary drivers identify a receiver manufacturer; u-blox identifies a
chipset, not necessarily the receiver maker. A daemon with multiple devices is
ambiguous and supplies no identity. Queries time out after two seconds.

Each GeoJSON feature can contain a `gnss` quality extension with Signal K's
`type`, `methodQuality`, `integrity`, `satellites`, `antennaAltitude`,
`horizontalDilution`, `positionDilution`, `geoidalSeparation`,
`differentialAge`, and `differentialReference`. Values retain Signal K names
and units; altitude is not antenna mounting height. Missing values are omitted.
Live values must match the selected GPS and be no more than two seconds old.
History values must have matching source metadata and the same one-second
bucket as the sounding. Unsupported quality queries do not prevent reporting
positions and depths, and current GPS values never fill historical gaps.

Configure your history provider to record these `navigation.gnss.*` paths.
Without a history provider, the plugin preserves quality alongside each
sounding in SQLite. The added nullable `gnss` column migrates existing logs
without changing their readings. Back up the database before testing this
preview: an older build does not know the new migration version. Raw GPSD
error estimates and satellite sky-view arrays are not collected by this path.

### Chart

- **Show my soundings on the chart** — Offer the [My soundings](#my-soundings-on-the-chart) layer to chartplotters (on by default).
- **Safety depth** — Depth areas and soundings shoaler than this draw as unsafe on the layer (3 m by default).
- **Colour of my soundings** — The colour of the layer's soundings, contours and tint (violet by default).
- **Colour of my shoal soundings** — The colour of soundings shoaler than the safety depth (dark violet by default).
- **Tint over sounded water** — Off, faint, normal or strong (normal by default).
- **Draw depth contours** — Draw the layer's depth contours (on by default).
- **Contour detail** — High draws a contour every metre, or every foot, from zoom 13 in, with every fifth one bold and labelled, and the rest labelled too once you zoom in close (the default). Standard draws the chart's depth contours. Zoomed out, both draw the chart's.

## My soundings on the chart

On a chartplotter that supports Signal K plotter extensions, Crowd Depth draws the depths your boat records as a "My soundings" layer: depth areas, contours and soundings, by the same rules as Open Waters' crowd depth overlay, and zoomed in, with finer contours. It fills in under the bow as you go.

> [!WARNING]
> The layer shows your own sounder's depths, quality checked, reduced to chart datum only with predicted tides where a station is in reach, and only as accurate as your sensor offsets. **Do not use it for navigation.**

### What you need

- A chartplotter that supports plotter extensions with data overlays, such as [Freeboard-SK](https://github.com/SignalK/freeboard-sk) 3.4.0-beta.1 or later.
- **Show my soundings on the chart** turned on in the plugin's settings. It's on by default.

### Using it

The layer appears in the chartplotter's chart list as **My soundings**, with its own show and hide and opacity controls. Its depth areas shade from the deep blue of shallow water to the pale blue of deep water, through the colours Open Waters' charts use for their depth bands, and its soundings, contours and a faint tint over the water are violet, strongest where the boat sounded itself, so it stands out over a chart drawn in those colours. Soundings shoaler than the safety depth are a darker violet. In the plugin's settings you can pick other colours if your chart uses violet, make the tint fainter or stronger or turn it off, and leave out the contours. The chartplotter's opacity control applies on top. Saving the settings restarts the plugin, and the change shows the next time the chartplotter loads the layer. Depths are labelled in metres or feet, as you've chosen in the chartplotter. Soundings the boat has just recorded show as orange dots, labelled with the depth the sounder read, less the tide where there is one, before the quality checks have judged them and before the safety margin the layer's areas and soundings carry, until they're folded into the layer: usually within a minute of leaving a spot. Historical refinement no longer holds live soundings until the full backfill finishes. At a mooring, where the depth holds steady, they can stay orange for up to an hour, until the checks can tell a steady depth from a stuck sounder. A sounder reading one depth for a long way is held until it has covered a kilometre, as the checks need to judge it, or until about an hour of soundings at 10 a second is waiting. Over water the layer hasn't drawn yet, a line along the boat's latest pass, as wide as the layer's cells, shows the colour of the depth area its soundings will make, less the same safety margin, until the layer redraws there. Where the chartplotter shows few of your soundings the layer redraws every 5 seconds; where it shows many, as rarely as every 30 seconds, as the chartplotter pauses while it redraws. The plugin builds requested tiles in worker threads and caches them for reuse. Whole-history pre-rendering is disabled to limit background CPU and storage work; an uncached view can take longer to draw.

### What it shows

- **Your own soundings**, placed and offset the same way as the soundings the plugin shares, so the layer shows what you contribute.
- **Depths on chart datum, where there's a tide station.** With the [signalk-tides](https://github.com/openwatersio/signalk-tides) plugin installed, each sounding is reduced by the predicted tide at its own time and place, from the nearest tide station within 50 km, the same station and predictions the Open Waters grid uses. Depths are then below the chart's datum (mean lower low water in the US), as on a paper chart. Without signalk-tides, or more than 50 km from a station, depths stay below your waterline at the moment you sounded them, and the tiles' coverage data marks that water as not reduced for tide. With Signal K security on, the layer reads signalk-tides only with the server's read-only access turned on.
- **A shoal-biased depth.** Each spot about 20 m across keeps a timestamp-weighted mean with a configurable half-life and at most one unit of weight per UTC hour, and shows that depth less a safety margin for its uncertainty, as the Open Waters overlay does. Until your boat is calibrated against the grid the margin is about 2 m, so the layer reads shallower than your sounder; tide takes about 0.15 m off it near a station.
- **Soundings, then areas.** Soundings are thinned as the overlay thins them, keeping the shoalest in each area, so zooming in shows more. Depth areas follow every track you've sounded, and fill in between tracks less than 200 m apart, never past the ends of a track.
- **Suspect readings shown, not drawn.** The same checks the Open Waters grid runs on every boat's track run on yours. A reading they doubt on the shallow side, such as a spike or a stuck sounder in shallow water, stays out of the depth areas, except that the areas never reach past your track any deeper than it, and shows as a faint unconfirmed sounding, so you see the shoals the checks doubt rather than losing them. A stretch where the sounder zig-zags too much to trust is left out on both sides, as the Open Waters grid leaves it out. Readings that would show water deeper than it is, and bad data such as a position that jumped, are left out.
- **Sounding weight half-life (days).** Defaults to 365 days. An hourly contribution this old has half the weight of a new one; larger values retain more historical influence. This setting changes the rendered estimate, not retention, and changing it rebuilds derived summaries. Each cell receives at most one unit of weight per UTC hour, so a higher sampling rate does not automatically outweigh other hours. The estimate and weighted spread are independent of the order history is acquired. The estimator remains experimental and needs field validation.
- **History when it starts.** The layer considers all available recorded history. A separate recent-first preview draws orange, translucent observations in your viewport before track checks, tide reduction and contours are ready. It keeps the latest observation per roughly 20 m cell and at most 1,200 in a view; these are untided observations, not the refined depth estimate. Existing local history starts loading even while the plugin waits for a History API provider. Panning displays cached observations for the new view. Where the provider exposes spatial Track API queries, matching visits in the viewport are prioritized. Other providers are scanned backward from recent history; older visits may take longer to discover. Refined cells and zoomed-out overviews publish after independent hourly QC jobs, newest first, with already acquired tracks in the viewport prioritized. Preview and refined history share spatially indexed, compressed settled-hour input chunks. Completed jobs have persistent receipts and are not counted twice after a restart; failed jobs remain pending.

### When it rebuilds

- Changing your **depth sounder or GPS position** on the boat, or a plugin update that changes the quality checks, the tide reduction or the size of a spot, rebuilds the layer from all available recorded soundings, so old soundings don't sit beside new ones in the wrong place.
- **Installing, removing or turning on or off signalk-tides**, or turning on Signal K's read-only access it needs, rebuilds the layer the same way at the next start, reduced for tide or not.
- Changing the **depth path, transducer depth or, for depth below the keel, the draft** rebuilds it from a History API provider if you have one. Without one, the layer starts afresh from that point, because the plugin's own log stores depths with the old offset.

### Who can see it

With Signal K security on, the layer needs a login or the server's read-only access, the same as your boat's position. With security off, anyone who can reach your server can see it.

### Credits

The plotter extension's provider and page serving are adapted from [signalk-livedepth-plugin](https://github.com/night199uk/signalk-livedepth-plugin) by Nick Roberts, under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Final reports

When a settings change restarts the plugin, it stops collecting and attempts a final report with the previous settings. It waits for any active upload, then flushes available data through the last complete second, with a 15-second timeout covering the active upload and final attempt. A failed or timed-out window retains its checkpoint and is retried after restart using the new settings. SQLite depths keep the offsets applied when collected, while report metadata uses the new settings; changing the depth reference can therefore mislabel that queued data. Completed batches keep their checkpoints. If the server accepted an upload but its response was lost or timed out, retrying can upload that batch again.

The same attempt runs if the server calls the plugin’s stop hook during a graceful shutdown; Signal K 2.33 does not call that hook on shutdown. Correcting an erroneous offset also flushes with the previous value; the correction applies after restart. Disable the plugin before editing to skip that final upload, but this does not correct depths already stored in SQLite.

The final attempt does not wait for a history provider to finish buffering. Readings that arrive later with timestamps before the successful flush checkpoint may be missed. Normal scheduled reports still use the history safety delay. If the plugin is still discovering its history source, it leaves the data queued rather than flushing an incomplete local fallback.

Disabling the plugin or changing sharing to anonymous skips the final flush and cancels reporting, so that action cannot trigger one last identified upload. A process crash or power loss cannot guarantee a final report. There are no configuration-history tables, data migrations, or backlog resets.

## Source selection and recorded data

Explicit selection requires Signal K 2.33 or newer, which passes per-source subscription policies to plugins.

An empty source setting means **Preferred source**. Live depth and position each follow Signal K’s priority decisions independently. Selecting a device pins that input even when Signal K prefers a different one. Saved explicit selections remain visible when offline; `derived-data` is omitted from new manual choices but retained if previously saved. Preferred mode still honors the server’s chosen source, including a derived source if you prioritize it there.

For history, Preferred source requests the provider’s default recorded series; it does not apply today’s live source to past data. In-process history providers receive explicit source filters. Legacy HTTP history does not support those filters through this adapter, so explicit selections stop reporting with a configuration error. The reporting checkpoint and existing data are retained. The provider continues recording independently, and the live chart continues; report attempts show the configuration error until it is resolved. Choose Preferred source for both sensors or switch to a source-aware History API provider before restarting. Older versions automatically saved concrete source IDs, so existing installations may need this configuration change on upgrade.

Changing selections rebuilds history-backed chart cells. SQLite rows have no source identity, so the local chart starts afresh rather than displaying old readings as if they came from the newly selected device.

Offsets remain the values configured in Crowd Depth. This change does not introduce per-device geometry or configuration history: use an explicit device when receivers or sounders have different installation offsets. Source-specific geometry is separate follow-up work. Settings restarts attempt the final flush described above; failed queued SQLite readings retain their recorded depths and use the next configuration’s report metadata.

## For developers

- Data is reported every 6 hours, at midnight, 06:00, noon and 18:00 local
  time; set a cron-style schedule in the `BATHY_DEFAULT_SCHEDULE` environment
  variable to change it.
- `BATHY_WINDOW_SIZE` sets the maximum hours in each batch (default 6, positive whole hours). It also sets the default cron hour step unless `BATHY_DEFAULT_SCHEDULE` is set; steps of 24 or more run daily. If an upload gets HTTP 413 (too large), lower it, for example to `1`, and restart the Signal K server to retry in smaller batches.
- Failed reports retry every five minutes, resuming from the last successful report. Recognized service authentication, size, version, or User-Agent rejections wait for the normal schedule; other failures, including truncated uploads and proxy errors, retry. Rejected windows and later data stay queued until the underlying problem is corrected, such as an invalid identity or an oversized report; waiting for cron does not repair the cause. Reports that fit in one configured reporting window read their range directly; longer gaps, startup catch-up, and recovery after failure use batched reports, with availability scans covering at most a year at a time. Stopping cancels pending retries; a settings restart allows the final flush described above, while disabling sharing cancels reporting immediately.
- `BATHY_REPORT_TIMEOUT` sets the deadline in seconds for each availability scan, history read, identity lookup, or GeoJSON generation (default 1800). Raise it for slow history providers or storage. Network uploads retain native fetch/TCP timeout behavior without an additional total-duration limit. A peer that keeps a stalled send alive can block reporting until the plugin is restarted; the stop flush cancels the request after its 15-second timeout. A timed-out operation retries from the saved checkpoint; if the server accepted an upload but its response was lost, retrying can submit duplicate data.
- Source deadlines bound waiting for asynchronous history calls. They cannot interrupt synchronous SQLite reads or cancel in-process provider queries. Timed-out queries can continue in the background, including HTTP history fallback requests; late results are discarded. Set the deadline above the provider's expected query time to avoid overlapping retries of slow work.
- For a persistent `Invalid token` or `Invalid uniqueID` rejection, stop Signal K, rename `identity.json` in Crowd Depth's data directory to an unused backup filename, and restart. The plugin creates a new vessel UUID and token; keep the backup as a record of the old identity.
- `BATHY_HISTORY_WAIT` sets how many seconds to wait at startup for a History
  API provider (default 600).
- `BATHY_REPORT_DELAY` sets how many seconds behind now each scheduled report ends, so
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

### Source-selection upgrade notes

Previously saved source IDs remain explicit selections; older versions sometimes filled those IDs automatically and ignored them during live collection. Choose **Preferred source** to retain automatic failover. A pinned device does not fall back to a different receiver when absent. Use stable CAN-name IDs for devices whose bus addresses can change. Live matching accepts known address/CAN-name aliases; history filters use the exact stored source reference and cannot reconstruct old bus-address assignments.

On first upgrade to these source-selection rules, the derived chart is rebuilt. History-backed layers refill from the provider; SQLite-backed layers start from the upgrade time because older rows have no source identity. Raw SQLite soundings and upload checkpoints are retained. Rolling back and forward also changes the chart fingerprint and can restart this local chart coverage. Preferred historical readings are the provider's default series, which may aggregate sources; use explicit selections with a source-aware provider when device-specific geometry is needed.

## Detected sensor details in reports

Reports include the selected device’s detected identity. If a manual make or model differs from detection, the report uses only the manual identity (missing fields become Unknown), so a known conflicting identity is not combined with the detected device. With Preferred source, detection uses Signal K's current preferred device. NMEA 2000 model, product and firmware fields and GPSD driver, subtype and cycle information are included when available; no retail model or transducer frequency is guessed. GPSD is queried only through the selected enabled connection, with a two-second deadline and a one-minute cache shared across report windows. Missing or ambiguous device information is omitted.

These details describe devices at report creation, not a reconstruction of which hardware produced every historical sounding. Failed queued reports use the next configuration, as described under Final reports. The NMEA serial-number and CAN NAME fields are omitted from reports; CAN NAMEs still identify sources locally. Identified reports include free-form firmware strings, which can contain identifiers. Anonymous reports also omit free-form NMEA firmware/GPSD subtype strings; local device paths are never reported.

Detection identifies the network device publishing the data, which may be a gateway or chartplotter rather than the physical transducer. Fill both manual make and model to identify equipment behind a gateway. Filling only a missing field supplements detection; the plugin cannot infer whether that describes a separate physical sensor. A missing detected field can be filled manually without discarding other details; a conflicting identity suppresses them. Failed GPSD queries are cached for a minute and reports proceed without those optional details.
