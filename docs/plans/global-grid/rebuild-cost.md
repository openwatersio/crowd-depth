# Rebuild cost

Can the planet be rebuilt daily on cheap hardware? Not with the pipeline as it stands, but probably with four targeted changes to a per-tile design. Three spikes on the Chesapeake set (98.5M active soundings, 18,434 files, 212 1° tiles) show where the time goes. The store layout and QC are not the bottleneck. Two costs are: new data landing in the same dense harbor tiles every day, so rebuilding at 1° granularity re-processes most of the data daily, and a full-size raster for every 1° tile however empty it is. Across the whole NOAA archive the first is the larger: it covers 7,295 tiles, and a day's arrivals touch tiles holding two thirds of its soundings ([planet-size.md](planet-size.md)).

Details are in [store-layout.md](store-layout.md), [qc-functions.md](qc-functions.md), [per-tile-pipeline.md](per-tile-pipeline.md) and [planet-size.md](planet-size.md). The work that follows from them is in [backlog.md](backlog.md).

## Summary of the spikes

**Store layout.** One table sorted by 10° cell and then tile, with row groups of about 123k rows, reads about as efficiently as physically separate per-tile files: 1.26× read amplification over a full rebuild, against 1.0×. In ingest order, row groups cross a median of 6 tiles, so a full rebuild reads the store 6.8 times over. `grid cells` can query one store per cell, as long as the store is compacted in tile order and daily appends are sorted. Dropping the stored `point_id` saves 47% of bytes, and putting `tile_id` on `qc_flags` lets flag reads prune by tile.

**QC as pure functions.** Track QC runs as numpy ([qc.py](../../../packages/grid/src/grid/qc.py)), with flags matching the day-split SQL's on the whole Chesapeake store (98.5M soundings) apart from stuck runs across UTC midnight. QC of that store takes 53 s against 204 s for the SQL, about 4 times faster on this laptop's cores; on NOAA's largest Chesapeake file (3.5M soundings) ingest's QC takes 0.9 s against 5.0 s, with about 420 MB more memory. Its TypeScript port shares thresholds and test vectors as JSON.

**Per-tile pipeline.** It works end to end and matches a single global run, apart from tie-breaking noise in `placed`:

- cells per 1° tile;
- the surface per 1° tile, plus a 450 m strip from each neighbor;
- web tiles per z8 tile, whose z8–z15 subtree is disjoint from every other;
- one low-zoom run for z0–7;
- assembly by copying tile bytes into one PMTiles archive, in 1.3 s.

Chesapeake takes 1 h 53 m serially and 81 min with 4 workers on a shared laptop. Its limits:

- **A daily run costs about 75% of a full rebuild.** Over the last 30 arrival days, the 3–15 tiles touched each day held 47–86% of all soundings (median 76%).
- **Memory.** Surfaces peak at 3–4.5 GB, past the 2 GB budget per work unit. Full-tile rasters alone take about 1.7 GB.
- **Seams.** Coverage stops at a tile edge on one side in 28% of samples, and depth bands disagree across an edge in 9.4%. A single global run draws the same seams, so they come from the per-tile surface, not from the split.

## Current design

- **Ingest.** The Chesapeake import to R2 loaded 97.2M points from 18,066 new files in 5 h 19 min, with a peak of 1.65 GB. Seconds per step: list 45, download wait 536, parse 2,644, dedupe 574, write 2,507, QC 630, coverage 9,724. Coverage, a per-file query against every other file's time range, is half the wall time. The run is one transaction, so one late R2 error discards everything; two attempts were lost that way after the machine slept.
- **`grid cells`.** A full rebuild at about 46 min per 100M soundings, which puts a planet rebuild at about 16–20 h with no incremental path. With the corroboration join fixed, the bay's build on R2 (8.0M measured cells and 2.8M filled, 20 units) takes 2 h 59 min, with DuckDB at 3.5 GB of a 4 GB limit and a peak RSS of 5.0 GB. The largest costs are hole filling (3,412 s), rereading each unit's active points (3,081 s) and deleting the old `qc_flags` (2,583 s); consensus takes 692 s.

The per-tile cells stage costs about the same (36 min serially for Chesapeake). Splitting by tile doesn't make the work cheaper. It makes the work partitionable, and so incremental and parallel.

## A planet day

This assumes 8 cores and 32 GB, and the measured archive from [planet-size.md](planet-size.md): 1.96B active soundings in 7,295 tiles, 42 of which hold half of them, and about 900 tiles touched a day. Costs use the per-tile model in [per-tile-pipeline.md](per-tile-pipeline.md#planet-extrapolation-8-cores-32-gb), with cheap cores 1.5× slower than this laptop's M-series cores and 8 workers giving 6×, and these inputs:

- **Cells:** 0.9 s per tile plus 22.7 s per million soundings, from a full Chesapeake build on main 42a9f95 (2,427 s for 98.5M soundings).
- **Surface:** 2.8 s per tile with empty space skipped, the median of the Chesapeake's tiles under 10k soundings, against 6.5 s for the whole raster. Of that 2.8 s, about 1.2 s builds the COG's overviews, which nothing in the pipeline reads yet; without them a tile takes about 1.6 s. Plus 19.4 s per million soundings, which skipping empty space doesn't change: dense tiles spend it in their soundings and depth areas.
- **Web tiles:** 1.3 s per tile plus 7.8 s per million.

A daily run rebuilds cells in the touched tiles, and surfaces and web tiles in those and their neighbors.

|                                                       | Worker-hours | Wall time on cheap cores |
| ----------------------------------------------------- | -----------: | -----------------------: |
| Full rebuild, whole rasters                           |           45 |                     11 h |
| Full rebuild, empty space skipped                     |           37 |                    9.5 h |
| …and the COG's overviews left out                     |           35 |                    8.5 h |
| Daily at 1°, empty space skipped (30-day range)       |        23–27 |                    6–7 h |
| Daily with empty space skipped and sub-tile dirtiness |    about 1–3 |                under 1 h |

The last row is an estimate. It assumes dirty work follows each day's new tracks, a few percent of the dense tiles rather than all of them.

The per-sounding cost decides the planet, not the fixed cost. Skipping empty space takes the fixed cost from 18 to 10 worker-hours of a full rebuild, and to about 8 without overviews, while the soundings cost 27. A day's touched tiles and their neighbors hold 79 to 88% of all soundings, so a 1° daily run costs about two thirds of a full rebuild whatever the fixed cost. Sub-tile dirtiness is the change that makes a daily run cheap, and the per-sounding cost of cells and surfaces is what decides a full rebuild.

The densest tile is a critical path of its own. The Galveston and Houston tile (29°N 95°W) holds 67M soundings, more than twice Chesapeake's densest, and needs about 45 min of cells and surface on one M-series core at the linear rate.

## Not measured

- Reading tiles out of DuckLake on R2 after compaction, and real R2 latency and throughput.
- The planet's active soundings outside Chesapeake. [planet-size.md](planet-size.md) scales the archive's rows by Chesapeake's active ratio.
- Memory and time for tiles denser than Chesapeake's densest. Three tiles hold more than twice as many soundings.
- Cheap x86 cores and a dedicated machine. Every timing here is from a shared M-series laptop.
- Upload cost of a 15–30 GB daily archive, and how clients handle its ETag changing.
- Open Waters GeoJSON input, and latitudes above 60°.
- The effect of each proposed change. Each needs measuring before the estimates above are relied on.
