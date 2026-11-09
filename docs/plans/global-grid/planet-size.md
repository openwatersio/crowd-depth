# Planet size

How many 1° tiles the NOAA CSB archive covers, how its soundings spread across them, and how a day's arrivals spread. Measured on 2026-10-17 from the archive's track index, calibrated against sampled CSVs and checked against the full Chesapeake set. [rebuild-cost.md](rebuild-cost.md) uses these numbers for its planet estimate.

Short answer: the archive covers 7,295 tiles, not 15–30k, and it is more skewed than assumed. About 1.96 billion active soundings sit in those tiles; 42 tiles hold half of them and 396 hold 90%. The densest tiles are the US Gulf Coast and the lower Mississippi, not Chesapeake. A typical day touches about 900 tiles, which hold 65% of all soundings, and their neighbors bring that to 84%.

## Tiles and density

Soundings are active soundings, estimated as 0.749 of the archive's rows (the ratio in Chesapeake, 98.5M active of 131.5M rows; see [Method](#method)).

| soundings in tile | tiles | share of tiles | soundings | share of soundings |
| ----------------- | ----: | -------------: | --------: | -----------------: |
| < 1k              | 1,092 |          15.0% |      0.4M |               0.0% |
| 1k–10k            | 2,952 |          40.5% |       12M |               0.6% |
| 10k–100k          | 2,395 |          32.8% |       80M |               4.1% |
| 100k–1M           |   606 |           8.3% |      207M |              10.5% |
| 1M–10M            |   201 |           2.8% |      604M |              30.8% |
| > 10M             |    49 |           0.7% |    1,061M |              54.0% |
| total             | 7,295 |                |    1,964M |                    |

