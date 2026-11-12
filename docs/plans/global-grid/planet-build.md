# Planet build

How to build the grid from every file in NOAA's CSB archive in one run, on the Mac Studio, and what the same build and a daily run would cost on Hetzner. The archive covers 7,295 1° tiles and about 1.96B active soundings ([planet-size.md](planet-size.md)). Every stage's jobs fit a 2 GB worker on the Chesapeake ([backlog.md](backlog.md)), which is what lets the per-tile stages run in parallel.

Short answer, before measurement: ingest is the long pole. It is one process, and at the Galveston–Houston run's rate it takes about a day and a half for the planet. Everything after it, run in parallel on 18 cores, takes under half a day. The archive's CSVs are 471 GB, as much as the scratch disk has free, so ingest streams them through a capped cache rather than keeping them; the store and the tile outputs then fit with room to spare.

## Where it runs

- **Machine.** Mac Studio, 18 cores. Linux stages run in the grid image under OrbStack (25 GB VM), so DuckDB's jemalloc setting and `grid.release` work as on a server and each stage's peak is a cgroup's.
- **Disk.** Everything large lives on `/Volumes/External/crowd-depth/planet/`, a scratch disk with 471 GB free that Seascape's build shares, so its free space moves; the internal disk has 20 GB. Nothing there is kept: it can all be rebuilt from NOAA's bucket, or from R2 once published.

| Path     | What                                                                                    |
| -------- | --------------------------------------------------------------------------------------- |
| `cache/` | `GRID_CACHE_DIR`: up to 20 GB of NOAA's CSVs, CO-OPS months, BlueTopo and S-102 rasters |
| `store/` | The point store, a local DuckLake                                                       |
| `run/`   | `grid tiles`' run directory: tile outputs and fingerprints                              |
| `tmp/`   | `GRID_TEMP_DIR`: DuckDB spill and downloads in flight                                   |
| `logs/`  | One log per stage, with its wall time and peak                                          |

- **The heavy-job lock.** Every CPU- or memory-heavy stage takes `HEAVY.lock` with `lockf`, so it waits for any other full-store run on the machine. Only publishing, which is uploads, runs outside it.

## Stages

Each stage is a `grid` command run in a container. A stage starts only when the one before it finished.

| #   | Stage     | Command                                                | Runs as                                                                           | Lock |
| --- | --------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- | ---- |
| 1   | Ingest    | `grid ingest --source noaa`                            | one process, `GRID_MEMORY_LIMIT=8GB` in 12 GB, downloading as it goes             | no   |
| 2   | Compact   | `grid compact`                                         | one process, a partition at a time, `GRID_MEMORY_LIMIT=768MB` in 3 GB             | yes  |
| 3   | Tide      | `grid tide` with `GRID_WATER_LEVELS=stillwell`         | one process, `GRID_MEMORY_LIMIT=768MB` in 3 GB                                    | yes  |
| 4   | Calibrate | `grid calibrate --reference s102 --reference bluetopo` | one process, `GRID_MEMORY_LIMIT=1GB` in 4 GB                                      | yes  |
| 5   | Tiles     | `grid tiles --out run --memory-gb 20`                  | Snakemake: leaf cells, leaf surfaces, splices, overlays, web, low zooms, assembly | yes  |
| 6   | Publish   | `grid tiles --out run --publish s3://…`                | uploads only; no job reruns                                                       | no   |

Ingest downloads as it goes, 16 files at a time, while it parses, checks and writes the files before them; in the Galveston–Houston run it waited on the network for 1,283 s of 18,350. A separate download ahead of ingest would need the whole archive on disk at once, which doesn't fit beside the store.

Open Waters submissions are left out of this build: they aren't in NOAA's archive and are a few thousand small files ([noaa-archive.md](noaa-archive.md)). A later run adds them with `grid ingest --source openwaters`, which is incremental.

## Size and time, estimated

From a listing of NOAA's bucket on 2026-11-08 (1,045,268 CSVs, 471.1 GB), the Chesapeake store, and the Galveston–Houston 3×3 run (54,121 files, 252M rows, ingested to R2 in 5.1 h at a 5.3 GB peak):

| Stage     | Estimate                                                  | From                                                                                      |
| --------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Download  | 471 GB, inside ingest                                     | the bucket's listing                                                                      |
| Ingest    | 30–40 h                                                   | Galveston's 46 s per million rows outside R2 writes, times about 2.1B rows                |
| Compact   | under 1 h                                                 | Chesapeake's 81 s, times 20                                                               |
| Tide      | 1–2 h, mostly CO-OPS fetches                              | Chesapeake's 211 s, plus every US gauge's months                                          |
| Calibrate | 3–5 h, plus reference downloads                           | Chesapeake's 627 s reducing every file, times 20                                          |
| Tiles     | 40–50 worker-hours, 5–6 h on 9 workers of 2 GB            | Chesapeake's leaf build, 74 job-seconds per million soundings, plus a fixed cost per tile |
| Publish   | 40–60 GB, 3–4 h at the 4.1 MB/s the Chesapeake went up at | the Chesapeake's 1.36 GB, times 20, and a 15–30 GB archive                                |

