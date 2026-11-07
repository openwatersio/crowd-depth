# Sub-tile rebuild

How a daily `grid tiles` run can rebuild only the parts of a dense 1° tile that new data touched, and how that design also closes the seams between tiles. Measured on the Chesapeake store by replaying its last 30 arrival days, and by rebuilding tiles 45824 and 46183 whole and in windows for the last of them (2026-10-15, 365 files).

Short answer: rebuild dense tiles in quadtree leaves with a halo, and make the 1° tile edge just another leaf edge. Once σ's fallback has a bounded reach and settles ties between equally near pixels by their values, the windows rebuilt here match a full rebuild byte for byte inside them, and a window costs about a tenth of its tile per sounding. But leaves don't make a day as cheap as [rebuild-cost.md](rebuild-cost.md) assumed. On the Chesapeake a day's new files dirty leaves holding a median 38% of all soundings for cells and 40% for surfaces, against 76% and 90% at 1°, not a few percent. New data lands where the data already is at every scale down to 400 m: in Norfolk's tile one vessel logged half the soundings, crossing the same harbour daily. A planet day comes to about 17 worker-hours instead of 23, and more on days when tide or calibration moves. Getting further needs the hot spots handled differently, which is a separate change.

## What a sounding reaches

A leaf can be rebuilt alone if it reads every input its outputs depend on, and it must be rebuilt when a change lands within reach of its outputs. These reaches come from the code; the replay confirms them.

| Step                                                                      | Reads around each output                                                                             | Reach                                                                                        |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Consensus (`cells.CONSENSUS`)                                             | votes of the 3×3 blocks of 3″ around a sounding's block                                              | 1 block, 93 m; a new sounding changes flags up to 2 blocks away, about 260 m on the diagonal |
| Levels, cell statistics                                                   | the 1″ or 3″ cell, aligned to blocks                                                                 | none past the block                                                                          |
| Vote smoothing, σ window, outvoted shoals (`statistic`, `cells.OUTVOTED`) | 1 + 2 pixels, and the 3×3 pixels                                                                     | 62 m                                                                                         |
| σ fallback (`statistic.sigma_at`)                                         | the nearest pixel with a measured spread, anywhere in the tile, ties picked by the k-d tree's layout | unbounded                                                                                    |
| Surface interpolation (`surface.ALGORITHM`)                               | votes within 200 m                                                                                   | 200 m                                                                                        |
| Blur, band beside a track, shoal guard                                    | 8 px, 40 m, 1 px                                                                                     | 165 m                                                                                        |

Without the fallback, cells depend on points within about 330 m and the surface on votes within about 430 m. A pixel whose 5×5 window holds fewer than three votes, and every interpolated pixel, takes its spread from the nearest pixel that has one, however far. Where several pixels are equally near, `cKDTree` returns whichever its layout finds first, and the layout depends on every pixel in the build. Pixels sit on a grid, so ties are common, and the candidates' spreads can differ tenfold (0.3 against 3.5 m beside a lone track).

On the replay, every cell-level flag that changed lay within 166 m of a new sounding in tile 45824 and 225 m in 46183. But cells changed up to 89 km away in 45824 and 5.8 km in 46183, surface pixels up to 117 km away, and 60 cells of 45824 more than 1 km from any new sounding moved by up to 1.22 m in depth. A 1° tile rebuild has this too; it just never looks outside the tile.

With the fallback taken only from pixels closer than 25 pixels (about 515 m), and the largest spread among those at the nearest distance, every step is local. A cell's σ can then come from a pixel 515 m away, whose own spread reads votes 2 pixels further and whose votes' flags read consensus 2 blocks further: about 0.007° in all. The surface adds interpolation and blur to the fallback: about 0.009°. What an output reads is also what can change it, so a leaf's cells are dirty when a change lands within 0.007° of it and its surface within 0.009°, and those are the halos it reads. They are counted in rows and in base columns, not in metres: east–west every reach is k times wider in degrees, where k is the tile's column width in base steps (`cells.k_for`), 1 on the Chesapeake and 2 from 48°N to 66°N. A smaller fallback bound shrinks both.