- 42 tiles hold 50% of soundings, 180 hold 80%, 396 hold 90% and 2,687 hold 99%. The 10 densest hold 21%, the 100 densest 69%.
- The densest tiles are Galveston Bay (29°N 95°W, 67M; 71.6M measured), the Louisiana coast and Atchafalaya (30°N 92°W, 56M; 29°N 91°W, 52M), Houston (29°N 96°W, 45M; 48.3M measured) and the lower Mississippi at Memphis (36°N 90°W, 37M). All of the top 10 are between 29°N and 36°N and 90°W and 96°W, and the US Gulf and Mississippi hold about 40% of the archive. The densest Chesapeake tile (36°N 77°W, 26M) is not in the top 10. The Chesapeake set's 28.0M in it counts only files that touch the bay.
- The densest holds up to 2.6 times as many as Chesapeake's densest. Split into 49 leaves, its cells and surface take 1.8 worker-hours, and its region's compact, calibrate and densest tile jobs each finish in a 2 GB cgroup, the densest leaf cells within 47 MB of it ([The Galveston region](#the-galveston-region)).

## Daily arrivals

A day is one archive date folder, the unit daily ingest reads. Over the 30 folders from 2026-09-17 to 2026-10-16:

| per day                                          |   min | median |   max |
| ------------------------------------------------ | ----: | -----: | ----: |
| files                                            |   546 |  1,286 | 3,132 |
| soundings (active)                               |  1.5M |   3.0M |  3.8M |
| tiles touched                                    |   642 |    912 | 1,311 |
| touched tiles plus their neighbors with data     | 1,262 |  1,722 | 2,261 |
| share of all soundings in touched tiles          | 58.8% |  65.0% | 71.4% |
| share of all soundings in touched plus neighbors | 79.5% |  84.3% | 88.4% |

Over the last year, 357 folders held 567M active soundings, 1.6M a day on average; the last month runs at about twice that.

New data lands where the data already is. Every day touches most of the dense tiles, so rebuilding at 1° re-reads about two thirds of the planet for cells and about 84% for surfaces and web tiles, which rebuild the neighbors too. This matches Chesapeake (median 76% for touched tiles).

## The Galveston region

The densest tile and its eight neighbors, from 28°N to 31°N and 96°W to 93°W, ingested from NOAA's archive into a DuckLake store on R2 in November 2026 (main 9337d76). The keys are the 54,121 track-index entries whose lines cross the box. Their files carry 27M soundings outside it, along transits.

| tile  | where                    | active soundings | estimated |
| ----- | ------------------------ | ---------------: | --------: |
| 42925 | 29°N 95°W, Galveston Bay |            71.6M |       67M |
| 42924 | 29°N 96°W, Houston       |            48.3M |       45M |
| 43286 | 30°N 94°W, Lake Charles  |            40.5M |           |
| 42926 | 29°N 94°W, Port Arthur   |            32.3M |           |
| 42564 | 28°N 96°W, Freeport      |            23.2M |           |
| 42566 | 28°N 94°W                |             5.3M |           |
| 43285 | 30°N 95°W, Beaumont      |             2.0M |           |
| 42565 | 28°N 95°W                |             1.9M |           |
| 43284 | 30°N 96°W                |                0 |           |

- **Density.** Tile 42925 holds 71.6M active soundings, up to 2.6 times Chesapeake's densest (45463, 28.0M from files that touch the bay, so a lower bound for that tile), and 7% more than the track-index estimate. Houston's tile is 7% over its estimate too. Four of the nine tiles hold more than Chesapeake's densest.
- **Active ratio.** Of the 54,113 files found, 40,866 are active, holding 252.1M of the 329.3M rows: 0.766, against Chesapeake's 0.749, counted the same way, as stored rows before the dedupe that tile jobs apply when they read. The other 13,247 files, 77.2M rows, are superseded: 13,233 copies of a stored file and 14 that later files cover. No file is invalid or withdrawn. The planet estimate's 0.749 is within 2.5% here.
- **Ingest.** 40,880 new files and 252.1M soundings and 56.5 GB of CSVs downloaded in 5.1 h, at a 5.3 GB anon peak at grid's default 4 GB DuckDB limit (`GRID_MEMORY_LIMIT`), in a Linux cgroup on OrbStack's VM (18 threads). Of the step times in seconds: write to R2 6,789, QC 3,215, parse 2,904, download wait 1,283, dedupe 574, coverage 63, list 54. The steps overlap, and the last publish took most of the rest. Eight keys were not in the bucket. The store is 19.2 GB on R2, 17.3 GB of it points.
- **Tide.** 2.9 h at a 4.2 GB anon peak, most of it fetching 2,824 CO-OPS gauge months; 52,064 station days in 67 tiles. CO-OPS answered 39 months of gauge 8761955 with HTTP 400; tide skips such a month with a warning, keeps what it had for it, and asks again on every run.

The steps after tide were measured on a local copy of the store, downloaded from R2 in 19 min, in the grid image on OrbStack's Linux VM (18 threads, aarch64), each in a Linux cgroup of its own, with anon memory sampled every 50 ms. Calibrate at 1 GB and the tile jobs ran while the planet's NOAA ingest ran in the same VM, so their times are upper bounds; their memory is their cgroup's own. Spill and data were on a USB SSD shared into the VM, and with eight jobs at once the leaf surfaces waited on its I/O: run alone, the slowest took 264 s against 1,303 s in the build.

- **Compact** finishes in a 2 GB cgroup at a 1 GB limit, at 1.31 GB, in 163 s: six partitions in 48 ranges. The points go from 17.3 GB to 7.28 GB, in 21 files and row groups of 101k rows.
- **Reads.** Pruned by its row groups' tiles, a tile's read touches 1.00 to 1.02 times its own rows in the five densest tiles, and 1.19 in 42565 (1.9M). Tile 42925 reads 721 row groups in 5 files, 2.11 GB with every column. From R2 over the Mac Studio's connection that read takes 124 s cold and 80 s warm on 4 threads, 17 to 26 MB/s, the speed the store downloaded at; from the local SSD 5.9 s and 2.4 s.
- **Calibrate**, reducing every file again, finishes in a 2 GB cgroup at a 1 GB limit, at 1.79 GB, in 34 min: the reduce takes 7.5 min at 1.36 GB, the stuck-run search 474 s, publishing 52 s. With the files already reduced it takes 26 min at the same peak. At 768 MB it runs out of DuckDB memory after the lost-median passes, while judging transits: the temp tables of 45.6M file-pixel medians fill the pool, 709 MB of it with 5.9 GB spilled, and a statement can't pin the blocks it reads. At the 4 GB default it takes 21 min at 4.62 GB. Every run gives the same 114 segments, 3 steps, 2,251 stray transits, 90,018 lost runs and 39,830 file offsets.
- **Tile jobs.** `grid tiles` builds the 92 tiles the region's files reach, in 425 leaves, in 73 min with eight jobs at once in 18 GB, 9.6 worker-hours: leaf cells 3.5 h, leaf surfaces 5.7 h, overlays 0.25 h, web tiles 0.06 h. Tile 42925 splits into 49 leaves, whose cells and surfaces take 1.8 worker-hours. The densest jobs, each alone in a 2 GB cgroup, all finish, and so do all 92 overlays, at most 1.49 GB; the other leaf jobs were not run alone:

| job                     | soundings in reach | peak anon |   s |
| ----------------------- | -----------------: | --------: | --: |
| leaf cells 42924/r331   |              25.8M |  1,956 MB | 154 |
| leaf cells 42924/r313   |              17.3M |  2,001 MB |  99 |
| leaf cells 43286/r101   |              15.8M |  1,658 MB | 140 |
| leaf cells 42925/r023   |              11.7M |  1,800 MB |  76 |
| leaf surface 42924/r331 |              25.8M |  1,544 MB | 264 |
| leaf surface 43286/r101 |              15.8M |  1,505 MB | 117 |
| leaf surface 42925/r023 |              11.7M |  1,305 MB |  88 |
| cells splice 42925      |              71.6M |    918 MB |   5 |
| overlay 42925           |              71.6M |  1,489 MB |  52 |
| overlay 42924           |              48.3M |    947 MB |   9 |
| overlay 42926           |              32.3M |  1,374 MB |  33 |

Overlay 42925 places the 20M published soundings in and beside its tile in its pixels a million at a time: all at once, they took it to 2.74 GB, with the same output on all 92 tiles, byte for byte. Leaf cells 42924/r313 runs within 47 MB of its cgroup's 2,048 MB, with the kernel reclaiming.

## Method

1. **Track index.** All 787,557 entries of the [track index](noaa-archive.md#layout) (`MapServer/1`), with `NAME`, `FILE_SIZE`, `PROVIDER` and the track line, simplified by the server to 0.002° (`maxAllowableOffset`). The index has no sounding counts. `FILE_SIZE` is the submitted `.tar.gz`.
2. **Soundings per file.** `FILE_SIZE` times a rate per provider. The rates come from 443 CSVs sampled in proportion to the index by provider and year (at least 2 per provider and year), 2.0M rows in all. The overall rate is 0.029 rows per submitted byte. Rates are tight within a provider: Rosepoint, the largest, has 0.032–0.041 between the 10th and 90th percentile, and SeaKeepers 0.015–0.020. Every sampled entry had a CSV, which puts the share of index entries without one under 0.7% at 95% confidence.
3. **Soundings per tile.** Each file's soundings are spread along its track line in proportion to the line's length in each tile.
4. **Active soundings.** The archive's rows times 0.749, Chesapeake's ratio of active files' stored rows to all rows. The rest are rows of files superseded by an identical or newer submission. The Galveston region's ratio is 0.766 ([below](#the-galveston-region)).

Checks:

- **Chesapeake, every file.** The 24,413 local CSVs of the Chesapeake set hold 131.5M rows in 212 tiles. The method gives 133.2M (+1.3%) in 211 tiles, the same density bands to within a few tiles (3 tiles > 10M against 4; 11 at 1M–10M against 10), and the same top-10 share (86.1% against 86.3%). The densest tiles come out within 7% (45463: 30.1M against 31.5M; 46183: 26.0M against 24.4M).
- **Placement.** Given each file's true row count, length placement puts 98.2% of Chesapeake's soundings in the right tile, counted by tile totals. In the 443-file sample, it puts 93% of each file's soundings in the right tile. A slow boat in a harbor logs more soundings per kilometer than one in transit, so placement leans slightly toward transit tiles.

## Not measured

- **Index entries without a CSV.** Every index entry is counted, but some have no CSV in the bucket ([noaa-archive.md](noaa-archive.md#quirks)). The rate is 0 of the 443 sampled entries, 5 of Chesapeake's 24,418, and 0.5% in Fiji, but about 7% in the regions of [#127](https://github.com/openwatersio/crowd-depth/pull/127). The missing entries are mostly small fragments, so they hold a smaller share of soundings than of entries. Where the rate is near 7%, the estimate overstates soundings by up to that much and may add a few sparse tiles; the planet totals are likely high by about 1%.
- **The active ratio in other regions.** It is 0.749 in Chesapeake and 0.766 around Galveston. Resubmissions may differ by provider and region elsewhere.
- **Tiles below one sounding.** A track clipping a tile corner credits it a fraction of a sounding. Tiles under one estimated sounding are left out, and none were. A track's simplified line can miss or add a tile at the edges, which matters only for the count of sparse tiles.
- **Open Waters submissions.** Plugin data from non-IHO waters isn't in NOAA's archive.
- **Arrivals by collection date.** Folder dates are processing dates, so a day's folder can hold older soundings. This changes which tiles are dirty only where old data arrives late.
- **Growth.** Arrivals in the last month run about twice the yearly average. The tile count and skew will move as the archive grows.
