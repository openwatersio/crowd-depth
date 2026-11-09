# Planet build

How to build the grid from every file in NOAA's CSB archive in one run, on the Mac Studio, and what the same build and a daily run would cost on Hetzner. The archive covers 7,295 1° tiles and about 1.96B active soundings ([planet-size.md](planet-size.md)). Every stage's jobs fit a 2 GB worker on the Chesapeake ([backlog.md](backlog.md)), which is what lets the per-tile stages run in parallel.

Short answer, before measurement: ingest is the long pole. It is one process, and at the Galveston–Houston run's rate it takes about a day and a half for the planet. Everything after it, run in parallel on 18 cores, takes under half a day. The planet fits on a 471 GB scratch disk if the download cache is dropped once ingest has read it.

## Where it runs

- **Machine.** Mac Studio, 18 cores. Linux stages run in the grid image under OrbStack (25 GB VM), so DuckDB's jemalloc setting and `grid.release` work as on a server and each stage's peak is a cgroup's.
- **Disk.** Everything large lives on `/Volumes/External/crowd-depth/planet/`, a scratch disk with 471 GB free; the internal disk has 20 GB. Nothing there is kept: it can all be rebuilt from NOAA's bucket, or from R2 once published.

| Path     | What                                                           |
| -------- | -------------------------------------------------------------- |
| `cache/` | `GRID_CACHE_DIR`: NOAA's CSVs, then BlueTopo and S-102 rasters |
| `store/` | The point store, a local DuckLake                              |
| `run/`   | `grid tiles`' run directory: tile outputs and fingerprints     |
| `tmp/`   | `GRID_TEMP_DIR`: DuckDB spill and downloads in flight          |
| `logs/`  | One log per stage, with its wall time and peak                 |

- **The heavy-job lock.** Every CPU- or memory-heavy stage takes `HEAVY.lock` with `lockf`, so it waits for any other full-store run on the machine. Only the download runs outside it.

## Stages

Each stage is a `grid` command run in a container. A stage starts only when the one before it finished.

| #   | Stage     | Command                                                | Runs as                                                                           | Lock |
| --- | --------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- | ---- |
| 0   | Download  | `prefetch.py`: every submission into `cache/files`     | host, 32 HTTP threads                                                             | no   |
| 1   | Ingest    | `grid ingest --source noaa`                            | one process, `GRID_CACHE_FILES_GB` above the archive so nothing is trimmed        | yes  |
| 2   | Compact   | `grid compact`                                         | one process, a partition at a time                                                | yes  |
| 3   | Tide      | `grid tide`                                            | one process                                                                       | yes  |
| 4   | Calibrate | `grid calibrate --reference s102 --reference bluetopo` | one process, `GRID_MEMORY_LIMIT=768MB`                                            | yes  |
| 5   | Tiles     | `grid tiles --out run --memory-gb 20`                  | Snakemake: leaf cells, leaf surfaces, splices, overlays, web, low zooms, assembly | yes  |
| 6   | Publish   | `grid tiles --out run --publish s3://…`                | uploads only; no job reruns                                                       | no   |

Download is split from ingest because ingest is one process and spends most of its time parsing, checking and writing, not waiting on the network (1,283 s of 18,350 in the Galveston–Houston run). Prefetching lets the download run while another session holds the lock, and lets ingest read local disk. The script keys each file as ingest's own fetch does (URL, key and ETag), so ingest finds every file in the cache, and a file it can't find it downloads itself.

Open Waters submissions are left out of this build: they aren't in NOAA's archive and are a few thousand small files ([noaa-archive.md](noaa-archive.md)). A later run adds them with `grid ingest --source openwaters`, which is incremental.

## Size and time, estimated

From the archive's size ([noaa-archive.md](noaa-archive.md)), the Chesapeake store, and the Galveston–Houston 3×3 run (54,121 files, 252M rows, ingested to R2 in 5.1 h at a 5.3 GB peak):

| Stage     | Estimate                                                  | From                                                                                      |
| --------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Download  | about 240 GB, a few hours                                 | 80 GB of submissions as submitted, CSVs about three times that                            |
| Ingest    | 30–40 h                                                   | Galveston's 46 s per million rows outside R2 writes, times 2.6B rows                      |
| Compact   | under 1 h                                                 | Chesapeake's 81 s, times 20                                                               |
| Tide      | 1–2 h, mostly CO-OPS fetches                              | Chesapeake's 211 s, plus every US gauge's months                                          |
| Calibrate | 3–5 h, plus reference downloads                           | Chesapeake's 627 s reducing every file, times 20                                          |
| Tiles     | 40–50 worker-hours, 5–6 h on 9 workers of 2 GB            | Chesapeake's leaf build, 74 job-seconds per million soundings, plus a fixed cost per tile |
| Publish   | 40–60 GB, 3–4 h at the 4.1 MB/s the Chesapeake went up at | the Chesapeake's 1.36 GB, times 20, and a 15–30 GB archive                                |

Disk at its fullest: the CSV cache (about 240 GB) and the store (about 60 GB compacted, 21 bytes a row on the Chesapeake, more before compaction) at the end of ingest. The CSV cache is deleted once ingest finishes, before calibration downloads BlueTopo and S-102 rasters for every US tile with data (32 GB for the Chesapeake and Galveston together), and before the run directory fills. Each stage logs free space, and a stage stops if the disk would fill.

## Checkpoints

A stopped run picks up where it stopped, stage by stage:

- **Download** skips every file already in the cache at its size; a `.part` file is a write that didn't finish and is ignored.
- **Ingest** publishes its catalog every 15 minutes (`catalog.CHECKPOINT_SECONDS`), so a rerun skips the files it committed.
- **Compact** rewrites each partition once per store layout and skips the ones already done.
- **Tide** fetches only station days it lacks, and calibrate reduces only files whose fingerprint moved (`lake.file_medians`).
- **Tiles**: Snakemake reruns only unfinished jobs; a job's outputs are its checkpoint.
- **Publish** names tile files by content, so a rerun uploads only what isn't there, and writes the manifest last.

The driver script records which stages finished in `logs/`, and on restart starts from the first that didn't.

## What to publish

The same keys as the Chesapeake preview ([per-tile-pipeline.md](per-tile-pipeline.md#publishing)): `overlay.pmtiles`, each tile's surface, cells and depth areas named by content, and `manifest.json`. The first planet publish goes to a preview prefix, `s3://tiles/crowd-depth/preview/planet/`, for review on the map before anything production reads it. The point store stays on the scratch disk for this run: moving it to R2 is a separate step, needed once the daily run lives somewhere other than the Studio.

## Measured

_To be filled in as each stage finishes: wall time, worker-hours, peak memory, bytes read and written._

| Stage     | Wall | Worker-hours | Peak memory | Read | Written |
| --------- | ---: | -----------: | ----------: | ---: | ------: |
| Download  |      |              |             |      |         |
| Ingest    |      |              |             |      |         |
| Compact   |      |              |             |      |         |
| Tide      |      |              |             |      |         |
| Calibrate |      |              |             |      |         |
| Tiles     |      |              |             |      |         |
| Publish   |      |              |             |      |         |

## Hetzner

_To be filled in: the same build and a planet day (about 18 worker-hours, [sub-tile-rebuild.md](sub-tile-rebuild.md#planet-estimate)) priced on Hetzner's cloud and dedicated servers, with traffic, from the Studio's measured worker-hours._
