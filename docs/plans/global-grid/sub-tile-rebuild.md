# Sub-tile rebuild

How a daily `grid tiles` run rebuilds only the parts of a dense 1° tile that new data touched, and how the same design can close the seams between tiles. Measured on the Chesapeake store by replaying its last 30 arrival days, by rebuilding tiles 45824 and 46183 whole and in windows for the last of them (2026-10-15, 365 files), and by building the whole store in leaves and in whole tiles with the same code.

Short answer: dense tiles are rebuilt in quadtree leaves, each reading the reach around it, and the leaves' rows and pixels are spliced into the tile files the overlay reads. With σ's fallback bounded and its ties settled by value, leaves build what whole tiles build: on the Chesapeake all 212 tiles' cells, shoals and flags match row for row, and their surfaces pixel for pixel. But leaves don't make a day as cheap as [rebuild-cost.md](rebuild-cost.md) assumed. Each leaf's jobs read its reach again, about 0.7 km for cells and 1.1 km for surfaces, so small leaves in a busy harbour reread their neighbours many times over. Leaves no smaller than 1/8° read the least: a day's leaf jobs read a median 50% of all soundings for cells and 56% for surfaces, against 76% and 90% at 1°. Counted once however many jobs read it, the dirty leaves and their reach hold 37–45%, the 38–40% this design first measured. New data lands where the data already is at every scale down to 400 m: in Norfolk's tile one vessel logged half the soundings, crossing the same harbour daily. A planet day comes to about 18 worker-hours instead of 23, and more on days when tide or calibration moves. Getting further needs the hot spots handled differently, which is a separate change.

## What a sounding reaches

A leaf can be rebuilt alone if it reads every input its outputs depend on, and it must be rebuilt when a change lands within reach of its outputs. These reaches come from the code; the replay confirms them.

| Step                                                                      | Reads around each output                                                                         | Reach                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Consensus (`cells.CONSENSUS`)                                             | votes of the 3×3 blocks of 3″ around a sounding's block                                          | 1 block, 93 m; a new sounding changes flags up to 2 blocks away, about 260 m on the diagonal |
| Levels, cell statistics                                                   | the 1″ or 3″ cell, aligned to blocks                                                             | none past the block                                                                          |
| Vote smoothing, σ window, outvoted shoals (`statistic`, `cells.OUTVOTED`) | 1 + 2 pixels, and the 3×3 pixels                                                                 | 62 m                                                                                         |
| σ fallback (`statistic.nearest`)                                          | the nearest pixel with a measured spread within 25 pixels, the largest spread among equally near | 25 pixels, about 515 m                                                                       |
| Surface interpolation (`surface.ALGORITHM`)                               | votes within 200 m                                                                               | 200 m                                                                                        |
| Blur, band beside a track, shoal guard                                    | 8 px, 40 m, 1 px                                                                                 | 165 m                                                                                        |

Without the fallback, cells depend on points within about 330 m and the surface on votes within about 430 m. A pixel whose 5×5 window holds fewer than three votes, and every interpolated pixel, takes its spread from the nearest pixel that has one. Left unbounded, that reaches however far, and where several pixels are equally near `cKDTree` returns whichever its layout finds first, which depends on every pixel in the build. Pixels sit on a grid, so ties are common, and the candidates' spreads can differ tenfold (0.3 against 3.5 m beside a lone track).

On the replay, every cell-level flag that changed lay within 166 m of a new sounding in tile 45824 and 225 m in 46183. But cells changed up to 89 km away in 45824 and 5.8 km in 46183, surface pixels up to 117 km away, and 60 cells of 45824 more than 1 km from any new sounding moved by up to 1.22 m in depth. A 1° tile rebuild has this too; it just never looks outside the tile.

