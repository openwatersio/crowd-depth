# Per-tile pipeline

Verdict: the per-tile pipeline works end to end and matches the package's own results. Points go to cells, then the surface, then depth areas, contours and soundings, then z8 web tile archives and one low-zoom archive. These are byte-copied into one PMTiles with no global tippecanoe run. A 1° tile is the right unit for the surface. It is the wrong unit for daily incremental work. On every day of the last month, the 3 to 15 tiles that new files touched held 47–86% of all soundings, because new data lands in the dense harbor tiles every day. A daily run at 1° granularity costs about 75% of a full rebuild (Chesapeake: 60 min against 81 min with 4 workers). Two fixed costs dominate at planet scale. First, a full-size raster per tile, even for a tile with 800 soundings. Second, the densest tiles, which set the critical path and break the 2 GB memory budget. Both are fixable, and the fixes are listed under Recommendation.

Measured in October 2026 on the Chesapeake set, with the `packages/grid` code as of the overlay branch ([#150](https://github.com/openwatersio/crowd-depth/pull/150)). The spike's code isn't checked in, and nothing was written to R2.

## Data

|                                                |                                                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Staged soundings (active, after rule-1 copies) | 98,508,663 from 18,434 files (5,979 copies dropped)                                                      |
| 1° tiles with soundings                        | 212                                                                                                      |
| Density                                        | 10 tiles ≥ 1M hold 87%; the top 3 hold 59.4M (28.0M, 16.8M, 14.7M); 99 tiles have 10k–100k; 33 have < 1k |
| Shuffle by tile (store order to `tile_id=N/`)  | 20 s, 0.98 GB RSS, 3.8 GB Parquet                                                                        |

The "Chesapeake" set is every file that touches the bay. Transits take it to 212 tiles between 31°N and 42°N, so it includes a long sparse tail like the planet's.

## The pipeline as built

| Stage    | Unit                     | Reads                                                                                            | Writes                                                               | Package code reused                                                                                             |
| -------- | ------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| cells    | 1° tile                  | its points; `lake.files`                                                                         | cells, all flags, SOUNDG sources, edge strip                         | `cells.build` unchanged (one patched CTE, below), `overlay.SOURCES`                                             |
| surface  | 1° tile                  | its points + the 8 neighbors' edge strips; the 9 tiles' flags; its cells                         | COG, DEPARE/DEPCNT/M_QUAL/prime features, simplified z0–7 copy       | `surface.build_tile`, `overlay.TILE_QUALITY`, `surface_bands`, `quality`, `tile_areas` unchanged                |
| web      | z8 web tile (about 1.4°) | features of the 1° tiles it overlaps (clipped to it + tippecanoe's buffer); their SOUNDG sources | `web/X_Y.pmtiles` (z8–z15), z6–7 soundings, its level-5 pyramid cell | `overlay.feature`, `thin_shift`, `MERCATOR`; the pyramid loop of `overlay.soundings`, restricted to levels 15–5 |
| low      | once                     | every tile's z0–7 features, the web jobs' z6–7 soundings, level-4 reduce                         | `low.pmtiles` (z0–z7)                                                | tippecanoe flags from `overlay.build`                                                                           |
| assemble | once                     | every archive's directory                                                                        | `overlay.pmtiles`                                                    | `pmtiles` writer                                                                                                |

How the package runs on one tile: `lake` is an in-memory DuckDB catalog built from the package's own `SCHEMA`. `lake.points` is a view over the tile's Parquet, and `ACTIVE_POINTS` is installed as written, so dedupe, QC flags and `active_points_in` behave as in the store . `cells.build(con, tiles=[t])` then runs as written, band units included.

Why z8 for tiling: a z8 tile's subtree (z8–z15) is disjoint from every other one. Every shoalest-wins pyramid level from zoom 15 down to 5 nests inside it, so soundings are exact per job. Assembly needs no MVT merging, only dropping tiles that a job's clip margin spilled into a neighbor's subtree (15% of tiles written). A 1° tile overlaps 1–4 z8 tiles, and a z8 job reads 3.15 tiles on average.

Below z8: z0–z7 come from one more tippecanoe run over every tile's features with minzoom ≤ 7. The soundings there come from the web jobs (levels 5–7 are exact per z8 tile). Level 4, which only shows soundings deeper than 1,000 m at z6, is reduced from each job's level-5 cell (min over 2×2). This low-zoom run is the "merge/reduce" step. It is a global run, but only for z0–7.

Assembly: a Python script reads each archive's directory, keeps the tiles it owns, and copies tile bytes in tile-id order into one clustered archive. Alternative: `pmtiles extract --bbox` per z8 archive, inset so neighbors' tiles don't intersect, then `pmtiles merge`. Both give identical tiles.

### What had to change

- **`cells.CLASSIFY` corroboration join**. On tile 45463 (28M soundings) the `corroborated` CTE, which joins each consensus shoal to every sounding in its 3″ block, ran out of memory at 2 GB after 243 s. I rewrote it against one row per distinct depth in the block, with the min and max vessel that read that depth. It is exact while one reading of the same depth corroborates a shoal. On the dev sample it gave identical flags and cells, apart from the tie noted next. With the patch, that statement takes 24 s.
- **Edge strips.** `surface.margin` reads the E/W neighbors whole, so each surface would read 9 tiles. The cells stage writes the points within 0.004° (about 450 m) of each edge (1.6% of points, 63 MB). The surface stage's `lake.points` is the tile plus its neighbors' strips. `PIXELS` filters them as before.
- **Memory settings, per stage.** Cells: DuckDB 1.2 GB, because resident memory runs 0.7–1.1 GB past `memory_limit`. Surface: 1 thread and 1.2 GB. The per-pixel `quantile_disc` in `surface.PIXELS` can't spill, so 4 threads ran out of memory at 0.6 GB and at 1.1 GB on the three densest tiles.
- **Low-zoom pre-simplification** (`shapely.coverage_simplify` at half a z7 unit). A collapsed DEPARE polygon must keep its original geometry, or shoals vanish below z8. The first dev run lost them.
- No changes to `surface.py` or `overlay.py`.

## Cost per tile, by density (serial: 1 worker, 4 DuckDB threads)

| soundings in tile | tiles | cells s, median / max | surface s, median / max | cells peak RSS | surface peak RSS | cells, median |
| ----------------- | ----: | --------------------: | ----------------------: | -------------: | ---------------: | ------------: |
| < 1k              |    33 |             0.8 / 1.4 |               5.6 / 6.6 |         0.2 GB |           3.0 GB |            58 |
| 1k–10k            |    39 |             1.0 / 1.3 |              6.4 / 11.6 |         0.3 GB |           3.0 GB |           702 |
| 10k–100k          |    99 |             1.2 / 2.3 |              6.6 / 15.4 |         0.5 GB |           3.3 GB |         2,378 |
| 100k–1M           |    31 |              2.4 / 23 |                9.3 / 77 |         1.6 GB |           3.4 GB |        14,583 |
| 1M–10M            |     7 |             105 / 235 |                73 / 533 |         2.3 GB |           4.5 GB |       312,356 |
| > 10M             |     3 |             379 / 491 |               592 / 653 |         1.9 GB |           4.4 GB |     2,052,980 |

Linear fits: cells = 1.0 s + 20 s per million soundings; surface = 9.0 s + 19.4 s per million. Neither stage is really linear:

- **Surface has a fixed floor** of about 6 s and 1.7–3 GB for any tile, however few soundings it has. At 37°N a tile is 5,400 × 5,400 pixels. COG write (4.6 s), blur and guard (2.0 s), distance transform (1.5 s), polygonizing (1.4 s) and `gdal_grid` (1.0 s) all scale with pixels, not soundings (profiled on an 830-sounding tile).
- **Dense surfaces are dominated by `tile_areas`** (shapely unions over complex bands): 317–424 s of the 533–653 s on 45464, 45823 and 46183. Grid time grows with density too (152 s on 45463).
- **Dense cells re-read the tile per band unit.** `active_points_in` reruns the dedupe for every band: 6 units × about 20 s on 45463, plus 16–23 s per unit for `SHOAL_CELLS`. The `SOURCES` write took 122 s on the same tile.
- Each unit is its own Python process. The import costs 0.6–1 s (134 s of the cells stage's 2,191 s).

Web jobs (z8): 239 jobs, 166 with output; median 1.2 s, max 110 s (74/99: 1,662 area features, 234k soundings, tippecanoe 91 s, 1.65 GB). Low-zoom run: 22 s, 0.94 GB. Assembly: 1.3 s, 0.16 GB for 181,108 tiles (217 MB); the CLI path takes 18 s.

## Totals for Chesapeake

| run                                                                          |   cells | surface |                        web |  low | assemble |                  total |
| ---------------------------------------------------------------------------- | ------: | ------: | -------------------------: | ---: | -------: | ---------------------: |
| serial, 1 worker × 4 threads                                                 | 2,191 s | 3,820 s |                      771 s | 22 s |      1 s | **6,805 s (1 h 53 m)** |
| 4 workers × 2 threads, 8 GB budget (base: all but the last 7 days)           | 1,022 s | 3,534 s |                      296 s | 32 s |      2 s |     **4,886 s (81 m)** |
| simulated from serial unit times, 4 workers, 14 GB, no head-of-line blocking |   548 s | 1,142 s |                      193 s |      |          |                1,883 s |
| simulated, 8 workers, 28 GB                                                  |   491 s |   653 s |                      110 s |      |          |                1,254 s |
| global tippecanoe z0–15 over the same features, for comparison               |         |         | 318 s (978 s CPU, 1.36 GB) |      |          |                        |

Four workers gave only 1.4×. Three things held it back. First, the densest tile is the critical path (cells 491 s serial, 1,022 s with 2 threads under contention). Second, the scheduler holds a dense surface back until its 4.6 GB fits the budget, and the units queued behind it wait too. Third, the laptop was shared with another import (swap was at 13 of 14 GB all night). The 8-worker simulation is bounded by one tile: 491 + 653 + 110 s.

Output sizes: cells 314 MB (9.14M cells, 3.43M of them filled), flags 131 MB, SOUNDG sources 140 MB, edge strips 63 MB, surfaces 465 MB, area features 550 MB of GeoJSON, low-zoom features 98 MB, web GeoJSON 1.3 GB (scratch), web archives 228 MB, final archive 217 MB.

## Correctness

- Soundings: on the dev sample (10 tiles, 1.05M soundings), the union of the per-z8 pyramids plus the low-zoom ones equals `overlay.soundings` over the whole store exactly (34,320 features, 0 missing, 0 extra).
- Tiles against a global tippecanoe run over the same features: the same 181,108 tile addresses. At z8–z15, 0.6% of tiles differ, by points outside the tile's extent. A per-z8 job doesn't see the neighbor job's soundings in its buffer. MapLibre places a symbol only from the tile holding its anchor, so this doesn't show. At z0–z7 the separate run's tiles encode differently. Band areas agree within a few percent per band, and the 0–2 m band covers slightly more in the per-tile build, so no shoal is lost. Feeding the low run unsimplified features gives the same kind of difference (61 s instead of 22 s), so the difference comes from tippecanoe seeing a subset, not from my simplification.
- Incremental against full: base (to 10-08) → +6 days → +1 day, compared with the serial full build. Flags are identical in all 212 tiles. DEPARE, DEPCNT and M_QUAL are identical in all 212. Prime soundings have the same counts and depths. 31 tiles' cells differ only in `depth_lon` and `depth_lat` (23,777 cells), and 0.1% of final tiles differ by one sounding. Cause: `placed` in `cells.CLASSIFY` takes `arg_min(position, time)`, and soundings at the same depth and time tie, so the position depends on thread order. This affects the package as it is, not just this spike.

## Daily incremental

Dirty sets: cells rebuild the tiles that new files' points touch. Surfaces rebuild those tiles and their 8 neighbors (the edge strips). Web jobs rebuild every z8 tile whose inputs include a rebuilt tile. Low and assemble always rerun.

| run                     | new files | tiles: cells / surface / web | soundings in rebuilt tiles |   cells | surface |   web | low + assemble | total (4 workers) |
| ----------------------- | --------: | ---------------------------: | -------------------------: | ------: | ------: | ----: | -------------: | ----------------: |
| 6 days (10-09 to 10-14) |       144 |                 17 / 35 / 35 |                87.0M (88%) | 1,200 s | 2,540 s | 182 s |           27 s |       **3,949 s** |
| last day (10-15)        |       376 |                  8 / 18 / 23 |                83.4M (85%) | 1,082 s | 2,336 s | 160 s |           25 s |       **3,603 s** |

The last day is large (376 files), but a typical day is no better. On each of the last 30 days, the tiles touched held 46–85M of the 98.5M soundings, and 3–9 of them were tiles ≥ 1M. Rebuilding a whole 1° tile because one track crossed it means re-reading and re-classifying 28M soundings.

Swapping changed tiles in the archive: rerun only the dirty z8 jobs, then re-assemble. Assembly copies unchanged tiles byte for byte (1.3–2 s here), so a full rewrite costs about the same as a patch. PMTiles can't be patched in place. Appending new tile data and rewriting the directory would work, but every changed byte range still has to be re-uploaded. A rewrite uploads the whole archive.

## Seams between tiles

Measured on the full build's depth areas and contours, along all 204 shared edges (84 have areas near the edge), sampled every surface pixel:

- **Overlap: none.** Areas never cross into the other tile.
- **Gaps: small.** Where both sides have areas within 3 pixels of the edge, both reach it exactly in 90% of samples (`gdal_contour -p` closes polygons at the raster edge). Elsewhere the gap is up to 82 m, about 4 pixels.
- **Coverage stops at the seam on one side** in 28% of active samples (2,278 of 8,193). One tile has areas at the edge and its neighbor has none within 3 pixels.
- **Band mismatch across the seam**: 9.4% of samples where both sides have areas (558 of 5,915), up to 20% on 45463/45823.
- **Contours**: 371 contour ends near an edge found a same-depth end across it, with a median distance of 23 m (median of the per-pair medians). 84 had none. Some pairs' 90th percentile is over 1 km, meaning the nearest partner end is somewhere else entirely.

These seams come from the package's per-tile surface, not from the split. A global tippecanoe run draws the same ones. Interpolation sees 200 m of the neighbors, but the blur, the shoal guard (`minimum_filter`), the unconfirmed-shoal holes and consensus QC (whose votes stop at tile edges, the existing `ponytail` in `cells.py`) don't. Gridding each tile with a margin of a few pixels and cropping after the guard would remove most of the mismatch. Consensus would also need to read across edges, which makes the cells stage depend on its neighbors too.

## Planet extrapolation (8 cores, 32 GB)

Assumptions, none measured:

- 2B soundings (the archive note's estimate), 20× Chesapeake.
- 15,000–30,000 1° tiles with soundings (Chesapeake's files alone reach 212). Most are sparse transit tiles.
- Density as skewed as here: a few hundred harbor tiles over 1M.
- Per tile: fixed cost 8.7 s (cells 0.9, surface 6.5, web 1.3), plus 47 s per million soundings (cells 20, surface 19.4, web 7.8). These are M-series cores; a cheap server core is taken as 1.5× slower.
- 8 workers on 32 GB (sparse surfaces need about 3 GB, dense ones 3–4.5 GB) at 75% efficiency, so 6×.

|                                                                 | worker-hours | wall, this laptop's cores | wall, cheap cores |
| --------------------------------------------------------------- | -----------: | ------------------------: | ----------------: |
| full rebuild: 2,000 × 47 s + N × 8.7 s                          |      62–99 h |                   10–16 h |           16–25 h |
| of which fixed per-tile cost (mostly empty rasters)             |      36–73 h |                           |                   |
| daily: dirty tiles hold 40–70% of soundings, about 10% of tiles |      14–26 h |                 2.4–4.3 h |         3.5–6.5 h |
| low-zoom run (scales with feature volume, 70–140×)              |              |   25–140 min, one process |                   |
| assembly (13–25M tiles, 15–30 GB)                               |              | minutes of sequential I/O |                   |

A full daily rebuild doesn't fit in a day on 8 cores as the code stands. A 1°-dirty daily run fits, but costs about half to three quarters of a rebuild every day. Two changes would cut that by an order of magnitude: cropping each surface to its data, which removes most of the fixed cost, and sub-tile dirtiness in dense tiles.

## Downsides I hit

1. **Dense tiles.** They ran out of memory in the corroboration join. Their surfaces peaked at 3.2–4.5 GB with 4 threads (3.0–3.8 GB with 1), against a 2 GB per-process target; DuckDB's limit doesn't cover numpy, shapely or GDAL. They set the critical path (about 20 min for the densest alone). They needed a memory-weighted scheduler, which then stalled sparse work behind them. **The 2 GB cap was exceeded:** 201 of 212 serial surface processes peaked over it (the full-tile rasters alone take about 1.7 GB), as did one cells process (2.3 GB, tile 46544). Web, low and assembly stayed under 1.7 GB. I couldn't keep the surface under 2 GB without changing `surface.py`, so I kept the machine safe with a total budget instead: 8 GB across workers, dense surfaces counted as 4.6 GB.
2. **Margins.** Surfaces need neighbors' points, so cells must finish for all 9 tiles first: a barrier between stages, and dirtiness spreads to a 3×3 block and then to about 2 z8 jobs per tile. Cells need no margin only because consensus and holes stop at tile edges, which is itself a cause of the seams. Fixing the seams means cells depend on neighbors too.
3. **Low-zoom merge.** z0–z7 can't be built per tile. A z7 tile covers about 3°×2°, and DEPARE starts at z4. I used one global low-zoom run over pre-simplified features. It is cheap here, but it grows with the planet's total area features, and naive simplification drops small shoals. Level 4 of the sounding pyramid needs its own reduce. For the planet it should be hierarchical: z5–z7 per z5 tile, then z0–z4 from those.
4. **Versioning and change detection.** Each tile's outputs depend on its own inputs, its neighbors' edge points and flags, and the code version, and the tie nondeterminism changes bytes with no input change. A real run needs a per-tile manifest (input fingerprint, `GRID_VERSION`, `QC_VERSION`, and the neighbors' fingerprints), and the archive should be published only when every dirty unit has finished. A version bump rebuilds everything (16–25 h on the assumptions above). Withdrawn files that empty a tile need its outputs deleted; this spike doesn't handle that.
5. **Process-per-unit.** It made memory measurable, but costs 0.6–1 s per unit. At planet scale, use long-lived workers.

## Recommendation

Keep the 1° tile as the unit for the surface, and tile at z8 web tiles with byte-copy assembly. That part works and is exact. Before building the daily run on it:

1. **Crop the surface to the data's extent** (or skip 512×512 blocks with no sounding within 200 m). This removes most of the 36–73 worker-hours of fixed cost and brings sparse tiles' memory far under 2 GB.
2. **Make dense tiles incremental below 1°.** `cells.units` already splits dense tiles into 3″-row bands. Mark bands dirty (plus one band each side for consensus and holes), and rebuild the surface in windows (for example 1/8° plus 200 m). Then daily cost follows the new data's footprint, not the harbor's history.
3. **Grid each tile with a few pixels of margin and crop after the blur and guard,** and let consensus read across tile edges. Then re-measure the seams.
4. **Make `placed` deterministic** (break ties on `point_id`), so unchanged inputs give unchanged bytes and change detection can trust hashes.
5. **Read the tile's active points once per cells run,** not once per band unit, and fold `SOURCES` into it.
6. **Build the low zooms hierarchically** before the planet's feature volume makes one run slow, and test that shoals survive at z4–z7.

## Not measured

- The real store: reading a tile out of DuckLake on R2 (rows pruned by `tile_id` after compaction), the catalog lock, and uploads.
- Cheap x86 cores and a dedicated machine: every timing here is on a shared M-series laptop, with swap nearly full all night.
- The planet's tile count and density distribution. Read them from the store's `points` by `tile_id` before trusting the extrapolation.
- A run with a fixed (non-blocking) memory scheduler. The simulated numbers assume one.
- Upload time and cost of a 15–30 GB daily archive, and how clients handle the ETag change.
- Seams in the soundings layer, and visual review of the seams.
- Open Waters GeoJSON input (NOAA CSV only) and tiles past 60° latitude, where `k > 1`.