The replay stayed well inside those reaches: with the bound and tie rule the same day changed cells no farther than 415 m from a new sounding (99th percentile 205 m) and surface pixels no farther than 1,064 m (99th percentile 659 m), and windows read with halos of 0.004° and 0.006° matched, since none of their pixels fell back farther.

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

### Why the floor is about a third

One tile holds most of what's left. [dirty.py](../../../packages/grid/spikes/subtile/dirty.py) counts a tile's soundings per window and marks the windows within about 610 m of a day's new soundings in that tile. In Norfolk's tile (45463, 28M soundings), at 1/128° windows, the arrivals of five sample days dirtied 21–25M of its soundings, 74–88%, while in 45823 and 46183 the same days dirtied 0.1–5.8M of 15–17M. Norfolk's soundings sit in a few square kilometres of harbour: two 1/8° windows hold 24M of them, and the busiest 1/256° window (about 430 by 350 m) holds 0.8M. One vessel logged 14M of the tile's soundings and works it daily, so each day's track runs over most of the busy water again. It isn't moorings: capping each vessel at 10 soundings per 10 m cell per day still keeps 24.6M.

The planet's densest tiles look like this. Half its soundings sit in 42 tiles, led by Galveston and Houston, the Louisiana coast and the lower Mississippi ([planet-size.md](planet-size.md)): ports and rivers worked daily by the same tugs, pilots and ferries.

### Replaying the last arrival day

[window.py](../../../packages/grid/spikes/subtile/window.py) runs a tile's cells or surface job as `grid tiles` does, on the run's frozen catalog, with additions that need no changes to the package. It can hide a day's arrivals, which read as withdrawn. That is the state before the day only when the day superseded no older file, which holds for 2026-10-15, and it keeps the offsets, stuck runs and tide as they stood after the day: the replay measures new files, not the calibration and tide they moved. It can keep only the points within a halo of a window. And it can replace `statistic.nearest` with one bounded to N pixels that takes the largest value among the pixels at the nearest distance. Cells read a halo of 0.004° (440 m north–south), surfaces 0.006°. [compare.py](../../../packages/grid/spikes/subtile/compare.py) and [surfdiff.py](../../../packages/grid/spikes/subtile/surfdiff.py) compare the outputs inside each window. Every surface takes its neighbors' cell-level flags from one earlier full run.

Tile 45824 (2.8M soundings) took 5,530 new soundings in a strip along its south edge; the window is that strip, 1/32° by 9/32°. Tile 46183 (14.7M soundings) took 245,885 in 165 of its 1/32° windows; four of them were rebuilt, the densest (934k soundings) among them.

| Inside the window                                        | Cells                                                    | Flags     | Surface                                                                                                                        |
| -------------------------------------------------------- | -------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 45824, as the package is                                 | 6 of 13,982 cells differ, in σ, by up to 0.17 m in depth | identical | coverage, distance and counts identical; σ differs in 8.9% of pixels, depth by more than 0.1 m in 1.4% and by up to 5.9 m      |
| 46183, 4 windows, as the package is                      | identical, row for row                                   | identical | coverage, distance and counts identical; σ differs in 7–11% of pixels, depth by more than 0.1 m in 0.4–2.7% and by up to 3.1 m |
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

Split each tile whose active soundings pass 1M into a quadtree whose leaves hold at most 250k soundings, keyed by quadkey within the tile; every other tile is one leaf. Leaf edges fall on whole 6″ steps, 18 base rows or columns: two consensus blocks of 9 and nine surface pixels of 2, so no block, cell or pixel straddles two leaves. A tile is 600 steps tall and 600/k wide, where k is its column width in base steps, so a split rounds its midpoint to a step and leaves needn't be square. Past about 86°, where k doesn't divide 600, a tile stays one leaf. A cell, flagged sounding or shoal belongs to the leaf holding its base row and column, half-open on the leaf's north and east edges.

