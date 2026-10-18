# Rebuild cost

Can the planet be rebuilt daily on cheap hardware? Not with the pipeline as it stands, but probably with four targeted changes to a per-tile design. Three spikes on the Chesapeake set (98.5M active soundings, 18,434 files, 212 1° tiles) show where the time goes. The store layout and QC are not the bottleneck. Two costs are: a full-size raster for every 1° tile however empty it is, and new data landing in the same dense harbor tiles every day, so rebuilding at 1° granularity re-processes most of the data daily.

Details are in [store-layout.md](store-layout.md), [qc-functions.md](qc-functions.md) and [per-tile-pipeline.md](per-tile-pipeline.md). The work that follows from them is in [backlog.md](backlog.md).

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

This assumes 8 cores, 32 GB, 2B soundings and 15–30k tiles with data, extrapolated from Chesapeake. None of the planet numbers are measured.

|                                                                                    |  Worker-hours | Wall time on cheap cores |
| ---------------------------------------------------------------------------------- | ------------: | -----------------------: |
| Full rebuild, per-tile as built                                                    |         62–99 |                  16–25 h |
| …of which fixed per-tile cost, mostly empty rasters                                |         36–73 |                          |
| Daily at 1° granularity                                                            |         14–26 |                3.5–6.5 h |
| Full rebuild with empty blocks skipped, one read per tile and deterministic output | roughly 25–35 |            roughly 5–7 h |
| Daily with those and sub-tile dirtiness                                            |     about 1–3 |                under 1 h |

The last two rows are estimates. The full rebuild drops by most of the fixed cost, leaving about 47 s per million soundings. The daily figure assumes dirty work follows each day's new tracks, a few percent of the dense tiles rather than all of them.

Skipping empty raster blocks has the headroom to do this. On a 5,400-pixel tile with 512-pixel blocks, blocks with a sounding within about 200 m are a median 15% of a tile's blocks, and 17% on average across the 171 tiles under 100k soundings. Pixels within 200 m of a sounding are 1% of a median tile. If the fixed stages scale with pixels, as profiling suggests, block skipping cuts the fixed cost by roughly 5 times.

## Not measured

- Reading tiles out of DuckLake on R2 after compaction, and real R2 latency and throughput.
- The planet's tile count and density distribution. Read them from `points` by `tile_id` before relying on the extrapolation.
- Cheap x86 cores and a dedicated machine. Every timing here is from a shared M-series laptop.
- Upload cost of a 15–30 GB daily archive, and how clients handle its ETag changing.
- Open Waters GeoJSON input, and latitudes above 60°.
- The effect of each proposed change. Each needs measuring before the estimates above are relied on.
