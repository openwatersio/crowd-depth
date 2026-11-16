# Rebuild cost

Can the planet be rebuilt daily on cheap hardware? Three spikes on the Chesapeake set (98.5M active soundings, 18,434 files, 212 1° tiles) showed where the time went: not the store layout or QC, but new data landing in the same dense harbor tiles every day, so rebuilding at 1° granularity re-processes most of the data daily, and a full-size raster for every 1° tile however empty it is. Across the whole NOAA archive the first is the larger: a day's arrivals touch tiles holding two thirds of its soundings ([planet-size.md](planet-size.md)). The pipeline sorts the store by tile, skips empty raster blocks, rebuilds only the leaves of a dense tile that new data reaches, and finishes every job in a 2 GB cgroup. What a planet day costs with them is below.

Details are in [store-layout.md](store-layout.md), [qc-functions.md](qc-functions.md), [per-tile-pipeline.md](per-tile-pipeline.md), [sub-tile-rebuild.md](sub-tile-rebuild.md) and [planet-size.md](planet-size.md). The work that follows from them is in [backlog.md](backlog.md).

## What the spikes found

**Store layout.** One table sorted by 10° cell and then tile, with row groups of about 123k rows, reads about as efficiently as physically separate per-tile files: 1.26× read amplification over a full rebuild, against 1.0×. In ingest order, row groups cross a median of 6 tiles, so a full rebuild reads the store 6.8 times over. Dropping a stored `point_id` saves 47% of bytes, and putting `tile_id` on `qc_flags` lets flag reads prune by tile. The store is built this way ([store-layout.md](store-layout.md#in-the-store)).

**QC as pure functions.** Track QC runs as numpy ([qc.py](../../../packages/grid/src/grid/qc.py)), with flags matching the day-split SQL's on the whole Chesapeake store (98.5M soundings) apart from stuck runs across UTC midnight. QC of that store takes 53 s against 204 s for the SQL. Its TypeScript port in the plugin shares thresholds and test vectors as JSON ([qc-functions.md](qc-functions.md)).

**Per-tile pipeline.** `grid tiles` rebuilds cells, surfaces and depth areas per 1° tile, cut into leaves where a tile is dense, web tiles per z8 tile, one low-zoom run for z0–7, and assembles one PMTiles archive by copying tile bytes ([per-tile-pipeline.md](per-tile-pipeline.md)). A tile or leaf reruns only when its inputs move. Its limits:

- **A daily run at 1° cost about 75% of a full rebuild.** Over the last 30 arrival days, the 3–15 tiles touched each day held 47–86% of all soundings (median 76%). Leaves of at least 1/8° take a day's reads to a median 50% for cells and 56% for surfaces ([sub-tile-rebuild.md](sub-tile-rebuild.md)).
- **Memory.** Every job finishes in a 2 GB Linux cgroup, the densest with the kernel taking back what it can, and the scheduler reserves 2.3 GB for dense ones: a surface works only the blocks with data, and the densest cells, surfaces and overlays were each brought under it ([backlog.md](backlog.md#3-make-the-daily-rebuild-fit)).
- **Seams.** Coverage and depth bands can disagree across a tile edge, since consensus and the surface's blur stop there: on the Chesapeake, coverage stops on one side in 39% of the samples along edges and bands differ in 3.4% where both sides draw. A single global run draws the same seams, so they come from the per-tile surface, not from the split ([per-tile-pipeline.md](per-tile-pipeline.md#seams-between-tiles)).

## The store's own steps

- **Ingest** commits per batch and publishes its catalog every 15 minutes, so a failure loses only the work since, and a rerun skips files already published. Rule 4's coverage finds every candidate pair in one query and checks containment in groups, 136 s on the Chesapeake's 18,055 files. Around Galveston, ingest from NOAA to R2 took 5.1 h for 252M soundings ([planet-size.md](planet-size.md#the-galveston-region)).
- **Compact** rewrites a partition a range of tiles at a time: 163 s around Galveston, 53 min for the planet's 285 partitions.
- **Tide** fetches gauge months and predicts station levels: 2.9 h around Galveston, most of it CO-OPS.
- **Calibrate** reduces only files whose inputs moved and solves every segment: 34 min around Galveston reducing every file again, within a 2 GB cgroup.

## A planet day

This assumes 8 cores and 32 GB, and the measured archive from [planet-size.md](planet-size.md): an estimated 1.96B active soundings in 7,295 tiles (the planet's ingest stored 1.90B soundings, active or not, so the per-sounding costs here err a few percent high), 42 of which hold half of them. On the median day 912 tiles are touched, holding 65% of all soundings, and with their neighbors 1,722 tiles holding 84%. Cheap cores are taken as 1.5× slower than the Mac Studio's M-series cores, and 8 workers as giving 6×. The inputs come from a full Chesapeake build on main 56620f4 (98.5M soundings, 212 tiles, 485 leaves; [per-tile-pipeline.md](per-tile-pipeline.md#measured-with-snakemake)), with each stage's cost per tile the median of the tiles under 10k soundings and its cost per million soundings what's left over the store:

| Stage   | Per tile | Per million soundings |
| ------- | -------: | --------------------: |
| Cells   |   0.55 s |                22.4 s |
| Surface |   2.88 s |                40.6 s |
| Overlay |   1.15 s |                18.7 s |
| Web     |   0.50 s |                 2.6 s |
| In all  |   5.08 s |                84.3 s |

The build took 2.62 worker-hours in all, 95.8 s per million soundings, with the low zooms and assembly. The COG's overviews, which nothing in the pipeline reads yet, are a large part of a sparse tile's 2.88 s of surface: written outside the build from 150 of the build's surfaces, a COG under 10k soundings takes 2.86 s with them and 0.26 s without (median). Inside the build the same write shares the job with its query and gridding, so leaving them out saves up to about 2.6 s a sparse tile, which the row below takes off every tile; dense tiles' overviews are unmeasured. Around Galveston a build of every tile took 9.6 worker-hours for 252M soundings, 137 s per million, with its jobs waiting on spill I/O, eight at once on a USB SSD shared into the VM, beside an ingest. So it bounds the per-sounding cost from above.

A daily run rebuilds cells in the touched tiles, and surfaces, overlays and web tiles in those and their neighbors.

|                                    | Worker-hours | Wall time on cheap cores |
| ---------------------------------- | -----------: | -----------------------: |
| Full rebuild                       |           56 |                     14 h |
| …and the COG's overviews left out  |     about 51 |               about 13 h |
| Median day at 1°                   |           39 |                    9.7 h |
| Median day with sub-tile dirtiness |           29 |                    7.4 h |

The last row comes from [sub-tile-rebuild.md](sub-tile-rebuild.md): on the Chesapeake a day's leaf jobs read a median 50% of all soundings for cells, against 76% at 1°, and 56% for surfaces, against 90%, since the busiest harbours are crossed daily by the same vessels and each leaf rereads the reach around it, and the overlay and web jobs stay per tile. Days whose tide levels or offsets move dirty more.

The per-sounding cost decides the planet, not the fixed cost: 46 worker-hours of a full rebuild are soundings and 10 are tiles, about 5 without overviews. A day's touched tiles and their neighbors hold most of the soundings, so a 1° daily run costs about two thirds of a full rebuild whatever the fixed cost, and sub-tile dirtiness takes a quarter off it. Surfaces and overlays are 70% of the per-sounding cost, and the surface's own share, 40.6 s per million, is twice what a build at main 42a9f95 measured in October (19.4 s).

The densest tile isn't a critical path of its own. The Galveston Bay tile (29°N 95°W) holds 71.6M active soundings, up to 2.6 times Chesapeake's densest; split into 49 leaves, its cells and surface take 1.8 worker-hours, and its densest leaf's cells and surface take 76 s and 88 s alone. Its region, 252M soundings in 92 tiles and 425 leaves, builds in 73 min with eight jobs at once, 9.6 worker-hours; its slowest leaf job, a surface in Houston's tile, takes 264 s alone, and its densest jobs, measured alone, each finish in a 2 GB cgroup, the densest leaf cells within 47 MB of it. The store-level steps are longer: ingesting the region from NOAA to R2 took 5.1 h and tide 2.9 h; compact takes 163 s and calibrate, reducing every file again, 34 min, both in 2 GB ([planet-size.md](planet-size.md#the-galveston-region)).

## Not measured

- R2 throughput from a worker in the cloud. From the Mac Studio, Galveston Bay's compacted tile, 2.11 GB with every column, reads in 80 to 124 s, at the speed of its connection; pruned by row group, the five densest tiles each read 1.00 to 1.02 times their own rows ([planet-size.md](planet-size.md#the-galveston-region)).
- The active ratio beyond two regions. [planet-size.md](planet-size.md) scales the archive's rows by Chesapeake's 0.749; around Galveston it is 0.766.
- Ingest and tide in 2 GB. Around Galveston, ingest peaked at 5.3 GB and tide at 4.2 GB, both at grid's default 4 GB DuckDB limit.
- Cheap x86 cores and a dedicated machine. Every timing here is from Apple silicon: a shared M-series laptop, the Mac Studio running other jobs beside the Galveston build, and the Mac Studio alone for the Chesapeake build the model takes its inputs from.
- Upload cost of a daily archive of about 6–10 GB (the Chesapeake's 291 MB scaled by soundings and by tiles), and how clients handle its ETag changing.
- Open Waters GeoJSON input, and latitudes above 60°.
- The effect of each proposed change. Each needs measuring before the estimates above are relied on.
