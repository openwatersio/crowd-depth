# Live layer performance

The "My soundings" layer ([live-layer.md](live-layer.md)) is slow to fill a view and heavy for a Raspberry Pi and the plotter that draws it. Most of the cost is two things. The plugin rebuilds each tile's depth surface from the cells every time the tile is asked for, and the zoom-13 to 15 tiles it sends carry far more geometry than a screen can show. This note measures both, reviews what upstream signalk-livedepth-plugin has done since we adapted it, and proposes a staged plan. The measurements describe the layer before stage 1; [Stage 1 results](#stage-1-results) and [Stage 2 results](#stage-2-results) measure what each changed.

## How the layer worked before stage 1

- **Server:** the plugin folds each pass into its cells in SQLite (`src/tiles/writer.ts`, `cells.ts`). Tiles are built on request on a pool of up to three worker threads (`service.ts`, `tile-worker.ts`). Each build runs these steps:
  - reads the cells under the tile and a 364 m margin;
  - interpolates a depth surface over a raster of at most 256 pixels a side, plus its halo (`surface.ts`);
  - smooths and upsamples it (`portray.ts` `prepare`, `cut`);
  - traces depth areas, contours and coverage with d3-contour;
  - encodes the result as an MVT.

  Encoded tiles are kept in memory, up to 2,000 of them. Zoom 15 tiles are cut from their zoom 14 parent's surface, and each worker keeps the last four such surfaces. A pass drops the cached tiles within the margin at zooms 10 to 15 at once, and those at 4 to 9 on a 5-minute timer.

- **Client:** there's no client renderer any more. The WebGL renderer we adapted from upstream was replaced on 2026-10-20 (`9fcf576`) with a plotter-extension `overlays.data` overlay. Freeboard-SK draws the MVT tiles with OpenLayers from a MapLibre style (`style.ts`). A headless runtime iframe (`web/runtime.ts`, `batch.ts`) does three things:
  - polls `/live` every 2 s;
  - sends the provisional soundings with `overlay.setData`;
  - asks for at most one `overlay.refresh` of changed tiles every 30 s. Freeboard re-keys the whole source on each refresh, so it redraws every tile in view.

## Measurements

Everything below was measured on an Apple M5 Max laptop, Node 26, with a synthetic store of 1,482,873 cells: the size of the busiest vessel in the Chesapeake set, from `scripts/bench-live-layer.mjs`'s random-walk lanes. Detail is "High", the default, unless noted. A Pi is much slower per core. **The Pi factor is not yet measured;** [Numbers from a Pi](#numbers-from-a-pi) asks for it. Until then, read the times below as ratios, and expect a Pi 4 to be something like 10 to 15 times slower per core, and a Pi 5 about a third of that.

### Server: building tiles

`scripts/bench-live-layer.mjs` at full size:

| What                           |                                                       Measured |
| ------------------------------ | -------------------------------------------------------------: |
| Live writer                    |                                              4,232 soundings/s |
| Backfill writer                | 42,507 soundings/s; on its worker, the event loop held ≤ 19 ms |
| Database                       |                                         119 MB for 1.48M cells |
| Cold tile z15 / z14 / z13      |                           150 / 131 / 375 ms; 22 / 50 / 102 KB |
| Cold tile z12 / z11 / z10 / z8 |                                       271 / 266 / 253 / 214 ms |
| 20 z13 tiles on the 3 workers  |                                2.25 s, event loop held ≤ 12 ms |

The writer, the backfill and SQLite are not the problem: at one sounding a second, the live writer uses a fraction of a percent of a core, and the backfill keeps the server responsive. The cost is in building tiles.

Where a cold tile's time goes, as the median of 8 tiles, run on one thread:

| Tile | Read cells | Surface | Prepare | Trace and encode |  Total |
| ---- | ---------: | ------: | ------: | ---------------: | -----: |
| z15  |       6 ms |   83 ms |   13 ms |            31 ms | 133 ms |
| z14  |       2 ms |   77 ms |   10 ms |            44 ms | 133 ms |
| z13  |      15 ms |  231 ms |   41 ms |            55 ms | 343 ms |
| z12  |      49 ms |  151 ms |   44 ms |            27 ms | 271 ms |
| z10  |     109 ms |   35 ms |   42 ms |            47 ms | 234 ms |

A CPU profile of 25 z13 tiles puts 55% of all samples in `surface()` itself, almost all in its neighbour search. For every pixel within 200 m of a cell, it scans a square of buckets 200 m each way: at z13, 29 × 29 buckets for each of up to 92,000 pixels. Next come the blur (6%), contour stitching (3%) and isolines (3%).

Two size effects make z13 the worst tile:

- **Pixels are finer than cells away from the equator.** The raster is sized by zoom alone, as at the equator, so that neighbouring tiles share a pixel grid. At 37.5° N a z13 pixel is 15.2 m, against 20.5 m cells, so the surface has 1.8 times the pixels it needs. The factor grows toward the poles, as 1/cos² of the latitude.
- **z13 has no parent to share.** It interpolates its own 304-pixel raster with halo, the same pixel size as z14 over four times the area. Sharing surfaces from zoom 13 instead of 14 didn't help: a zoom 14 view then built 3 × 2 larger z13 surfaces. Zooming 13 → 14 → 15 went from 10.5 s to 10.9 s.

