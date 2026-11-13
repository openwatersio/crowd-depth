# Live layer performance

The "My soundings" layer ([live-layer.md](live-layer.md)) is slow to fill a view and heavy for a Raspberry Pi and the plotter that draws it. Most of the cost is two things. The plugin rebuilds each tile's depth surface from the cells every time the tile is asked for, and the zoom-13 to 15 tiles it sends carry far more geometry than a screen can show. This note measures both, reviews what upstream signalk-livedepth-plugin has done since we adapted it, and proposes a staged plan. The measurements describe the layer before stage 1; [Stage 1 results](#stage-1-results), [Stage 2 results](#stage-2-results) and [Stage 3 results](#stage-3-results) measure what each changed, [Live and instant](#live-and-instant) designs stages 4 and 5, and [Stage 4 and 5 results](#stage-4-and-5-results) measures them.

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

The neighbour search spends most of its time between tracks, where fewer than 12 cells lie within 200 m and the whole radius has to be scanned, so stopping early only helps on dense water. The rest of `surface()` allocated an object per candidate neighbour and sorted per pixel; [stage 3](#stage-3-results) rewrites it over typed arrays.

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
- Rewrite the search over typed arrays, without a per-pixel sort: done in stage 3, with the rest of the surface worked only where soundings reach.
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

| Stage | Change                                                                                | Expected                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | Simplify to half a pixel, finer at zoom 15; coarser coverage                          | Done, but coverage is simplified as lines, not traced coarser: z13 view vertices −42% and bytes −34%, z15 −17% and −13%                          |
| 1     | Early-stopping neighbour search; typed arrays in `surface()`                          | The search is done, byte-identical; typed arrays are in stage 3                                                                                  |
| 1     | Runtime: pause while hidden; timeouts on fetches and host calls; provisional upserts  | Done: no polling from background tabs; no stuck runtime                                                                                          |
| 2     | Tile cache bounded by bytes; encoded tiles persisted in SQLite, versioned             | Done: the cache is 16 MB in memory, 64 MB on disk, and a restart builds nothing. The plugin's memory is dominated by its tile threads instead    |
| 2     | Contours of one unit per tile, once Freeboard's fetching of hidden sources is checked | Not done: Freeboard fetches tiles for a source whose layers are all hidden                                                                       |
| 2     | Latitude-sized rasters, if seams can be held                                          | Done below zoom 14: a zoom 13 view builds 35 to 44% faster. Zooms 14 and 15 are unchanged                                                        |
| 3     | Typed arrays in `surface()`; the surface worked only where soundings reach            | Done, byte-identical: the boat's view on its Pi 8.0 → 4.6 s for the zoom 13 to 15 walk. What follows is in [Live and instant](#live-and-instant) |

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

- **Kept tiles.** Encoded tiles are kept in the plugin's database (`kept.ts`), and memory holds the most recently used, up to 16 MB, rather than up to 2,000 tiles. On disk they're bounded at 64 MB, counting 256 bytes for each row besides its tile, so empty tiles count too, the oldest built going first. Before a tile is built, it's reserved with the boxes of cells it's built from, its ancestor's for a zoom 15 tile, one box per 1° band. Triggers on `cells`, `overviews` and `shoals`, made with the tables when the layer starts, drop every kept tile under a row that's inserted, updated or deleted. An overview block reaches 2^level cells past the cell it holds. They fire on any connection and under any build, so a backfill's writes and an older plugin's after a rollback drop tiles too. A build that read the cells before a write finds its reservation gone, and isn't kept. While a backfill writes, tiles aren't reserved or kept at all, since that takes the write lock, which the backfill's transactions hold, on the server's thread. Nor is a tile changed in the last 10 minutes: underway, the tiles round the boat change with every flush, and keeping each would only wear the SD card. An overview block is written only when it changes, since a backfill ends by writing every block again, and each unchanged write would drop the tiles round it. The tables and triggers are made all or none, outside the migrations: a database that can't hold them, such as one whose SQLite lacks R*Tree, runs the layer without kept tiles. Tiles drawn by other code, hashed from the tile modules, `definitions.json` and the installed versions of the plugin's dependencies, are dropped when the layer starts.
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

## Stage 3 results

A CPU profile of the boat's own view on its Pi, on `main` after stage 2, put a third of the time in `prepare` and a quarter in `surface()`, but little of it in the neighbour search, 9%. The rest went to passes over every pixel of the raster: the blurs, `soften`, `carry`, the 3 × 3 shoal caps, upsampling and slopes. A zoom 13 tile with 46 cells took about as long as one with 1,658, 92 and 112 ms on the laptop, so the time was the raster's, not the soundings'. Most of a raster on the boat's store is empty water: on its view, the soundings and what they reach cover 1% to 100% of a tile's raster, 40% on average.

Stage 3 changes how the surface is worked, not what it draws:

- **Only where soundings reach.** `prepare` works its fields over the box the surface's depths and shoals reach, plus `REACH_PX`: the depth blur's reach, the carry's passes, and the bicubic's and a slope's past them, 15 pixels. Past it every field is what it is far from any depth, and is filled. `cut` upsamples and takes slopes only over that box's samples. The surface's caps beside shoals are worked only beside a depth or a shoal.
- **No empty windows.** The blurs skip a window none of whose weights is set, which sums to 0 either way, and the coverage's normalising weight is worked only where some pixel is valid.
- **Typed arrays.** The neighbour search keeps its neighbours in typed arrays, without an object per candidate, and `soften`, `carry` and the growth of the masks run as plain loops. A carry stops once a pass carries nothing.

Tiles are byte-identical: 528 tiles, zooms 10 to 15 at both details over the boat's, the real and the synthetic stores, hashed the same as `main`'s on the laptop and on the Pi. A test checks that the windowed fields equal those worked over the whole raster, and that tiles cut from them encode the same; it fails with the window 6 pixels short.

Two things were tried and left out:

- **Searching only pixels that can be interpolated.** A pixel between tracks takes a depth only with a cell in each quadrant, and a count of cells in each quadrant's box, from a summed table, says when one is empty, so such a pixel needs only its nearest cell. On the Pi it gained nothing, 4.6 → 4.7 s for the boat's view, so it isn't kept.
- **Latitude-sized rasters at zooms 14 and 15.** At the boat's 23.5° N they'd drop the rasters from 128 to 112 pixels a side, 23% of their pixels and about a tenth of a view, and stage 2's objection, shoals drawn blockier where zoom 15 tiles are stretched, is the pixel size itself. Not taken.

`scripts/bench-view.mjs` on the boat's Pi, a Raspberry Pi 5 with 8 GB, on a copy of its own store, 373,164 cells, `main` and stage 3 interleaved, three runs each, at a load average of 2:

| View of 20 tiles, one thread | Main        | Stage 3     |
| ---------------------------- | ----------- | ----------- |
| z13                          | 3.19–3.50 s | 1.64–1.72 s |
| z14                          | 2.38–2.73 s | 1.40–1.53 s |
| z15                          | 2.07–2.22 s | 1.47–1.58 s |
| 13 → 15                      | 7.9–8.1 s   | 4.6–4.8 s   |

On the laptop, the same walk on each store, medians of three: the boat's 1.9 → 1.0 s (−47%), the real one 4.1 → 3.2 s (−20%) and the synthetic one 6.9 → 6.3 s (−9%). Dense water gains least: its time is the neighbour search, which stage 3 makes no shorter.

### What the boat feels

Measured on the Pi itself: a second Signal K server, 2.33.0 with Freeboard-SK 3.4.1 and `signalk-tides`, on a copy of the boat's store and its plugin settings, beside the boat's own server, with the boat's position set where it has the most cells. Headless Chromium on the laptop drew Freeboard from it at 1280 × 800 with the CPU throttled 6×, through an SSH tunnel on the local network. Each run started the server on a fresh copy, so nothing was built before. Two runs each, `main` → stage 3:

| What                                                  | Main           | Stage 3     |
| ----------------------------------------------------- | -------------- | ----------- |
| Cold view at map zoom 13, until its last tile         | 2.5–2.7 s      | 1.9–2.1 s   |
| Zoom 13 → 14, until its last tile                     | 2.0 s          | 1.3 s       |
| Zoom 14 → 15                                          | 2.1–2.3 s      | 1.4–1.7 s   |
| Sailing at 6 kn, map zoom 13: a refresh's tile, built | 0.57–0.69 s    | 0.35–0.51 s |
| Sailing: frames over 50 ms; worst frame               | none; 17–33 ms | none; 17 ms |

Freeboard asks for tiles a zoom below the map's, 512 pixels a side, so a view at map zoom 13 is 12 zoom 12 tiles. The cold view's time includes Freeboard starting up under the throttle.

On the boat's store, Freeboard doesn't freeze on a refresh: a view holds 9 to 25 KB of tiles, against 0.6 to 0.8 MB on the synthetic store, where [stage 1](#client-freeboard-drawing-the-layer) measured a 0.6 s freeze. What a sounding waits for is the batching:

- **As a provisional sounding:** the next poll of `/live`, within 2 s.
- **In the surface:** the writer's flush, every 10 s; then the runtime's batch, one refresh per 30 s; then the next poll, and the tile's build, 0.4 s. So up to 42 s, about 20 s on average.

With the batch at 5 s rather than 30, in a build made for the test, the boat sailing at map zoom 13 and 15 refreshed 10 times in 95 s, as often as the writer flushed, each a tile built in 0.24 to 0.42 s, with no frame over 17 ms. A sounding reached the surface within 17 s, about 10 s on average, at under 5% of a core on the Pi.

Building ahead costs little on this store: every tile with a cell under it, zooms 4 to 15, is 13,313 tiles and 29 MB at High detail, built in 23.4 min on one of the Pi's threads, about 105 ms a tile. Zoom 15 is half the tiles and half the time.

## Live and instant

Two targets, which the stages so far haven't met:

1. **Live.** Under way, the surface under the boat redraws every few seconds as it moves, without freezing the map.
2. **Instant.** Panning and zooming draw tiles already built, as any other chart's do, not after seconds of interpolation.

### Instant: build tiles ahead

Build every tile with a cell under it, at every zoom, in the background, nearest the boat first, and keep them, so a plotter's request is read from disk. On the boat's store that's 13,313 tiles and 29 MB, about 8 min from nothing if the three tile threads share it evenly, which wasn't measured. A restart already builds nothing (stage 2).

- **Queue.** Tiles to build, nearest the boat first, zoom 13 and out before zooms 14 and 15, which plotters ask for only closer in. A plotter's request jumps the queue. The builder runs on the tile threads only when no request waits, and yields to them.
- **Invalidation.** Already there: the triggers on `cells`, `overviews` and `shoals` drop every kept tile under a changed row (stage 2). The builder queues what they drop.
- **Changed tiles under way.** Stage 2 doesn't keep a tile changed in the last 10 minutes, to spare the SD card from a rewrite every flush. Rebuilt ahead, such tiles stay in memory, and are kept once they settle.
- **Bound.** The kept bound is 64 MB, twice this store's every tile. A busier store holds more, not measured here; past the bound, the oldest-built go first, as now, and the builder skips what it would only evict.
- **Cost.** A flush drops 1 to 4 tiles at each of zooms 10 to 15 round the boat, and zooms 4 to 9 every 5 minutes: 6 to 24 tiles, about 0.6 to 2.5 s of a thread every 10 s under way.

### Live: refresh every few seconds

What holds the surface back is the 30 s batch, which exists because Freeboard redraws the whole layer on any refresh (option E). Its cost scales with what's drawn: none on the boat's store today, 0.6 s on a dense store at map zoom 13.

- **Shorter batch.** A batch of 5 s puts a sounding into the surface within about 10 s of the writer's flush, at under 5% of a core on the Pi, and no freeze on the boat's store. On a dense store it would freeze the map for 0.6 s every 10 s until Freeboard changes.
- **Freeboard re-keying only the named tiles.** Freeboard-SK 3.4.1 already invalidates just the tiles `overlay.refresh` names, in its tile fetcher, and counts each tile's revisions (`fb-data-overlay`'s `onRefresh`). Then `applyRekeys` sets a new key on the whole OpenLayers source, which re-parses, restyles and declutters every tile in view. With a list of tiles, it could reload those tiles alone, and keep the source's key. Drafted below.
- **The pass, drawn at once.** Provisional soundings are drawn within 2 s as points. Drawn as a ribbon, a line along the pass styled by its depth band, as wide as the cells, the boat would see the surface's colour under it at once, and the tiles would replace it as they refresh. It's a GeoJSON source the runtime already sends, so it costs the Pi nothing, and the plotter a line of the last few minutes' points.
- **Incremental surfaces (option D).** A refresh costs a tile built in 0.24 to 0.51 s here, once every 10 s. Patching a kept zoom 14 surface would cut that to the pass's neighbourhood, but at these numbers it buys little for its size. Leave it unless a dense store's refresh builds prove too slow.

### Recommendation

| Stage | Change                                                                               | Target                                                                   |
| ----- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 3     | The surface worked only where soundings reach; typed arrays                          | Done: a view 40 to 50% faster on the boat's Pi, byte-identical           |
| 4     | Tiles built ahead in the background, nearest the boat first, at every zoom, and kept | Done: pan and zoom read built tiles, 11 to 39 ms a tile on the boat's Pi |
| 5     | The batch at 5 s, chosen by the view                                                 | Done: the surface in 27 s                                                |
| 6     | A live preview of the surface round the boat, sent with each poll as GeoJSON         | Done: the surface within 1.1–1.4 s at the median, for 2–3% of a core     |
| —     | Freeboard: `overlay.refresh` with tiles reloads those tiles alone                    | No freeze on dense stores at a 5 s batch                                 |
| Later | Incremental zoom 14 surfaces (option D)                                              | Only if refresh builds on dense stores prove too slow                    |

Stage 5's batch could go to 5 s at once on stores as light as the boat's. The coordinator chose not to wait for the Freeboard change: the batch goes to 5 s where the view is light, and the plugin chooses it by how much the view holds, so a dense store isn't frozen for 0.6 s every 10 s until Freeboard can reload just the tiles it names.

### Freeboard-SK issue, drafted

> **`overlay.refresh` with `tiles` redraws the whole overlay**
>
> A plotter extension's `overlays.data` overlay asks for changed tiles with `overlay.refresh({ source, tiles })`. Freeboard-SK 3.4.1 invalidates just those tiles in the overlay's tile fetcher (`onRefresh` in `fb-data-overlay`), which is right. But it then re-keys the whole OpenLayers source in `applyRekeys`, so OpenLayers reloads, re-parses, restyles and re-declutters every tile in view, though only the named ones changed.
>
> With a few hundred kilobytes of vector tiles in view, at a 6× CPU throttle standing in for a tablet, that's a 0.6 s freeze of the map per refresh. Our extension (the Crowd Depth plugin's "My soundings" layer) batches refreshes to one every 30 s because of it, while the boat's soundings change the tiles round it every 10 s.
>
> Could `overlay.refresh` with `tiles` reload only those tiles, and keep the source's key, re-keying the whole source only when `tiles` is left out? The fetcher's per-tile invalidation and revisions are already there; what's needed is to drop the named tiles from the OpenLayers source's tile cache and redraw, rather than changing the source's key. We're glad to test a build against our overlay, and can send a PR if that approach suits you.

