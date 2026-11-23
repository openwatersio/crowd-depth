# Point store layout

Question: can each stage read one 1° tile efficiently from one store if the points are clustered (sorted by tile, compacted), or do points have to be stored physically per tile? And what does each layout cost to keep up under daily appends?

Short answer: one store, sorted by tile and compacted, reads a tile almost as cheaply as a per-tile layout (1.26x read amplification against 1.0x; the same request counts for dense tiles). A store left in ingest order reads 6.7x the store over a full per-tile rebuild, and 3.3x the requests and bytes on a dense tile. Physical per-tile storage costs a lot to maintain: in Chesapeake, one day of arrivals touches only 4 to 14 tiles, but those are the dense tiles, so rewriting them rewrites 60 to 80% of the store every day. The store is one DuckLake table, sorted by tile within each 10° partition, with each ingest batch written sorted and each partition compacted again once its small files pile up ([In the store](#in-the-store)). Details and caveats below.

Measured in October 2026 on the Chesapeake set, every NOAA file that touches the bay. The spike's code isn't checked in. Every process ran with DuckDB `memory_limit='2GB'` and `threads=4`, on local disk with a warm page cache unless stated.

## Step 1: staged ingest-order dataset

Staging parses every CSV with `grid.sources.load` (the same load, validate and content hash as ingest), gets tile and cell ids from ingest's `ADD_POINTS` expressions, derives `point_id` the same way, and adds a `qc` column. That column holds the most severe flag `qc_py.track_qc` gives the sounding, run once per file. Files are ordered by NOAA `ARRIVAL_DATE` and then key. They are written in batches that close once they pass 500k soundings, the same rule as ingest's `FLUSH_POINTS`, partitioned by `cell_id` as DuckLake partitions `lake.points`. Rule 1 (identical content hash) is applied in ingest order, so copies hold no points. Rules 4 and 5 and the ACTIVE dedupe are not applied.

| measure                | value                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------- |
| files                  | 24,413 (all found in index.json; 0 invalid)                                           |
| active / rule-1 copies | 18,434 / 5,979 (copies hold 33.0M soundings, mostly same-day Rosepoint resubmissions) |
| soundings stored       | 98,508,663 (131.5M parsed)                                                            |
| QC                     | reject 1,566,652 · unconfirmed 211,171 · review 485,336 · null 96.2M                  |
| tiles / 10° cells      | 212 / 11                                                                              |
| output                 | `cell_id=*/batch-*.parquet`: 249 files, 178 batches, 1,032 row groups, 3.88 GB        |
| wall time              | 1,159 s parse+QC (4 worker processes × 1 DuckDB thread) + 24 s batching               |
| throughput             | ~113k parsed soundings/s, ~19 MB CSV/s on 4 cores                                     |
| peak memory            | worker 1.02 GB RSS (the 582 MB CSV, ~6.9M rows); batching process 1.36 GB             |

A files table holds file_id, key, arrival, bytes, n, status, reason, superseded_by, batch_id, content_hash, vessel, time_min/max, `tiles` (the list of tile ids each file touches) and per-file seconds.

Bytes per row: 40.5 in total. **`point_id` alone is 18.7 bytes per row, 47% of the store**, because a random 16-byte hash doesn't compress. `(file_id, row)` already identifies a sounding.

## Step 2: layouts

All are built from `points_ingest`. The full-store builds:

| layout                    | how                                                                                         | files           | size         | row groups | build time                                |
| ------------------------- | ------------------------------------------------------------------------------------------- | --------------- | ------------ | ---------- | ----------------------------------------- |
| a ingest order            | as staged                                                                                   | 249             | 3.88 GB      | 1,032      | n/a                                       |
| b sorted, 123k-row groups | `ORDER BY tile_id, lat, lon`, 256 MB files                                                  | 17              | 3.81 GB      | 802        | **58 s** (full external sort, 2.2 GB RSS) |
| b sorted, 1M-row groups   | rewritten from b                                                                            | 17              | 3.80 GB      | 95         | 20 s                                      |
| c hive per tile           | same sort, `PARTITION_BY (tile_id)`                                                         | 236 (212 tiles) | 3.83 GB      |            | 82 s                                      |
| d base + appends          | b built from arrivals before 2026-09-16, then one unsorted file per arrival day for 30 days | 17 + 1..30      | 3.84–3.99 GB | 773–814    | base 80 s; 30 day files 3.5 s             |

Daily volume over the last 30 arrival days: median 88k soundings per day, 3.74M in total (one 718k day).

### Per-tile reads, local disk

Query: one tile's `point_id, file_id, unique_id, time, lon, lat, depth_raw, qc`, aggregated so every column is decoded. The file list each query gets is the one a DuckLake catalog would pass after pruning on per-file tile_id min/max. The query then prunes row groups by zone map and bloom filter (DuckDB 1.5 writes bloom filters for the dictionary-encoded `tile_id` and uses them). Row groups read = zone map hit and bloom filter not excluded, which matched the HTTP request counts. Times are the median of 3 warm runs, each on a new connection. Values are medians over the 5 tiles in each group. Dense tiles hold 7.1M–27.9M points, median tiles ~24k, sparse tiles 6–19.

| tiles  | layout         | files opened | row groups read | MB read | warm s |
| ------ | -------------- | ------------ | --------------- | ------- | ------ |
| dense  | a ingest       | 174          | 702             | 2,731   | 1.10   |
| dense  | b sorted 123k  | 3            | 120             | 513     | 0.28   |
| dense  | b sorted 1M    | 5            | 19              | 693     | 0.37   |
| dense  | c per tile     | 1            | 127             | 590     | 0.27   |
| dense  | d base+1 day   | 4            | 115             | 491     | 0.27   |
| dense  | d base+7 days  | 10           | 119             | 506     | 0.27   |
| dense  | d base+30 days | 32           | 147             | 599     | 0.32   |
| median | a ingest       | 5            | 3               | 6.9     | 0.006  |
| median | b sorted 123k  | 1            | 1               | 4.6     | 0.007  |
| median | b sorted 1M    | 1            | 1               | 38.6    | 0.042  |
| median | c per tile     | 1            | 1               | 1.0     | 0.002  |
| median | d base+30 days | 1            | 1               | 4.8     | 0.007  |
| sparse | a ingest       | 1            | 1               | 0.2     | 0.001  |
| sparse | b sorted 123k  | 1            | 1               | 4.6     | 0.007  |
| sparse | b sorted 1M    | 1            | 1               | 39.6    | 0.041  |
| sparse | c per tile     | 1            | 1               | 0.0     | 0.001  |
| sparse | d base+30 days | 1            | 1               | 4.6     | 0.007  |

The densest tile (45463, 28M points, 28% of the store): a 2.34 s, b 0.63 s, c 0.50 s, d+30 days 0.56 s. In ingest order it sits in 817 of 1,032 row groups.

On local disk, everything other than the dense tiles in (a) is fast. The differences that matter show up in total bytes and in request counts.

### Read amplification over a full per-tile rebuild

For every tile, sum the row groups that actually contain it, across all 212 tiles, and divide by the store. This is what a rebuild of every tile reads in total.

| layout                    | tiles per row group (median / max) | rows read ÷ store | bytes read ÷ store |
| ------------------------- | ---------------------------------- | ----------------- | ------------------ |
| a ingest order            | 6 / 32                             | **6.76x**         | 6.74x              |
| b sorted 123k             | 1 / 11                             | **1.26x**         | 1.28x              |
| b sorted 1M               | 2 / 49                             | 4.26x             | 4.50x              |
| d base + 30 unsorted days | 1 / 15                             | 1.47x             | 1.50x              |
| c per tile                | 1                                  | 1.00x             | 1.00x              |

Ingest order is not spatially compact enough here. One 122,880-row group is about 1.4 days of one vessel's track and crosses a median 6 tiles, so the plan's assumption that row-group statistics will "prune reads to a few tiles" holds for small tiles and fails for dense ones. Row groups of 1M rows are too coarse: every small tile pays for a 40 MB group.

### Requests: HTTP stand-in for R2

No credentials were used and nothing was read from or written to R2. A local HTTP server serves the data with Range support, counts requests and bytes, and adds a fixed delay to each request (0 or 75 ms). DuckDB reads it through httpfs with one new connection per tile, so every tile starts with a cold metadata cache.

| tile            | layout          | GETs                    | HEADs           | MB                       | s at 75 ms, 4 threads          | s at 75 ms, 16 threads |
| --------------- | --------------- | ----------------------- | --------------- | ------------------------ | ------------------------------ | ---------------------- |
| 45463 dense 28M | a ingest        | 3,017                   | 177             | 3,328                    | 67.5                           | 17.5                   |
| 45463 dense 28M | b sorted 123k   | 917                     | 6               | 971                      | 20.0                           | 5.4                    |
| 45463 dense 28M | c per tile      | 829                     | 1               | 915                      | 18.0                           |                        |
| 45463 dense 28M | d base+30 days  | 1,037                   | 36              | 1,074                    | 23.2                           |                        |
| 46183 dense 15M | a / b / c / d30 | 2,645 / 483 / 434 / 592 |                 | 2,936 / 563 / 524 / 655  | 59.6 / 10.8 / 9.6 / 13.5       |                        |
| median ~24k     | a / b / c / d30 | 10–16 / 4 / 3 / 4       | 1–9 / 1 / 1 / 1 | 6–13 / 3.5–5.4 / 0.9 / 5 | 0.43–0.74 / 0.42 / 0.33 / 0.42 |                        |
| sparse ≤19      | a / b / c / d30 | 1–15 / 5 / 1 / 5        | 1–7 / 1 / 1 / 1 | 0–7 / 5.5 / 0 / 5.5      | 0.16–0.85 / 0.5 / 0.16 / 0.5   |                        |

Findings:

- DuckDB issues about 4 GETs per row group read (one per column-chunk range it needs), plus a HEAD and a footer GET per file. Request count tracks row groups read, so the row-group numbers above carry over to R2.
- Latency is hidden only as far as DuckDB's thread count allows: about 3.3 requests in flight at 4 threads, about 13 at 16. A remote worker should run more DuckDB threads than it has cores, or stage the row groups first.
- A tile has a floor of about 0.4 s at 75 ms, from 4 or 5 serial round trips (HEAD, footer, bloom filter and data), whatever the layout. With 10–30k planet tiles that is 1–3 hours of pure latency for one serial worker, so sparse tiles have to be grouped into work units (`cells.units` already groups tiles) or read in parallel.
- This is a model, not R2. It has a constant delay, no TLS, unlimited local bandwidth, and no throttling.

### Daily appends (d) and per-tile maintenance (c)

Unsorted daily files on top of a sorted base degrade reads slowly. After 30 days, dense-tile reads cost 10–25% more bytes, requests and time, and full-rebuild amplification goes from 1.26x to 1.47x. Each appended file costs every tile whose range it overlaps one HEAD, one footer, and a bloom probe per row group. A daily file covers every tile that got data that day, so DuckLake's catalog can only prune it by the 10° partition.

Per-tile physical storage under daily appends, with each touched tile rewritten with the day's points merged in (7 days):

| day        | tiles touched | rows rewritten | s    |
| ---------- | ------------- | -------------- | ---- |
| 2026-09-16 | 6             | 58.2M          | 25.3 |
| 2026-09-17 | 7             | 62.0M          | 26.3 |
| 2026-09-18 | 4             | 60.5M          | 24.6 |
| 2026-09-19 | 5             | 75.3M          | 28.4 |
| 2026-09-20 | 10            | 79.1M          | 33.1 |
| 2026-09-21 | 14            | 80.2M          | 29.4 |
| 2026-09-22 | 10            | 75.2M          | 27.7 |

New data lands where the data already is. In Chesapeake the top 5 tiles hold 76% of the points and the top 20 hold 93%. So an eager per-tile layout rewrites 60–80% of the store every day, about as costly as a full daily re-sort (58 s), with 212 small files. The alternative is per-tile delta files, which turn into tiles × days small files.

### Per-file access

The sort has a cost elsewhere. Lookups by `file_id` (rule 4's `covers`, rule 1's takeover `UPDATE ... WHERE file_id`, withdrawals, QC reruns by `batch_id`) are clustered in ingest order and scattered once the store is sorted. A median file's `file_id` falls in the zone maps of 3 row groups in (a) but 466 of 802 in (b). Bloom filters save this on local disk (0.035 s against 0.064 s; 0.07 s against 0.42 s for the largest file). On R2 it means one bloom probe for each of those 466 row groups. The per-file rules belong in the recent, still-unsorted part of the store (the day's files) or in the `files` table, not in scans of compacted points.

## Step 3: planet estimates

Scale: 455 GB / 21.9 GB = **20.8x by bytes** (1.02M / 24.4k = 41.8x by files; Chesapeake files are larger than average, so bytes is the better scale). That gives ~2.05B stored soundings (2.7B parsed before rule 1), which agrees with the plan's ~2B. Daily arrivals: 20.8 × 88k ≈ 1.8M per day. NOAA's 751 MB day folder ÷ 222 CSV bytes per stored sounding ≈ 3.4M per day. So 1.8–3.4M soundings, or 75–140 MB of Parquet, per day. The planet tile count is assumed to be 10–30k tiles with data; it was not measured.

| estimate                    | a ingest order                                                                                  | b sorted + d daily appends                                                                                                                                                                                                          | c per tile                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| store size                  | ~83 GB (~44 GB without `point_id`)                                                              | same                                                                                                                                                                                                                                | same, in 10–30k+ files                                                                                                           |
| files                       | ~4–5k batch files × partitions                                                                  | ~330 × 256 MB + daily deltas                                                                                                                                                                                                        | one or more per tile; many tiles hold under 100 points                                                                           |
| full per-tile rebuild reads | 6.7x (likely 5–10x on the planet, since transiting ships cross a tile every few hours) ≈ 550 GB | 1.3–1.5x ≈ 110–125 GB                                                                                                                                                                                                               | 1.0x ≈ 83 GB                                                                                                                     |
| full rebuild requests       | ~4 per row group read ≈ 4 × 6.7 × 16.7k ≈ 450k, plus a HEAD and footer per file per tile        | ≈ 4 × (16.7k + tiles) ≈ 110–190k, plus 1–2 files per tile                                                                                                                                                                           | ≈ 4 × 16.7k + 2 per tile ≈ 90–130k                                                                                               |
| full re-sort / compaction   | n/a                                                                                             | ~20–40 min CPU on 4 threads (58 s × 21, sort superlinear, ~100 GB spill at a 2 GB limit) plus 83 GB down and up (~15–30 min at 100–200 MB/s). Per 10° partition instead: the same total, but in bounded pieces that run in parallel | n/a                                                                                                                              |
| daily maintenance           | append 1.8–3.4M rows (seconds)                                                                  | append the day sorted by tile (2–5 s to sort in memory); re-sort only the partitions whose unsorted files pass N                                                                                                                    | eager: rewrite touched tiles ≈ the busy majority of the store (Chesapeake 60–80%) ≈ 30–65 GB/day; lazy: tiles × days small files |
| R2 request cost             | 450k GETs ≈ $0.16 per rebuild                                                                   | ≈ $0.05–0.07                                                                                                                                                                                                                        | ≈ $0.04                                                                                                                          |

The request prices are R2 class B at $0.36 per million, and egress is free. Per-request latency and bytes cost more time than money. At ~13 requests in flight (16 threads), (b) is about 15 min of request latency across all tiles for one worker, plus 110–125 GB transferred. (a) takes 3–4x that.

## In the store

`lake.points` and `lake.qc_flags` are one DuckLake table each, sorted by tile within each 10° partition ([catalog.py](../../../packages/grid/src/grid/catalog.py)):

1. **Sorted base.** `SORTED BY` tile, then latitude and longitude, in files of up to 256 MB with row groups of 122,880 rows. On the Chesapeake, a dense tile reads about what a per-tile file would (0.28 s against 0.27 s, 483 against 434 requests in the spike), sparse tiles read one row group of about 5 MB, and full-rebuild amplification is 1.26x. Around Galveston, a tile's read touches 1.00 to 1.02 times its own rows in the five densest tiles ([planet-size.md](planet-size.md#the-galveston-region)).
2. **Ingest batches sorted.** Each batch is written sorted by tile, in small files of its own, so the cost of not compacting yet is the extra files' HEAD, footer and bloom probe, not their data.
3. **Compaction by partition.** `grid compact` rewrites each partition's points and flags sorted, about 20M points at a time, once per store layout, and a partition's points or flags again once that table holds 64 files there under 16 MB or with deletes. Each range commits alone, and the catalog is published once the partition is done, so jobs are bounded and no planet-wide sort is needed. The planet's 285 partitions compact in 53 min at a 768 MB limit ([backlog.md](backlog.md#3-make-the-daily-rebuild-fit)).
4. **No stored `point_id`.** A sounding is its `(file_id, row)`, packed into one 64-bit key that the point macros compute and `qc_flags` stores with `tile_id`, so flag reads prune by tile.

Still open:

- **Per-file rules on a sorted store.** Rule 4's cover, QC of an old batch and a takeover (`ingest.take_over`, an `UPDATE` of `file_id` on the points) read every row group's `file_id` or `batch_id` once points are compacted. Run them against a run's new files or per-file summaries, or give points a content id that `files` maps to the active holder, so a takeover changes only the catalog.
- **Remote reads.** DuckDB on a remote worker with 16 or more threads for I/O, or the needed files staged locally first; sparse tiles grouped into units, since the ~0.4 s floor per tile is round trips, not data. R2 reads from a worker in the cloud aren't measured.

Why not per tile (c): it reads best (1.0x), but the gain over sorted is small (0.27 s against 0.28 s on dense tiles; one fewer request on small ones). Daily appends land on the dense tiles, so eager maintenance rewrites most of the store every day. The lazy version multiplies small files to tiles × days, which is the "hundreds of thousands of tiny files" the plan already rules out. It also can't be a DuckLake partition without that file explosion, so it would mean a store outside DuckLake: no snapshots, no change feed, and no single catalog transaction.

Why not stay in ingest order (a): 6.7x read amplification over a rebuild, and 3.3x requests and bytes on dense tiles (68 s against 20 s for the densest at 75 ms and 4 threads). Its one advantage, per-file locality, matters only for the recent files that the per-file rules touch.

## Withdrawals and supersession in each layout

All three layouts handle status changes logically: `ACTIVE` joins points to `files` on status, so withdrawing or superseding a file rewrites no points in any layout. The differences show up when points have to be removed or moved physically.

- **Dirty tiles.** Keep each file's tile list (`files.tiles` here). A withdrawal, a supersession, or a copy taking points over dirties exactly those tiles, plus the neighbors within the surface's search radius, in every layout.
- **Physical purge** (a takedown, or dropping dead rows): (a) rewrite or delete-file the 1–5 batch files of the file's batch. (b) DuckLake writes a delete file for each data file holding the file's rows; a vessel's track spans every tile it crossed, so that can be many files. The rows actually go at the partition's next compaction, which also drops non-active files' points. (c) rewrite every tile the file touched.
- **Rule 1 takeover** (`UPDATE lake.points SET file_id = new WHERE file_id = old`): in (b) and (c) this rewrites scattered rows across every tile the track crossed, and DuckLake turns the update into a delete plus an insert, which also un-sorts those rows. Better: never update points. Give points a content id that `files` maps to the active holder, so a takeover only changes the catalog.
- **Rule 2 replacement and rule 4 cover**: the old file's points stay until compaction and are filtered by status. Cover's per-file comparison should run against the incoming delta, or against per-file summaries, rather than scan sorted points.

## Caveats

- DuckLake itself was not run. Its file pruning was emulated by passing each query the files whose tile_id min/max covers the tile, which is what its catalog stats allow. Partition pruning by `cell_id` was modeled by the directory layout. DuckLake's own compaction (`merge_adjacent_files`) merges files without sorting; the store sorts through DuckLake's `SORTED BY` and `grid compact`'s ranged rewrite.
- Chesapeake is small and concentrated: 212 tiles, 76% of points in 5. The planet has many more sparse tiles, and more ship transits crossing tiles. Amplification for (a) probably rises there; for (b) it may rise a little, as more small tiles share row groups.
- Local timings come from a warm page cache. The HTTP model has a constant delay, no bandwidth limit, no TLS and no throttling, so it is not R2.
- The query reads only one tile. Real stages read row bands with a margin into neighboring tiles, which adds requests in every layout. That cost wasn't measured.
- `qc` is stored inline; the real `qc_flags` table and its join were not measured. Rules 4 and 5 and the ACTIVE dedupe were not applied, so the counts include soundings that the dedupe would remove.
- Processes ran at 2.2–2.6 GB RSS, a little over the 2 GB target: DuckDB was capped at 2 GB, and Python, Arrow and the allocator add to that.
- The hive build wrote 236 files for 212 tiles: DuckDB split some large partitions into more than one file.

## Not measured

- Real R2 latency, throughput and concurrency limits.
- Sorted daily appends (only unsorted ones were measured).
- Per-partition compaction on its own, as opposed to the full sort.
- A multi-worker parallel rebuild.
- The planet's tile count and tile size distribution.
- Spill size and time of a 2B-row sort.
- The pipeline's actual `list_contains($tiles, tile_id)` path inside DuckLake. On plain Parquet it was as fast as `tile_id = X`: 1.25 s against 1.71 s on the dense tile, cold, and order effects may explain the gap.