### Server: what a view costs

`scripts/bench-view.mjs` (added with this note) builds a 5 × 4 view's tiles cold at z13, then z14, then z15, on one thread, taking each zoom's tiles by the ancestor whose surface they share, as the service sends them to one worker. It times only the builds, and counts what the tiles send. These runs were on the same laptop with other work running, a load average of about 10, so they're about a tenth slower than the per-tile table above:

| View of 20 tiles | Build |   Bytes | Vertices |  DEPARE |                DEPCNT m | DEPCNT ft |  M_QUAL |
| ---------------- | ----: | ------: | -------: | ------: | ----------------------: | --------: | ------: |
| z13, High        | 7.2 s | 1.95 MB |  855,042 | 225,542 |                  76,021 |   250,467 | 301,780 |
| z14, High        | 2.7 s |  980 KB |  421,617 | 111,039 |                  40,016 |   133,416 | 136,061 |
| z15, High        | 1.5 s |  506 KB |  206,578 |  52,856 |                  20,197 |    66,638 |  66,156 |
| z13, Standard    | 6.7 s |  944 KB |  423,421 |  99,892 | 20,517 (chart isobaths) |         — | 301,780 |

On one thread, a zoom 13 view takes about 7 s to build here, and so perhaps a minute on a Pi 4, or 20 s or more spread over its three tile threads. Meanwhile all four of its cores are busy, and Signal K shares the one left. A z13 view is about 2 MB of tiles and 855,000 vertices, for a screen of about a million pixels:

- **Coverage (`M_QUAL`)** is 35% of the vertices. It only tints the water, but it's traced at full resolution, along two edges, measured and interpolated.
- **Foot contours** are 29%, even for a user who reads metres, and **metre contours** 9% for one who reads feet. High detail puts every metre and every foot in every tile, and the style picks one unit with `global-state`.
- At Standard detail, the build is barely cheaper, since the surface is the same, and coverage is 71% of the vertices.
- Every line is simplified to 1 unit of the tile's 4,096 extent, a sixteenth of a screen pixel at 256 px a tile.

### Prototypes

Each was tried on the same store and then reverted. They're listed here as evidence for the design.

| Change                                                         | Effect                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Neighbour search nearest-first, stopping at the 12th neighbour | Byte-identical tiles; z13 336 → 297 ms (−12%), z12 −7%, z10 −16%                 |
| Simplification tolerance 4 units (a quarter of a pixel)        | z13 view 855k → 553k vertices, 1.95 → 1.38 MB                                    |
| Simplification tolerance 8 units (half a pixel)                | z13 view 855k → 387k vertices (−55%), 1.95 → 1.07 MB (−45%); z15 view 207k → 76k |
| Surfaces shared from zoom 13 rather than 14                    | No gain: 10.5 → 10.9 s for the 13 → 15 zoom-in                                   |

The neighbour search spends most of its time between tracks, where fewer than 12 cells lie within 200 m and the whole radius has to be scanned, so stopping early only helps on dense water. The rest of `surface()` allocates an object per candidate neighbour and sorts per pixel; rewriting it over typed arrays is not yet measured.

### Client: Freeboard drawing the layer

Freeboard-SK 3.4.1 on signalk-server 2.33.0, with the plugin and the same store, in headless Chromium at 1280 × 800. The boat sailed at 6 kn through the soundings, a sounding a second. The CPU was throttled 6× to stand in for a Pi or tablet browser; that's a rough proxy, not a measurement on one. Each run loaded the view, then sailed for 95 s:

| View               | Tiles at load | Frames over 50 ms while sailing | Worst frame | Main thread busy | JS heap |
| ------------------ | ------------: | ------------------------------: | ----------: | ---------------: | ------: |
| z13, layer blocked |             0 |                               0 |       17 ms |               2% |   22 MB |
| z13                |    9 (823 KB) |       6, with 3 tiles refetched |      617 ms |               6% |   84 MB |
| z15                |   12 (577 KB) |       3, with 6 tiles refetched |      150 ms |               7% |   64 MB |
| z11                |    6 (622 KB) |       6, with 3 tiles refetched |      383 ms |               5% |   60 MB |

The plotter is idle between refreshes. Each refresh, every 30 s while the boat moves, freezes the map for up to 0.6 s at z13. That's because Freeboard re-keys the whole source and OpenLayers re-renders and re-declutters every tile in view, even though only a few tiles changed. The layer adds 40 to 60 MB of JS heap. Both scale with the vertices in view, so smaller tiles cut them roughly in proportion. Unthrottled, there were no frames over 50 ms.

Two smaller client costs:

- **Polling doesn't stop in a background tab.** The runtime polls `/live` every 2 s while the overlay is shown, 1,800 requests an hour, because it only listens to `overlay.state`, not to the page's visibility. Browsers throttle timers in hidden tabs, Chromium to about once a minute after five minutes, so a background tab costs less than that, but never nothing. Freeboard's own `suspended` flag marks an overlay over its budget, not a hidden tab. The runtime's `fetch` also has no timeout, and one that never settles leaves the `busy` flag set, so polling stops for good. Host calls time out after the bus's default of 10 s.
- **Provisional soundings are resent in full.** Each poll that changes them sends up to 2,000 provisional soundings with `overlay.setData`, rather than the few that came or went.