With the fallback taken only from pixels closer than 25 pixels (about 515 m), and the largest spread among those at the nearest distance, every step is local. A cell's σ can then come from a pixel 25 pixels away, whose own spread reads votes 2 pixels further, smoothed a pixel further, from soundings whose flags read 20 base rows further (consensus's 3×3 blocks, and the outvoted check's 3×3 pixels): 78 base rows, about 0.0072°. A surface pixel's σ comes from as far, and that pixel's spread is taken around the interpolated surface there, which reads votes within the 200 m search radius and the blur's 8 pixels of it: 110 base rows on the Chesapeake, about 0.0102° (`leaves.reach`). What an output reads is also what can change it, so a leaf's cells are dirty when a change lands within their reach and its surface within its own, and those are what each reads. They are counted in rows and in base columns, not in metres: east–west every reach is k times wider in degrees, where k is the tile's column width in base steps (`cells.k_for`), 1 on the Chesapeake and 2 from 48°N to 66°N, and the search radius spans however many columns it does in the tile. A surface reads a neighbor tile's flags, which reach 20 of that tile's columns, so where the tile north or south has wider columns its reach widens to match. A smaller fallback bound shrinks both.

The replay stayed inside those reaches: with the bound and tie rule the same day changed cells no farther than 415 m from a new sounding (99th percentile 205 m) and surface pixels no farther than 1,064 m (99th percentile 659 m), past 0.009° (about 1,000 m). Windows read with halos of 0.004° and 0.006° matched, since none of their pixels fell back farther.

## Options

**3″ bands across the tile.** `cells.units` already splits a dense tile into bands of rows, and the store sorts each tile by latitude, so a band reads only its own row groups. But a band is a degree wide: a track running north–south dirties every band it crosses. A day's dirty bands, plus one each side, hold a median 46% of all soundings (12–78%), worse than windows at every size, and bands do nothing for the surface. That figure flatters bands: it counts 3″ bands dirty only within one band of a new sounding and takes nothing from neighbor tiles.

**Fixed windows.** A grid of square windows in each dense tile, each rebuilt with a halo of points around it. Simple to key and splice. Their size trades dirt against job count: past 1/32° they barely shrink the dirty share, while jobs multiply.

**Adaptive quadtree.** Split a tile into quarters until each leaf holds at most N soundings. Leaves follow density: Norfolk's harbour splits finely, open water stays whole, and a sparse tile is one leaf. The leaf bound also bounds most jobs' memory and time, which the planet's densest tiles need anyway (67M soundings in Galveston's tile against 28M in Norfolk's, whose single cells job already sets the Chesapeake's critical path).

**Rebuild only what each vessel changed.** Cells and the surface could keep per-vessel summaries per pixel or block and recompute only the vessels with new soundings, as `grid calibrate` keeps each file's medians. It is the only option that helps a harbour crossed daily, but medians don't merge and a new vote can reflag every other vessel's soundings in its blocks, so it changes how cells are classified. It is sketched under [Hot spots](#hot-spots), not designed here.

## Measured

### Dirty share over 30 days

[footprint.py](../../../packages/grid/spikes/subtile/footprint.py) counts every active sounding on a grid of 1/512° (about 217 m). For each of the last 30 arrival days, it marks dirty the fine cells within the reach of that day's new soundings, its neighbor tiles' included, and reads the dirty units plus the same reach around them, from neighbor tiles too: 0.007° for cells, 0.009° for surfaces, widened by 1/cos(latitude) east–west, which on the Chesapeake (k = 1) reads a little more than the design needs. Tiles under 1M soundings rebuild whole, cells included once they read across edges. The two columns are two runs, `REACH=0.007` and `REACH=0.009`. Shares are of all 98.5M soundings: medians over the 30 days, with the range.

