# Backlog

The work that takes the pipeline from a working point store to a planet rebuilt daily on cheap hardware, in priority order. Evidence for each item is in [rebuild-cost.md](rebuild-cost.md), [store-layout.md](store-layout.md), [qc-functions.md](qc-functions.md), [per-tile-pipeline.md](per-tile-pipeline.md), [channel-speckle.md](channel-speckle.md) and [surface-statistic.md](surface-statistic.md). The phases in the [plan](README.md#phases) still apply. This list orders the work inside them.

## 1. Fix what fails today

- [ ] **Corroboration join runs out of memory.** `cells.CLASSIFY` joins each consensus shoal to every sounding in its 3″ block, which ran out of memory in the bay's `grid cells` at 3.7 GB and on the densest tile at 2 GB. Joining against one row per distinct depth in the block, with its least and greatest vessel, is exact for `CORROBORATE = 1` and takes 24 s on that tile. In progress on the point store branch.
- [x] **Ingest can't resume.** A multi-hour import is one transaction, so a single late R2 error discards it. Commit per batch, and record progress so a rerun skips committed files.
- [x] **Coverage is half of ingest.** Rule 4's coverage step (9,724 s of 19,153 s for Chesapeake) queries each file against every other file's time range. Sort files by vessel and start time and sweep instead.
- [ ] **Output isn't deterministic.** `placed` in `cells.CLASSIFY` takes `arg_min(position, time)`, and ties at the same depth and time resolve by thread order, so unchanged inputs give different bytes. Break ties on a stable key. Per-tile change detection depends on this.

## 2. Calibrate vessels

Per-vessel vertical offsets are the largest error in the grid. In Thimble Shoal Channel vessels read a median 3.8 m shallower than BlueTopo, from 0.6 to 5.4 m by vessel, and the current surface draws the channel 9.3 m too shallow. An offset learned on one half of the channel leaves ±0.14 m on the other, so each vessel's offset is constant. Without calibration, no per-pixel statistic draws the channel right.

- [ ] **Spike crossover offsets.** Compare reference-survey calibration with crossover-only offsets (least squares at track crossings, as in GMT's x2sys) anchored to calibrated vessels, check how offsets drift over time and with sounder changes, and cost both at planet scale. Repeat the BlueTopo comparison in a sparse area and on rocky bottom.
- [ ] **Offsets table.** A `calibration` table of offset, scale and uncertainty per vessel and time span, fit against BlueTopo, S-102 and Seascape's surveyed sources where tracks overlap them, and solved at crossovers elsewhere, as in [Vessel calibration](README.md#vessel-calibration). Applied before gridding. A calibration change dirties every tile the vessel crossed.
- [ ] **Replace the 10th percentile with `median − kσ`** over per-vessel medians, with σ published per pixel for `M_QUAL` and CATZOC, and k a stated margin. With offsets corrected, k = 1.645 draws more than 1 m deeper than the shoalest BlueTopo cell under it in 0.6% of pixels, against 2.7% for the current surface.
- [ ] **Mark interpolated cells.** Cells filled within 200 m of tracks get `kind = interpolated` and a σ that widens with distance from the nearest track, and are never interpolated over an unconfirmed shoal, as in [Interpolation](README.md#interpolation).
- [ ] **Drop the guard on the shoalest sounding.** Carry hazards through confirmed shoals, which publish as soundings anyway. In the channel the guard alone draws a third of pixels under 9 m.
- [ ] **Better σ.** Per-vessel uncertainty from calibration residuals, plus spread around a local plane, so slopes don't widen σ as noise does. CUBE/CHRT does this formally and suits dense areas.

## 3. Make the daily rebuild fit

In order: each step makes the next one measurable.

- [ ] **Store sorted by tile.** One `points` table, sorted by `cell_id` and `tile_id` within each 10° partition, in 256 MB files with row groups of about 123k rows. Daily appends sorted by tile; each partition is compacted when its delta files pass a threshold. Per-file rules (copy takeover, coverage, QC by batch) run against the day's delta or the `files` table, not sorted points.
- [ ] **Drop the stored `point_id`** (47% of bytes) and key soundings by `(file_id, row)`. Put `tile_id` on `qc_flags`, so flag reads prune by tile. Do this with the sort, since both rewrite the store.
- [ ] **Skip empty raster blocks in the surface.** Only a median 15% of a tile's 512-pixel blocks have a sounding within 200 m. This removes most of the 36–73 worker-hours of fixed per-tile cost at planet scale and brings sparse tiles well under the 2 GB budget.
- [ ] **Read a tile's points once per cells run.** `active_points_in` reruns the dedupe for every band unit (6 × about 20 s on the densest tile), and the `SOURCES` write is a separate pass (122 s). Read once and derive both.
- [ ] **Per-tile pipeline.** Cells and surface per 1° tile, web tiles per z8 tile, one low-zoom run, byte-copy assembly into one PMTiles archive. Each tile has a manifest of its input fingerprint, its neighbors' fingerprints, `GRID_VERSION` and `QC_VERSION`. The archive is published only when every dirty unit has finished, and a tile emptied by withdrawals has its outputs removed. Long-lived workers, with a scheduler that weighs memory without stalling small units behind large ones.
- [ ] **Dirty work below 1° in dense tiles.** Mark the bands that new files touch, plus one band each side, and rebuild surfaces in windows of about 1/8° with a 200 m margin, so daily cost follows each day's new tracks. Compare with an adaptive quadtree that splits tiles until each holds under N soundings.
- [ ] **Hierarchical low zooms.** z5–z7 per z5 tile, then z0–z4 from those, before the planet's feature volume makes one run slow. Test that shoals survive at z4–z7.
- [ ] **Measure the planet.** Tile count and density from `points` by `tile_id`, reads from DuckLake on R2 after compaction, timings on cheap x86 cores, and upload cost of the daily archive. Re-run the estimate in [rebuild-cost.md](rebuild-cost.md) against them.

## 4. Clean up QC and seams

These change results, so each bumps `QC_VERSION` or `GRID_VERSION` and triggers a full rebuild. Batch them where possible.

- [ ] **QC as pure functions.** Replace the track QC SQL with the numpy version, identical on 13.4M soundings and 17 times faster per core. Share thresholds and test vectors as JSON so the plugin can run the same checks in TypeScript. Do this before the next QC rule, so the rule is written once.
- [ ] **Widen the cell tolerance for candidate shoals** to max(2 m + 5%, 3 × MAD). Removes 77–89% of the holes that speckle busy channels, and nothing is dropped in sparse areas. Re-measure after calibration, since vessel offsets cause many of these candidates.
- [ ] **Score track noise.** Keep the soundings of a track with a large local spread for consensus, but don't let them set depths, cap pixels or punch holes, so one-sided spike rejection doesn't throw out the true bottom.
- [ ] **Seams between tiles.** Grid each tile with a few pixels of margin and crop after the blur and shoal guard, let consensus votes read across tile edges, then re-measure. This makes cells depend on their neighbors, so design it with the dirty-work item above.
- [ ] **Mask structures.** The Chesapeake Bay Bridge's piers draw as a line of 0.6–3 m shoals, from real echoes off the piers. Mask soundings on bridges, piers and pylons from OSM or ENC structure layers.