## Stage 4 and 5 results

Stage 4 builds tiles ahead:

- **What's built.** Every tile within the surface's margin of a cell, at zooms 4 to 15, found from the overview blocks of 16 cells: 26,838 tiles on the boat's store, of which 13,313 have a cell under them. A tile kept already isn't built again.
- **Order.** Nearest the boat first, by the distance to a tile's edge; zoom 13 and out before 14 and 15; a zoom 15 tile beside its zoom 14 ancestor, on the thread that keeps that ancestor's surface. The queue is ordered when it's filled and when the boat has moved 500 m; tiles a change brings go to its front.
- **Threads.** A tile is built ahead only on a tile thread with no request waiting, and a request below zoom 14 takes an idle thread first, so a plotter waits on one tile built ahead at most.
- **Changes.** Besides the tiles a flush changes, the triggers drop kept tiles that didn't change: zoom 15 tiles cut from a changed ancestor's surface, and any within two overview blocks, about 4 km, of a changed cell. All of them are held off the disk for 10 minutes. Those gone that are in the view of a plotter, as it reported with a poll of `/live` in the last 30 s, at the zoom it draws, are built again into memory, so its refresh reads a built tile; the rest wait to be asked for or to settle. A host that reports no view gets no tiles built ahead under way. Each minute, tiles quiet for 10 minutes are built again and kept. A backfill pauses the builder, and its end queues everything again.
- **Bound.** Built ahead, tiles fill the kept bound to three quarters, 48 MB, and the builder skips what's left: past it, each would only push out one kept before it. The rest is built when it's asked for.