Leaves split once they pass the bound and merge back only under a quarter of it, so a day's arrivals rarely change the partition. The partition is kept per tile in the run directory (`RUN/leaves/{tile}/partition.json`), and a split or merge removes the old leaves' outputs and rebuilds the new ones whole. At 250k the Chesapeake has a few hundred leaves and the planet about 8,000 or more (1.96B ÷ 250k, plus under-full leaves). Snakemake planned a day of 17,000 jobs over 25,000 tiles in 46 s ([per-tile-pipeline.md](per-tile-pipeline.md#measured-with-snakemake)), and planning time follows the graph, not the dirty jobs; a graph of leaves, with surfaces depending on leaves across tile edges, hasn't been planned.

Quadtree over fixed windows because the leaf bound keeps most jobs well under 2 GB and short, while fixed windows either leave Norfolk's 3.4M-sounding 1/64° windows as they are or cut Chesapeake Bay's open water into thousands of tiny jobs. The dirty share is within a few points of fixed windows of the same job count. The bound is on the leaf, not its halo: in Norfolk a 0.007° halo around a small leaf spans several of the busiest 1/256° windows, up to a few million soundings, so the densest harbour's jobs still need measuring against 2 GB.

A leaf's cells read the points within 0.007° of it, and its surface the votes within 0.009°, **across tile edges as within them**. That is the seam fix: consensus, σ and the surface see a neighboring tile's soundings exactly as they see the next leaf's, so a 1° edge draws like any other line. Cells then depend on their neighbors' points, which is the change [backlog.md](backlog.md) asked to design here.

### Make σ's fallback local

Take the fallback spread only from a pixel closer than 25 pixels, otherwise treat it as unmeasured, as `statistic.sigma_at` already does for a tile with no measured spread anywhere, and among the pixels at the nearest distance take the largest spread. `sigma_at` takes the corrections' σ the same way, and the prototype bounds both; a bounded correction σ with nothing in reach must fall back to the corrections' own default rather than NaN, which no pixel within today's 200 m search radius reaches. Within 25 pixels at most 24 grid points lie at any one distance from a pixel. Without the bound one day's track moves depths kilometres away; without the tie rule a window and a tile disagree beside every lone track.

On tile 45824 the two together change 1,040 of its 304,360 cells, σ in 15% of its 2.9M surface pixels, and depth by more than 0.1 m in 40,344 pixels: 38,447 shoaler, 1,897 deeper. Most of that is the tie rule, which takes the largest of the tied spreads where the k-d tree took any one; the bound alone moves depth by more than 0.1 m in 1,911 pixels. A neutral rule, such as the pixel with the least row and column, would move less and still be local; the largest spread is the cautious choice, and the benchmark should decide between them. The bound also needs its own check: a lone track far from any measured spread then gets σ from its corrections alone, which may draw it deeper. If it does, give those pixels a floor (the 0.5 m `untided_sigma_m` in the definitions is one candidate) rather than a farther pixel's spread. This changes cells' and surfaces' depths, so it bumps `GRID_VERSION`; batch it with the seam change, which bumps it too.

### What reruns

Every part of a tile's fingerprint ([manifest.py](../../../packages/grid/src/grid/manifest.py)) but one belongs to files: a file's own key, content and status, its batches' QC version, its offsets, the stuck runs on its content, the Open Waters files that take over its soundings, and the tide levels on its days at its stations. So `prepare` keeps those parts per file and tile, not summed per tile, in `RUN/fp/{tile}/files.parquet`, and diffs them against the last run's to find the changed files. A leaf's cells are dirty when a changed file, in its own tile or any other, has a sounding within 0.007° of it, and its surface within 0.009°. The changed files' positions come from the store by file id, reading only the `file_id`, `lat` and `lon` columns of the tiles they touch. A leaf next to a tile edge can therefore be dirty while its own tile's fingerprint stands still.

The one part that isn't a file's is the tile's tide cells, their stations and distances (`stations`). Keep it per tide cell: a cell that's added or changes station dirties the leaves within reach of it, as a changed file does. A day's arrivals add tide cells as they reach new water (five in one tile on the Chesapeake's last day), so tile-wide this part would dirty whole tiles most days.

What belongs to no file or tide cell dirties every leaf: the code, `QC_VERSION`, `GRID_VERSION`, and a split or merge, its old and new leaves. So does a missing or unreadable per-file baseline, as on the first run after upgrading. A stuck run recorded without a tile belongs to every file holding its content.

Withdrawals and takeovers need nothing extra: a withdrawn file is a changed file, its soundings still in the store, and a copy that takes another file's soundings over has the same positions. A calibration change dirties every leaf a vessel's moved segment crossed, and a revised tide level every leaf of the files on that day near that station; for a busy vessel or gauge that is most of a tile, as today.

The store is sorted by tile, latitude and longitude, so a leaf's read prunes row groups to its latitude strip; within a dense tile that strip spans the tile's width. On the Chesapeake that is cheap next to the work. If R2 reads prove otherwise, sort within a tile by quadkey.

### Jobs

| Job                | Unit     | Reruns when                             | Writes                                                                                                             |
| ------------------ | -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| cells              | leaf     | a changed file within 0.007°            | `leaves/{tile}/{quadkey}/` cells, shoals and flags, the rows the leaf owns                                         |
| surface            | leaf     | a changed file within 0.009°            | `leaves/{tile}/{quadkey}/surface.tif`, the leaf's pixels                                                           |
| splice             | 1° tile  | any of its leaves reran                 | `cells/`, `shoals/`, `flags/{tile}.parquet` and `surface/{tile}.tif`, the leaves' rows and pixels in one file each |
| overlay            | 1° tile  | its splice or a neighbor's splice reran | as today                                                                                                           |
| web, low, assemble | as today | as today                                | as today                                                                                                           |

A leaf's cells job needs only points, so no cells job waits on another. A leaf's surface reads the cell-level flags of every leaf within its halo, its own tile's or a neighbor's, straight from those leaves' files, so it runs after their cells jobs. It must not rerun just because one of them did: today a surface reruns whenever a neighbor's cells job does (`Snakefile`'s `around`, with `--rerun-triggers mtime params input`), and with leaves that would rerun every surface within 0.009° of a rerun leaf's whole box, not of the change. So each leaf's cells and surface get fingerprint files of their own, `RUN/fp/{tile}/{quadkey}.cells` and `.surface`, rewritten only when a change lands within their reach, as `fp/{tile}.txt` is now, and a surface takes its neighbors' cells sentinels as `ancient()` inputs, which order the jobs without rerunning them. The `fp/{tile}/` directory keeps them out of `prepare`'s `fp/*.txt`.

The splice writes the tile files every reader takes today, so the overlay, `publish`, `tiles.has_cells` and a neighbor's overlay need no change. It copies each leaf's own pixels into the surface, not whole 512-pixel blocks, since blocks don't line up with leaves; a block no leaf wrote any depth into stays out of the COG.

The overlay stays per tile. Its depth areas are traced and unioned across the tile, and a window's polygons would have to be stitched at its edges; on the Chesapeake the overlay is 23% of the surface and overlay stages' time, so it keeps that share of a dirty tile's cost. Web jobs stay per z8 tile.

### Changes needed in the package

- `cells.build`: build only the cells, flags and shoals a leaf owns, from points read within its halo. Today it reads one tile's points through `corrected_points_in(partition, tiles, rlo, rhi)`; it needs a box and points from up to four tiles, and its exports keep only the rows the leaf owns. Consensus already reads its band's rows ±9; the halo replaces that.
- `surface.tile_entries` and `grid_tile`: entries within a box and its halo, from any tile, and only the leaf's pixels written. The whole-tile arrays (`Sounded`, the sparse COG) should be sized to the leaf, which removes most of a small job's 1.3 GB.
- `statistic.nearest` and `sigma_at`: the bounded fallback with ties to the largest spread, as [window.py](../../../packages/grid/spikes/subtile/window.py) patches it.
- `manifest.fingerprints`: parts per file and tile as well as summed per tile.
- `tiles.py` and the Snakefile: leaves and their partition, the leaf fingerprints, the splice job, and per-leaf outputs and their removal on a split. `tiles.forget` removes `leaves/{tile}/` and `fp/{tile}/` with the tile files, so a tile emptied by withdrawals leaves no leaf behind for a neighbor's halo to read.
- Upgrading and rolling back: the tile files keep their names and readers, and `fp/{tile}.txt` is still written. A change of build either way changes `tiles.code()`, which reruns every job, so whatever leaf state an older or newer build left behind is rebuilt or ignored, and `prepare` treats a per-file baseline it didn't write in the last run as missing, which dirties every leaf. An older build ignores `leaves/` and `fp/{tile}/`, and on its gone tiles leaves them for the next leaf run's `forget`.
- `overlay.py`: none for leaves. The seams come from the surface, which then reads across edges.

## Hot spots

What's left after leaves is mostly a few harbours where the same vessels cross the same water every day. Two directions, neither measured here:

- **Keep per-vessel summaries.** The surface's input is one vote per vessel and pixel. Keeping each vessel's votes per pixel (or the per-file medians `grid calibrate` already keeps) and recomputing only vessels with new soundings would make a day's surface work follow the new vessels. Cells are harder: a new vote changes the consensus that judges every other vessel's soundings in its blocks, so flags would have to come from per-block thresholds rather than be stored per sounding.
- **Thin redundant soundings at ingest.** A slow boat logs about three soundings per 10 m cell per day in Norfolk; one per vessel, cell and pass would cut the tile by up to a third. That changes what cells count and needs its own check.

## Planet estimate

From [rebuild-cost.md](rebuild-cost.md)'s model, the soundings of a full rebuild cost about 12 worker-hours in cells, 10.5 in surfaces and overlays and 4.2 in web tiles. A day at 1° rebuilds 65% for cells and 84% for the rest ([planet-size.md](planet-size.md)). Applying the Chesapeake's ratios with 250k leaves (38% against 76% for cells, 40% against 90% for surfaces), and keeping overlays (23% of the surface stage's time) and web jobs per tile:

| Worker-hours          | Today at 1° | With leaves |
| --------------------- | ----------: | ----------: |
| Cells                 |           8 |         4.0 |
| Surfaces and overlays |           9 |         5.2 |
| Web                   |         3.5 |         3.5 |
| Fixed per-tile cost   |       2–2.5 |       2–2.5 |
| Leaf jobs' own cost   |             |     about 2 |
| A day                 |    about 23 |    about 17 |

The leaf jobs' own cost is about 40% of some 8,000 planet leaves rebuilt a day, at about 2 s for a surface and 1 s for cells, plus the splices. [rebuild-cost.md](rebuild-cost.md) gives 23–27 for today over its 30-day range. On 8 cheap cores (1.5× slower, 6× from 8 workers) about 17 worker-hours is about 4 h of wall time, against 6–7 h. It counts arrivals only, rests on the Chesapeake's hot-spot share holding for the planet, which the Gulf's ports and rivers may well exceed, and doesn't count a leaf's lower cost per sounding, measured at about a tenth of its tile's.

## Not measured

- The quadtree as jobs: splitting, snapping, splicing and the Snakefile. Every window here ran as a one-off job on a 1/32° grid.
- The design's halos (0.007° and 0.009°): the replay read 0.004° and 0.006°. And windows reading across a tile edge: the replay's cells read their own tile only.
- Latitudes where k is more than 1/cos(latitude), 48–60°N, where the east–west reach is widest.
- A day's calibration and tide changes: the replay hid new files only, keeping offsets, stuck runs and tide as after the day.
- The local fallback against the benchmark, and how it changes lone tracks.
- Days whose tide levels or offsets move, which dirty more than arrivals.
- Reading a leaf's points from DuckLake on R2, and the memory of Norfolk's leaves with their halos.
- A whole tile spliced from leaves, as against windows checked one at a time.
- Cells and surfaces reading across tile edges, and whether leaves leave seams of their own.
- The planet's hot spots. Its densest tiles are rivers and ports this store doesn't have.
- Timings without other jobs on the machine.