Rows come from Galveston's 4.5M rows per GB of CSV, times 471 GB. Disk: the store is about 45 GB compacted at the Chesapeake's 21 bytes a row, more before compaction; the CSV cache stays under 20 GB; calibration downloads BlueTopo and S-102 rasters for every US tile with data, 32 GB for the Chesapeake and Galveston together and likely a few hundred GB for every US coast; the run directory holds about 30–60 GB of tile outputs. The rasters are the one cost that could outgrow the disk. The driver logs free space after every stage and stops when under 30 GB is left.

## Checkpoints

A stopped run picks up where it stopped, stage by stage:

- **Ingest** publishes its catalog every 15 minutes (`catalog.CHECKPOINT_SECONDS`), so a rerun skips the files it committed.
- **Compact** publishes after each partition, and a rerun skips the partitions already done, unless their points or flags have crowded again.
- **Tide** fetches only station days it lacks, and calibrate reduces only files whose fingerprint moved (`lake.file_medians`).
- **Tiles**: Snakemake reruns only unfinished jobs; a job's outputs are its checkpoint.
- **Publish** names tile files by content, so a rerun uploads only what isn't there, and writes the manifest last.

The driver script records which stages finished in `logs/`, and on restart starts from the first that didn't.

## What to publish

The same keys as the Chesapeake preview ([per-tile-pipeline.md](per-tile-pipeline.md#publishing)): `overlay.pmtiles`, each tile's surface, cells and depth areas named by content, and `manifest.json`. The first planet publish goes to a preview prefix, `s3://tiles/crowd-depth/preview/planet/`, for review on the map before anything production reads it. The point store stays on the scratch disk for this run: moving it to R2 is a separate step, needed once the daily run lives somewhere other than the Studio.

## Measured

On the Mac Studio under OrbStack, with the store on a USB SSD. Each stage is one process, so its worker-hours are its wall time. Peak memory is the container's anonymous memory, sampled each second; the cgroup's read and write counts miss most of the bind mount's traffic, so they're left out.

| Stage     |                Wall | CPU-hours | Peak memory |
| --------- | ------------------: | --------: | ----------: |
| Ingest    | 24.3 h, in six runs |      34.5 |     10.5 GB |
| Compact   | 53 min, in two runs |       2.6 |      2.0 GB |
| Tide      |              61 min |       3.3 |      1.8 GB |
| Calibrate |                     |           |             |
| Tiles     |                     |           |             |
| Publish   |                     |           |             |

**Ingest** read all 1,045,268 CSVs into 1.90B points and 171M flags. It ran at a 2 GB limit in 6 GB at first, then at 8 GB in 12 GB; the lock was waived so it ran beside the Galveston probes, and its times include their load. Two runs stopped about 7.8 h in when a download in `tmp/` vanished from OrbStack's bind mount, and the driver now reruns ingest after that error, up to three times; each rerun resumes from the last checkpoint. One run was killed at 6 GB while rule 4 judged one vessel's 1.49M overlapping pairs, and two failed in the final publish's merge of 34,168 flag files, one at 10.5 GB. The fixes for both are in [#237](https://github.com/openwatersio/crowd-depth/pull/237), and with them the last run took 520 s at 2.3 GB.

**Compact** rewrote all 285 partitions, the points from 42,753 files to 389 (132 GB on disk, old files included until snapshots expire) and the flags from 34,168 to 277. Its memory grows over a run, in DuckDB's file and object caches and about 1 GB outside them: the first run was killed at 2 GB after 197 partitions, and the second finished the other 88 in 3 GB.

**Tide** read gauge observations from Stillwell. A first run against CO-OPS' API spent 9 h fetching gauge months at about 8 s each and stopped unfinished when the Studio rebooted; from Stillwell the whole stage took 61 min. It wrote 382,510 station days. Of the 14,522 gauge months the soundings need, Stillwell couldn't give 4,268: 2,801 at 132 gauges it hasn't backfilled, 1,189 at 57 gauges with no MLLW in its station list, 278 at 49 gauges whose year file has nothing usable that month, and 5 that returned HTTP 500. Those months keep CO-OPS residuals from the stopped run (597) or none, so their soundings get Slackwater's prediction alone (3,671). Each later tide run asks for them again. Six more months failed when two of tide's fetchers downloaded the same year file at once and one read it mid-rename on OrbStack's bind mount; they're asked for again too.

## Hetzner

The same build and a planet day priced on Hetzner, read from Hetzner's own pages on 2026-11-08, in euros before VAT. Worker-hours are the Studio's estimates above until the Measured table holds real ones, scaled by 1.5 for server cores against the Studio's ([rebuild-cost.md](rebuild-cost.md#a-planet-day)). A planet day is about 18 worker-hours on the Studio ([sub-tile-rebuild.md](sub-tile-rebuild.md#planet-estimate)), so about 27 on a server.

### Prices

| Server                      | Cores, memory, disk                                                               | Price                                      | Source                                                                    |
| --------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| Cloud CCX43, dedicated vCPU | 16 vCPU, 64 GB, 360 GB                                                            | €0.4431 an hour, capped at €276.49 a month | [general purpose](https://www.hetzner.com/cloud/general-purpose/)         |
| Cloud CPX62, shared vCPU    | 16 vCPU, 32 GB, 640 GB                                                            | €0.2091 an hour, capped at €130.49 a month | [regular performance](https://www.hetzner.com/cloud/regular-performance/) |
| Dedicated AX42              | Ryzen 7 PRO 8700GE, 8 cores and 16 threads, 64 GB, 2 × 512 GB to 2 × 1.92 TB NVMe | €79–99 a month, €49 setup                  | [AX matrix](https://www.hetzner.com/dedicated-rootserver/matrix-ax/)      |
| Dedicated AX102             | Ryzen 9 7950X3D, 16 cores and 32 threads, 128 GB, 2 × 1.92 TB NVMe and up         | €159–259 a month, €129 setup               | [AX matrix](https://www.hetzner.com/dedicated-rootserver/matrix-ax/)      |
| Server auction              | Ryzen 7 7700, 8 cores and 16 threads, 64 GB, 2 × 1 TB NVMe                        | €136 a month, no setup                     | [server auction](https://www.hetzner.com/sb/)                             |

- **Traffic.** Hetzner bills outgoing traffic only, on cloud and dedicated servers alike ([cloud billing](https://docs.hetzner.com/cloud/billing/faq/), [dedicated traffic](https://docs.hetzner.com/robot/general/traffic/)). Reading NOAA's 471 GB and the store from R2 costs nothing at either end, since R2 doesn't charge for egress. Uploads to R2 are Hetzner egress: a dedicated server's 1 Gbit port has no traffic limit, and a cloud server in the EU includes 20–40 TB a month, far above a first publish of 40–60 GB and a day's few GB. US cloud locations include only 3–5 TB, still enough.
- **Price rises.** Hetzner raised prices on 1 April 2026 and again for new orders on 15 June 2026; the figures above are after both. Cloud plan pages showed every plan as currently unavailable when read, which may be capacity limits; the console is the check.
- **Disk.** A dedicated server's two disks come mirrored, so an AX42 needs the 1.92 TB drives for the 500 GB–1 TB the planet needs, the top of its price range.

### The build and a day

|                      | Studio                    | Cloud CCX43, by the hour                                                                        | Dedicated AX42                                             |
| -------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Full build, ingest   | 30–40 h, one process      | 45–60 h, €20–27                                                                                 | 45–60 h, in the month's price                              |
| Full build, the rest | 50–60 worker-hours, 6–8 h | 75–90 worker-hours, 6–7 h on 14 workers, €3                                                     | the same on 14 workers of 64 GB, 6–7 h                     |
| A planet day         | 18 worker-hours           | 27 worker-hours, 2–3 h, about €1.30, but the run directory and store have to outlive the server | 27 worker-hours, 2–3 h                                     |
| A month of days      |                           | about €40, plus somewhere to keep 100 GB between runs                                           | €99, with the disk to keep the run directory and the store |

A cloud server by the hour is cheap for one build, but a daily run needs its run directory (tile outputs, fingerprints, shoals and web archives, 30–60 GB, which R2 doesn't hold) and the store each day. Keeping them on a cloud volume or rebuilding them from R2 every morning costs more effort than a dedicated server costs money.

**Recommendation:** run the daily rebuild on a dedicated AX42 with the 1.92 TB drives, about €99 a month and €49 to set up, or an auction machine of the same class at about €136 with no setup fee. It has the cores for a planet day in 2–3 hours, memory for 14 or more 2 GB workers, and room for the store, the run directory and the reference rasters. Keep the Studio for one-off builds and spikes, where its cores are faster and it costs nothing more.

Not verified: the price of the AX42's 1.92 TB drive option on its own, cloud volume prices, and whether AX servers have a minimum contract.
