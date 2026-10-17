# Live layer

The crowd-depth plugin draws the boat's own soundings on the chart as they're recorded, on top of the global grid overlay. The live layer is the grid pipeline run on one vessel's soundings, incrementally: the same QC, corrections, statistic, interpolation and portrayal, from the same definitions. A depth the boat just measured looks the way the grid will publish it from the same soundings, only sooner, so where the two layers meet they agree.

Every number below comes from the grid's design and changes with it. This note covers only what's different about running that design live, on one boat.

## Shared definitions

The grid is Python and the plugin is TypeScript, so both read one set of definitions instead of porting by hand:

- **Constants as JSON:** QC thresholds, cell resolution, the statistic's k, the interpolation radius, band levels, contour tiers and sounding rounding, in one file under `packages/grid` that the plugin imports at build time.
- **Test vectors as JSON:** inputs and expected outputs for QC, the statistic, interpolation and rounding, run by both pytest and vitest. A change on either side fails the other's tests until both agree.
- **QC as pure functions:** the grid's track QC as plain loops, ported once to TypeScript and checked against the shared vectors ([qc-functions.md](qc-functions.md)).

When the grid changes a definition, the plugin picks it up on its next release, and its tiles are rebuilt from the plugin's sounding log, as they are for an offset change.

## Pipeline

### QC