### Memory on the server

Before stage 2, which bounds the cache by bytes and finds the tile threads hold most of it ([Stage 2 results](#stage-2-results)). In the server above, resident memory rose from about 310 MB to 640 to 740 MB once tiles had been built for a few views, and fell back as macOS reclaimed pages. That's Signal K and the plugin together; the tile threads' share wasn't separated out. Three things the plugin holds grow with what's been viewed:

- **The encoded tile cache:** up to 2,000 tiles, at 100 to 140 KB each at High detail at zooms 10 to 13, and 20 to 50 KB at 14 and 15, so 200 to 280 MB if a view's worth at 10 to 13 fill it; an extrapolation from the tile sizes, not measured.
- **The surfaces each tile thread keeps:** four zoom 14 surfaces per thread, five Float64 fields of 138² each, about 0.8 MB a surface, so about 9 MB across three threads.
- **The threads' own V8 heaps.**

On a 1 GB or 2 GB Pi running Signal K and other plugins, the cache's bound is the risk.

## Upstream since the port

We adapted the tile store, plotter extension and renderer in `83ffdd9` (2026-10-16) from upstream's `d5157a2`, released as 0.3.1 in `10b0a0d` (2026-10-15). The two are the same code; only the version and changelog differ. The evidence is that `83ffdd9`'s `web/renderer.ts` has `d5157a2`'s changes word for word (`LIVE_FLUSH_MS = 300`, `baseSamples`), and none of `909a5a8`'s from 10-19. Everything upstream between `10b0a0d` and our port is docs.

Upstream has kept the client-side design we left behind, `overlays.image` with a WebGL renderer. Its server sends sparse binary tiles of 5-byte cells, from a min-pooled pyramid, z4 to z20. Its browser worker builds an IDW field and shades it with a fragment shader. It also traces contours and draws soundings on a 2D canvas, and patches the field in place from live deltas. It has no statistic, tide or QC.

Code commits since `10b0a0d`, through `08954bd` (0.3.18, 2026-11-02):

| Commit    | What                                                                                                                                                                                                                                                                    | Perf | For us                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------- |
| `909a5a8` | Caches shoal and cluster aggregation per data version. Patches the IDW field in place and re-uploads only the changed rectangle. Scales surface quality to a 10 ms frame budget. Drops the forced 2× pixel ratio.                                                       | yes  | Only with an image renderer                                                              |
| `174a7a9` | Caches the rendered surface and overlay as bitmaps, keyed on field version, box, size and settings                                                                                                                                                                      | yes  | Only with an image renderer                                                              |
| `ecbb4bd` | Reuses the output canvas, which had been a fresh 13 MB one each frame, and renders 25% past the view to crop on pan                                                                                                                                                     | yes  | Only with an image renderer                                                              |
| `95c1308` | Fetches tiles for a padded box and skips refetching and rebuilding while the view stays in it                                                                                                                                                                           | yes  | Only with an image renderer; Freeboard fetches our tiles                                 |
| `4c63f7e` | Pads by 10%, matching Freeboard's overlay margin                                                                                                                                                                                                                        | yes  | Only with an image renderer                                                              |
| `b360ec8` | Pauses timers, fetches and the frame cycle while the tab is hidden                                                                                                                                                                                                      | yes  | **Yes**: our runtime polls in a hidden tab (see above)                                   |
| `ab5cec7` | Recovers from WebGL context loss; a 4 s watchdog on a stalled worker                                                                                                                                                                                                    | no   | The watchdog idea: our runtime's `busy` flag waits forever on a fetch that never settles |
| `f1e6391` | Re-registers the plotter extension provider on every plugin start                                                                                                                                                                                                       | no   | Already so: our `provider.ts` registers on every start                                   |
| `1249930` | Offers tide-compensated depth paths as sources                                                                                                                                                                                                                          | no   | A product call; the plugin does its own tide reduction                                   |
| `184fd39` | Versions the render worker's URL against stale caches                                                                                                                                                                                                                   | no   | Marginal: our runtime is served to revalidate                                            |
| Others    | Soundings from every vessel (`248793b`); a transducer offset sign (`3a868b7`); a nearby vessel's implausible depth (`c00f606`); linear fill, vector contours, palette, clusters and settings UI (10-23/24); tiles as the only source (`c546285`); docs, CI and releases | no   | No                                                                                       |

No upstream commit touches the server's tile or store cost. Upstream's performance work all goes to keeping a client renderer cheap per frame, and going back to one would mean doing our surface, portrayal and statistic work in every plotter's browser. Only the hidden-tab pause carries over as is. We take no upstream code in this plan, so [THIRD_PARTY_NOTICES.md](../../../packages/signalk-plugin/THIRD_PARTY_NOTICES.md) stays as it is; adopting `b360ec8` would mean writing our own listener, not copying it.

## Options

**A. Send less geometry.** Simplify lines to half a screen pixel rather than a sixteenth. Trace coverage coarser, and simplify it harder: it's a tint. Zoom 15 tiles need a finer tolerance, about 2 units: they're the finest built, and a plotter stretches them at zoom 16 and in, where half a pixel at 15 becomes 2 pixels at 17.

- Measured: −55% vertices and −45% bytes from simplification alone at zoom 13, with 8 units; zoom 15, at 2 units, gains less, to be measured.
- Cuts the client's refresh stall and heap roughly in proportion, as well as the transfer and encoding.
- Cost: contours and area edges move by up to half a pixel, which needs before-and-after screenshots, including zoom 17 and 18 over stretched zoom 15 tiles.
- Effort: small.

A tile could also carry only the user's unit's contours, which would take off about another 9% (feet users) to 29% (metres). But the style's tile URL is fixed by the server, which doesn't know the viewer's unit, and the plotter bus can't change a source's URL. Two sources, one per unit, with the other unit's layers hidden by `overlay.setLayer`, would work only if Freeboard skips fetching a source none of whose layers are drawn, which isn't checked. A server-side unit setting would break two plotters in different units. So this needs a check of Freeboard first, or a Freeboard change, and isn't in stage 1. Stage 2 checked: Freeboard fetches a hidden source's tiles anyway ([Stage 2 results](#stage-2-results)).

**B. Make the surface cheaper.**

- Search nearest-first and stop early: exact, −12% at z13, measured.
- Rewrite the search over typed arrays, without a per-pixel sort: unmeasured, likely as much again.
- Size rasters by latitude, so a pixel is about a cell everywhere: at 37.5° N, 0.55 times the pixels. It needs neighbours to agree on a grid, for example by fixing the pixel size per latitude band of tiles, and keeping zoom 15 tiles cut from their parents.
- Effort: small for the first two, medium for the third.

**C. Keep built tiles.** Bound the in-memory cache by bytes, say 32 MB, rather than by count. Persist encoded tiles in SQLite beside the cells, with the same invalidation, so a restart doesn't rebuild them; plotters already share one cache. Optionally warm the tiles round the boat's position in idle time.

- Helps the cold load and memory, not the refresh after a pass.
- A persisted tile must never outlive what it was built from. Key it by tile, detail and a portrayal version bumped with any change to how tiles are drawn, and clear it with the cells. An older plugin, after a rollback, writes cells without knowing about persisted tiles, so a marker that only new builds write can't catch it. SQLite triggers can: created with the table, they fire under any build. They're needed on every table a tile is built from, `cells`, `shoals` and `overviews`, for inserts, updates and deletes, and clear the persisted tiles or bump a counter they're stamped with. The names `tiles` and `tile_meta` are taken, the first by an old table that migrations drop, so the new table needs another.
- Cost: more writes on the SD card. A pass drops one to four tiles at each zoom from 10 to 15, and zooms 4 to 9 every 5 minutes, and only tiles a plotter asks for are rebuilt and written.
- Effort: medium.

**D. Rebuild less after a pass.** Keep each zoom 14 surface between requests, and update only the pixels within the margin of the changed cells, instead of rebuilding the surface. Build zoom 13 and below by assembling and pooling zoom 14 surfaces rather than interpolating again.

- Turns the per-refresh cost from whole tiles to the pass's neighbourhood.
- Cost: surfaces in memory or on disk, under 1 MB per zoom 14 surface as Float32. Getting the pooled zoom 13 to match the interpolated one closely enough for contours needs care.
- Effort: large.

**E. Redraw less in Freeboard.**

- Pause the runtime while the tab is hidden, as upstream's `b360ec8` does.
- Send provisional soundings as upserts and removals by id.
- Upstream to Freeboard: re-key only the tiles `overlay.refresh` names, so a refresh redraws just those, not the whole layer. That ends the stall outright and would let the 30 s batching shrink. It needs a Freeboard change, outside our control.
- Effort: small for ours, medium upstream.

**F. Go back to a client renderer.** Upstream's route: the server sends cells, and each browser draws them.

- The Pi does almost nothing per tile.
- Cost: every plotter, often a tablet or the same Pi's browser, runs the interpolation, smoothing and tracing. The layer stops matching the grid's portrayal, and we'd maintain a WebGL renderer again, with upstream's `909a5a8`, `174a7a9`, `ecbb4bd`, `95c1308` and `ab5cec7` as its price.
- Not recommended.

**G. Raster areas.** Send depth areas and coverage as raster tiles, with contours and soundings still vectors. Images are cheap to draw.

- Cost: the area colours, tint and safety depth are baked in on the server, a re-render when settings change, and lose MapLibre's restyling. The contours, which are most of the label work, stay vectors.
- Effort: medium. Worth revisiting only if A falls short.

## Recommendation

Do A, B's small parts, and E's small parts first. They're local changes that need no new storage, and together they halve what a plotter draws and take an eighth to a quarter off what the Pi computes per tile. Then C, which bounds memory and makes views after a restart free. Measure on a Pi before D, which is the large one. Propose the Freeboard change in parallel. Leave F and G.

| Stage | Change                                                                                | Expected                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Simplify to half a pixel, finer at zoom 15; coarser coverage                          | Done, but coverage is simplified as lines, not traced coarser: z13 view vertices −42% and bytes −34%, z15 −17% and −13%                       |
| 1     | Early-stopping neighbour search; typed arrays in `surface()`                          | The search is done, byte-identical; typed arrays are not, and carry over to stage 2                                                           |
| 1     | Runtime: pause while hidden; timeouts on fetches and host calls; provisional upserts  | Done: no polling from background tabs; no stuck runtime                                                                                       |
| 2     | Tile cache bounded by bytes; encoded tiles persisted in SQLite, versioned             | Done: the cache is 16 MB in memory, 64 MB on disk, and a restart builds nothing. The plugin's memory is dominated by its tile threads instead |
| 2     | Contours of one unit per tile, once Freeboard's fetching of hidden sources is checked | Not done: Freeboard fetches tiles for a source whose layers are all hidden                                                                    |
| 2     | Latitude-sized rasters, if seams can be held                                          | Done below zoom 14: a zoom 13 view builds 35 to 44% faster. Zooms 14 and 15 are unchanged                                                     |
| 3     | Incremental zoom 14 surfaces, with zoom 13 and below assembled from them              | A refresh rebuilds a pass's neighbourhood, not whole tiles; to be measured on a Pi first                                                      |
| —     | Freeboard: `overlay.refresh` re-keys only the tiles it names                          | No redraw of the whole layer per refresh; refresh every few seconds instead of every 30                                                       |

Rendering changes in stage 1 and 2 come with before-and-after screenshots on real data, as any change to how tiles render does.

## Stage 1 results

Stage 1 changes four things:

- **Simplification:** contours and coverage are simplified to half a screen pixel of a 256-pixel tile, 8 units, and depth areas to an eighth, 2 units, since neighbouring bands simplify their shared edge apart and on a steep slope the gap shows as a light seam. Zoom 15 tiles take a quarter of each, never under a unit. A closed contour or polygon that would collapse, such as a loop round a small shoal or a lone pass's coverage, is kept to within a unit.
- **Neighbour search:** buckets are visited nearest first, and the search stops once none left can hold a nearer cell than the 12th found. With the old simplification, the hashes of 348 tiles, zooms 10 to 15 at both details on both stores below, matched those built before it, and a test checks it against a full search.
- **Runtime:** it polls only while the overlay is drawn and the tab is showing, gives up a fetch after 10 s, and sends provisional soundings as upserts and removals by id, in full when it starts polling and with each tile refresh.
- **Encoding:** a polygon whose outer ring collapses takes its holes with it.

`scripts/bench-view.mjs`, before and after, on the same laptop. "Synthetic" is the 1.48M-cell store above; "real" is 300,212 cells folded by the plugin's backfill writer from one vessel's 5.2M NOAA CSB soundings in the Chesapeake, 2025 to 2026, viewed where it has the most cells:

| View of 20 tiles        |           Vertices |                   Bytes |
| ----------------------- | -----------------: | ----------------------: |
| Synthetic z13           | 853k → 494k (−42%) | 1,944 → 1,274 KB (−34%) |
| Synthetic z14           | 435k → 224k (−49%) |   1,010 → 629 KB (−38%) |
| Synthetic z15           | 254k → 211k (−17%) |     610 → 533 KB (−13%) |
| Synthetic z13, Standard | 416k → 223k (−46%) |     928 → 570 KB (−39%) |
| Real z13                | 273k → 148k (−46%) |     639 → 402 KB (−37%) |
| Real z14                | 253k → 128k (−49%) |     617 → 380 KB (−38%) |
| Real z15                | 215k → 177k (−18%) |     552 → 479 KB (−13%) |

Build times, the median of three runs, main and stage 1 interleaved under the same load, a load average of 6 to 7 with another job running:

| View of 20 tiles, one thread | Synthetic           | Real                |
| ---------------------------- | ------------------- | ------------------- |
| z13                          | 6.9 → 5.0 s (−28%)  | 5.4 → 2.0 s (−64%)  |
| z14                          | 2.7 → 1.9 s (−28%)  | 4.3 → 1.4 s (−68%)  |
| z15                          | 1.6 → 1.2 s (−22%)  | 2.6 → 1.1 s (−57%)  |
| Zoomed in from 13 to 15      | 11.2 → 8.1 s (−28%) | 12.4 → 4.5 s (−64%) |

The real store gains far more than the synthetic one. A boat sounding once a second leaves dense tracks, where the search stops early almost everywhere; the synthetic lanes are sounded every 10 s.

The vertex cut is less than the prototype's −55% because depth areas, a third of the vertices, are simplified a quarter as far, and collapsing loops are kept. Zoom 15 gains least, at a quarter of the tolerance.

## Stage 2 results

Stage 2 changes two things, and checks a third:

- **Kept tiles.** Encoded tiles are kept in the plugin's database (`kept.ts`), and memory holds the most recently used, up to 16 MB, rather than up to 2,000 tiles. On disk they're bounded at 64 MB, counting 256 bytes for each row besides its tile, so empty tiles count too, the oldest built going first. Before a tile is built, it's reserved with the boxes of cells it's built from, its ancestor's for a zoom 15 tile, one box per 1° band. Triggers on `cells`, `overviews` and `shoals`, made with the tables when the layer starts, drop every kept tile under a row that's inserted, updated or deleted. An overview block reaches 2^level cells past the cell it holds. They fire on any connection and under any build, so a backfill's writes and an older plugin's after a rollback drop tiles too. A build that read the cells before a write finds its reservation gone, and isn't kept. While a backfill writes, tiles aren't reserved or kept at all, since that takes the write lock, which the backfill's transactions hold, on the server's thread. Nor is a tile changed in the last 10 minutes: underway, the tiles round the boat change with every 10-second flush, and keeping each would only wear the SD card. An overview block is written only when it changes, since a backfill ends by writing every block again, and each unchanged write would drop the tiles round it. The tables and triggers are made all or none, outside the migrations: a database that can't hold them, such as one whose SQLite lacks R*Tree, runs the layer without kept tiles. Tiles drawn by other code, hashed from the tile modules, `definitions.json` and the installed versions of the plugin's dependencies, are dropped when the layer starts.
- **Latitude-sized rasters below zoom 14.** A pixel is about a cell at the tile's latitude, in steps of 16 pixels, so at 37.5° N a zoom 13 tile interpolates 192² pixels rather than 256². Zooms 14 and 15 stay as they were. With them sized by latitude too, a zoom 15 tile at 37.5° N is 48 pixels, not 64, and stretched to zoom 17 and 18, small shoals drew visibly larger and blockier. Below zoom 13 a tile is 256 pixels anyway, short of about 58° N.
- **Contours of one unit per tile: not done.** Freeboard-SK 3.4.1 draws an `overlays.data` overlay with its own component, one OpenLayers layer per run of style layers on a source. It styles them with ol-mapbox-style's `stylefunction`, but not through `apply`, whose `manageVisibility` hides an OpenLayers layer none of whose layers is visible. `overlay.setLayer` with `visibility: none` only skips the features when drawing; the layer stays visible and its tiles load. A `global-state` filter that comes out false also still fetches. Two overlays, one per unit, would work, since a hidden overlay fetches nothing, but each is a toggle the user sees. The extension can learn the unit from the host's `units.get`.

Seams where the raster size steps were measured with contours crossing the edge between two tiles, north over south, at 39.64° N, where a zoom 13 tile steps from 176 to 192 pixels. Over a synthetic slope, metre contours met within 0.12 pixels at the median and 0.82 at most, against 0.11 and 1.16 on main for the same edge, and 0.06 and 0.28 between two tiles of one size. In the real store, a lone track crosses that edge without a break.

`scripts/bench-view.mjs`, main and stage 2 interleaved, medians of three, on the laptop at a load average of 3 to 5. Zoom 14 and 15 tiles hashed the same as main's:

| View of 20 tiles, one thread | Synthetic              | Real                 |
| ---------------------------- | ---------------------- | -------------------- |
| z13 build                    | 4.70 → 2.62 s (−44%)   | 1.84 → 1.19 s (−35%) |
| z13 vertices                 | 494k → 457k (−7%)      | 148k → 146k (−1%)    |
| z13 bytes                    | 1,274 → 1,204 KB (−5%) | 402 → 402 KB         |
| z14, z15                     | unchanged              | unchanged            |

The real store gains less than the synthetic one; 11 of its view's 20 tiles have no soundings.

`scripts/bench-cache.mjs` (added with stage 2) pans a 5 × 4 view over a 3 × 3 grid of positions at each zoom from 10 to 15, 1,080 tiles, on the three tile threads, then restarts the service and asks for the middle view at zooms 13 to 15:

| What                                    | Synthetic, main → stage 2 | Real, main → stage 2  |
| --------------------------------------- | ------------------------- | --------------------- |
| Buffers in memory, mostly encoded tiles | 31 → 18 MB                | 5 → 5 MB              |
| Kept on disk                            | 29 MB                     | 4 MB                  |
| Process resident memory, at the end     | 946 → 931 MB              | 818 → 808 MB          |
| z13 view after a restart                | 1.90 s → 0 s              | 0.74 s → 0 s          |
| z14 and z15 views after a restart       | 0.73 and 0.45 s → 0 s     | 0.53 and 0.47 s → 0 s |

So the cache is bounded, and a restart builds nothing it has built before, but for tiles under soundings the restart's backfill finds, and round overview blocks whose cells tie for shoalest: the live writer keeps the latest of them, and the backfill's closing rebuild the first. But it was never most of the plugin's memory. Resident memory rose from 89 MB to 800 to 950 MB within the first 180 tiles, with the main thread's heap at 10 MB: it's the tile threads. Their V8 heaps grow toward the laptop's default limit before collecting the cells and rasters each build allocates. Capping each thread's old generation at 64 or 128 MB with `resourceLimits` brought the synthetic run to about 400 MB, with builds about 18% slower and no thread running out. That's not in this stage: the limit a large tile needs isn't measured, and V8 sizes its default by the machine's memory, so the Pi's own figure came first: see [Stage 2 on the Pi](#stage-2-on-the-pi).

With triggers on them, SQLite deletes a table's rows one at a time rather than at once, so a rebuild's clearing of the synthetic store's cells took 10.6 s, against 1.1 s without. The plugin's `clear()` drops the triggers for the moment, in its transaction, and takes 0.45 s; an older build after a rollback pays the full cost.

An R*Tree indexes nothing but its id, so each box's tile is in a table of its own, indexed by tile: dropping a tile finds its boxes by id rather than reading them all. With 14,269 tiles kept past the bound, 1 in 10 of 40 KB, keeping a tile took at most 19 ms, eviction included, and a pass of 60 cells dropping 36 kept tiles took 4 ms.

The triggers cost the backfill. `bench-live-layer.mjs 400000`, two runs each, with nothing kept, main → stage 2: the live writer 5,908 and 6,071 → 5,827 and 5,741 soundings/s (−1 to −5%); the backfill writer 44,253 and 45,518 → 36,534 and 36,460 (−17 to −20%); and filling the store on its worker 26,884 and 27,359 → 20,875 and 24,767 (−9 to −22%). Cold tiles were unchanged but for zoom 13, 221 → 140 ms, and 20 z13 tiles on the three threads, 1.1 → 0.57 s.

Screenshots of zoom 13 on the real store show the change. An unconfirmed shoal's cap reaches a fixed number of pixels, so with pixels about a cell rather than three quarters of one, the rings round shoals draw larger, as they already did near the equator. In the view of 20 tiles, shoals add 61 small closed metre contours, against 29 on main.

## Denser soundings zoomed in

Plotters stretch zoom 15 tiles past zoom 15. With 8 soundings a side, Freeboard-SK's zoom 18 drew them 256 px apart, further where a lone track crossed few of the lattice's squares. Zoom 15 tiles carry 16 a side, 128 px apart at zoom 18, listed shoalest first, since Freeboard-SK and MapLibre both keep the first of the labels that collide within a tile; Freeboard-SK refuses a layer with `symbol-sort-key`, so the order in the tile is what keeps the shoalest. Soundings take 8 px of padding at the style's zoom 15 (Freeboard-SK's 16) and 5 px at 16, against the default 2 px below 15 and from 17, so a zoom 15 view isn't crowded. Below zoom 15 the live layer has the grid overlay's 8 a side.

`scripts/bench-view.mjs`, main and this change interleaved, three runs at a load average of 6 to 9, on the real store, at its busiest block and at a channel with a few tracks (−76.33546, 36.96009). Only zoom 15 tiles change:

| View of 20 z15 tiles, one thread | Busiest block       | Channel            |
| -------------------------------- | ------------------- | ------------------ |
| Soundings                        | 763 → 2,621         | 170 → 417          |
| Bytes                            | 479 → 544 KB (+14%) | 108 → 116 KB (+7%) |
| Build, median                    | 1.30 → 1.20 s       | 0.48 → 0.48 s      |

32 soundings a side drew them 64 px apart at zoom 18, but cost 730 KB (+52%) and 130 KB (+20%), with 8,277 soundings in the busy view for the plotter to place. The bytes and build time on a Pi aren't measured yet; [Numbers from a Pi](#numbers-from-a-pi) has the commands.

## Numbers from a Pi

The figures above are from a fast laptop. To size the plan on the hardware that matters, run these on a Pi whose plugin is a build with the live layer, which no release has yet: a [preview](../../../CONTRIBUTING.md#plugin-previews) from `main` or later, with its backfill finished. The published plugin has no scripts, so they need a checkout of this repository on the Pi, with the plugin's dependencies installed and the plugin built. Installing only the plugin's workspace skips the API's dev tools, which have no 32-bit ARM builds:

```bash
git clone https://github.com/openwatersio/crowd-depth.git && cd crowd-depth && npm ci -w crowd-depth --include-workspace-root && npm run build -w crowd-depth
```

Then, from `packages/signalk-plugin`, the synthetic store, and a view of the boat's own soundings, centred where it has the most cells, or at a `lon lat` given after the path. The second opens the plugin's database, in the plugin's data directory, usually the one below, read-only, so the server can keep running:

```bash
node scripts/bench-live-layer.mjs 400000
```

```bash
node scripts/bench-view.mjs ~/.signalk/plugin-config-data/crowd-depth/bathymetry.sqlite
```

And what the cache holds and costs as a plotter pans, and a restart, on a copy of the database, which this one writes to:

```bash
rm -f /tmp/bench-copy.sqlite && node -e 'new (require("node:sqlite").DatabaseSync)(process.argv[1],{readOnly:true}).prepare("VACUUM INTO ?").run(process.argv[2])' ~/.signalk/plugin-config-data/crowd-depth/bathymetry.sqlite /tmp/bench-copy.sqlite && node --expose-gc scripts/bench-cache.mjs /tmp/bench-copy.sqlite
```

Along with the Pi's model and memory, these give the factor this note assumes, and a view's cost on the boat's own soundings.

### First Pi run

The boat's own Pi, a Raspberry Pi 5 with 8 GB, on the stage 1 build. Its tile sizes match the laptop's stage 1 build to the tenth of a KB, so the two are compared directly. The laptop ran at a load average of 6 to 9 with other work.

`bench-live-layer.mjs 400000`, a store of 431,666 cells:

| What                           |                Pi |             Laptop |              Pi factor |
| ------------------------------ | ----------------: | -----------------: | ---------------------: |
| Live writer                    | 1,376 soundings/s |  5,633 soundings/s |                   4.1× |
| Backfill writer                | 5,955 soundings/s | 43,517 soundings/s |                   7.3× |
| Filling the store              | 2,776 soundings/s | 23,864 soundings/s |                   8.6× |
| Cold tiles, z15 to z6          |      442–1,255 ms |          86–267 ms | 4.5× to 5.7×, about 5× |
| 20 z13 tiles on 3 tile threads |             8.8 s |              1.3 s |                   6.6× |

The event loop was held at most 91 ms while the store filled, and 29 ms while the 20 tiles were built.

So a Pi core builds tiles about 5 times slower than the laptop's, not 10 to 15 times as the estimates above assumed; that's a Pi 5's figure more than a Pi 4's. Writing to its storage costs more, 7 to 9 times. A zoom 13 view's worth of tiles takes about 9 s on the three tile threads.

`bench-view.mjs` on the boat's own store, 373,011 cells, centred where it has the most: most of the view is unsounded, so it's light on geometry, though not on time.

| View of 20 tiles | Tiles with soundings | Build, one thread | Bytes | Vertices |
| ---------------- | -------------------: | ----------------: | ----: | -------: |
| z13              |                    6 |             4.3 s | 30 KB |    8,176 |
| z14              |                   10 |             3.2 s | 31 KB |    7,995 |
| z15              |                   12 |             2.1 s | 55 KB |   17,566 |
| 13 → 15          |                      |             9.6 s |       |          |

Stage 1's gain on the Pi is inferred from the laptop's: `main` before it wasn't measured there.

### Stage 2 on the Pi

The same Pi, running its Signal K server alongside at a load average of 1 to 4, with `main` and stage 2 interleaved. Node 24.18.

`bench-live-layer.mjs 400000`, two runs each, main → stage 2:

| What                           |                        Main |                     Stage 2 |
| ------------------------------ | --------------------------: | --------------------------: |
| Live writer                    | 1,390 and 1,359 soundings/s | 1,357 and 1,268 soundings/s |
| Backfill writer                | 4,521 and 5,531 soundings/s | 4,811 and 5,053 soundings/s |
| Filling the store              | 2,838 and 2,822 soundings/s | 2,786 and 2,787 soundings/s |
| Cold z13 tile                  |          1,241 and 1,235 ms |              757 and 786 ms |
| 20 z13 tiles on 3 tile threads |               8.5 and 9.7 s |               5.1 and 5.7 s |

On the Pi the triggers cost the writers little: filling the store is 1 to 2% slower, the live writer 2 to 7%, and the backfill writer's runs overlap. Writing to the SD card, not the triggers, is most of a write's cost there. A zoom 13 view's worth of tiles takes about 5.4 s on the three tile threads, not 9. Other zooms' cold tiles were within 15% either way, run to run.

`bench-view.mjs` on the boat's own store, 373,026 cells, medians of three:

| View of 20 tiles |    Build, one thread |      Bytes |             Vertices |
| ---------------- | -------------------: | ---------: | -------------------: |
| z13              | 4.47 → 3.65 s (−18%) | 30 → 28 KB | 8,176 → 7,294 (−11%) |
| z14              |        2.61 → 2.91 s |      31 KB |                7,995 |
| z15              |        2.25 → 2.44 s |      55 KB |               17,566 |
| 13 → 15          |          9.5 → 8.9 s |            |                      |

Zoom 14 and 15 tiles are the same as main's, byte for byte, but built 8 to 12% slower at the median: 2.54 to 2.93 s against 2.58 to 2.82 at zoom 14, and 2.35 to 2.53 against 2.25 to 2.32 at zoom 15. Nothing they run changed; the laptop showed no difference.

`bench-cache.mjs` on a copy of the boat's store, one run each:

| What                                |            Main |                 Stage 2 |
| ----------------------------------- | --------------: | ----------------------: |
| Panning 1,080 tiles, zooms 10 to 15 |          41.2 s |                  42.3 s |
| Kept on disk                        |                 | 1,080 tiles, under 1 MB |
| Process resident memory, at the end |          490 MB |                  524 MB |
| z13 view after a restart            |          3.50 s |                     0 s |
| z14 and z15 views after a restart   | 3.00 and 2.01 s |                     0 s |

Most of the walk is unsounded, so the tiles kept are mostly empty. Resident memory rose from 78 MB to about 380 MB with the first 180 tiles, and to about 500 MB by the end, with the main thread's heap at 10 MB: the tile threads again, though at half the laptop's 800 to 950 MB, since V8 sizes its heaps by the machine. Within 8 GB that's room enough, so stage 2 leaves the threads' heaps unlimited. A 1 or 2 GB Pi, where V8 would size them smaller still, hasn't been measured.
