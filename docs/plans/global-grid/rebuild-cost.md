# Rebuild cost

Can the planet be rebuilt daily on cheap hardware? Not with the pipeline as it stands, but probably with four targeted changes to a per-tile design. Three spikes on the Chesapeake set (98.5M active soundings, 18,434 files, 212 1° tiles) show where the time goes. The store layout and QC are not the bottleneck. Two costs are: new data landing in the same dense harbor tiles every day, so rebuilding at 1° granularity re-processes most of the data daily, and a full-size raster for every 1° tile however empty it is. Across the whole NOAA archive the first is the larger: it covers 7,295 tiles, and a day's arrivals touch tiles holding two thirds of its soundings ([planet-size.md](planet-size.md)).

Details are in [store-layout.md](store-layout.md), [qc-functions.md](qc-functions.md), [per-tile-pipeline.md](per-tile-pipeline.md) and [planet-size.md](planet-size.md). The work that follows from them is in [backlog.md](backlog.md).

## Summary of the spikes

**Store layout.** One table sorted by 10° cell and then tile, with row groups of about 123k rows, reads about as efficiently as physically separate per-tile files: 1.26× read amplification over a full rebuild, against 1.0×. In ingest order, row groups cross a median of 6 tiles, so a full rebuild reads the store 6.8 times over. `grid cells` can query one store per cell, as long as the store is compacted in tile order and daily appends are sorted. Dropping the stored `point_id` saves 47% of bytes, and putting `tile_id` on `qc_flags` lets flag reads prune by tile.

**QC as pure functions.** A numpy version of QC v2 gives identical flags to the production SQL on 1,000 files, 13.4M soundings and 50,740 flags. It runs about 17 times faster per core and uses a fraction of the memory. A plain-loop version ports directly to TypeScript, with thresholds and test vectors shared as JSON. With it, QC adds about 2% to ingest, against about 40% for the SQL.

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
- **`grid cells`.** A full rebuild at about 46 min per 100M soundings, published only at the end, which puts a planet rebuild at about 16–20 h with no incremental path. With the corroboration join fixed, the bay's build on R2 (8.0M measured cells and 2.8M filled, 20 units) takes 2 h 59 min, with DuckDB at 3.5 GB of a 4 GB limit and a peak RSS of 5.0 GB. The largest costs are hole filling (3,412 s), rereading each unit's active points (3,081 s) and deleting the old `qc_flags` (2,583 s); consensus takes 692 s.

The per-tile cells stage costs about the same (36 min serially for Chesapeake). Splitting by tile doesn't make the work cheaper. It makes the work partitionable, and so incremental and parallel.

## A planet day

This assumes 8 cores and 32 GB, and the measured archive from [planet-size.md](planet-size.md): 1.96B active soundings in 7,295 tiles, 42 of which hold half of them, and about 900 tiles touched a day. Costs use the per-tile model in [per-tile-pipeline.md](per-tile-pipeline.md#planet-extrapolation-8-cores-32-gb): a fixed 8.7 s per tile (cells 0.9, surface 6.5, web 1.3) plus 47 s per million soundings (cells 20, surface 19.4, web 7.8) on M-series cores, with cheap cores 1.5× slower and 8 workers giving 6×. A daily run rebuilds cells in the touched tiles, and surfaces and web tiles in those and their neighbors.

|                                                        |         Worker-hours | Wall time on cheap cores |
| ------------------------------------------------------ | -------------------: | -----------------------: |
| Full rebuild, per-tile as built                        |                   43 |                     11 h |
| …of which fixed per-tile cost, mostly empty rasters    |                   18 |                          |
| Daily at 1° granularity                                | 22–25 (30-day range) |                5.5–6.5 h |
| Full rebuild with empty blocks skipped                 |                   29 |                    7.5 h |
| Daily at 1° with empty blocks skipped                  |                19–22 |                  5–5.5 h |
| Daily with empty blocks skipped and sub-tile dirtiness |            about 1–3 |                under 1 h |

The last row is an estimate. It assumes dirty work follows each day's new tracks, a few percent of the dense tiles rather than all of them.

The per-sounding cost decides the planet, not the fixed cost. With 7,295 tiles, the fixed cost is 18 of 43 worker-hours, and the dense tiles hold most of the work. A day's touched tiles and their neighbors hold 84% of all soundings, so a 1° daily run costs about 55% of a full rebuild as built and about 70% with block skipping, which saves the daily run only 3–4 worker-hours. Sub-tile dirtiness is the change that makes a daily run cheap, and the per-sounding cost of cells and surfaces is what decides a full rebuild.

The densest tile is a critical path of its own. Galveston and Houston (29°N 95°W) holds 67M soundings, more than twice Chesapeake's densest, and needs about 45 min of cells and surface on one M-series core at the linear rate.

Skipping empty raster blocks has the headroom to remove most of the fixed cost. On a 5,400-pixel tile with 512-pixel blocks, blocks with a sounding within about 200 m are a median 15% of a tile's blocks, and 17% on average across the 171 Chesapeake tiles under 100k soundings. Pixels within 200 m of a sounding are 1% of a median tile. If the fixed stages scale with pixels, as profiling suggests, block skipping cuts the fixed cost by roughly 5 times, which the table assumes.

## Not measured

- Reading tiles out of DuckLake on R2 after compaction, and real R2 latency and throughput.
- The planet's active soundings outside Chesapeake. [planet-size.md](planet-size.md) scales the archive's rows by Chesapeake's active ratio.
- Memory and time for tiles denser than Chesapeake's densest. Three tiles hold more than twice as many soundings.
- Cheap x86 cores and a dedicated machine. Every timing here is from a shared M-series laptop.
- Upload cost of a 15–30 GB daily archive, and how clients handle its ETag changing.
- Open Waters GeoJSON input, and latitudes above 60°.
- The effect of each proposed change. Each needs measuring before the estimates above are relied on.
