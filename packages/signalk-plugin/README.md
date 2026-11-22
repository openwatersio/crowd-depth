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

### Depth

- **Path** — Which depth path to report (`belowSurface`, `belowTransducer`,
  or `belowKeel`), depending on what your instruments provide. Defaults to
  the first one with data.

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
- **Details** (optional) — Make, model, frequency, and transducer type.
  Included in report metadata to help downstream processors assess data
  quality.

### GPS Receiver

- **Position source** — Follow Signal K’s preferred source (the default), including failover, or pin a specific receiver. Explicit selection never substitutes another receiver when it is missing or stale.
- **Antenna height** (required) — Height above the waterline, in meters.
- **Horizontal offsets** — Set distance from the bow and centerline in Signal K’s GNSS sensor settings. These two fields are no longer duplicated here. Previously saved plugin offsets remain a fallback when no linked server sensors exist.
- **Details** (optional) — Make and model.

### Detected sensor identities

The Make and Model fields show optional hints from the selected NMEA 2000
source. GPSD’s Garmin binary drivers can also identify Garmin receivers; a GPSD driver
name is not assumed to be a retail model or receiver manufacturer. In particular, a u-blox driver identifies a chipset, so its manufacturer hint stays blank. Unknown or ambiguous devices leave the
hints blank. Detection uses the configured GPSD endpoint. Lookups run in the background with a two-second timeout; opening the plugin list never waits for GPSD. Results, including failures, are cached for one minute. The first load or a refresh can show blank hints; reload after the lookup completes. Concurrent requests share one lookup.

These placeholders do not save an override or change existing settings. Reports use detected identities unless a manual entry identifies different equipment. Hints describe the saved source and depth path; unsaved edits do not refresh them. Save and reload the form to update hints. Report-time detection cannot reconstruct historical sensor changes.

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
- **Fill the layer from** — The last 30 days, the last year or all recorded history (the last year by default): how far back the layer fills in from recorded soundings when it starts or rebuilds. Changing it rebuilds the layer.
- **Contour detail** — High draws a contour every metre, or every foot, from zoom 13 in, with every fifth one bold and labelled, and the rest labelled too once you zoom in close (the default). Standard draws the chart's depth contours. Zoomed out, both draw the chart's.

## My soundings on the chart

On a chartplotter that supports Signal K plotter extensions, Crowd Depth draws the depths your boat records as a "My soundings" layer: depth areas, contours and soundings, by the same rules as Open Waters' crowd depth overlay, and zoomed in, with finer contours. It fills in under the bow as you go.

> [!WARNING]
> The layer shows your own sounder's depths, quality checked, reduced to chart datum only with predicted tides where a station is in reach, and only as accurate as your sensor offsets. **Do not use it for navigation.**

### What you need