| Unit                                | Cells: units | Cells: soundings read | Surfaces: units | Surfaces: soundings read |
| ----------------------------------- | -----------: | --------------------: | --------------: | -----------------------: |
| 1° tile (today, own tile for cells) |            8 |          76% (47–86%) |              18 |             90% (80–92%) |
| 3″ bands across the tile            |              |          46% (12–78%) |                 |                          |
| 1/8° windows                        |           43 |          45% (29–74%) |              43 |             47% (30–76%) |
| 1/32° windows                       |          216 |          37% (18–67%) |             229 |             39% (22–70%) |
| 1/128° windows                      |        1,737 |          34% (15–63%) |           1,995 |             36% (18–66%) |
| 1/256° windows                      |        5,886 |          33% (15–62%) |           6,935 |             35% (18–65%) |
| Quadtree, leaves ≤ 1M               |           98 |          42% (18–75%) |             101 |             44% (22–78%) |
| Quadtree, leaves ≤ 250k             |          342 |          38% (16–70%) |             350 |             40% (19–73%) |
| Quadtree, leaves ≤ 100k             |          677 |          37% (16–68%) |             694 |             38% (19–70%) |

These count arrivals only. A day whose tide levels or offsets move, or that adds tide cells, also dirties the leaves the moved files cross (see [What reruns](#what-reruns)), so they are a floor.

That table counts each sounding once, however many units read it. Jobs don't: each reads its own unit and the reach around it, so where small leaves sit side by side in a busy harbour, each sounding there is read by every leaf within reach of it. [share.py](../../../packages/grid/spikes/subtile/share.py) replays the same 30 days through the package's own partition and dirty test (`leaves.partition`, `leaves.dirty`), with the reaches as built, 78 base rows for cells and 110 for surfaces, and sums what each dirty leaf's job reads: cells their own tile's soundings within reach, surfaces every tile's. A floor on a leaf's size trades dirt against reread halos. Medians over the 30 days, with the range, of all 98.5M soundings:

| Least leaf, steps a side | Leaves | Cells: read by jobs | Surfaces: read by jobs | Cells: read once | Surfaces: read once |
| ------------------------ | -----: | ------------------: | ---------------------: | ---------------: | ------------------: |
| 1 (6″)                   |  1,316 |     573% (388–697%) |       855% (593–1027%) |              37% |                 39% |
| 18                       |    878 |       70% (35–130%) |         100% (51–180%) |              38% |                 39% |
| 37                       |    686 |        52% (24–97%) |          63% (36–121%) |              39% |                 41% |
| 75 (1/8°)                |    485 |        50% (33–85%) |           56% (36–96%) |              43% |                 45% |
| 150                      |    326 |        54% (31–79%) |           62% (33–86%) |              52% |                 56% |
| 1° tile                  |    212 |                 76% |                    90% |                  |                     |

So leaves never split below 75 steps (`leaves.MIN_STEPS`), 1/8° on the Chesapeake. Most of the gain is in the busiest tiles: Norfolk's 28M soundings become 16 leaves of 1/8°, of which a day still dirties most.

### Leaves against whole tiles

The whole Chesapeake store built by `grid tiles` twice with the same code, once in leaves (485, in 10 split tiles) and once with every tile one leaf, then compared tile by tile ([runs_compare.py](../../../packages/grid/spikes/subtile/runs_compare.py)): all 212 tiles' cells, shoals and cell-level flags match row for row, and all five bands of every surface pixel for pixel. A leaf with none of its tile's soundings still draws the band beside a neighbor tile's track, as the whole tile does. A surface pixel with no soundings has no data in the soundings band, rather than 0, so a leaf's splice, which writes only the blocks a leaf has data in, reads the same as the whole tile.

On 18 cores, the leaf build took 13 min and the whole-tile build 22. Leaf jobs' time summed to 1,720 s for cells and 3,711 s for surfaces, against 1,829 s and 4,630 s for whole tiles: a split tile's leaves cost about what the tile does for cells (Norfolk's 16 leaves 272 s against 231 s), and less for surfaces where the tile's fixed cost goes (45824's 31 leaves 187 s against 352 s). The densest leaves set the run's critical path: Norfolk's busiest cells leaf took 117 s and its surface 294 s, against 231 s and 557 s for the whole tile. In a Linux cgroup of their own (OrbStack, with the threads the pipeline gives them), the ten heaviest leaf jobs peaked at 1.04–1.57 GB anon: Norfolk's busiest leaf, 16M soundings within its reach, at 1.57 GB for cells and 1.50 GB for its surface, against 1.74 and 1.71 GB for the whole tile. Its cells job also finished under a 2 GB limit.

### Why the floor is about a third

One tile holds most of what's left. [dirty.py](../../../packages/grid/spikes/subtile/dirty.py) counts a tile's soundings per window and marks the windows within about 610 m of a day's new soundings in that tile. In Norfolk's tile (45463, 28M soundings), at 1/128° windows, the arrivals of five sample days dirtied 21–25M of its soundings, 74–88%, while in 45823 and 46183 the same days dirtied 0.1–5.8M of 15–17M. Norfolk's soundings sit in a few square kilometres of harbour: two 1/8° windows hold 24M of them, and the busiest 1/256° window (about 430 by 350 m) holds 0.8M. One vessel logged 14M of the tile's soundings and works it daily, so each day's track runs over most of the busy water again. It isn't moorings: capping each vessel at 10 soundings per 10 m cell per day still keeps 24.6M.

The planet's densest tiles look like this. Half its soundings sit in 42 tiles, led by Galveston and Houston, the Louisiana coast and the lower Mississippi ([planet-size.md](planet-size.md)): ports and rivers worked daily by the same tugs, pilots and ferries.

### Replaying the last arrival day

[window.py](../../../packages/grid/spikes/subtile/window.py) runs a tile's cells or surface job as `grid tiles` does, on the run's frozen catalog, with additions that need no changes to the package. It can hide a day's arrivals, which read as withdrawn. That is the state before the day only when the day superseded no older file, which holds for 2026-10-15, and it keeps the offsets, stuck runs and tide as they stood after the day: the replay measures new files, not the calibration and tide they moved. It can keep only the points within a halo of a window. And it can replace `statistic.nearest` with one bounded to N pixels that takes the largest value among the pixels at the nearest distance. Cells read a halo of 0.004° (440 m north–south), surfaces 0.006°. [compare.py](../../../packages/grid/spikes/subtile/compare.py) and [surfdiff.py](../../../packages/grid/spikes/subtile/surfdiff.py) compare the outputs inside each window. Every surface takes its neighbors' cell-level flags from one earlier full run.

Tile 45824 (2.8M soundings) took 5,530 new soundings in a strip along its south edge; the window is that strip, 1/32° by 9/32°. Tile 46183 (14.7M soundings) took 245,885 in 165 of its 1/32° windows; four of them were rebuilt, the densest (934k soundings) among them.

| Inside the window                                        | Cells                                                    | Flags     | Surface                                                                                                                        |
| -------------------------------------------------------- | -------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 45824, unbounded fallback, k-d tree ties                 | 6 of 13,982 cells differ, in σ, by up to 0.17 m in depth | identical | coverage, distance and counts identical; σ differs in 8.9% of pixels, depth by more than 0.1 m in 1.4% and by up to 5.9 m      |
| 46183, 4 windows, unbounded fallback, k-d tree ties      | identical, row for row                                   | identical | coverage, distance and counts identical; σ differs in 7–11% of pixels, depth by more than 0.1 m in 0.4–2.7% and by up to 3.1 m |
| 45824, fallback within 25 px, ties to the largest spread | identical                                                | identical | identical in all five bands                                                                                                    |
| 46183, one window, the same                              | not rebuilt                                              |           | identical in all five bands                                                                                                    |

Every difference was σ's fallback. The differing pixels sat next to soundings (a median 16 m away), spread through the window rather than along its edge, with the same votes, distances and coverage, and the worst were interpolated pixels whose σ flipped between about 0.3 and 3.5 m: equally near pixels with different spreads, picked differently by two k-d trees. Bounding the fallback alone changed nothing inside the window; settling ties made it exact. Two builds of the same full tile are byte-identical, so the package is deterministic, just not local. In one 46183 window the counts band also differed in 3,042 pixels with no depth in either: the full build wrote a 512-pixel block there that the window didn't.

Time and memory per job, with 4 DuckDB threads:

| Job                                |               Soundings read |  Seconds |     Peak RSS |
| ---------------------------------- | ---------------------------: | -------: | -----------: |
| 46183 cells, whole tile            |                        14.7M |      313 |       3.5 GB |
| 46183 cells, densest window        |                        1.10M |      2.7 |       1.4 GB |
| 46183 cells, three other windows   |                     20k–133k |  0.5–1.3 |   0.4–0.6 GB |
| 46183 surface, whole tile          | 14.7M and neighbors' margins |  123–141 |   3.5–4.5 GB |
| 46183 surface, four windows        |                    25k–1.17M |  2.2–4.3 |   1.4–1.8 GB |
| 45824 cells, whole tile / window   |                  2.8M / 108k | 91 / 1.0 | 2.5 / 0.5 GB |
| 45824 surface, whole tile / window |                       / 145k | 51 / 2.5 | 2.6 / 1.3 GB |

These ran alongside another session's R2 ingest on an 18-core Mac Studio, so treat them as relative. A window costs about a tenth of its tile per sounding: 2.5 s per million soundings for 46183's densest window's cells against 21 s for the tile. Part is the whole tile's own overheads (band units, σ for every pixel, the 1 GB limit spilling), and part is that the halo, on these windows, read 18% more soundings than the window held. A surface window's fixed cost is about 2 s and 1.3 GB, mostly whole-tile arrays that `surface.grid_tile` sizes to the tile, not the window.

## Design

### Leaves

Each tile whose active soundings pass 1M is split into a quadtree whose leaves hold at most 250k soundings or are too small to split, a node under 150 steps either way, keyed by quadkey within the tile (`leaves.partition`); every other tile is one leaf. Leaf edges fall on whole 6″ steps, 18 base rows or columns: two consensus blocks of 9 and nine surface pixels of 2, so no block, cell or pixel straddles two leaves. A tile is 600 steps tall and 600/k wide, where k is its column width in base steps, so a split rounds its midpoint to a step and leaves needn't be square; where k is 5 or more (past about 77°) a tile is under 150 steps wide and stays one leaf, as it does past about 86°, where k doesn't divide 600. A cell, flagged sounding or shoal belongs to the leaf holding its base row and column.

Leaves split once they pass the bound and merge back only under a quarter of it, so a day's arrivals rarely change the partition. The partition is kept in the run directory (`RUN/baseline/partitions.json`) with each leaf's soundings and those within its surface's reach, which size its jobs. A tile is cut again when its leaves' counts no longer add up to its own, and a split or merge removes the old leaves' outputs and rebuilds the new ones whole. On the Chesapeake that is 485 leaves in 10 split tiles. Snakemake planned a day of 17,000 jobs over 25,000 tiles in 46 s ([per-tile-pipeline.md](per-tile-pipeline.md#measured-with-snakemake)), and planning time follows the graph, not the dirty jobs; a planet graph of leaves hasn't been planned.

Quadtree over fixed windows because leaves follow density: open water stays in large leaves and only busy water splits, down to the floor. The floor is what keeps reread halos from swamping the saving ([Dirty share](#dirty-share-over-30-days)); with it, Norfolk's leaves hold millions of soundings each, and their jobs cost about what whole tiles of that size do.

A leaf's cells read its tile's points within the cells' reach of it, and its surface the votes within the surface's reach, its tile's and its neighbors'. Cells read their own tile only, as whole tiles do, so leaves build what whole tiles build and the seams between tiles stay as they are. Reading cells across tile edges as within them is the seam fix: consensus, σ and the surface would see a neighboring tile's soundings as they see the next leaf's, and a 1° edge would draw like any other line. That changes what cells build, and is the next change ([backlog.md](backlog.md)).

### σ's fallback is local

The fallback spread comes only from a pixel closer than 25 pixels, otherwise none, and among the pixels at the nearest distance the largest (`statistic.nearest`). The corrections' σ is taken the same way, and with none in reach is an uncorrected sounding's, √(0.5² + 1²), though no pixel within the 200 m search radius lacks one. Within 25 pixels at most 24 grid points lie at any one distance from a pixel, so 32 candidates always hold every tie. Without the bound one day's track moves depths kilometres away; without the tie rule a window and a tile disagree beside every lone track.

On tile 45824 the two together change 1,040 of its 304,360 cells, σ in 15% of its 2.9M surface pixels, and depth by more than 0.1 m in 40,344 pixels: 38,447 shoaler, 1,897 deeper, and up to 30 m where a pixel's only spread lay out of reach. Most of that is the tie rule, which takes the largest of the tied spreads where the k-d tree took any one; the bound alone moves depth by more than 0.1 m in 1,911 pixels. A neutral rule, the pixel with the least row and then column, moves 27,061: 12,601 shoaler, 14,460 deeper.

Against the benchmark, over the Chesapeake's 8.2M reference pixels ([variant.py](../../../packages/grid/spikes/subtile/variant.py) rebuilds every tile under each rule):

| Rule                                    | Overall: >1 m too deep | Overall: >2 m false shoal | Interpolated: >1 m too deep | Interpolated: >2 m false shoal | No vessel: >1 m too deep | No vessel: >2 m false shoal |
| --------------------------------------- | ---------------------: | ------------------------: | --------------------------: | -----------------------------: | -----------------------: | --------------------------: |
| Within 25 px, ties to the largest       |                 10.19% |                     5.60% |                      10.12% |                         17.61% |                   11.34% |                       9.80% |
| Within 25 px, ties to least row, column |                 10.20% |                     5.59% |                      10.53% |                         16.85% |                   11.64% |                       9.26% |
| Unbounded, k-d tree ties                |                 10.19% |                     5.63% |                      10.48% |                         16.81% |                   11.63% |                       9.23% |

The rules differ only where the surface interpolates or no vessel sounded: there, ties to the largest spread draw 0.3–0.4 points fewer pixels more than 1 m too deep, at 0.5–0.8 points more false shoals. Too deep is the costlier error, so ties go to the largest spread. A lone track far from any measured spread gets σ from its corrections alone; the benchmark's single-vessel pixels move by no more than 0.04 points between the rules, so they take no floor.

### What reruns

Every part of a tile's fingerprint ([manifest.py](../../../packages/grid/src/grid/manifest.py)) but one belongs to files: a file's own key, content and status, its batches' QC version, its offsets, the stuck runs on its content, the Open Waters files that take over its soundings, and the tide levels on its days at its tile's stations. `manifest.FILE_PARTS` gives those parts per file and tile, and a tile's fingerprint sums them. `prepare` keeps them in `RUN/baseline/files.parquet` and diffs them against the last run's to find the changed files. A changed file is placed by the 6″ steps its soundings in each tile fall in, read from the store by file id; one whose soundings left the store by its whole tile. A leaf's cells are dirty when a change in its own tile lands within their reach, since they read no other, and its surface when one in its tile or a neighbor does. A leaf next to a tile edge can therefore be dirty while its own tile's fingerprint stands still.

The one part that isn't a file's is the tile's tide cells, their stations and distances, kept per tide cell (`manifest.CELL_PARTS`, `RUN/baseline/tide_cells.parquet`): a cell that's added or changes station dirties the leaves within reach of its 1/50° box, as a changed file does. A day's arrivals add tide cells as they reach new water (five in one tile on the Chesapeake's last day), so tile-wide this part would dirty whole tiles most days.

What belongs to no file or tide cell dirties every leaf: `QC_VERSION`, `GRID_VERSION`, the cells code (`manifest.constants`) and the leaves' bounds, and a missing baseline, as on the first run after upgrading. A leaf the last partition didn't have is dirty, and a change to the rest of the code reruns every job through Snakemake (`tiles.code()`). A stuck run recorded without a tile belongs to every file holding its content. The baseline is written last, so a prepare that stops partway marks the same leaves again.

Withdrawals need nothing extra: a withdrawn file is a changed file, its soundings still in the store. A copy that takes another file's soundings over has the same positions, but the file it took them from holds none, so that file marks its whole tile: correct, at the cost of rebuilding the tile. A calibration change dirties every leaf a vessel's moved segment crossed, and a revised tide level every leaf of the files on that day near that station; for a busy vessel or gauge that is most of a tile, as at 1°.

The store is sorted by tile, latitude and longitude, so a leaf's read prunes row groups to its latitude strip; within a dense tile that strip spans the tile's width. On the Chesapeake that is cheap next to the work. If R2 reads prove otherwise, sort within a tile by quadkey.

### Jobs

| Job                | Unit                                               | Reruns when                                     | Writes                                                                                  |
| ------------------ | -------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| leaf_cells         | leaf                                               | a change in its tile within the cells' reach    | `leaves/{tile}/{quadkey}/` cells, shoals and flags, the rows the leaf owns              |
| cells              | 1° tile                                            | any of its leaves' cells reran                  | `cells/`, `shoals/` and `flags/{tile}.parquet`, the leaves' rows in one file each       |
| leaf_surface       | leaf                                               | a change in or beside its tile within its reach | `leaves/{tile}/{quadkey}/surface.tif`, a tile's raster whose leaf pixels are the leaf's |
| surface            | 1° tile                                            | any of its leaves' surfaces reran               | `surface/{tile}.tif`, the leaves' pixels                                                |
| overlay            | 1° tile                                            | its surface or a neighbor's cells reran         | as for whole tiles                                                                      |
| web, low, assemble | as in [per-tile-pipeline.md](per-tile-pipeline.md) |                                                 |                                                                                         |

Each leaf's cells and surface have fingerprint files of their own, `RUN/fp/{tile}/{quadkey}.cells` and `.surface`, rewritten only when a change lands within their reach. A leaf's cells job needs only points, so no cells job waits on another. A leaf's surface reads the cell-level flags of its tile and its neighbors, from their spliced files, so it runs after their cells. It must not rebuild just because one of them reran: that would rebuild every surface within reach of a rerun leaf's whole box, not of the change. Snakemake reruns it after them, and a job whose fingerprint and code are the ones it last built from (`surface.fp` beside its raster) does nothing and is logged as unchanged. Snakemake's `ancient()` can't do this: it never checks the fingerprint of a job downstream of one that reruns.

The splices write the tile files every reader takes, so the overlay, `publish`, `tiles.has_cells` and a neighbor's overlay read them as they do whole tiles' files. A tile of one leaf has its leaf's files copied as they are. A split tile's surface copies each leaf's own pixels into the tile's raster, not whole 512-pixel blocks, since blocks don't line up with leaves; a block no leaf wrote any data into stays out of the COG.

The overlay stays per tile. Its depth areas are traced and unioned across the tile, and a window's polygons would have to be stitched at its edges; on the Chesapeake the overlay is 23% of the surface and overlay stages' time, so it keeps that share of a dirty tile's cost. Web jobs stay per z8 tile.

### Where it lives

- [leaves.py](../../../packages/grid/src/grid/leaves.py): the partition, the reaches and the dirty test.
- `tiles.plan`, run by `prepare`: the partition, the diff against the baseline, and the leaves' fingerprints. `tiles.do_leaf_cells` and `do_leaf_surface` build a leaf from the points within its reach (`tiles.within`), copying in only those points' flags; `do_cells` and `do_surface` splice. `tiles.forget` removes a gone tile's leaves with its files, and `plan` removes leaves a split or merge did away with, and any an older build left of a tile no longer live.
- `surface.tile_entries`: with `alone` false, a leaf whose box holds none of its tile's soundings still grids its neighbors'.
- `statistic.nearest` and `sigma_at`: the bounded fallback with ties to the largest spread.
- `manifest.FILE_PARTS` and `CELL_PARTS`: the parts of each tile's fingerprint per file and per tide cell.
- Upgrading and rolling back: the tile files keep their names and readers, and `fp/{tile}.txt` is still written. A change of build either way changes `tiles.code()`, which Snakemake reruns jobs on, and the first leaf run has no baseline, which dirties every leaf. An older build ignores `leaves/`, `fp/{tile}/` and `baseline/`; the next leaf run diffs against the baseline it last wrote, so the leaves what changed meanwhile reaches are rebuilt, and the splices, which the older build's tile jobs replaced, rerun and write the tile files from the leaves again.
- Not done here: `surface.grid_tile` still sizes its sparse COG and `Sounded` to the tile, not the leaf.

## Hot spots

What's left after leaves is mostly a few harbours where the same vessels cross the same water every day. Two directions, neither measured here:

- **Keep per-vessel summaries.** The surface's input is one vote per vessel and pixel. Keeping each vessel's votes per pixel (or the per-file medians `grid calibrate` already keeps) and recomputing only vessels with new soundings would make a day's surface work follow the new vessels. Cells are harder: a new vote changes the consensus that judges every other vessel's soundings in its blocks, so flags would have to come from per-block thresholds rather than be stored per sounding.
- **Thin redundant soundings at ingest.** A slow boat logs about three soundings per 10 m cell per day in Norfolk; one per vessel, cell and pass would cut the tile by up to a third. That changes what cells count and needs its own check.

## Planet estimate

From [rebuild-cost.md](rebuild-cost.md)'s model, the soundings of a full rebuild cost about 12 worker-hours in cells, 10.5 in surfaces and overlays and 4.2 in web tiles. A day at 1° rebuilds 65% for cells and 84% for the rest ([planet-size.md](planet-size.md)). Applying the Chesapeake's ratios of what a day's jobs read with leaves of at least 1/8° (50% against 76% for cells, 56% against 90% for surfaces), and keeping overlays (23% of the surface stage's time) and web jobs per tile:

| Worker-hours          | Today at 1° | With leaves |
| --------------------- | ----------: | ----------: |
| Cells                 |           8 |         5.3 |
| Surfaces and overlays |           9 |         6.4 |
| Web                   |         3.5 |         3.5 |
| Fixed per-tile cost   |       2–2.5 |       2–2.5 |
| Leaf jobs' own cost   |             |   about 0.5 |
| A day                 |    about 23 |    about 18 |

A leaf job costs about what its share of the tile does: on the Chesapeake the whole store in leaves took 1,720 job-seconds for cells against 1,829 in whole tiles, and 3,711 for surfaces against 4,630. The leaf jobs' own cost is the extra jobs, 2.3 a dense tile on the Chesapeake, each a fork, a DuckDB start and a catalog attach, plus the splices, about 0.3 s a tile. [rebuild-cost.md](rebuild-cost.md) gives 23–27 for today over its 30-day range. On 8 cheap cores (1.5× slower, 6× from 8 workers) about 18 worker-hours is about 4.5 h of wall time, against 6–7 h. It counts arrivals only, and rests on the Chesapeake's hot-spot share holding for the planet, which the Gulf's ports and rivers may well exceed.

## Not measured

- Latitudes where k is more than 1/cos(latitude), 48–60°N, where the east–west reach is widest, and the planet's dense tiles past 77°, which stay one leaf.
- A day's calibration and tide changes as leaves see them: the replays count arrivals only.
- Reading a leaf's points from DuckLake on R2, rather than a local store.
- A daily run on a store that moves: the leaf build here rebuilt every leaf, and the 30-day replay ran the dirty test without building.
- Leaves reading cells across tile edges, and the seams that would close.
- The planet's hot spots. Its densest tiles are rivers and ports this store doesn't have.
- Timings without other jobs on the machine.
