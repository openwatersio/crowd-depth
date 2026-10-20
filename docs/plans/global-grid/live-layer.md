# Live layer

The crowd-depth plugin draws the boat's own soundings on the chart as they're recorded, on top of the global grid overlay. The live layer is the grid pipeline run on one vessel's soundings, incrementally: the same QC, corrections, interpolation and portrayal, from the same definitions, and a one-vessel version of the grid's statistic. A depth the boat just measured is drawn with the grid's bands and contours, only sooner. The two layers can differ by the spread between vessels, which one boat can't see (see [Cells and surface](#cells-and-surface)).

Every number below comes from the grid's design and changes with it. This note covers only what's different about running that design live, on one boat. The layer shows only the boat's own soundings: the plugin records its own vessel and nothing it hears from others, since only the owner has agreed to share them.

## Shared definitions

The grid is Python and the plugin is TypeScript, so both read one set of definitions instead of porting by hand:

- **Constants as JSON:** QC thresholds, cell resolution, the statistic's k, the interpolation radius, smoothing and blur, band levels, contour tiers and sounding rounding, in [definitions.json](../../../packages/grid/src/grid/definitions.json), which the grid's modules read and the plugin imports at build time.
- **Test vectors as JSON:** inputs and expected outputs for QC, the statistic, interpolation and rounding, run by both pytest and vitest. A change on either side fails the other's tests until both agree. QC's are in [qc_vectors.json](../../../packages/grid/tests/qc_vectors.json), with flags from `grid.qc`; pytest checks them against the reference SQL for every check but the steep and noise checks, and against flags worked out by hand for those two.
- **QC as pure functions:** the grid's track QC as numpy functions ([qc.py](../../../packages/grid/src/grid/qc.py)), ported once to TypeScript as plain loops ([qc.ts](../../../packages/signalk-plugin/src/qc.ts)) and checked against the shared vectors with vitest ([qc-functions.md](qc-functions.md)).

When the grid changes a definition, the plugin picks it up on its next release, and its cells are rebuilt from the plugin's sounding log, as they are for an offset change. With the plugin's own SQLite log, which stores depths with the offset of their day, a depth offset change starts the cells afresh instead. A rebuild reaches back as far as the backfill does, 30 days, so cells from older passes are lost with it.

## Pipeline

### QC

[Track QC](README.md#2-quality-control) runs on the plugin's stream, through the same port. Checks that look ahead along the track, such as the spike check's window and the noise check's, make the newest soundings provisional until their window fills. Provisional soundings draw as soundings with a provisional flag; only judged ones go into cells.

Cell QC runs across the boat's own passes, as the grid's does across vessels. Consensus QC needs other vessels, so on its own the plugin can't run it. Where the grid overlay covers the water, its published depth and σ stand in for the other vessels' vote.

The plugin reads GNSS quality from the same Signal K data it sends to the grid, so its position checks and horizontal uncertainty match the grid's for the same soundings.

Unconfirmed shoals are handled as in the grid: they publish as soundings with a low-reliability flag, and the surface is drawn as if those QC judged improbable weren't there.

**Transits that lost the bottom.** In the grid, a stray transit reading more than 2 m shallower than its vessel's segment, and under half of what the segment reads over the same seabed, has lost the bottom: its soundings set no depths and draw no surface, and those shoaler than 30 m publish as unconfirmed shoals ([Corrections](README.md#3-corrections)). One boat has no segment to compare with, so the plugin judges each stretch of its track against a reference for the same seabed: the overlay's depth where the overlay covers the water, and otherwise its own cells from earlier passes. A stretch of about a kilometre that reads more than 2 m shallower than the reference, and under half of it, at the median of its cells, is set aside the same way. It's judged over a stretch, never a cell, because a sounder that lost the bottom is wrong the whole way, while a real shoal is local. Passes in the stretch wait for the judgment, as soundings wait for the spike window. Where neither reference exists, as on a first passage through water the overlay doesn't cover, nothing is judged.

### Corrections

The layer is a chart, so it shows charted depths: depth below the waterline reduced to chart datum, never depth below the keel or transducer. The plugin applies the grid's [corrections](README.md#3-corrections) in the same order:

- **Offsets:** the plugin's depth reference and transducer offsets, which bring every sounding to depth below the waterline, and the GNSS antenna to transducer offset, which moves each sounding to where it was measured. Each change of these settings is to go into a log with its time (see [Open questions](#open-questions)).
- **Vessel calibration:** the vessel's own offset, scale and uncertainty, fetched from the grid's calibration ([Vessel calibration](README.md#vessel-calibration)). It needs the plugin's `SIGNALK-<uuid>` to match the vessel's `UNIQUE_ID` in the grid. A vessel without a calibration is marked uncalibrated, as the grid marks it.
- **Tide:** the water level at each sounding's own time and place, from the same Slackwater engine the grid uses, which the plugin reaches through signalk-tides' Neaps API. The correction is applied as each pass enters its cell. The plugin's upload to the grid carries raw depths, so a better prediction or observed level reaches the grid; the live layer keeps the level it had.
- **Datum:** the grid's low-water chart datum, from the same separation source.

Each cell records which corrections it has, as in the grid. A cell without tide and datum isn't on the overlay's reference, and the layer says so.

### Cells and surface

Cells are the grid's 2/3″ surface pixels ([resolution](README.md#resolution)), and use the form of the grid's [statistic](surface-statistic.md), `median − kσ` with the same k = 1.75 and σ published, but the plugin keeps no soundings in them. Each cell holds a running estimate, updated once per pass:

- **A pass** is one transit through a cell. The plugin holds only the soundings of the cells under the boat and its neighbours, and when the boat leaves a cell, the median of the pass's soundings within a pixel of it goes into that cell's estimate. That's the grid's per-vessel smoothing along its own coverage, for one vessel.
- **The estimate** is an exponential moving average of pass medians, m ← m + α(x − m), with an exponential moving average of their absolute deviation, d ← d + α(|x − m| − d), at α = 0.2, with d starting at 0.3 m. σ is √(σ_c² + (1.25d)²), where σ_c is the vessel's correction uncertainty (tide and calibration) and 1.25d estimates the spread of its passes, and depth is m − kσ. As in the grid, the margin never makes wet water drying: depth goes below 0 m only where m does. The two values fit in 4 bytes as centimetres.
- **Against the grid:** the grid's σ also counts how far other vessels spread around a local plane, which one boat can't measure. Where vessels disagree, the grid draws shoaler than the live layer by k times that spread. Where the overlay covers the water, the plugin can draw the shoaler of the two.
- **A vessel's offset changing** rebuilds its cells from the sounding log, or with the plugin's own log after a depth offset change, starts them afresh. Since the average is linear, a depth offset change could instead shift them by the difference and keep passes older than the log's reach. A new tide level for past passes doesn't reach the live layer; the grid's next build carries it.

Replayed per vessel in Thimble Shoal Channel (2/3″ cells, per pass), against BlueTopo and on a synthetic 1 m change with 0.3 m noise:

| Per cell              |      State | Too deep by > 1 m | Passes to show a 1 m shoal | Passes to forget it |
| --------------------- | ---------: | ----------------: | -------------------------: | ------------------: |
| Shallowest            |        2 B |              2.0% |                          8 |               never |
| Median of every pass  | all passes |              2.2% |                         33 |                  33 |
| EMA, α = 0.2, − 1.0σ  |        4 B |              1.4% |                          3 |                  11 |
| EMA, α = 0.2, − 1.75σ |        4 B |              1.2% |                          2 |                  12 |
| Running mean − 1.75σ  |        8 B |              1.3% |                          9 |               never |

The moving average shows a new shoal within 2 passes and lets go of one in about 12, so it errs shoal while the water changes. One vessel crosses a cell a median of once: most of the layer is a single pass, and the estimate is that pass. Across the Chesapeake set, a vessel touched a median of 10,800 cells (90th percentile 96,000, largest 1.48M). At 4 bytes of state and a 4-byte cell index, that's 87 KB for the median vessel and 12 MB for the largest; in SQLite, with row overhead and the overview levels zoomed-out tiles read, about 75 bytes a cell, or 114 MB for the largest.

### The grid's rules for one vessel

Each rule the grid applies across vessels has a one-vessel form, with the overlay standing in for the other vessels where it covers the water. The table is the design; [Phases](#phases) says which parts run today. Confirmed shoals, the checks against the overlay, GNSS quality and the offset log wait on theirs.

| Grid rule                                                                                                                 | One vessel                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each vessel votes once per pixel with its median, smoothed along its own coverage                                         | The cell's estimate is the boat's one vote, built from pass medians over a pixel each way                                                                              |
| Depth is the median of the votes less 1.75σ                                                                               | Depth is the estimate less 1.75σ                                                                                                                                       |
| σ is the vessels' spread around a local plane, with the corrections' σ                                                    | σ is the spread of the boat's passes, with its corrections' σ                                                                                                          |
| Track QC: spikes, stuck runs, noisy tracks, position jumps, GNSS quality                                                  | The same checks, from the same port, on the live stream; GNSS quality once the plugin records it                                                                       |
| Consensus QC against the other vessels within about 270 m                                                                 | Against the overlay's depth and σ where it covers the water; otherwise not run                                                                                         |
| A shoal is confirmed by another reading of the same depth in its block                                                    | Confirmed by another of the boat's transits reading the same depth, within 2 m + 5%                                                                                    |
| A confirmed shoal stands only within 2 m + 5% of the other vessels' median in its pixel                                   | Within 2 m + 5% of the overlay's depth where the overlay covers the water; otherwise it stands, as the grid's does where fewer than 2 other vessels sounded            |
| Unconfirmed shoals publish as unconfirmed soundings, and the surface is drawn as if they weren't there                    | The same, one per cell, the shoalest. Every reading track QC doubts on the shoal side shows this way; what it rejects or marks noisy is the deep side, and isn't drawn |
| A stray transit that lost the bottom is set aside                                                                         | A stretch of track that lost the bottom is set aside, judged against the overlay or the boat's own earlier passes                                                      |
| Vessel calibration by step segment                                                                                        | The grid's calibration for this vessel, fetched; the plugin's log of offset changes helps the grid find its steps                                                      |
| Interpolation within 200 m with a sounding in every quadrant, 40 m of smoothing, a 2-pixel blur never toward deeper water | The same, from the stored cells, except that a pixel the boat sounded always keeps a depth, so its own track draws as areas                                            |
| No pixel deeper than a confirmed shoal in it or next to it                                                                | The same                                                                                                                                                               |
| `M_QUAL` split into measured and interpolated coverage                                                                    | The same                                                                                                                                                               |

### Surface

The surface follows the grid's [interpolation](README.md#interpolation) and [depth surface](surface.md), with the same definitions: from each cell's estimate at its centre, inverse distance to the 12 nearest cells within 200 m, with at least one in each quadrant and 40 m added to every distance, so it fills between tracks but never past their ends and a sounded pixel takes its neighbours' depths too. Then a gaussian blur over 2 pixels, clamped so no pixel reads deeper than it was interpolated; then k × σ off, with σ from the nearest sounded cell widened by its distance d, √(σ² + (r·d)²) with r = 0.005; then no pixel deeper than a confirmed shoal in it or next to it. A pixel more than a pixel from any sounded cell is interpolated, and coverage is split into measured and interpolated `M_QUAL`. For display, areas, contours and coverage are traced from the continuous surface, interpolated between pixel centres, rather than pixel by pixel: the surface's edge is where half of each pixel's blurred neighbourhood has a depth, or within a cell of a sounded cell, and the traced lines are rounded off with two passes of Chaikin's corner cutting. Each tile is traced three pixels past its edges, which the renderer clips, so areas meet across tiles. This closes holes between lanes narrower than the blur, which the grid leaves open.

The plugin builds the surface per vector tile as the tile is asked for, from the stored cells under it and a margin of 200 m plus the blur, and caches the encoded tile. A tile is a raster in Web Mercator of at most 256 pixels a side and none finer than a cell, to zoom 15 as the overlay's, so at the cells' zoom a pixel is about a cell, and zoomed out a pixel takes the shoalest of its cells, as the grid aggregates. A pass that changes a cell drops the cached tiles within that margin of it, and those are the tiles the layer refreshes. Below zoom 10 a tile spans a bay or more and a pass hardly shows, so those tiles refresh every 5 minutes instead. Areas and contours stop at 200 m, as the grid's do.

### Portrayal

The live layer and the global overlay are two plugin layers, which Freeboard lists under "Plugin layers" with their own on/off toggles, so a user can show either, both, or neither. The global overlay is a data overlay too, drawn with the same style as the live layer, so the two match where they meet. `overlays.data` takes `{z}/{x}/{y}` tile templates, so the plugin serves the published PMTiles archive's tiles at such paths, reading the archive with HTTP range requests and keeping what it reads on disk for use offshore.

The live layer has the overlay's schema: S-57 `DEPARE`, `DEPCNT`, `SOUNDG` and `M_QUAL` vector tiles, built with the grid's band levels, contour tiers and rounding toward shoal, and the same `depth_m`, `depth_ft` and `depth_fm` sounding labels. The portrayal code shared with Seascape ([#146](https://github.com/openwatersio/crowd-depth/issues/146)) covers the live layer too.

Freeboard can't keep an S-57 chart resource current (see [Freeboard refresh](#freeboard-refresh)), so the plugin draws the layer as a plotter extension data overlay (`overlays.data`):

- **Stored cells:** the MVT tiles, as a `vector` source in a MapLibre style. When a cell changes, the plugin's background runtime calls `overlay.refresh` with just the tiles it touches, and Freeboard refetches those within a second.
- **Provisional soundings:** a `geojson` source, replaced with `overlay.setData` on each poll, so a sounding leaves it once its cell is stored.
- **Styling:** a MapLibre style with the overlay's Seascape palette for depth areas, contours and soundings. Depth units come from `units.get`, set as a `global-state` variable that picks the sounding label, and the safety contour from the plugin's settings, since Freeboard doesn't pass its S-52 settings to extensions.

The plugin is to list the same tiles as a `type=S-57` chart resource too, for plotters without `overlays.data`, where they'd be current as of when the chart was last shown.

## Phases

- [x] Shared constants and test vectors, read by both the grid and the plugin.
- [x] Track QC ported from the plain-loop functions and checked against the shared vectors.
- [x] Track QC on the live stream, with provisional soundings.
- [x] Cells as running estimates per pass, with the grid's resolution, statistic and interpolation.
- [x] S-57 vector tiles drawn as a data overlay with per-tile refresh, and provisional soundings as GeoJSON.
- [ ] The same tiles listed as a chart resource, for plotters without `overlays.data`.
- [ ] Tide and datum through signalk-tides, applied per sounding time.
- [ ] The global overlay as a second data overlay, served from the PMTiles archive.
- [ ] Cell QC, confirmed shoals and lost-bottom stretches against the overlay's depth and σ where the overlay covers the water.
- [ ] A log of offset changes, sent with the plugin's submissions.
- [ ] GNSS quality in the live QC, with the backlog's [Record GNSS quality](backlog.md) item.
- [ ] A depth offset change shifting the cells by the difference instead of rebuilding them, so passes older than the backfill's 30 days survive it.
- [ ] Vessel calibration fetched from the grid, once the grid publishes it per vessel.

## Open questions

- What the layer shows where there's no tide station or datum separation: raw depths, flagged, or nothing on top of the overlay.
- **Seabed change.** A seabed that moves, such as a shoaling channel or a dredged one, and a source that's wrong both make the boat disagree with the overlay or the survey. Time tells them apart: sources that disagree at the same time point to a bad source, and sources that agree at each time but drift across time point to a moving seabed. The moving average lets go of an old depth in about 12 passes, but the grid and the overlay need the comparison by time to keep a real change rather than reject it as a bad vessel.
- **A log of offset changes.** Each time the owner changes the draft, the depth reference or the transducer or antenna position, the plugin records the time and the old and new values, and sends them with its submissions. For the grid's calibration, each change is a hint for step detection, not a fixed boundary: an owner may correct a setting long after the sounder moved, or change one without the soundings changing at all. In the live layer, a change rebuilds the cells from the sounding log.

## Freeboard refresh

Read from Freeboard-SK v3.4.0-beta.1, the latest release ([`afe3b1c`](https://github.com/SignalK/freeboard-sk/tree/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/)) and OpenLayers 10.7, which it uses. Not measured on a running plotter, since the source leaves no doubt.

**An S-57 chart resource never refetches a tile it holds.** Each S-57 chart is one OpenLayers `VectorTileSource` built from the chart's `url` when the layer is first created ([vectorLayerStyleFactory.ts:43-63](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/ol/lib/charts/vectorLayerStyleFactory.ts#L43-L63)). Later chart updates only change z-index, opacity and extent ([layer-s57-chart.component.ts:59-83](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/ol/lib/charts/layer-s57-chart.component.ts#L59-L83)), so a new `url` is ignored. The source is refreshed only when the user changes S-52 settings ([s57.service.ts:167-173](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/ol/lib/charts/s57.service.ts#L167-L173)). Otherwise a changed tile shows only when the user hides and shows the chart, reloads the page, or the tile falls out of OpenLayers' cache and is fetched again ([ol/source/VectorTile.js `removeSourceTiles`](https://github.com/openlayers/openlayers/blob/v10.7.0/src/ol/source/VectorTile.js)). That last case goes through the browser's HTTP cache, so `Cache-Control: no-cache` makes it fresh, but it happens only when the user pans or zooms far enough.

**No signal from the provider helps.** The server sends a `resources.charts.<id>` delta when a chart resource is written ([signalk-server resources/index.ts:976-990](https://github.com/SignalK/signalk-server/blob/master/src/api/resources/index.ts)), and a plugin can send one itself. Freeboard re-lists its charts on any such delta ([resources.service.ts:579-581](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/skresources/resources.service.ts#L579-L581)), but its layers are keyed by chart id ([fb-map.component.html:166-168](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/fb-map.component.html#L166-L168)), so the S-57 layer and its tiles stay. The one delta Freeboard acts on in place is a new time dimension, and only raster layers use it ([resources.service.ts:597-617](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/skresources/resources.service.ts#L597-L617)). A chart's `refreshInterval` refetches every visible tile on a timer, but only on raster tile layers, and never more often than every 60 s ([layer-raster-chart.component.ts:155-178](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/ol/lib/charts/layer-raster-chart.component.ts#L155-L178), [chart-time.ts:31](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/lib/chart-time.ts#L31)). ETags and cache headers matter only on the fetches above.

**The Plotter Extensions API draws vector features.** It has two kinds of overlay:

- `overlays.image`: the extension's background runtime renders the whole view, padded 10% per side, to an `ImageBitmap` and transfers it to Freeboard. It renders a new frame on every zoom or resize and whenever the view leaves the padded box. Live frames are limited to one per 200 ms, and a frame can be up to 8 M pixels, about 32 MB ([overlay-registry.ts:28-32](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/plotterext/overlay-registry.ts#L28-L32), [freeboard-plotter-ext-support.md "Budget" and "The frame cycle"](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/docs/freeboard/freeboard-plotter-ext-support.md)). Each change to one cell means re-rendering the whole view on the client.
- `overlays.data`, new in 3.4.0-beta.0 (freeboard-sk#1022): Freeboard draws `vector` (MVT), `geojson`, `raster` and `raster-dem` sources with `fill`, `line`, `circle` and `symbol` layers from a MapLibre style the extension supplies ([plotter-extensions-api.md "Data overlays"](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/docs/api/plotter-extensions-api.md)). The extension renders nothing per frame. `overlay.refresh` with a list of `[z, x, y]` bumps those tiles' cache keys, so only they are fetched again, with `cache: 'reload'`. Old tiles stay drawn until the new ones load, and a burst of refreshes redraws once on the next animation frame ([layer-data-overlay.component.ts:446-475, 625-662](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/ol/lib/data-overlay/layer-data-overlay.component.ts#L446-L475), [tile-fetcher.ts:131](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/ol/lib/data-overlay/tile-fetcher.ts#L131)). `overlay.setData` replaces a `geojson` source's features, or upserts or removes them by id. The style is MapLibre's, not Freeboard's S-52 engine, and the host passes no S-52 settings to it.

How long a change takes to show:

| Path                                               | Latency                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| S-57 chart resource                                | Until the user toggles the chart, changes S-52 settings or reloads; no upper bound |
| Raster chart with `refreshInterval`                | 60 s at best, refetching every visible tile; not available for S-57                |
| `overlays.image`                                   | 200 ms at best, re-rendering the whole view each time                              |
| `overlays.data` vector tile with `overlay.refresh` | One tile fetch, under a second on the boat's network                               |
| `overlays.data` GeoJSON with `overlay.setData`     | The next map render                                                                |

A chart resource for stored cells with an extension for provisional soundings doesn't work in Freeboard as it is: the stored cells would stop changing on screen. The data overlay carries both at the latencies a live layer needs, without per-frame rendering on the client, at the cost of drawing S-52 in a MapLibre style. Keeping Freeboard's own S-52 rendering needs the upstream change below.

### Upstream change for live chart resources

Freeboard needs one change to draw the live layer as a local S-57 chart resource: when a chart's `url` changes, swap it into the existing tile source in place. The signal already exists. The plugin bumps a revision in the chart's URL, for example `/plugins/crowd-depth/tiles/{z}/{x}/{y}.pbf?rev=42`, and sends a `resources.charts.<id>` delta carrying the chart. Freeboard subscribes to `resources.*` once a second ([skstream.facade.ts:286](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/skstream/skstream.facade.ts#L286)), so the delta arrives within about a second. The Signal K chart schema needs no new field.

In Freeboard:

1. **Re-point the S-57 layer's source when its `url` changes.** `parseChart` in [layer-s57-chart.component.ts:79-83](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/ol/lib/charts/layer-s57-chart.component.ts#L79-L83) updates z-index, opacity and extent. It would also compare `chart[1].url` with the URL the source was built from, and call `source.setUrl(url)` when they differ. OpenLayers' `setUrl` re-keys the source without clearing it ([ol/source/UrlTile.js `setUrls`](https://github.com/openlayers/openlayers/blob/v10.7.0/src/ol/source/UrlTile.js)), so old tiles stay drawn until their replacements load. Freeboard already relies on that for vector sources in `startChartTileRecovery` ([chart-utils.ts:944-971](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/ol/lib/charts/chart-utils.ts#L944-L971)). Don't use `source.refresh()`: it blanks the layer, and Freeboard avoids it for that reason (openlayers#17389). The vector chart layer (`tilelayer` with `pbf`/`mvt`, [layer-vector-chart.component.ts](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/ol/lib/charts/layer-vector-chart.component.ts)) has the same gap and needs the same change.
2. **Absorb a URL-only delta in place.** [`absorbChartDelta`](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/skresources/resources.service.ts#L597-L617) handles a delta that changes only `time` without re-listing charts. It would also handle one that changes only `url`, and update that chart's entry in the chart cache. Without this, every revision makes Freeboard list every chart from the server again. That works, but it's wasteful every few seconds.
3. **Tests** alongside the existing [layer-raster-chart.component.spec.ts](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/ol/lib/charts/layer-raster-chart.component.spec.ts) and the `absorbChartDelta` specs: a changed `url` re-keys the same source, an unchanged one doesn't, and a URL-only delta doesn't re-list.

That's roughly 30 lines plus tests. The benefit isn't specific to crowd-depth: any plugin serving vector data that changes, such as AIS-derived layers or a tide-corrected depth layer, gets live updates through the standard chart resource, and every client that follows `url` behaves the same.

**What it costs.** Changing the URL changes every tile's URL, so each revision refetches every visible tile, not just the changed ones. A typical view is about 12 to 40 tiles of a few KB from the boat's own server. The plugin keeps it cheap by caching encoded tiles and rebuilding only the ones a new cell touched, and by bumping the revision at most every few seconds. Latency is the revision interval, plus up to 1 s for the delta, plus one tile fetch.

**Refetching only changed tiles** would need a way to name them, which the chart resource schema has no field for. Freeboard could take a list of `[z, x, y]` in the delta, as `overlay.refresh` does, and re-key just those tiles, as the data overlay does. That's a schema proposal for Signal K, so it can follow the URL change if the whole-view refetch proves too costly.

**Alternative: `refreshInterval` for S-57.** Giving S-57 and vector layers the raster layers' `startChartTileRefresh` ([chart-utils.ts:1039-1068](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/ol/lib/charts/chart-utils.ts#L1039-L1068)), with a lower minimum for server-relative URLs, also works. But it polls whether or not anything changed, and the 60 s minimum is there to protect remote tile servers, so a shorter one is a harder sell upstream. The URL change refreshes only when the provider says something changed.

With the change, the chart resource carries the stored cells in Freeboard's own S-52 rendering, including the user's safety contour and units. The plotter extension then only draws the provisional soundings of the last few seconds, as GeoJSON in an `overlays.data` overlay. That's the alternative to the data overlay if Freeboard takes the change.