- A chartplotter that supports plotter extensions with data overlays, such as [Freeboard-SK](https://github.com/SignalK/freeboard-sk) 3.4.0-beta.1 or later.
- **Show my soundings on the chart** turned on in the plugin's settings. It's on by default.

### Using it

The layer appears in the chartplotter's chart list as **My soundings**, with its own show and hide and opacity controls. Its depth areas shade from the deep blue of shallow water to the pale blue of deep water, through the colours Open Waters' charts use for their depth bands, and its soundings, contours and a faint tint over the water are violet, strongest where the boat sounded itself, so it stands out over a chart drawn in those colours. Soundings shoaler than the safety depth are a darker violet. In the plugin's settings you can pick other colours if your chart uses violet, make the tint fainter or stronger or turn it off, and leave out the contours. The chartplotter's opacity control applies on top. Saving the settings restarts the plugin, and the change shows the next time the chartplotter loads the layer. Depths are labelled in metres or feet, as you've chosen in the chartplotter. Soundings the boat has just recorded show as orange dots, labelled with the depth the sounder read, less the tide where there is one, before the quality checks have judged them and before the safety margin the layer's areas and soundings carry, until they're folded into the layer: usually within a minute of leaving a spot. While the layer first fills in a long stretch of history, new soundings stay orange until it's done, for up to 3 hours, so older passes go in first. At a mooring, where the depth holds steady, they can stay orange for up to an hour, until the checks can tell a steady depth from a stuck sounder. A sounder reading one depth for a long way is held until it has covered a kilometre, as the checks need to judge it, or until about an hour of soundings at 10 a second is waiting. Over water the layer hasn't drawn yet, a line along the boat's latest pass, as wide as the layer's cells, shows the colour of the depth area its soundings will make, less the same safety margin, until the layer redraws there. Where the chartplotter shows few of your soundings the layer redraws every 5 seconds; where it shows many, as rarely as every 30 seconds, as the chartplotter pauses while it redraws. The plugin builds the layer ahead in the background, nearest the boat first, and keeps it, so panning and zooming read it at once.

### What it shows

- **Your own soundings**, placed and offset the same way as the soundings the plugin shares, so the layer shows what you contribute.
- **Depths on chart datum, where there's a tide station.** With the [signalk-tides](https://github.com/openwatersio/signalk-tides) plugin installed, each sounding is reduced by the predicted tide at its own time and place, from the nearest tide station within 50 km, the same station and predictions the Open Waters grid uses. Depths are then below the chart's datum (mean lower low water in the US), as on a paper chart. Without signalk-tides, or more than 50 km from a station, depths stay below your waterline at the moment you sounded them, and the tiles' coverage data marks that water as not reduced for tide. With Signal K security on, the layer reads signalk-tides only with the server's read-only access turned on.
- **A shoal-biased depth.** Each spot about 20 m across keeps a running average of your passes over it, and shows that depth less a safety margin for its uncertainty, as the Open Waters overlay does. Until your boat is calibrated against the grid the margin is about 2 m, so the layer reads shallower than your sounder; tide takes about 0.15 m off it near a station.
- **Soundings, then areas.** Soundings are thinned as the overlay thins them, keeping the shoalest in each area, so zooming in shows more. Depth areas follow every track you've sounded, and fill in between tracks less than 200 m apart, never past the ends of a track.
- **Suspect readings shown, not drawn.** The same checks the Open Waters grid runs on every boat's track run on yours. A reading they doubt on the shallow side, such as a spike or a stuck sounder in shallow water, stays out of the depth areas, except that the areas never reach past your track any deeper than it, and shows as a faint unconfirmed sounding, so you see the shoals the checks doubt rather than losing them. A stretch where the sounder zig-zags too much to trust is left out on both sides, as the Open Waters grid leaves it out. Readings that would show water deeper than it is, and bad data such as a position that jumped, are left out.
- **History when it starts.** The first time the layer starts, it fills in your recorded soundings (a History API provider such as signalk-to-influxdb2, or the plugin's own log) from as far back as **Fill the layer from** says: the last year by default, or the last 30 days or all of it. After that, it fills in whatever was recorded while it wasn't running, as far back as the same setting. A long history takes a while: about an hour for each year of soundings recorded around the clock, on a Raspberry Pi 5. A fill stopped by a restart goes on from where it got to at the next start. If that source fails at three starts in a row without getting any further, the layer gives up on what is left of that span and leaves it empty. Spots already in the layer stay, however long ago they were sounded, until something below rebuilds it.

### When it rebuilds

- The plugin update that adds **Fill the layer from** rebuilds every layer once, from the last year of recorded soundings. Spots older than your recorded soundings go back are lost with it.
- Changing your **depth sounder or GPS position** on the boat, or a plugin update that changes the quality checks, the tide reduction or the size of a spot, rebuilds the layer from recorded soundings as far back as **Fill the layer from** says, so old soundings don't sit beside new ones in the wrong place.
- **Installing, removing or turning on or off signalk-tides**, or turning on Signal K's read-only access it needs, rebuilds the layer the same way at the next start, reduced for tide or not.
- Changing **Fill the layer from** rebuilds it from the new span.
- Changing the **depth path, transducer depth or, for depth below the keel, the draft** rebuilds it from a History API provider if you have one. Without one, the layer starts afresh from that point, because the plugin's own log stores depths with the old offset.

### Who can see it

With Signal K security on, the layer needs a login or the server's read-only access, the same as your boat's position. With security off, anyone who can reach your server can see it.

### Credits

The plotter extension's provider and page serving are adapted from [signalk-livedepth-plugin](https://github.com/night199uk/signalk-livedepth-plugin) by Nick Roberts, under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Final reports

When a settings change restarts the plugin, it stops collecting and attempts a final report with the previous settings. It waits for any active upload, then flushes available data through the last complete second, with a 15-second timeout covering the active upload and final attempt. A failed or timed-out window retains its checkpoint and is retried after restart using the new settings. SQLite depths keep the offsets applied when collected, while report metadata uses the new settings; changing the depth reference can therefore mislabel that queued data. Completed batches keep their checkpoints. If the server accepted an upload but its response was lost or timed out, retrying can upload that batch again.

The same attempt runs if the server calls the plugin’s stop hook during a graceful shutdown; Signal K 2.33 does not call that hook on shutdown. Correcting an erroneous offset also flushes with the previous value; the correction applies after restart. Disable the plugin before editing to skip that final upload, but this does not correct depths already stored in SQLite.

The final attempt does not wait for a history provider to finish buffering. Readings that arrive later with timestamps before the successful flush checkpoint may be missed. Normal scheduled reports still use the history safety delay. If the plugin is still discovering its history source, it leaves the data queued rather than flushing an incomplete local fallback.

Disabling the plugin or changing sharing to anonymous skips the final flush and cancels reporting, so that action cannot trigger one last identified upload. A process crash or power loss cannot guarantee a final report. There are no configuration-history tables or backlog resets.

## Source selection and recorded data

Explicit selection requires Signal K 2.33 or newer, which passes per-source subscription policies to plugins.

An empty source setting means **Preferred source**. Live depth and position each follow Signal K’s priority decisions independently. Selecting a device pins that input even when Signal K prefers a different one. Saved explicit selections remain visible when offline; `derived-data` is omitted from new manual choices but retained if previously saved. Preferred mode still honors the server’s chosen source, including a derived source if you prioritize it there.

For history, Preferred source requests the provider’s default recorded series; it does not apply today’s live source to past data. In-process history providers receive explicit source filters. Legacy HTTP history does not support those filters through this adapter, so explicit selections stop reporting with a configuration error. The reporting checkpoint and existing data are retained. The provider continues recording independently, and the live chart continues; report attempts show the configuration error until it is resolved. Choose Preferred source for both sensors or switch to a source-aware History API provider before restarting. Older versions automatically saved concrete source IDs, so existing installations may need this configuration change on upgrade.

Changing selections rebuilds history-backed chart cells. SQLite rows have no source identity, so the local chart starts afresh rather than displaying old readings as if they came from the newly selected device.

Sounder offsets remain configured in Crowd Depth. GPS horizontal offsets come from Signal K 2.33 GNSS sensor settings; see below. Settings restarts attempt the final flush described above; failed queued SQLite readings retain their recorded depths and use the next configuration’s report metadata.

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

## Signal K GPS geometry

Each live sounding uses the geometry of the receiver that supplied its position, including preferred-source failover. The coordinate origin is stored with new SQLite readings so later changes do not move them using another antenna’s offsets. Historical reads use the selected or provider-reported source with current server geometry; old provider records cannot reconstruct earlier installation changes. Legacy single-receiver `sensors.gps` offsets and saved plugin offsets remain supported.

With Signal K correction **off**, the origin is the physical antenna. With **both**, a `.ccrp` source represents the vessel center and is shifted only from that center to the transducer. **Replace** mode cannot distinguish uncorrected fixes when heading was unavailable; affected readings are rejected with an actionable error. Missing geometry is not assumed to be zero: live readings are skipped with a configuration error, and history reports retain their checkpoint until corrected. Set source-specific offsets and use off/both mode. A preferred historical series without source identity may require an explicit receiver selection.

The SQLite change adds one nullable column for each reading’s coordinate origin. Existing rows and reports remain, and older builds ignore the column. No configuration-history tables are introduced. Historical rows without an origin retain the legacy saved plugin geometry behavior. GNSS position metadata is omitted when no single static antenna location is configured; reported sounding positions are still corrected to the transducer.

GPS geometry requires Signal K 2.33 sensor settings for new multi-receiver installations. After changing those settings, restart Crowd Depth to rebuild chart cells. Preferred history without receiver identity cannot use per-receiver geometry: use a source-aware provider with explicit selection, or the local recorder. Legacy HTTP history cannot support that configuration. Legacy plugin offsets are used only when no server sensor rows exist. A historical `.ccrp` series remains vessel-centre coordinates even after correction mode changes.

Rollback requires restoring the previous plugin configuration and database backup together: older versions ignore recorded origins and require the removed x/y fields. New rows cannot safely be reinterpreted by old releases. The XYZ converter requires explicit legacy x/y geometry because XYZ carries no receiver identity. GNSS report position is included for an explicitly selected raw receiver or a legacy static configuration; preferred-mode reports may span receivers and omit that static position.

Signal K `fromCenter` is positive to port; the plugin converts it to its starboard-positive coordinate convention. Unlinked GNSS rows allow saved plugin offsets as a fallback, but cannot revive stale server-wide GPS paths. When static antenna position is unknown the report omits that field while keeping `positionOffsetsDocumented` true because the submitted positions have been corrected, following the optional GNSS position in the [CSB 3.1 schema](../../docs/CSB-schema-3_1_0-2024-04.json). Legacy rows without a recorded origin require the old saved x/y; if those fields have already been removed, those rows cannot be positioned and are skipped.

Upgrading changes the chart geometry fingerprint and rebuilds derived cells. With a history provider that omits receiver identity and configured server sensor rows, select an explicit receiver before relying on the refill; otherwise reports and backfill show a configuration error. Older servers without the GNSS sensor settings page need an upgrade to Signal K 2.33 for new multi-receiver configuration. A fresh installation cannot roll back to an older plugin without manually supplying the old x/y fields and an appropriate database.
