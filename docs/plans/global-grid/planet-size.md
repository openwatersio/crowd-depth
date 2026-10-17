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
- The densest tiles are Galveston and Houston (29°N 95°W, 67M), the Louisiana coast and Atchafalaya (30°N 92°W, 56M; 29°N 91°W, 52M), Freeport (29°N 96°W, 45M) and the lower Mississippi at Memphis (36°N 90°W, 37M). All of the top 10 are between 29°N and 36°N and 90°W and 96°W, and the US Gulf and Mississippi hold about 40% of the archive. The densest Chesapeake tile (36°N 77°W, 26M active) is not in the top 10.
- Three tiles hold more than twice Chesapeake's densest. At the pipeline's linear rate, the densest needs about 45 min of cells and surface on one M-series core. Its memory is not measured; Chesapeake's densest tiles already peak at 4.5 GB.

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

## Method

1. **Track index.** All 787,557 entries of the [track index](noaa-archive.md#layout) (`MapServer/1`), with `NAME`, `FILE_SIZE`, `PROVIDER` and the track line, simplified by the server to 0.002° (`maxAllowableOffset`). The index has no sounding counts. `FILE_SIZE` is the submitted `.tar.gz`.
2. **Soundings per file.** `FILE_SIZE` times a rate per provider. The rates come from 443 CSVs sampled in proportion to the index by provider and year (at least 2 per provider and year), 2.0M rows in all. The overall rate is 0.029 rows per submitted byte. Rates are tight within a provider: Rosepoint, the largest, has 0.032–0.041 between the 10th and 90th percentile, and SeaKeepers 0.015–0.020. Every sampled entry had a CSV.
3. **Soundings per tile.** Each file's soundings are spread along its track line in proportion to the line's length in each tile.
4. **Active soundings.** The archive's rows times 0.749, Chesapeake's ratio of active soundings to rows. Dedupe, missing-depth sentinels and QC remove the rest.

Checks:

- **Chesapeake, every file.** The 24,413 local CSVs of the Chesapeake set hold 131.5M rows in 212 tiles. The method gives 133.2M (+1.3%) in 211 tiles, the same density bands to within a few tiles (3 tiles > 10M against 4; 11 at 1M–10M against 10), and the same top-10 share (86.1% against 86.3%). The densest tiles come out within 7% (45463: 30.1M against 31.5M; 46183: 26.0M against 24.4M).
- **Placement.** Given each file's true row count, length placement puts 98.2% of Chesapeake's soundings in the right tile, counted by tile totals. In the 443-file sample, it puts 93% of each file's soundings in the right tile. A slow boat in a harbor logs more soundings per kilometer than one in transit, so placement leans slightly toward transit tiles.

## Not measured

- **The active ratio outside Chesapeake.** 0.749 comes from one region. Identical resubmissions, sentinels and QC flags may differ by provider and region.
- **Tiles below one sounding.** A track clipping a tile corner credits it a fraction of a sounding. Tiles under one estimated sounding are left out, and none were. A track's simplified line can miss or add a tile at the edges, which matters only for the count of sparse tiles.
- **Open Waters submissions.** Plugin data from non-IHO waters isn't in NOAA's archive.
- **Arrivals by collection date.** Folder dates are processing dates, so a day's folder can hold older soundings. This changes which tiles are dirty only where old data arrives late.
- **Growth.** Arrivals in the last month run about twice the yearly average. The tile count and skew will move as the archive grows.