[Track QC](README.md#2-quality-control) runs on the plugin's stream. Checks that look ahead along the track, such as the spike check's window, make the newest soundings provisional until the window fills. Provisional soundings draw as soundings with a provisional flag; only judged ones go into cells.

Cell QC runs across the boat's own passes, as the grid's does across vessels. Consensus QC needs other vessels, so on its own the plugin can't run it. Where the grid overlay covers the water, its published depth and σ stand in for the other vessels' vote.

Unconfirmed shoals are handled as in the grid: they publish as soundings with a low-reliability flag, and the surface is never drawn over them.

### Corrections

The plugin applies the grid's [corrections](README.md#3-corrections) in the same order:

- **Offsets:** the plugin's depth reference and transducer offsets.
- **Vessel calibration:** the vessel's own offset, scale and uncertainty, fetched from the grid's calibration ([Vessel calibration](README.md#vessel-calibration)). It needs the plugin's `SIGNALK-<uuid>` to match the vessel's `UNIQUE_ID` in the grid. A vessel without a calibration is marked uncalibrated, as the grid marks it.
- **Tide:** the water level at each sounding's own time and place, from the same Slackwater engine the grid uses, which the plugin reaches through signalk-tides. The correction is applied when cells are built, so the log keeps raw depths and a better prediction or observed level can be applied later.
- **Datum:** the grid's low-water chart datum, from the same separation source.

Each cell records which corrections it has, as in the grid. A cell without tide and datum isn't on the overlay's reference, and the layer says so.

### Cells and surface

Cells use the grid's [resolution](README.md#resolution) and [statistic](README.md#cell-statistics), with each transit standing in for a vessel: depth is the median of per-transit medians minus kσ, and σ is published. The surface follows the grid's [interpolation](README.md#interpolation): bounded, marked, with σ widening with distance from the nearest track.

The statistic needs the soundings, not a running minimum. Accepted soundings are kept indexed by grid cell in the plugin's SQLite database, and a cell's statistic is recomputed from its own soundings when a new one lands in it. Interpolated cells within the radius of a changed cell are recomputed with it. A cell holds few soundings, so this stays cheap on a Raspberry Pi. A month of one boat's soundings, about 2.6M, is roughly 50–100 MB.

### Portrayal

The live layer has the overlay's schema: S-57 `DEPARE`, `DEPCNT`, `SOUNDG` and `M_QUAL` vector tiles, built with the grid's band levels, contour tiers and rounding toward shoal. The portrayal code shared with Seascape ([#146](https://github.com/openwatersio/crowd-depth/issues/146)) covers the live layer too.

Freeboard can't keep an S-57 chart resource current (see [Freeboard refresh](#freeboard-refresh)), so the plugin draws the layer as a plotter extension data overlay (`overlays.data`) instead of an image overlay:

- **Stored cells:** the same MVT tiles, as a `vector` source in a MapLibre style. When a cell changes, the plugin calls `overlay.refresh` with just the tiles it touches, and Freeboard refetches those within a second.
- **Provisional soundings:** a `geojson` source, updated with `overlay.setData` upserts as soundings arrive and removed once their cell is stored.
- **Styling:** a MapLibre style with S-52's depth area colors, contour and sounding portrayal. Depth units come from `units.get` through `global-state`, and the safety contour from the plugin's settings, since Freeboard doesn't pass its S-52 settings to extensions.

The plugin also lists the tiles as a `type=S-57` chart resource, for plotters without `overlays.data`. There they're current as of when the chart was last shown.

## Phases

- [ ] Shared constants and test vectors, read by both the grid and the plugin.
- [ ] Track QC in the plugin, ported from the plain-loop functions and checked against the shared vectors.
- [ ] Accepted soundings stored by cell, with the grid's resolution, statistic and interpolation.
- [ ] Tide and datum through signalk-tides, applied per sounding time.
- [ ] S-57 vector tiles drawn as a data overlay with per-tile refresh, provisional soundings as GeoJSON, and the same tiles listed as a chart resource.
- [ ] Vessel calibration fetched from the grid, once the grid calibrates vessels.
- [ ] Cell QC against the overlay's depth and σ where the overlay covers the water.

## Open questions

- Whether a MapLibre port of S-52 is close enough, or Freeboard should refresh S-57 chart resources so both layers share its S-52 engine. That needs the [upstream change](#upstream-change-for-live-chart-resources) below.
- What the layer shows where there's no tide station or datum separation: raw depths, flagged, or nothing on top of the overlay.

## Freeboard refresh

Read from Freeboard-SK 3.4.0-beta.1 ([`afe3b1c`](https://github.com/SignalK/freeboard-sk/tree/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/)) and OpenLayers 10.7, which it uses. Not measured on a running plotter, since the source leaves no doubt.

**An S-57 chart resource never refetches a tile it holds.** Each S-57 chart is one OpenLayers `VectorTileSource` built from the chart's `url` when the layer is first created ([vectorLayerStyleFactory.ts:43-63](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/ol/lib/charts/vectorLayerStyleFactory.ts#L43-L63)). Later chart updates only change z-index, opacity and extent ([layer-s57-chart.component.ts:59-83](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/ol/lib/charts/layer-s57-chart.component.ts#L59-L83)), so a new `url` is ignored. The source is refreshed only when the user changes S-52 settings ([s57.service.ts:167-173](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/ol/lib/charts/s57.service.ts#L167-L173)). Otherwise a changed tile shows only when the user hides and shows the chart, reloads the page, or the tile falls out of OpenLayers' cache and is fetched again ([ol/source/VectorTile.js `removeSourceTiles`](https://github.com/openlayers/openlayers/blob/v10.7.0/src/ol/source/VectorTile.js)). That last case goes through the browser's HTTP cache, so `Cache-Control: no-cache` makes it fresh, but it happens only when the user pans or zooms far enough.

**No signal from the provider helps.** The server sends a `resources.charts.<id>` delta when a chart resource is written ([signalk-server resources/index.ts:976-990](https://github.com/SignalK/signalk-server/blob/master/src/api/resources/index.ts)), and a plugin can send one itself. Freeboard re-lists its charts on any such delta ([resources.service.ts:579-581](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/skresources/resources.service.ts#L579-L581)), but its layers are keyed by chart id ([fb-map.component.html:166-168](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/fb-map.component.html#L166-L168)), so the S-57 layer and its tiles stay. The one delta Freeboard acts on in place is a new time dimension, and only raster layers use it ([resources.service.ts:597-617](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/skresources/resources.service.ts#L597-L617)). A chart's `refreshInterval` refetches every visible tile on a timer, but only on raster tile layers, and never more often than every 60 s ([layer-raster-chart.component.ts:155-178](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/ol/lib/charts/layer-raster-chart.component.ts#L155-L178), [chart-time.ts:31](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/lib/chart-time.ts#L31)). ETags and cache headers matter only on the fetches above.

**The Plotter Extensions API draws vector features.** It has two kinds of overlay:

- `overlays.image`, which PR [#145](https://github.com/openwatersio/crowd-depth/pull/145) uses: the plugin's background runtime renders the whole view, padded 10% per side, to an `ImageBitmap` and transfers it to Freeboard. It renders a new frame on every zoom or resize and whenever the view leaves the padded box. Live frames are limited to one per 200 ms, and a frame can be up to 8 M pixels, about 32 MB ([overlay-registry.ts:28-32](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/plotterext/overlay-registry.ts#L28-L32), [freeboard-plotter-ext-support.md "Budget" and "The frame cycle"](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/docs/freeboard/freeboard-plotter-ext-support.md)). Each change to one cell means re-rendering the whole view on the client.
- `overlays.data`, new in 3.4.0-beta.0 (freeboard-sk#1022): Freeboard draws `vector` (MVT), `geojson`, `raster` and `raster-dem` sources with `fill`, `line`, `circle` and `symbol` layers from a MapLibre style the extension supplies ([plotter-extensions-api.md "Data overlays"](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/docs/api/plotter-extensions-api.md)). The extension renders nothing per frame. `overlay.refresh` with a list of `[z, x, y]` bumps those tiles' cache keys, so only they are fetched again, with `cache: 'reload'`. Old tiles stay drawn until the new ones load, and a burst of refreshes redraws once on the next animation frame ([layer-data-overlay.component.ts:446-475, 625-662](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/ol/lib/data-overlay/layer-data-overlay.component.ts#L446-L475), [tile-fetcher.ts:131](https://github.com/SignalK/freeboard-sk/blob/afe3b1ca419e26ed5a1f309d065552ecafdbefdf/src/app/modules/map/ol/lib/data-overlay/tile-fetcher.ts#L131)). `overlay.setData` upserts or removes GeoJSON features by id. The style is MapLibre's, not Freeboard's S-52 engine, and the host passes no S-52 settings to it.

How long a change takes to show:

| Path                                               | Latency                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| S-57 chart resource                                | Until the user toggles the chart, changes S-52 settings or reloads; no upper bound |
| Raster chart with `refreshInterval`                | 60 s at best, refetching every visible tile; not available for S-57                |
| `overlays.image` (PR #145)                         | 200 ms at best, re-rendering the whole view each time                              |
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

With the change, the chart resource carries the stored cells in Freeboard's own S-52 rendering, including the user's safety contour and units. The plotter extension then only draws the provisional soundings of the last few seconds, as GeoJSON in an `overlays.data` overlay. That's the design this plan started from.