Stage 5 refreshes faster:

- **The batch, by the view.** The runtime sends the host's `map.view`, with each poll of `/live`. The plugin weighs the tiles in view at the zoom a plotter draws, a zoom below the map's in 512-pixel tiles, in memory, kept, or as last built while they're rebuilt. It answers with a batch from 5 s to 30 s, 37.5 ms per KB: Freeboard's freeze, about 0.75 ms per KB of tiles in view at a 6× throttle, is then 2% of the time. Without a view, as on a host without `map`, the runtime keeps 30 s.
- **The pass, drawn at once.** Stage 6's [live preview](#stage-6-results-the-live-preview) draws the surface along the pass within about 1.5 s, until its tiles land.

Tiles are byte-identical: 16,211 tiles kept by the builder on the boat's store match a fresh build, and 528 tiles, zooms 10 to 15 at both details over the boat's, the real and the synthetic stores, hash the same as `main`'s. `scripts/bench-view.mjs` gives the same bytes and vertices on each, and build times within run-to-run noise.

### On the boat's Pi

The boat's Raspberry Pi 5 with 8 GB, its own Signal K server running beside, a bench server on a copy of the boat's store, Freeboard-SK 3.4.1 in headless Chromium on the laptop at 1280 × 800 and a 6× CPU throttle, over the local network, as in [What the boat feels](#what-the-boat-feels). Two runs each but where noted.

Building ahead from nothing kept took 1,073 s, about 18 minutes, for 26,838 tiles and 30 MB, at about 2.5 of the Pi's 4 cores. Resident memory held at 1.0 to 1.1 GB throughout, against about 500 MB after stage 2's walk of 1,080 tiles: with three tile threads kept busy, their V8 heaps grow to V8's own limit. Meanwhile a pan's tiles took 131 to 175 ms at the median, against 17 ms on `main`, as a request can wait behind a tile built ahead; the worst pan's last tile took 0.8 to 1.3 s, against 0.7 to 0.9 s.

Once built, from a copy of the store with its tiles kept:

| What                                                  | `main`                     | Stages 4 and 5           |
| ----------------------------------------------------- | -------------------------- | ------------------------ |
| Cold view at map zoom 13: median tile, last tile      | 550–720 ms; 1.9 s          | 29–39 ms; 1.3–1.4 s      |
| Zoom 13 → 14                                          | 360–570 ms; 1.2–1.4 s      | 15–18 ms; 0.9–1.0 s      |
| Zoom 14 → 15                                          | 420–510 ms; 1.4–1.6 s      | 12–15 ms; 0.66–0.68 s    |
| 8 pans at map zoom 13: median, 90th pct, slowest tile | 17–18, 272–334, 368–411 ms | 12, 16–19, 24–30 ms      |
| 8 pans at map zoom 15                                 | 17, 184–192, 243–286 ms    | 11–14, 23–33, 155–159 ms |
| Frames over 50 ms, panning                            | none                       | none                     |

The last tile's time includes Freeboard drawing under the throttle, and the cold view's its start. Panning, the slowest tiles on `main` are those with soundings, built cold; after, they're read from disk or memory.

Sailing at 6 kn, a sounding a second, for 125 s at map zoom 13 and 15, which matched, with the writer's flush at 5 s:

| What                                    | `main`                          | Stages 4 and 5                      |
| --------------------------------------- | ------------------------------- | ----------------------------------- |
| Batch                                   | 30 s                            | 5 s, chosen for a 9 KB view         |
| Tiles refetched                         | 4                               | 18 to 19                            |
| A refetched tile's response, median     | 384–434 ms                      | 9–16 ms                             |
| Sounding to the plotter, as provisional | 1.1–1.7 s median                | 1.0–1.3 s median, 1.3 s at most     |
| Sounding stored in its cell             | not measured                    | 26 s median, 34 s at most           |
| Sounding to the surface                 | 39–42 s median, 56–61 s at most | 27 s median, 30 s p90, 34 s at most |
| Frames over 50 ms                       | none                            | none                                |
| The Pi's server process, CPU            | 3% of a core                    | 7–10% of a core                     |

#### Where a sounding waits

The surface isn't within 10 s, because most of the wait comes before a sounding is written to a cell at all. From stored to the screen takes about 1 s. Stage 6's preview shows the surface within about 1.5 s of the sounding, before it's stored. The writer, at 6 kn and a sounding a second:

- **QC's look-ahead,** 11 soundings, 11 s: the spike and noise checks judge a sounding only once the soundings after it have come.
- **The pass leaving the cell,** about 10 s: a cell's pass is the median of the soundings within a pixel of it, so it closes only when a judged sounding lands outside the cell's 3 × 3, about 1.5 cells, 30 m, along the track.
- **The flush,** 2.5 s on average at 5 s.

QC judges a sounding at a time while the buffer it looks back over is under 2,000 soundings, as it is under way at 1 Hz, and it ran at least 0.5 s before, so a faster sounder or a burst of soundings is judged 10 at a time; past that, as at anchor, it judges a hundredth of the buffer at a time, as a backfill does, since each run reads the whole buffer, 7 ms for 1,000 soundings and 326 ms for 40,000 on the Pi. Judging 10 soundings at a time, with the flush at 10 s, the writer held a sounding 36 s at the median in a simulation of the same track, against 28 s judging one at a time and 25 s with the flush at 5 s too. On the Pi the same three steps measured 30, 29 and 26 s to stored: each run starts on a short buffer, which judges a few at a time. The fastest tenth still takes 22 s, the look-ahead and the pass: those are the grid's QC and pass rules, which the live layer follows so its cells match the grid's, so 10 s isn't reachable without departing from them. The flush at 5 s writes twice as many small transactions as at 10 s: about 720 an hour under way.

#### Where the CPU goes

Per thread on the Pi, over 125 s sailing with a plotter watching, building again every tile a change drops, at every zoom, cost 35–37% of a core: 23% on the tile threads, 11% in V8's helper threads collecting their garbage, and under 1% on the server's own. The triggers drop tiles that didn't change, as far as 4 km away through the overview blocks, and a flush changes tiles round the boat at zooms 10 to 15. Built again into memory only where they're in a plotter's view, at the zoom it draws, it's 7–10%: 3–5% on a tile thread, 3–4% collecting garbage, and under 1% on the server's thread, where the walk of tile ids and the view's weighing on each poll run. The rest is the tiles a refresh refetches, 18 to 19 in 125 s, built ahead rather than on request, and QC once a sounding. The other tiles changed or dropped wait to be asked for, at about 0.25 to 0.5 s each on the Pi, or to settle and be kept 10 minutes after the boat has passed.

### The batch on a dense store

The plugin's batch for a 1280 × 800 view, centred where each store has the most cells:

| Map zoom | Boat's store | Real store    | Synthetic store |
| -------- | ------------ | ------------- | --------------- |
| 11       | 7 KB, 5 s    | 18 KB, 5 s    | 502 KB, 18.8 s  |
| 13       | 9 KB, 5 s    | 63 KB, 5 s    | 328 KB, 12.3 s  |
| 15       | 25 KB, 5 s   | 174 KB, 6.5 s | 408 KB, 15.3 s  |

Sailing through the synthetic store's busiest water at map zoom 13 on the Pi, for 125 s, the plugin chose 12.3 s. Each refresh froze Freeboard for at most 233 ms, against 217 ms on `main` at 30 s; 17 frames went over 50 ms, against 6. So a refresh there is 1.9% of the time frozen, not 0.7%, and the 0.6 s freezes of stage 1 are gone with stage 1's smaller tiles.

### Limits

- **Memory.** Building ahead keeps the three tile threads busy for the first 18 minutes after an upgrade or a backfill, and the process's resident memory near 1 GB. On the boat's 8 GB Pi that's room enough; a 1 or 2 GB Pi isn't measured.
- **The bound.** The kept tiles go oldest-built first, and those built ahead first are nearest where the boat was. On a store past 48 MB of tiles, as the synthetic one at 1,091 tiles, zoom 13 and out round the boat are built ahead and the rest is built when asked for; past 64 MB, plotters' requests push out the tiles round the boat's berth first.
- **Under way.** 7–10% of a core on the Pi while a plotter watches, against the plan's 5%: a refresh's tiles every 5 s, built ahead, and QC once a sounding. A flush walks about 170 tile ids per changed cell on the server's thread; after a long hold, a backfill's 3 hours of passes flush at once, a few hundred thousand ids, not measured.
- **The view's zoom.** The plugin takes the host's zoom as OpenLayers', as Freeboard's is. A host reporting MapLibre's would be weighed a zoom coarser, and batched shorter.
- **The surface.** The writer's hold, QC's look-ahead and the pass leaving its cell, keeps the tiles' surface 27 s behind the boat at the median. The preview (stage 6) draws it within about 1.3 s meanwhile.
- **No view.** A host that doesn't report its view gets no tiles built ahead under way, so its refresh builds them, at the 30 s batch. A plotter that pans or zooms out right after a refresh builds the changed tiles it hasn't been shown.

## Stage 6 results: the live preview

The tiles hold a sounding 27 s, by QC's look-ahead and the pass rule, which follow the grid's. The preview draws the surface those soundings will make before then, the way the tiles will draw it:

- **What it draws.** The surface round the boat as the cells would hold it were every sounding held written now. The writer's `pending()` gives the passes held, the passes still open as if closed, and the soundings QC hasn't judged, run through the same pass rule on a copy, with what QC has already rejected left out. These are folded into the stored cells under the window with the cells' own moving average, so where the boat crosses old water the preview shows the average moving, not the pass alone. A test checks that the preview of pending passes equals the preview of the same passes once written.
- **Where.** Within 100 m of a pending pass or of a cell written in the last 90 s, whose tile may not have refreshed: as far as the surface spreads a lone pass, and where new water meets stored. The window is the square of those positions plus 100 m, on the tiles' own pixel grid: a zoom 21 tile is exactly one of the zoom 14 surface's pixels, so `surface()` takes a window of any size in pixels. At most 56 pixels a side, about a kilometre, about the newest sounding. The surface is searched only within the 100 m and the blur's reach past it, and traced only within the 100 m, so the cost follows the track, not the stored water under it.
- **How.** The same `surface()`, `prepare()`, `cut()` and tracing as a zoom 15 tile, at the same 4 samples a pixel and the same simplification, as depth areas and contours. Where the data agrees, the preview's contours lie within a metre of the zoom 15 tile's, in a test, and its surface's pixels within 0.05 mm of the tile's. Tiles are byte-identical: 194 tiles at zooms 10 to 15 at both details over the real and boat's stores hash the same as `main`'s.
- **When.** On a tile thread, an idle one first, when a `/live` poll asks for it with `preview=<rev>`, once a sounding or QC verdict has come in since, at most once a second, and shared by every plotter polling. A poll waits for it up to 1 s, then sends the last. It isn't worked out where the plotter's view doesn't show the window, nor for a runtime that doesn't ask. One worked out across a write of its passes would count them twice, so it's dropped and worked out again. It's empty once nothing is pending and nothing was written in 90 s.
- **What's sent.** GeoJSON depth areas and contours, with a revision, only when it's changed, and with contours in the unit the runtime asks for. The runtime sets it whole on a `preview` source, which Freeboard redraws without re-keying the tiles. It's drawn below the stored areas: over water sounded before the stored area shows, and over new water the preview shows until the tiles there refresh. Its contours are dashed, from zoom 13.
- **No ribbon.** The preview reaches the plotter on the same poll as the soundings, for 255 of 255 soundings over the three runs below, so nothing else is drawn along the pass.

### On the boat's Pi

As in stage 4 and 5: the boat's Pi 5, a bench server on a copy of the boat's store, Freeboard-SK 3.4.1 in headless Chromium on the laptop at a 6× CPU throttle, through an SSH tunnel over the local network, since macOS keeps the test browser off the local network. Sailing at 6 kn, a sounding a second, two runs each of 125 s at map zoom 15 on the boat's water, and one of 95 s at map zoom 16 sailing onto new water, `main` and the preview in turn:

| What                                         | `main`           | The preview                     |
| -------------------------------------------- | ---------------- | ------------------------------- |
| Sounding to the plotter, as provisional      | 1.1–1.6 s median | 1.2–1.4 s median, 1.6 s at most |
| Sounding to the surface on screen, new water | 26–27 s median   | 1.2–1.4 s median, 1.6 s at most |
| Sounding to the tiles' surface               | 26–27 s median   | 25–27 s median                  |
| GeoJSON per poll that carries the preview    | none             | 18–19 KB median, 31 KB at most  |
| On new water                                 | none             | 2 KB median, 3 KB at most       |
| A poll's response                            | 10 ms median     | 41–60 ms median, 0.65 s at most |
| Frames over 50 ms                            | none             | none                            |
| The Pi's server process, CPU                 | 7–8% of a core   | 10% of a core                   |

The time to the surface on screen is when the poll carrying it lands, on new water: over water already in a tile the stored areas draw over it, and the change shows when the tile refreshes. It's the same moment as the provisional sounding; Freeboard's drawing of it is in the frames, none over 50 ms, at most 17 ms at the 99th percentile. A poll's response includes waiting for the preview it worked out.

Per thread, the preview takes 2.1–2.2% of a core on the tile thread it runs on, against 3.9–4.3% for the tile thread refreshing tiles. Timed alone on the Pi, `readPreview` for 90 s of track, the last 27 s pending, takes 61 ms at the median over the boat's water, 128 ms at most, and 28 ms over new water, single-threaded; at one a poll every 2 s that's 1.5 to 3% of a core.

### Limits

- **Under way, 10% of a core** with a plotter watching, against `main`'s 7–8%: the preview's 2%, and its garbage.
- **A held track.** While a backfill holds the writer's passes, up to 3 hours, the preview draws only the kilometre about the boat; further back, the provisional points show the track, and the cells draw it once written.
- **90 s.** The preview stops drawing a cell 90 s after it's written. At zoom 10 and in, tiles refresh within 30 s; further out they refresh every 5 minutes, so there, from 90 s to 5 minutes, newly written water shows as points, where the preview's window is a few pixels across anyway.
- **Unjudged soundings.** The preview draws soundings QC hasn't judged yet, as the points do. A spike draws for the 11 s QC takes to judge it, and a wild position as the newest sounding moves the window there meanwhile. A run of one depth, which QC holds until it covers 1 km for the stuck-sounder check, is drawn only for its first 11 soundings, so a frozen sounder draws no further than a spike.
- **At a berth,** with the sounder on, a sounding a second keeps the preview worked out once a second, about 28 ms on the Pi, 3% of a core; an unchanged one isn't sent again.
- **First-pass colours.** Where the boat's sounded before, the preview's cell moves a fifth of the way, as the tile's will. An untided sounding over a tided cell, as when signalk-tides stops, is left out, as the tile leaves it.
- **A host holding an older style,** with no `preview` source, can't take it, so it's sent again each poll until the style reloads, without redoing the tile refresh. An older runtime doesn't ask for it.
- **Measured** on the boat's store and on new water at 6 kn. Over the synthetic store's busiest water a window took 42 ms at the median and 103 ms at most on the Pi; a faster boat's window reaches the 1 km cap sooner, and a sounder faster than 1 Hz isn't measured.
