# Point-store and performance release gate

## Current checkpoint — November 25, v44

Release acceptance is **not met**. Docker still runs reviewed v44 (`c974578`):
loaded full-model HTTP p95 was about 415 ms, above the 250 ms limit, and cold
viewport gates also failed. The capture-index foundation below is staged only;
production chart routing and stationary thinning remain unfinished. A later
review also confirmed that refinement can hide unmatched local preview evidence,
even though acquisition preserves its rows. That retirement defect remains open.

The new capture index avoids decoding originals at startup and pages candidates
before exact time filtering. Isolated Docker measurements used temporary databases:
4,096 one-point chunks opened in 12 ms, with query-page p95 1.1 ms and empty
same-day first-page p95 1.2 ms. A 65,536-point fixture in 128 full-size chunks
opened in 9 ms; its eight migration batches took at most 81 ms. Production
migration yields one second between batches. These runs are component evidence,
not a browser-paint, storage-wear, or whole-viewport acceptance result.
[Raw measurements](pi-capture-index-nov25.json) retain the earlier run and limits.

The foundation and header/query fixes pass 716 tests across 58 files, plugin
build/lint/publint, and nine real Signal K E2E tests. A mapped external Codex
review and independent internal review identified the repair and same-day scan
issues; their regression tests failed before the fixes. The focused external
follow-up found no new issues in those fixes. Broader canonical selection,
refinement retirement, input revision and hardware acceptance blockers remain open.

The same candidate-first query fix now also applies to historical import discovery,
which production chart readers use. The new regression follows empty pages to an
older matching window. All 719 tests in this checkpoint and plugin lint pass
locally. The focused mapped external review found no new issues, but independent
internal review subsequently reproduced a caller regression: replay exhausted its
64-page budget on empty candidates and requested an offline provider despite
retained evidence. Replay now limits matching manifests, yields between pages,
and honors reader-specific cancellation. Both regressions pass; the internal
reviewer verified the fixes and all 25 source tests. This caller fix was made
after the third external round; no fourth external review was run. Local index-only scaling includes
100,000 same-day candidates; [raw results](import-index-candidates-nov25.json)
measure pages, not whole traversal. Pi transfer was blocked by SSH signing, so
these new import-query figures are not hardware acceptance evidence.

## Earlier checkpoint — November 25, v39

Release acceptance is **not met**. The working tree uses observation schema v7;
678 regressions, plugin lint/publint pass. Nine real Signal K end-to-end tests passed the preview
coverage changes; the v7 archive follow-up is being checked separately.
Docker runs private preview v39 as of November 25, 18:15 UTC, after an online
backup passed SQLite quick_check. Initial capture verification found 12,853
observations in 33 chunks, with one full and seven preview imports. Integrated
performance acceptance remains open. The preview includes the follow-up review
fixes below. The dated measurements and test totals later in
this document describe their named earlier snapshots, not the current test count.

Repeated Pi fixtures measured owned-hour refinement at 3.5–3.8 s anchored and
3.0 s underway after the exact-output QC optimization, versus 9.3–9.5 s and
6.6–6.7 s before. These exclude provider latency and browser paint. Production
thinning, canonical live/history reads, independent enrichment scheduling,
storage-retention limits and the loaded viewport/browser gates remain unfinished.

The Pi preview demonstrated that early point publication alone is insufficient:
refined cells were still empty while chronological backfill visited old history.
Do not ship based on unit tests, total backfill time, or first database commit.
Measure actual useful viewport content and its refinement while acquisition runs.

## Storage direction to validate

History is an import/backfill adapter. Live capture and historical import converge
into an owned, versioned observation store; display and QC read that store, never
query the history provider directly. Retain source identity, observation time,
position, uncorrected depth/reference, calibration epoch, heading/attitude when
available, and quality/provenance. An imported aggregate is not an original ping.
Define live/history overlap precedence before deduplication; timestamps alone
cannot identify samples from multiple instruments or different aggregations.

Keep acquisition, preview aggregates, track-QC results, pass contributions and tile
versions separate. Reprocessing replaces identified contributions. It must not add
another copy of a pass or advance a global chronological checkpoint past holes.
Viewport requests select bounded spatial jobs with enough track context; provider
availability and failing jobs cannot block independent regions.

### Candidates

| Candidate                                             | What it adds                                                                                       | Initial disposition                                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| SQLite with R-tree                                    | Bounding-box indexing without another native extension                                             | Baseline; confirmed available in the Pi's Docker Node runtime                                               |
| Compressed track chunks in SQLite with a chunk R-tree | Fewer index entries and potentially fewer bytes/writes; decode cost and coarse candidate selection | Benchmark against individual point rows                                                                     |
| SpatiaLite                                            | Spatial SQL, geometry operations and coordinate transformations                                    | Consider if these operations are actually needed in the store; do not assume a faster R-tree                |
| GeoPackage                                            | Standard SQLite-based geospatial interchange and geometry encoding                                 | Useful export/interoperability candidate; not a different database engine or an automatic speed improvement |

The Pi is a Raspberry Pi 5 Model B Rev 1.1, Node 24.22.2, SQLite 3.53.4,
with R-tree available. Those are observations of the current Docker runtime,
not a declaration of the minimum supported hardware.

Raw spatial indexing alone is insufficient. A dense anchorage can put millions
of observations in one viewport. The initial display must read compact
multi-resolution cell summaries, not sort or decode every matching observation.
Raw tracks remain available to bounded chronological QC/research jobs.

### SD-card concerns

Measure payload bytes, database/index/free-page size, WAL high-water mark,
checkpoint latency, transaction count, host write bytes where available, and
write amplification relative to input bytes. Host write counters do not measure
physical NAND writes or card endurance. Measure both time-series append patterns
and repeatedly updated anchorage cells. Do not repeatedly recompress an active
chunk, rewrite all aggregate levels per ping, vacuum the database on startup, or
persist every transient tile rebuild.

Compare per-point R-tree inserts with sealed-chunk indexing and a small durable
active journal. Batch cell-summary updates by cell per transaction. Benchmark
NORMAL and FULL synchronization separately, recording the power-loss guarantee:
reconstructible caches and the only copy of an observation need different
policies. WAL checkpoints and compaction run with bounded work off the server
thread. Bounded readers must release snapshots so the WAL can be reclaimed.

## Activity-aware retention

Do not implement irreversible thinning until it passes information-loss tests.
Compression of unchanged raw observations is the first lossless comparison.

Candidate resting policy: retain recent original samples plus one-minute,
UTC-aligned summaries for older stationary periods. Preserve count, temporal
coverage and gaps, mean/median, spread, extremes, representative position and
position spread, sensor/reference epoch, and quality flags. Never combine
instruments, calibration/reference epochs, anchor relocations or discontinuities.
Sparse or invalid buckets remain sparse/invalid; do not invent continuity.

Resting must be identified from motion and position dispersion, not a single
speed reading. A swinging boat samples different bottom elevations. Test retaining
summaries per small spatial cell as well as per minute; a single anchorage mean
can confuse bottom slope with tide. Keep high-rate anomaly/movement boundaries,
calibration intervals, and selected raw bursts with explicit coverage metadata.

For later tide analysis preserve depth **before tide correction**, UTC timing,
position and reference/calibration history. Independent water-level variation
cannot be inferred from changing sounder depth without considering bottom,
boat motion, draft, loading and attitude. One-minute summaries are a candidate,
not a proven sufficient representation for every future analysis. Wave spectra
cannot be recovered from averages and spread alone; retain raw bursts for those.

Retention is a separate policy from rendering resolution. A chart may show a
single cell mean while the observation store retains its complete compressed
recording. Initially retain original observations losslessly; do not delete them
when QC finishes or derived caches are invalidated. Do not substitute a
predicted-tide-corrected seabed estimate for the original measurement.

Before enabling older-data thinning, define the supported research products and
an explicit error budget for each. Tide estimation needs a long, consistent
record at a known location/reference, not merely many closely spaced samples.
Retain time/position strata and sufficient statistics (count, sum, sum of squares,
minimum and maximum) so means and variance can be combined correctly. Medians
cannot be combined from bucket medians; retain raw values or a documented
approximate distribution if that capability is needed. Preserve observed time
coverage separately from sample count so outages and changing sample rates do
not silently alter weighting.

Store the retention method/version and original sampling/aggregation provenance
with each compacted interval. Keep boundaries between depth references and sensor
calibrations, and retain available draft/loading and attitude context without
inventing missing values. Prefer collecting high-rate data into sealed compressed
chunks before considering destructive thinning. Do not rewrite those chunks on
each new ping. No automatic raw-data deletion is enabled by this plan; approval
of a measured retention policy is a separate decision after fidelity validation.

Compare constituent amplitude/phase and held-out tide predictions using full
versus thinned recordings. Include a synthetic known tide, waves, sensor noise,
gaps, outliers, GPS wander, sloping bottom, mooring swing and reference changes.
Also compare repeat-pass bathymetry and shoal retention. Report errors rather
than declaring success because the downsampled curve looks similar.

## Performance matrix

| Dimension   | Required cases                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Scale       | 100k smoke, 1M regular, 10M and multi-year release fixtures; scale by samples, not only days                                               |
| Activity    | underway, dense repeated tracks, days at anchor at 1/5/10 Hz, mixed voyages                                                                |
| Geography   | tiny harbor, wide coastal viewport, empty region, dateline, high latitude, sparse isolated tracks                                          |
| Acquisition | empty install, warm restart, derived-cache invalidation, historical import, late corrections, duplicate windows, unavailable/slow provider |
| Interaction | pan away mid-job, rapid zoom, two viewers, return to previous viewport, units change                                                       |
| Concurrency | live capture + import + QC + visible tiles + reporting + checkpoint/compaction                                                             |
| Recovery    | crash/restart at each publish boundary, interrupted chunk, disk full, cancelled request, changed source/reference                          |
| Runtime     | production Docker on Pi SD card; CPU/RAM-constrained secondary target; Mac only for development                                            |

For each stage record p50/p95/p99/max latency, throughput, CPU, peak RSS, queue
length and age, event-loop delay, disk and WAL growth, bytes written, and work
cancelled/repeated. Separate first useful **browser paint**, first viewport QC
refinement, and eventual full-history completion. Log provider wait separately
from local processing. Distinguish OS-cache cold, process cold and fully warm
runs; reopening SQLite does not make the SD-card cache cold.

Release acceptance requires bounded memory/queues, no loss or duplicate
contributions, responsive capture/API under background load, and specified
viewport latency budgets on the minimum hardware. Set numeric budgets from
measured baselines and user-visible requirements before treating timing as a
pass/fail gate. CI uses deterministic correctness and large-regression checks;
controlled Pi runs enforce absolute latency/storage budgets. Store environment,
fixture seed, package hash, SQLite settings and raw metrics with every result.

The existing benchmarks cover useful pieces but do not constitute this suite.
They do not yet measure browser paint, all recovery paths, write amplification,
or fidelity after thinning. The candidate-storage benchmark is a comparison
experiment, not the production point-store implementation.

## Primary references

- SQLite R-tree: https://sqlite.org/rtree.html (bounding-box queries; float index rounding)
- SQLite WAL: https://sqlite.org/wal.html (reader/writer concurrency and checkpoints)
- SpatiaLite: https://www.gaia-gis.it/fossil/libspatialite/index
- OGC GeoPackage: https://www.geopackage.org/spec/
- NOAA measurement specification: https://tidesandcurrents.noaa.gov/publications/CO-OPS_Measurement_Spec.pdf
- NOAA harmonic constituents: https://tidesandcurrents.noaa.gov/about_harmonic_constituents

## Initial lossless storage experiment

Run `node packages/signalk-plugin/scripts/bench-point-store.mjs 100000 NORMAL`
from the repository root. Each candidate/fixture runs in a fresh process against
its own temporary database, verifies exact viewport counts, and deletes that
database afterward. The script never opens the plugin database.

The recorded [desktop smoke result](desktop-100k-normal.json) compares individual
point rows with compressed 256-point chunks, both with spatial indexes and cell
summaries. For 100,000 anchored observations, total database size was 12.30 MB
versus 2.65 MB respectively. This motivates testing lossless compression before
removing scientific observations. It does not select a production format.

These are warm desktop measurements with a simplified five-value observation
schema, not Pi SD-card acceptance results. Chunk queries decode matching points;
row queries count matching rows without materializing their payloads, so their
latencies are not an equivalent end-to-end data retrieval comparison. The
prototype has no production provenance columns, concurrent readers/writers,
crash tests, cold-cache runs, or fidelity analysis. The synthetic underway track
repeats; it is not a substitute for representative recorded voyages. Summary
queries are bounded but do not yet validate aggregate numerical accuracy.

## November 22 follow-up implementation and measured limits

The local implementation now uses independent hourly refinement jobs, newest
first, with spatial prioritization of already acquired chunks. Jobs publish cells
and overviews atomically. Failed windows remain pending while independent windows
can proceed. The original chronological backfill remains in the tree for legacy
regression comparisons; production uses `refineHistory`.

The refined estimate now uses timestamp-based exponential weighting, configurable
through `chart.halfLifeDays` (default 365, accepted range 1–36500 days). This changes
rendering weights, not retention. Each UTC hour/cell/reference contributes at most
one unit of weight; pass medians within it determine its mean and spread. Tided
and untided records remain separate. Weighted parallel variance replaces the
order-dependent moving absolute deviation. The existing correction and tide
uncertainties still contribute to the published conservative margin. This is a
changed estimator requiring field validation, not a claim of equivalent results
to the old fixed-alpha EMA or a validated hydrographic confidence interval.

Hour summaries are combined in a lazily promoted tree with fanout 256. Sparse
cells store only their hour summaries. A changed historical hour updates bounded
groups instead of replaying the cell's full history. A desktop in-memory test of
2,001 hourly jobs / 12,006 passes at one anchorage measured about 12.5 ms for the
last old chronological replay, versus about 0.23 ms for the initial weighted-tree
prototype. Re-run the committed tests/benchmarks; these numbers are exploratory.

An incomplete History response must never erase live contributions. Until an
owned raw observation store supplies an exact overlap contract, existing live
passes take precedence for their cell within the requested hour. Historical
passes for that cell/hour are withheld rather than counted again. This preserves
live evidence but does not reconstruct missing historical coverage inside that
cell/hour; full point-level reconciliation remains a release blocker.

The Pi Docker storage comparison (100k anchored synthetic observations, NORMAL,
256-point batches, warm reads, concurrent real backfill) recorded:

| Candidate                  |   DB bytes | Host write bytes | Ingest ms | Summary query p95 ms |
| -------------------------- | ---------: | ---------------: | --------: | -------------------: |
| Point rows + R-tree        | 12,304,384 |      626,130,944 |    28,521 |                0.248 |
| Compressed chunks + R-tree |  2,650,112 |       15,417,344 |     1,430 |                0.287 |

These are loaded-system observations, not controlled acceptance results or physical
NAND writes. The raw row query counts records while the chunk query decodes them,
so their retrieval times are not equivalent work. Both retain all synthetic input
values. Original results are stored beside this document.

Remaining storage work includes continuous owned raw capture even with History,
source/reference epochs for imported originals versus provider aggregates,
cache namespace/revalidation policy, and pass-ledger compaction after a retained
observation archive can reproduce it. No destructive thinning is enabled.

## November 22 cold-render investigation

Confirmed the Docker plugin symlink points to `progressive-20261122-demand`.
No rendering code was changed between these two measured runs:

| Zoom | Earlier cold viewport (ms) | Repeat cold viewport (ms) |
| ---- | -------------------------: | ------------------------: |
| 13   |                       3898 |                      1423 |
| 14   |                       5008 |                      1821 |
| 15   |                       3738 |                      1510 |

Each viewport requested nine tiles concurrently through a fresh tile service
against the production database opened read-only, with no persistent tile cache.
The benchmark ran at nice 10 inside the Signal K Docker container. Worker startup
is included; operating-system file caches were not flushed. In-memory repeats
were below 1 ms, which is not an HTTP or browser rendering measurement. The
variation between runs demonstrates that loaded-system results need repeated
measurements and concurrent Signal K latency probes; it is not a code speedup.

A separate low-priority V8 CPU profile rendered a populated tile three
times synchronously in the diagnostic process, clearing prepared surfaces between
renders. It took 345, 279 and 206 ms, with identical 5410-byte output lengths.
Sampled hotspots included nearest-neighbour interpolation, garbage collection,
surface construction, upsampling, cutting, contour and band tracing. The profile
is retained locally at `/tmp/crowd-depth-cold-tile.cpuprofile`; it is diagnostic
sampling, not a controlled attribution of all viewport latency. Neither run
modifies soundings or clears the production tile cache.

Cold rendering remains a release blocker. Whole-history warming stays disabled.
Next compare worker queueing/startup and shared-surface reuse under controlled
load, then measure any kernel changes against identical tile output and Signal K
responsiveness before considering bounded viewport prefetch.

### Candidate spatial-search optimization

The candidate uses a balanced spatial tree of occupied pixels for sparse
coverage, retaining raster-offset enumeration for dense coverage and small radii. It retains the exact search radius, neighbour count, distance
arithmetic and row-major tie breaking; uncertainty and interpolation rules are
unchanged. Existing dense/sparse brute-force comparisons and added exact-radius,
tie, empty and single-point cases exercise the search. Synthetic full tile
comparisons against the previous implementation produced identical bytes for
one, four and twenty parallel lanes. Desktop samples suggest a substantial sparse
track improvement and a smaller dense-track improvement, but do not establish Pi
acceptance. The Pi comparison was blocked when SSH key signing stopped working.
The installed Docker preview has not changed.

Run `node packages/signalk-plugin/scripts/bench-viewport.mjs <database> <lon> <lat>
[rounds] [health-url]` after building. It opens the database read-only and renders
nine-tile views at zooms 13–15 through the production worker pool. The first view
includes worker startup; subsequent views and rounds reuse workers but discard
tiles and shared surfaces. JSON output includes first populated tile, full view,
in-memory repeat, each tile's time/bytes, event-loop delay and optional concurrent
HTTP probes. No persistent tile cache is attached and no history is fetched.
This separates worker startup, cold surfaces and cache hits without clearing the
running plugin's caches. It is a diagnostic benchmark, not yet a passing Pi gate.

Working acceptance targets for the representative Pi viewport are first visible
content within 500 ms, a full cold nine-tile viewport within 1 s after worker
startup, and concurrent Signal K HTTP p95 below 250 ms without timeouts. Check
multiple viewports and repeats under backfill as well as at idle; do not use a
single favourable run or a desktop result as acceptance. These targets do not
cover browser paint time, which needs a separate plotter check.

### Final local search comparison and review corrections

The first tree-only candidate regressed dense-grid search. The final dispatch
keeps the raster search at occupancy >= 1/32 or radius <= two pixels. Measurements
near 1/16 occupancy were marginal after setup cost, so the more conservative
threshold leaves headroom. The tree traversal is allocated once per index, not
once per query. Its synchronous query callback reuses traversal state.

`bench-search.mjs [baseline-surface-module]` now compares the two builds on the
same grid/track inputs, including both sides of the dispatch threshold. It checks
25 queries per case against a brute-force distance sort after both timings, plus
total neighbour counts across every query. The dedicated tests cover dense and
sparse full-search equivalence, maximum counts 1/3/12, exact-radius ties, empty
inputs, and a collinear track. A separate 64-tile matrix across latitudes,
zooms, contour detail and shoals produced byte-identical output.

Historical round-14 desktop medians, superseded by the November 24 hybrid-search
measurements below, after one warm-up and five alternating-order rounds (Node
24.21.0, not Pi acceptance), including index setup:

| Search workload                         | Before ms | Candidate ms |
| --------------------------------------- | --------: | -----------: |
| Dense 65,536-point grid, 65,536 queries |    10.736 |       10.751 |
| Sparse 676-point grid, 65,536 queries   |   105.557 |       18.843 |
| Single track, 7,424 nearby queries      |     7.483 |        4.985 |
| Dense harbour patch, 3,136 queries      |     0.978 |        0.978 |

See [raw comparison](search-desktop.json). These are kernel timings, not viewport timings, and should not be extrapolated
to Pi acceptance.

The broad round 12 review reiterated existing release blockers without mapping
the new search. A focused round 13 used the standard Open Waters review script
against an isolated snapshot containing only the performance diff and surrounding
source. Both reviewers found that the added boundary test hit the raster fallback;
that test now explicitly exercises both paths. Their cutoff-evidence and
allocation feedback led to the comparison harness and hoisted traversal above.
The duplicate-pixel note is outside the documented input contract: the only
production caller coalesces sources to one per pixel before either search. No
extra deduplication was introduced. Both reviewers were static-only. The initial
focused-review attempt had an empty snapshot and is not a completed review.

The round 14 focused review found no correctness defect but identified a missing
performance case: a dense harbour inside an otherwise sparse raster. Direct
measurement confirmed the tree regression. That iteration checked
8×8-pixel blocks before constructing a tree; a block with at least 9 occupied
pixels kept the tile on the original raster search. That measured harbour case
returned to baseline performance while sparse tracks retained their improvement.
The November 24 candidate instead chooses per query block; see its newer Pi
measurements and the explicit dense-harbour setup regression below.
Both dispatches still compute identical neighbours. Tests now compare clustered
and dispersed inputs just below, at and above the global dispatch threshold, at
48- and 288-pixel sizes, against a full sort, including max counts larger than
the input. Small-radius raster tests also cover empty and single-point inputs.
The benchmark now includes the harbour and alternates variant order over five
rounds after an untimed warm-up. The single-run measurements above have been
replaced by this final repeated comparison. Neither benchmark is a Pi result.

Pi SSH authentication failed again during this work. All hardware acceptance and
installation of this candidate remain pending; the running Docker package is
still `progressive-20261122-demand`. No current claim of acceptable Pi cold-render
latency is made.

Round 15 completed a further static review of the search and benchmark evidence.
The proposed high-latitude regression did not reproduce: the supplied 19×19
harbour at 2.13-pixel spacing already triggers the dense guard, because its
maximum block occupancy (not average occupancy) reaches the threshold. The case
is now in `bench-search.mjs`. A different 15-points-per-block patch did regress;
the conservative block threshold was reduced from 16 to 9 after that review.
Cases with 8, 9 and 15 points per block now appear in the repeated comparison and
have full-search parity tests. The 64-tile comparison is now reproducible with
`bench-tile-parity.mjs <baseline-surface-module>`. These threshold, test and
harness changes were checked locally after the last model review. Duplicate
pixels remain outside the existing precondition, enforced by the production
caller's coalescing. No unsupported input mode was added.

The focused snapshot omitted unrelated historical measurement artifacts and was
copied before the final Markdown format pass; review notes about missing old
links and table formatting are not defects in the real worktree. Its linked
artifacts exist here, and explicit Prettier checks pass. Reviewers did not run
code; actual checks and raw measurements above were run separately. No review
establishes Pi performance acceptance.

## Pi comparison after SSH access recovered

The candidate ran beside the active plugin in Docker, reading the production
store without altering it. All 27 tested real tiles at zooms 13–15 matched the
installed renderer byte for byte, including worker results. The active package
remains `progressive-20261122-demand`; the candidate is not installed.

Five rounds of nine-tile viewports at each zoom used the same worker pool, reset
surface/tile caches between views, and probed Signal K over loopback concurrently.
No persistent tile cache was attached; OS caches were not flushed. With three
workers, the first viewport took 2.55 s, and later rounds took 0.57–1.02 s. Time to
first populated tile in later rounds reached 678 ms. HTTP p95 was 289 ms (47
probes), above the working 250 ms target. These are loaded-system observations,
not isolated or interleaved comparative trials.

An isolated two-worker experiment had HTTP p95 166 ms (56 probes), but later
viewports took 0.60–1.42 s. It is not adopted in the worktree or active plugin.
Docker reported no CPU quota or cgroup throttling during the check; the CPU clock
sample was 2.4 GHz. The measurements do not establish acceptable performance.
Further profiling of portrayal and contention is required before deployment.

[Sanitized measurements](pi-render-candidate.json) omit locations and individual
tile IDs; they retain view timings, worker counts and HTTP probe measurements.

## Contour allocation follow-up (November 22)

`isolines` no longer allocates a complete marching-squares case table at every
crossing. It reuses the corner-index scratch array and skips the raster scan
when no contour levels are requested. Segment order and geometry are unchanged.
`bench-contours.mjs` checks all 16 masks, wet/dry boundaries, unequal slopes and
clipped coverage before alternating baseline/candidate timing runs.

The sequential Pi kernel comparison measured medians of 31.63 → 18.90 ms for
three levels and 42.81 → 25.13 ms for nine levels. Empty levels fall from 11.03 ms
to below 0.01 ms. These are kernel timings, not whole-view speedups; see
[raw measurements](contours-pi.json). A preliminary comparison overlapped another
benchmark and is excluded from these timing results.

The isolated three-worker candidate (sparse search plus contour changes) produced
byte-identical output for 27 real tiles, including worker output, and 64 synthetic
tiles. Five sequential viewport rounds gave warmed-worker cold-view times of
492–903 ms, first populated tiles in 102–457 ms, and concurrent Signal K HTTP p95
201 ms (41 requests, all 200; maximum 347 ms). The first round took 1.18–1.20 s per
view. These are server tile timings, not browser paint timings; startup still
misses the target. See [sanitized viewport measurements](pi-contour-viewports.json).

Open Waters rounds 16 and 17 completed with Opus and Sonnet on isolated source
snapshots. Both found the contour refactor equivalent. Round 16 noted weak
benchmark coverage; the additional fixtures above were added and reviewed in
round 17. Reviews were static; tests and Pi measurements were run separately.

Round 17 also reviewed an attempted fix for preview starvation: the current query
limits to 1,200 recent points before removing refined points, which can hide older
unrefined evidence from both the display and the viewport scheduler. A regression
test reproduced it. Moving the refinement filter into SQL fixes the result but
adds a lookup per visible cell before sorting; both reviewers flagged this, and a
100,000-point desktop comparison measured about 21 ms versus 18 ms. That candidate
was withdrawn, not deployed or committed. A bounded spatial/temporal query remains
a release blocker. A time index alone did not change SQLite's selected latitude
index or remove the sort in the measured fixture.

The reviewers' dropped-table concern does not occur in the mapped lifecycle (the
receipt table is never dropped). Empty-history receipts deliberately preserve
preview evidence: viewport refinement passes `includeEmpty=false` so it can retry
that evidence. Neither should be changed to hide valid observations.

A subsequent run of the installed renderer under the same workload ranged from
512–1,291 ms for warmed-worker cold views, with HTTP p95 106 ms (43 requests;
maximum 623 ms). The runs were sequential against a live server, not a controlled
interleaved experiment; the candidate is not uniformly faster and these numbers
must not be attributed solely to the contour change. The installed package has
not been switched.

### Confirmed stationary-thinning requirement

The user confirmed a configurable **maximum retained-sample gap**, nominally
1–6 minutes, with additional points retained for significant changes. This is
not a minimum-spacing throttle. Prototype bounded-window Douglas–Peucker-style
simplification only within verified stationary segments, with independent
horizontal and depth tolerances. Compare depth to the retained endpoints at the
original timestamp, not just distance to a spatial polyline; a vertical excursion
at an unchanged position must survive.

Force interval anchors before simplification, retain segment endpoints, and
split at acquisition gaps, movement, source/reference/calibration changes and
quality discontinuities. The interval guarantee applies only where observations
exist; do not interpolate across an acquisition outage. Preserve uncorrected,
pre-tide depth and provenance in the owned store. Anchor swing over sloping bottom
must remain distinguishable from water-level variation.

Start with a derived retained-point view while originals remain recoverable.
Measure reconstruction error, extrema, timing/phase changes in synthetic tides,
anchor swing and steps, along with storage bytes, CPU, WAL and host writes.
Do not wire this into the collector or NOAA submission path before validating the
information loss and defining aggregation weights; fewer retained points must not
change the time-weighted meaning of an estimate. The current live stream already
applies the configured depth-reference offset, so its output alone is insufficient
for the proposed original-reference archive. No permanent thinning is enabled.

## November 23: merged renderer and bounded-query experiment

An isolated copy of the merged renderer ran inside the Pi's existing Signal K
Docker environment against the real store, read-only, with three tile workers.
Five rounds each requested nine tiles at zooms 13, 14 and 15, clearing tile and
surface caches between views. Fresh-worker full views took 1.02–1.29 s; subsequent
cold-cache views took 490–765 ms. First populated tiles in the initial round took
401–832 ms. Concurrent Signal K HTTP probes (37 samples) had p95 233 ms and
maximum 304 ms. These are server timings, not browser paint; background production
load was uncontrolled. Cold startup remains above target. The active plugin was
not replaced, and these tile measurements do not validate the later estimator
integration changes.

A separate read-only broad-viewport SQL experiment compared the current
latitude-range query plus timestamp sort against center-out primary-key row
seeks capped at 32 rows and 512 candidates. The current query took 2,511 ms on its
first call and 260–290 ms on repeats. Bounded seeks took 4.4–6.4 ms. Both returned
zero useful points in that first batch because its candidates were already
refined. This proves a useful work bound, not a correct progressive query: bounded
continuation, receipt filtering, empty/narrow views and fresh-point delivery still
need implementation and tests. No index or schema was changed by the experiment.

The merge review also found that production backfill disables shared prepared
surfaces through its whole retry loop. Standalone viewport benchmarks have sharing
enabled, so they did not represent that production mode. The November 24 changes
retain shared surfaces across atomic commits and invalidate changed regions; the
older measurements above predate that fix.

## November 24: bounded primary-key trial (not accepted)

The primary-key trial advanced at most 32 populated latitude rows and 1,200
candidates per poll. On the Pi, a broad viewport took 1.6–6.8 ms per slice versus
2,649 ms for the existing full-range timestamp sort. Local/narrow slices took
about 2 ms. With refinement filtering disabled to simulate a populated provisional
cache, retaining/rechecking the visible set took up to 24.3 ms. These are read-only
Docker measurements, not browser latency or acceptance results.

Open Waters rounds 21–22 (Opus and Sonnet, static reviews) exposed correctness and
latency limits: GPS jitter could restart a sweep, near-identical clients could
interfere, invisible incoming rows could evict useful points, and a wide sparse
view could take minutes to scan even though each individual call was fast.
Jitter/eviction/write-lock tests were added, but the overall query design is not
accepted. Do not count the slice timings as meeting the useful-first-view target.
A native pending-point spatial index is the next candidate; both local and Pi
Node SQLite builds support R*Tree, so no SpatiaLite dependency is needed for it.
The trial is retained outside the repository under `/tmp/preview-keyrange-trial`.

The independent cache-control change separates prepared-surface reuse from
persistent tile-cache writes. Refinement commits already report changed positions;
keep shared surfaces between commits, invalidate them on each commit, and reset
on uncertain worker failures. Persistent-cache writes remain suspended while any
background refinement/reweight writer is active. This change is under review in
round 23; the active Pi package has not been replaced.

## November 24: native preview spatial index candidate

The replacement uses SQLite's built-in `rtree_i32`, with integer longitude,
latitude, QC epoch and observation-minute bounds. It returns up to 1,200 pending
observations per viewport in one lookup (two across the dateline). The result is
a spatial sample, not the globally newest 1,200 observations. Acquisition still
prioritizes recent history. There is no shared viewport cursor: jitter, zooming
and multiple plotters do not restart or interfere with each other's queries.

Insertion/update/deletion triggers keep the index transactional with preview
cells. Refinement receipts mark covered observations complete before query LIMIT;
QC invalidation advances an epoch rather than rewriting every index entry.
Configuration invalidation drops/recreates the disposable index in the same
transaction as clearing the preview cache. Canonical raw history is untouched.
Stationary input batches coalesce to the latest observation per preview cell;
replaying an identical batch does not rewrite cells or index entries. This is
not archival thinning and does not reduce the raw data retained for tide analysis.

Existing preview caches migrate on a low-priority worker, committing 500 rows at
a time and yielding 25 ms between batches. Newly acquired evidence is indexed
immediately. Migration resumes from a durable key and retries failed attempts;
shutdown terminates the worker. During migration a viewport only sees the indexed
portion of old evidence. Completing a dense refinement hour still updates each
covered index entry and needs Pi write-lock measurements before acceptance.

The additive index/triggers remain on rollback to the earlier preview, whose
writes maintain them. The earlier preview recreates its dropped latitude index
on startup, which may cost time. A changed preview configuration can rebuild
this derived cache; it is not a migration of the proposed archival point store.

Local tests cover sparse/broad views, dateline and latitude bands, independent
clients, stable quiet sampling, deep-point exclusion, atomic replacement,
constant-cost QC reset, migration recovery and transactional configuration reset.
The full suite passes 521 tests. A small local file benchmark (7,896 retained
cells) measured pending viewport p95 5.44 ms, 500-row ingest p95 9.70 ms, and a
single 7,896-point retirement at 83.36 ms. These are desktop diagnostics, not Pi
acceptance; SD-card amplification and large dense retirements remain unverified.
Use `bench-preview-index.mjs` with a new output file for isolated storage tests,
and `bench-history-preview.mjs` only on an already indexed database.

Round 23 reviewed the cache-control change. Fixes restrict full cache resets to
failures that could have committed without reporting changes, release persistence
suppression during retry waits, and resume optional warming after suppression.
Tests exercise overlapping writers, provider versus uncertain-commit failures,
and real cross-connection sibling-tile invalidation. The native index and these
follow-up fixes still need another model review. Neither is installed in the
active Pi package; SSH signing is currently unavailable.

Round 24 (Opus/Sonnet, static-only) found that migration gated refinement,
overlapping receipts had inconsistent marks, trigger schema lacked a version, and
time-only lookups on the R*Tree could scan unrelated spatial nodes. Follow-up
fixes remove the refinement gate, use the union of coverage receipts, version the
derived schema, and maintain a compact `(time,id)` table for receipt updates.
The maximum receipt span bounds coverage lookups by start time; it grows
transactionally with inserted receipts. Replaying an identical receipt leaves
retired points unchanged. The next model review includes these fixes.

The index uses SQLite's built-in `rtree_i32` extension, present in the tested
Node builds. A subsequent fallback keeps collection and refined tiles available
without the extension, logs the missing historical preview capability, and
reindexes retained preview data when the extension becomes available.
Persistent corruption of the derived tree also needs a recovery policy before
release. Rollback is correct but can be slow: older code clears receipts and
preview cells with per-row triggers, as well as recreating the latitude index.
Do not treat rollback/configuration reset timings as verified.

A separate worker bundle reduces renderer module loading from 77 inputs to one
file. Twenty alternating local startup trials measured median 20.04 ms unbundled
versus 11.35 ms bundled, without pre-rendering any tiles. Fourteen worker tests
pass, including byte-equivalent tiles and recovery after worker startup failure.
The failure test exposed and fixed an old worker's delayed exit rejecting requests
already assigned to its replacement. Pi results are still required.

The local SQLite history reader now uses existence and keyset seeks, avoiding a
full COUNT before its first row and repeated OFFSET scans. Equal timestamps use
a separate timestamp/rowid seek so large tied batches remain efficient without
another persistent index. Bounds/order/ties are tested; this does not provide a
snapshot against late inserts behind a running cursor.

`check-viewport-benchmark.mjs` enforces the server targets over five rounds and
at least 30 HTTP samples, rejecting missing, empty or slow results. Applied to the
previous merged Pi run, it fails the first populated tile in round 0 at zoom 13;
HTTP p95 233 ms passes. Browser paint and loaded/backfill runs remain separate
gates. The current candidate is now staged separately in Docker for measurement;
the active plugin has not been switched.

### November 24 Docker measurements and follow-up candidates

SSH access resumed. The active plugin is still `progressive-20261122-demand`;
`crowd-depth-nov24-spatial-v2`, `v3` and `v4` are separate benchmark packages
alongside it, not active installs. Each uses the active database read-only for
rendering; index/write experiments use separate disposable databases on the SD.

The v2 native index ingested 100,000 actual retained preview points in timestamp
order. Pending-world queries returned 1,200 points: first 8.49 ms, p95 5.28 ms.
The fully QC'd query was empty at p95 0.35 ms. Ingest batches of 500 had p95
136 ms and maximum 436 ms; 326 distributed hour retirements had p95 22.7 ms
and maximum 440 ms. Replaying those receipts had p95 0.67 ms. The file plus WAL
was 28.8 MB, with 131 MB process RSS. These measurements precede asynchronous
preview writes and geographically stratified queries.

A synthetic 50,000-cell single hour on the Pi retired in 2,088 ms. Its 250-point
writes had p95 9.4 ms and maximum 137 ms, with 73 MB RSS and 25.9 MB file+WAL.
This is below the SQLite busy timeout but is still a main-thread write-lock risk;
it is not an acceptable event-loop latency. Source/collector and live-cell writes
sharing that lock remain to be examined. Preview acquisition itself now writes
through a persistent low-priority worker with acknowledgements, retry/restart on
failure, generation fencing and awaited shutdown. Its 250-observation streaming
batches and final atomic window replacement no longer execute on the server
thread. This change still needs model review and loaded Pi verification.

Twenty alternating Pi startup trials measured median 74.34 ms unbundled versus
50.09 ms bundled (p95 105.88 versus 62.79 ms). Three-renderer Lake Worth runs still
missed first content (769 ms), despite HTTP p95 26 ms. Two renderers did worse.
One renderer reached first content in 440–445 ms at two nearby Lake Worth views,
passing the server gate, but failed full-view latency in a distinct Abaco area.
A candidate serializes only the first populated tile, then uses the full pool;
its first Abaco run still failed several targets (first content 583 ms and some
warm-worker cold views above 1 s). Do not claim either schedule meets acceptance.

A profile led to replacing repeated whole-raster carry scans with frontier
propagation. All 512 small source masks match a nearest-Manhattan-source oracle;
64 synthetic tiles are byte-identical to the preceding renderer. Alternating Pi
prepared-field trials retain exact values and reduce sparse-track preparation
from roughly 10.4 to 7.5 ms and dense preparation from 10.2 to 8.5 ms. The complete
viewport gate, not these kernel timings, decides whether it helps enough.

Open Waters round 25 (Opus/Sonnet, static-only) highlighted clustered spatial
samples, long retirement locks, migration cache suppression and retry policy.
Follow-ups prefer the latest acquisition day within a 4-by-4 viewport sample,
fill unused capacity without shared cursors, preserve the first refinement-worker
failure classification, and back migration retries off to five minutes. Tests
cover recent-track reachability and widely separated track segments. Disk-cache
**reads**, encoded memory tiles and shared surfaces remain enabled during index
migration; only new persistent writes are suppressed to avoid main-thread lock
waits. This is an intentional temporary tradeoff, not disabled rendering/cache
reuse. Corrupt-derived-index recovery, migration viewport priority, loaded-write
latency and the full performance gate remain open.

The v4 dense Abaco run improved first content to 463 ms, but still failed first
content at zoom 14 (540 ms) and the next zoom-13 cold view (1,241 ms total,
588 ms first content). Later rounds passed. A subsequent scheduler candidate
serializes the first populated tile of each request burst and retains stable
worker affinity; it is not yet measured. The current full local suite passes
533 tests. No active Pi installation has been changed.

### Follow-up: nonblocking live writes (November 24)

The v5 per-burst scheduler still fails the Abaco gate: first zoom-13 content
556.6 ms, round-1 zoom-13/14 full cold views and round-2 zoom-13 full cold view
over target. HTTP p95 was 30.4 ms. Empty bursts now stop serializing after three
empty tiles; this bounds the first-content search but is not a performance pass.

Optional cache writes now temporarily use zero SQLite busy timeout and restore
the connection's timeout on success or failure. In Docker on the Pi, with another
connection holding BEGIN IMMEDIATE, reserve failed promptly in 0.122 ms and keep
in 0.154 ms; the timeout returned to 5,000 ms and keep succeeded after rollback.
Raw recording uses the same nonblocking attempt with asynchronous 100 ms retries
(up to 24 seconds) and stream backpressure. Live cell flushes also fail promptly,
retain their uncommitted buffers, and retry asynchronously every 100 ms while busy. A busy
release from a tide/backfill hold leaves its passes queued. These changes avoid
waiting on the event loop; they do not shorten a successful large transaction.

An upgrade preflight on the active Pi found the old depth fingerprint had no
source-selection fields, while its position fingerprint already recorded the
same selected sensors. That proven-compatible migration now preserves the
existing depth_since rather than moving it forward to installation time.
Unknown provenance and actual sensor/reference changes still set a new boundary.

Open Waters round 26 (Opus and Sonnet, static inspection) found an obsolete
preview benchmark wrapper and unclosed workers, incomplete missing-RTree
fallback, unbounded empty-view serialization, optional cache-write lock risk,
and unresolved corruption/shutdown/rollback concerns. The benchmark now times
acknowledged asynchronous writes and closes the workers. Fallback opens an
existing virtual table explicitly and clears stale coverage-span metadata before
recovery. Cache writes refuse locks regardless of writer-counter coordination.
The alleged between-batch counter race is not reproducible from that path alone:
write acknowledgments follow COMMIT, and the next onBusy(true) precedes posting
the next write; the zero-timeout guard also covers independent writers.
Corrupt-derived-index recovery, fully awaited plugin shutdown, rollback costs,
and release performance acceptance remain open. Latest full suite: 539 tests;
E2E: nine tests passed before the subsequent live-write retry changes.

The v7 Pi recording contention test held another write connection for 2.1 seconds.
All 20 observations were recorded after it released; the release timer ran at
2,100.07 ms, total recording completed at 2,111.97 ms, and event-loop maximum was
10.85 ms. The v7 full viewport test still failed: first content 563 ms, several
round-1/2 full views above one second, and full-model HTTP p95 359.79 ms. That HTTP
endpoint returns 1.2 MB; idle samples took 69–119 ms, while idle admin HTML took
2–28 ms. These are different endpoint costs, not evidence that the loaded gate
passed. The current active plugin remains unchanged.

Round 27's Opus report included its map and identified live-flush lock starvation
and automatic-source migration. Both are addressed: busy live flushes retry at
100 ms for up to 30 seconds, independent of the three-failure budget for other
errors, and unset sources normalize consistently. Sonnet reported the same issues
but its retained report omitted the required map; count that as a limited review,
not a fully completed round. Both also saw a symlink-to-copy conversion that was
an isolated review-snapshot copying error: the real definitions.json remains a
symlink. Subsequent snapshots must preserve symbolic links.

Chart close now awaits preview and tile workers plus active refinement/reweight
jobs; plugin stop waits for it, and replacement starts wait before opening the
new chart. An additional Gaussian-loop fusion preserves exact prepared fields
and 64 synthetic tile byte outputs. Alternating Pi medians changed from 7.33 to
7.01 ms for a sparse track and 8.39 to 7.82 ms for a dense field. This small kernel
improvement does not establish full viewport acceptance. Shutdown and these last
changes need another full model review and hardware verification.

### Viewport-first migration and follow-up review

A rehearsal against a backup of the active Pi database retained all 408,105
refined cells, 408,053 preview cells, 4,331 receipts and the existing depth_since.
Config migration took 13.18 ms; the initial full spatial fill took 37.65 seconds.
The migration worker now accepts viewport priorities and visits populated rows
outwards from the viewport centre, with primary-key seeks bounded to 32 rows and
500 cells per priority batch. The ordinary complete sweep continues between
priority batches. Dateline and dense-row paging have focused tests.

On a second copy of that Pi backup, the boat viewport's first indexed cells were
available at 112.49 ms and all 106 viewport cells at 212.91 ms, while the complete
408,053-cell migration finished at 41.47 seconds. These are index-availability
measurements, not pending-preview/browser-paint timings; existing QC receipts
remain intact. Panning can update the worker's priority without restarting the
complete sweep.

Lower-priority renderer workers (Linux nice 10) brought the concurrent full-model
HTTP p95 to 224.36 ms in the v8 Abaco run, but first content remained 568.68 ms and
round-1/2 cold viewport failures remain. Do not call this a full gate pass.

Open Waters round 28 included complete static maps from Opus and Sonnet. The
rapid-restart chain race is fixed and tested across three starts, and closed tile
services ignore later persistence notifications. The development command forces
an unbundled TypeScript emit before watch, avoiding a stale release bundle;
its emitted worker imports were verified, but sandbox FSEvents prevented a full
watch-session check. Final live flushes now retry a busy lock before completing.
The report's bulk-flush concern does not apply to the chart wrapper: it is passed
only to the live writer with bulk=false; refinement stages its passes in memory
and bulk backfill receives its own normal store/connection. A file-backed chart
test exercises actual preview-worker writes and awaited lock release. These
changes, viewport-priority migration, and worker priority need the next review.

### November 24: rollback and damaged-index isolation

The isolated v11 package passed a Pi round trip through the actual deployed old
package: upgrade, old `syncConfig`, then upgrade again preserved all 408,105
cells, 408,053 preview cells, 4,331 QC receipts and the original recording boundary.
The v11 package is staged but has not replaced the running plugin.

Review round 29 (Opus and Sonnet, complete static reports) identified a shutdown
race after live-pipeline failure and rollback fingerprint incompatibility. Closing
the chart now aborts its own lifetime before awaiting workers, even if the parent
session remains active. Equivalent legacy depth fingerprints retain their exact
encoding, verified by the real Pi rollback rehearsal. The HTTP-error acceptance
fixture now changes one sample in a complete run, so it tests the intended rule.

Actual corrupt-RTree fixtures exposed failure during statement preparation as
well as transaction execution. Preview and refinement workers now quarantine the
confirmed damaged derived index and retry once after rollback. Startup similarly
detaches its triggers, preserving canonical observations and QC receipts. Preview
queries return no provisional features while quarantined; refined tiles remain
available. No production code edits SQLite shadow tables. Automatic reconstruction
of a severely damaged virtual table remains unresolved: even DROP TABLE can fail.
This fallback preserves recording but is not an index-repair implementation.

Cold viewport acceptance still fails for several Pi views. These correctness fixes
and passing local tests do not constitute performance acceptance.

### November 24: active Docker preview and remaining contention

The v14 preview is now active inside the Pi's `signalk` container at
`local-pkgs/progressive-20261124-v14/node_modules/crowd-depth`. Activation saved
and checked a fresh 334 MB online database backup at
`local-pkgs/pre-progressive-v14-2026-11-24T16-26-34-131Z`, plus the previous manifest,
configuration and plugin link. All 408,105 refined cells and the recording boundary
survived. Background indexing completed with 408,130 preview rows indexed; the
increase reflects ongoing acquisition. No all-history tile pre-render was enabled.

The v12 isolated populated Abaco benchmark measured HTTP p95 213.62 ms but still
failed first zoom-13 content and two cold viewport checks. A subsequent experiment
removing the dense-patch raster-search shortcut matched fields and improved one
microbenchmark, but worsened the complete viewport run (HTTP p95 305.94 ms). It was
reverted; the deployed v14 retains the original search selection.

The browser reload after activation completed its document load in 970 ms; its
four tile revalidations took 64–82 ms. Those were cached revalidations, not cold
renders, and are not evidence that the cold viewport target passes. Startup HTTP
sampling also caught a 2.5 s response during acquisition. The input cache still
used synchronous SQLite busy waits. The next local change makes schema creation,
page writes, publishing and cleanup yield/retry, with a held-lock regression test.
That change is not in the active v14 package yet.

Round 30 completed Opus and Sonnet static reviews. Both could not execute checks.
Confirmed fixes: damaged-index handling now verifies both SQLite corruption codes;
visible startup quarantines before config rebuild, and hidden startup retries its
config rebuild after quarantining; CI's root build now runs the plugin bundle/web
build before tests. Opus's formatting concern was dismissed after the exact script
passed Prettier. The existing licence audit covered the bundle's three dependencies.
The arbitrary bounded sample within the most recent day, long writer-lock bounds,
and full cold-viewport failures remain limitations. Local v14 checks: 559 tests,
TypeScript and publint passed; nine server integration checks passed on v12.

### November 24: bounded cache cleanup and dense-query coverage

A replay of the real pre-upgrade database isolated 1,870 ms of the 2,031 ms chart
startup in synchronous deletion of old rendered tiles. The next candidate prepares
that optional cache in a worker, deleting 128 old tiles per transaction and yielding
between batches. Requested tiles render while the service cannot read the stale
cache; the cache attaches only after maintenance succeeds. The same Pi startup
profile then took 84 ms, preserving the original backup and canonical data.

The cleanup fixture contained 29,141 cached tiles and 408,105 canonical cells. All
cells survived. Stressing the same database with a synthetic write every 10 ms still
caused long synchronous write delays, including with WAL and NORMAL enabled;
disabling automatic checkpoints did not improve this experiment and was not applied
to production. This remains a limitation of main-thread SQLite writes under heavy
SD I/O, not evidence that the cleanup's complete lifecycle meets all latency targets.

Dense stratified preview queries were measured on 408,053 indexed points, all marked
pending in a disposable fixture. World, Florida and Abaco views each returned 1,200
points in all 30 samples. Their p95 query times were 18.03, 11.73 and 10.48 ms;
the empty view was 0.39 ms. Across 48 concurrent Signal K probes, HTTP p95 was
31.15 ms. This closes the missing large stratified-query measurement; it does not
represent refinement committing to that same fixture during the query run.

Round 31 completed both static reviews. Opus's uncaught-backfill finding was fixed
with cache-initialization retry/abort handling and a caller rejection handler;
plain SQLite read corruption now suppresses only the preview portion of a live
response. Known rolled-back worker errors no longer force global tile-cache resets.
Lint now rebuilds the bundled renderer, and contributor build instructions match
those commands. Sonnet's restart finding led to separating source collection and
reporting from the pending chart restart; the next chart still waits for old workers.
The regression test confirms recording starts before the old chart is released.
Sonnet's dense-query coverage concern prompted the above actual Pi measurement.
Full cold-render acceptance, other synchronous metadata writes and owned-archive
retention remain open. These changes and worker cache cleanup postdate round 31 and
are being reviewed again before the next checkpoint.

### November 24: Docker v19 and renderer follow-up

The active preview is now `progressive-20261124-v19`, installed inside the Signal K
Docker container. Its predecessor, configuration and a verified online database
backup are preserved under `pre-progressive-v19-2026-11-24T17-01-42-225Z`.
This package includes asynchronous input-cache writes, worker cache cleanup and
fingerprinting, independent collection during chart restart, and bounded backoff
for input-cache initialization failures. The first startup preview read timed out;
this is recorded as a remaining startup/provider interaction, not a successful
first-paint measurement.

The portable cleanup benchmark is reproducible with:

```sh
node packages/signalk-plugin/scripts/bench-kept-startup.mjs /path/to/bathymetry.sqlite 5
```

It copies the input database before modifying anything. On the Pi, its 5 Hz write
fixture retained all 408,105 cells while deleting 29,141 obsolete cached tiles.
Synchronous initialization took 3.22 ms; background completion took 11.89 s;
maximum measured write/event-loop delay was 108.15/118.42 ms. This does not close
the previously reported 100 Hz storage-stress limitation.

Five dense Abaco viewport rounds against v19 recorded 75 concurrent full-model
HTTP samples, p95 92.43 ms. Rendering still failed: initial content 744.98 ms,
and nine subsequent cold views exceeded 1 s. An isolated v20 experiment uses the
raster nearest-neighbor search inside dense 8×8 patches and the spatial tree
outside them. All 27 actual-data tiles compared byte-for-byte equal. Both full
viewport runs include search setup cost: the first had four timing failures and
HTTP p95 237.07 ms; the repeat had five timing failures and HTTP p95 125.84 ms.
Later cold viewports improve, but cold startup still fails. V20 is installed only
for isolated testing; v19 remains active. Do not call either a full gate pass.

Round 32 completed Opus and Sonnet static reviews. The fixed five-second cache
retry now backs off to five minutes. The claimed formatting failure was dismissed
after the exact files passed the configured Prettier check. The missing renderer watchdog was confirmed. The final correction, described
below, terminates after 30 seconds without replies, allowing a later request to
start a replacement; it does not automatically retry failed requests. This is
recovery, not a performance pass.
The generic shutdown-timeout recommendation was not applied: provider calls already
race abort/deadlines, and worker-owning jobs terminate on abort and await exit.
Starting replacement writers before those workers exit would weaken fencing.
Native SQLite or filesystem calls can delay worker termination and chart
restart. Busy waits have configured limits, but the OS does not guarantee a
maximum filesystem latency. Shutdown deliberately waits for worker exit. The legacy explicit-source provenance shortcut remains an open finding;
matching settings alone do not establish the origin of old observations.

Round 33 reviews only follow-ups to the round-32 snapshot, including moving cache
fingerprinting off-thread and the hybrid search. The worker timeout postdates that
snapshot and needs its own review. Local checks currently pass 569 tests in 50
files plus plugin lint/publint. The first full-suite attempt was sandbox-blocked
on localhost fixture listeners; the unrestricted rerun passed. Source provenance,
full cold-viewport acceptance, storage retention and the other release blockers
remain open; the draft PR is not release-ready.

Round 33 completed both static reviews with no correctness defect identified. The
stale search description above is now labeled historical. Alternating Pi kernel
runs, including setup, measured these medians (baseline v19 / hybrid v20):

| Case             |      Setup ms |        Query ms |
| ---------------- | ------------: | --------------: |
| Dense harbour    | 0.313 / 3.887 |   4.527 / 4.129 |
| 9-point patches  | 0.235 / 0.571 |   7.401 / 4.904 |
| 15-point patches | 0.244 / 0.878 |   6.080 / 4.324 |
| High latitude    | 1.207 / 1.851 | 68.946 / 15.925 |
| Single track     | 0.303 / 0.310 | 22.273 / 22.296 |

The harbour-only kernel regresses by about 3 ms including setup; the full dense
Abaco viewport improves in repeated runs but still fails acceptance. These numbers
justify continuing evaluation, not calling every workload faster. The new retry
regression checks all exponential delays through the repeated five-minute cap and
successful recovery. The timeout follow-up is being reviewed separately.

Separate Pi processes running the harbour/patch/high-latitude kernel cases peaked
at 64,080 KiB RSS for v19 and 65,888 KiB for v20 (about 1.8 MiB higher in this single sample). This is
process peak RSS, not an isolated per-index allocation measurement. All nine Signal
K integration checks also passed after the renderer timeout change.

### November 24: reviewed worker recovery and v22 activation

Round 34 completed both static reviews and found two defects in the initial
watchdog: queue time could kill healthy workers, and timed-out worker termination
was not tracked for shutdown. The corrected implementation measures 30 seconds
without a reply and waits for all terminating threads. It was reviewed in round 35
by both models. Opus found no correctness defect; its missing rearm regression is
now covered by replying at 20 s and verifying the next stalled request times out
at 50 s. Tests also cover healthy 60-second queues, queued failures, delayed exits,
and stale replies/exits after replacement. Test-only changes followed round 35.

Sonnet's proposed shutdown deadline was not applied: returning before the thread
exits would violate the verified resource-release requirement. Native filesystem
latency remains a limitation. The hypothesized rejected `terminate()` promise was
checked against the Pi's Node 24.22.2 `internal/worker` implementation: it resolves
on `exit` (or immediately if already exited), with no rejection callback. The
watchdog is not a per-request latency cap; a progressing queue can take longer.

V22 was backed up and activated inside Docker on November 24 at 17:18 UTC. The
verified prior database/config/package remain under
`pre-progressive-v22-2026-11-24T17-18-02-948Z`. This supersedes v19's active-package
status above. V21's flawed watchdog was only staged and never activated.

The final v22 tree passes 574 tests in 50 files, all nine Signal K integration
checks, and plugin lint/publint. The installed renderer SHA-256 matches the local
build (`63270272be6dda3e6b5f0eb32c3a4cfb2a88cedf366c4d58434ed945c6cc7345`).
A post-restart full-model HTTP probe returned 200 in 43 ms; this single probe is
not the loaded acceptance run.

### November 24: iterative search follow-up (v23, isolated)

The exact active-v22 post-deployment Abaco run remains a gate failure: initial
viewports took 1.85–5.27 s, settling to 0.62–0.81 s in the final two rounds. Full
Signal K HTTP p95 was 233.15 ms over 79 samples. The benchmark's event loop max
was 40.86 ms. This is the measured reason the draft stays blocked.

Production-worker CPU profiles identified tree traversal among the largest CPU
costs. V23 replaces recursion with a reused explicit depth-first stack, preserving
near-first order and delayed far-branch pruning. Five alternating Pi kernel rounds
showed total setup/query medians: sparse spacing 5.7, 194.34 → 140.67 ms; spacing
10, 82.49 → 56.05 ms; track, 23.65 → 16.66 ms; high latitude, 18.16 → 13.98 ms.
Dense raster cases were essentially unchanged. All 27 actual-data tiles matched
byte-for-byte, and all 574 tests passed. Round 36 Opus/Sonnet static reviews found
no important/correctness defect. Their missing-measurement concern is covered by
these Pi kernel runs. Unsupported NaN/zero-limit inputs are not produced by the
only production caller. The stack allocates 12 extra bytes per point once per
search; this is below the sparse dispatch threshold.

The v23 whole-viewport run still fails nine timing checks, though later views take
0.52–0.97 s; HTTP p95 is 180.20 ms across 71 samples. It is an isolated experiment,
not the active package. Kernel improvement does not establish cold-start acceptance.

### November 24: no-upsampling allocation reduction (v24, isolated)

When `cut` uses one sample per pixel, its four field conversions now copy and
normalize only the used window instead of first allocating full intermediate
arrays. Paired Pi field comparisons were exact for sparse/dense windows at sizes
64, 208 and 256. Median `cut` timings fell from 13.36 to 9.13 ms for the sparse
208-pixel case and 21.28 to 15.98 ms for dense 256 pixels. All 27 actual-data tiles
matched byte-for-byte. Round 37 Opus/Sonnet reviews found no issue. A direct
one-sample regression now checks preserved depth, NaN normalization, missing-water
fields outside the window, and unchanged input. The full suite passes 575 tests.
Opus's note that the default one-sample path requires n≥342 was arithmetically
incorrect: `round(256/n)` is 1 already at n=208, covered by the Pi measurements.

The Lake Worth view at (-80.04408, 26.72592) passes the server acceptance gate for
all 15 views, with 37 concurrent HTTP samples at p95 89.79 ms. Abaco still fails
five timing checks, with HTTP p95 140.40 ms across 70 samples. Browser paint,
loaded-backfill coverage and other release blockers remain open. V22 remains
active; v24 is staged only. A further experiment delaying neighbour-offset writes
was discarded after mixed microbenchmark results; it is not in the candidate.

### Owned observation foundation (November 24, after v24)

The next implementation step is the permanent store, then derived stationary
thinning and end-to-end Pi acceptance against that architecture. Additional
renderer micro-optimizations are deferred. v24 is now active through Docker;
its post-install Abaco run still fails cold-render gates (15 views, 76 concurrent
Signal K requests, HTTP p95 120.27 ms). No release acceptance claim follows.

The working implementation adds a separate worker-owned `observations.sqlite`
with compressed, checksummed chunks, atomic integer-RTree indexing, explicit
acquisition kinds, and original timestamp/depth/source metadata. Live recording
runs independently of history selection, and orderly stop flushes its current
batch. Ten-second batching leaves an acknowledged abrupt-power-loss window;
FULL synchronization protects committed chunks. See
`packages/signalk-plugin/src/observations/README.md` for limits. History imports,
chart reads from this store, and stationary thinning are still outstanding.

November 25 checkpoint: live recording is implemented in the worktree, with
source validation, separate heading/COG fields, full queue drain on the plugin
stop hook, transient write retries, visible error/restart backoff, and a 256 MiB
filesystem reserve. The active Pi remains v24; v25 was staged only for an
isolated storage experiment. [The raw results](pi-observations-nov25.json) show
10,000 synthetic points/200 FULL commits: 462,848-byte database, 4,140,632-byte
peak WAL, 17.89 ms commit p95, 33.72 ms maximum, and a 1.53 ms sampled lookup.
Only 11 HTTP probes were collected and two exceeded 250 ms; this accelerated
trial is not the end-to-end acceptance gate or an SD wear measurement.

A derived stationary simplifier now has initial tests for configurable maximum
gaps (60–360 seconds), horizontal shape and original-time depth tolerance,
source/quality boundaries, duplicate timestamps, unknown/moving speed, and gaps.
It is not yet connected to chart processing or retention. History now exposes
uncorrected observation aggregates with returned source metadata; chunk import
and atomic completion-receipt helpers are implemented and tested, but the owned
source adapter and chart routing remain unfinished.

Review 38 was interrupted: Sonnet completed; Opus produced no report. Its valid
input-validation, shutdown-drain, heading provenance and recovery findings were
addressed. Round 39 completed both reviewers. The saved position-origin omission,
SQLite auto-rollback error masking, retry backoff reset, chart/capture shutdown
coupling, and public documentation gaps were addressed. SQLITE_FULL auto-rollback
was reproduced and is now a regression test. The storage reserve addresses
filesystem exhaustion by this recorder, while original retention and full
architecture performance remain release blockers. Source timestamps rewritten
by Signal K cannot be identified independently; the docs now state that limit.
History import helpers and subsequent fixes still require the next review.

### November 25: chart history uses owned imports (staged v27)

The chart's original-history source now writes through the observation worker
and replays current published manifests. Concurrent preview/QC acquisitions share
one import. Cancelled and superseded chunks remain archived but do not appear in
manifest reads or spatial hints. Preview can replay stale data immediately;
refinement requests a fresh manifest. Schema v2 adds indexed import membership
and migrates v1 receipts without rewriting original chunks.

Validation: 619 unit/integration regressions and 9 real Signal K integration
tests passed; plugin build and lint passed. The Docker package was staged at
`progressive-20261125-v27`; the active plugin remains v24.

`bench-observation-source.mjs` on the Pi used an isolated store and 3,600 synthetic
history observations with GNSS quality and heading. First import produced its
first sample in 228 ms and completed in 572 ms. Warm replay produced its first
sample in 6.7 ms and completed in 225 ms. Reopening the worker/store took 101 ms
to first sample and 302 ms overall. Spatial hints took 0.6–1.2 ms. All three
reads used one provider acquisition total; maximum sampled event-loop delay was
59 ms. Raw output: `pi-owned-source-nov25.json`.

This measures source acquisition/replay, not tile generation, browser paint,
long-term spatial-index scaling, or the release viewport gate. Live/history
canonical overlap, production thinning, migration of previously refined history,
and refresh of already published chart summaries remain unfinished.

### November 25: retained history and bounded viewport pages (staged v29)

History reconciliation now retains timestamps omitted by a shorter/empty provider
response and replaces revised timestamp groups atomically. Acquisition time, not
consumer completion time, determines whether an import was taken after provider
buffering settled. Original chunk versions remain archived.

The original membership query took ~166 ms on the development host for an empty
viewport over 500,000 synthetic memberships because SQLite walked the time index
before testing spatial bounds. Schema v4 instead indexes published windows by
location, acquisition context, day, and window ID. Spatial queries bisect indexed
ID ranges into complete pages of at most 64 windows without sorting all matches.
Refinement keeps the cursor across discovery retries; regression tests verify
that pages neither omit nor duplicate windows with nonchronological insertion.

On the Pi's staged Docker build `progressive-20261125-v29`, the 100,000-window
synthetic index fixture measured 30 queries per case. P95: first populated page
2.43 ms; middle page 2.03 ms; empty viewport 0.16 ms; windows from another context
only 12.03 ms; outside the time range 0.19 ms. The source fixture imported 3,600
observations with first output at 252 ms and completion at 536 ms. Warm replay
was 7.6/165 ms; reopened replay 96/241 ms. Revalidating against a pruned 1,800-row
provider answer retained all 3,600 owned observations, with first output at
333 ms and completion at 542 ms. Maximum sampled event-loop delay was 50 ms.
Raw evidence: `pi-owned-paging-nov25.json`.

This is not the release viewport gate: no renderer/browser or actual History API
request latency was measured, and no concurrent full-model HTTP probe ran in this
fixture. Active Pi remains v24. The broader release blockers remain open.

At the v29 checkpoint all 632 regressions and 9 real Signal K integration tests
passed. The follow-up review then identified sparse-page preview coverage,
mid-page failure handling, and optional metadata failures replacing richer owned
rows. Those fixes and their focused regressions are now in the worktree; v29 does
not contain them. Independent horizontal thinning verification also matches GEOS
3.14.1 / Shapely 2.2.0 for three tolerances, using a generated reference fixture.
This validates only the horizontal simplifier, not tide-model fidelity or the
still-unimplemented production thinning/retention path.

### November 25: owned-store chart pipeline and QC profiling (staged v30/v31)

`bench-owned-chart.mjs` exercises an hour of 5 Hz original observations through
owned import/replay, sensor correction, the real refinement worker, cell publication,
and the production tile service. It reopens the archive, builds a new chart with the
provider disabled, and asserts identical resulting cells. Both anchored and underway
fixtures contain 18,000 points; adjacent QC context windows are empty. This excludes
provider latency, tides, browser paint and the concurrent Signal K HTTP gate.

The baseline Pi run took 9.27 s to refine the anchored hour from owned observations,
and 6.73 s underway. CPU profiling on the development host located most refinement
work in repeated sorting of overlapping rolling-median windows. The replacement
maintains a sorted sliding window and preserves the existing float32 median formula.
It does not thin samples or change QC thresholds. Shared grid reference vectors,
writer regressions, and 100 randomized full-track comparisons against the previous
implementation matched. The full suite passes 639 tests and 9 Signal K end-to-end
tests after this change.

On the Pi, two runs in opposite candidate order measured anchored owned rebuilds at
9.27/9.45 s before and 3.54/3.76 s after; underway rebuilds at 6.73/6.59 s before and
2.96/3.02 s after. First imports were 11.24/11.11 s versus 7.14/5.26 s anchored and
8.55/7.30 s versus 3.93/4.15 s underway. Tile requests were separately timed after
refinement. These small repeated fixtures locate a processing bottleneck; they do
not establish release acceptance or immediate-preview performance. Raw results:
`pi-owned-chart-nov25.json`.

Both candidates are staged only; v24 remains active. Round 43 found that strict
optional-metadata acquisition can block initial preview, and that a successful
source-unaware GNSS response can still remove metadata on refresh. These remain
open: do not activate these candidates until preview acquisition and metadata
enrichment are separated without downgrading richer stored observations. The QC
optimization and new pipeline benchmark postdate that review. Production thinning,
canonical live/history selection and the full loaded rendering gates remain open.

The subsequent local implementation persists first acquisitions as `preview` receipts,
then enriches them through full acquisition. An optional metadata failure preserves
the preview; full acquisition refuses source-unaware GNSS results. Schema v5 adds
receipt stages and conservatively marks older unclassified receipts as previews.
A full receipt cannot be overwritten by a later provisional acquisition. Regression
coverage includes the actual History API adapter through `storedHistorySource`,
failed enrichment, successful later enrichment, late-publication guards,
and a v4 migration preserving original observations. All 643 tests and 9 Signal K
end-to-end tests pass; plugin lint/publint pass. Full review of this stage mechanism
and QC optimization is in progress (round 44); it is not a clean-review claim.

Staged v32 repeats the pipeline test on schema v5: anchored owned rebuild 3.65 s,
underway 2.94 s, identical cells before and after archive reopen without provider
access. It remains inactive, with v24 serving Signal K. Full metadata/refinement
can still remain pending when a provider permanently fails optional metadata;
independent enrichment scheduling and derived-summary invalidation remain open.

### November 25: review follow-up (staged v33)

The next fixes supersede the earlier strict-metadata contract: failed or unattributed
optional metadata marks acquisition incomplete but does not prevent track refinement
from reading usable core observations. Incomplete publication cannot downgrade an
existing full receipt. Successful metadata-empty refreshes retain optional evidence
only when timestamp, actual sources, coordinates and position timestamp match
unambiguously; absent or changed provenance does not inherit fields. A full-first
hung metadata request no longer blocks preview acquisition: the two stages have
separate reservations within an overall four-request bound.

Refinement scans all pages of owned history before clearing global backfill, even
when provider availability succeeds with no retained history. Viewport priority still
runs between owned windows. A corrupt owned preview window is reported and left
incomplete while subsequent windows and temporal discovery continue. Uncancellable
provider-creation timeouts retain the existing stop policy. All 648 regressions and
9 real Signal K end-to-end tests pass after these fixes; review of the fixes is next.

`check-observation-upgrade.mjs` passed inside Pi Docker with the schema-v2 store from
531bc81 and staged v33: in-place upgrade retained originals; the older module explicitly
refused v5; its verified pre-upgrade snapshot was readable on rollback; the separately
preserved v5 file retained post-upgrade observations on roll-forward. This is an archive
module rehearsal on temporary synthetic data, not activation/rollback of the running
Signal K service. Evidence: `pi-observation-upgrade-nov25.json`.

### November 25 — partial refresh and corrupt-window follow-up

Full acquisitions with unavailable optional metadata now publish a distinct
`partial` receipt, cached for five minutes. They update revised depth/position
and late observations while preserving unambiguously matched earlier metadata.
Deliberate preview acquisitions cannot replace partial or full receipts. Schema
v6 makes older builds refuse this new receipt meaning; synthetic Docker upgrade
and snapshot rollback checks passed from both schema v2 and v5.

Corrupt-window handling now covers newest-hour and temporal discovery as well as
viewport scans. Failed windows remain incomplete and prevent overlapping span
checkpoints, while older independent spans continue. Regression cases cover a
failed newest hour, a failed older hour, and successful retry after repair.

The final follow-up review found transient provider failures were also being
skipped. The next candidate retries those errors in the same scan; only known
corrupt stored records become holes. Three regressions cover newest, viewport,
and temporal retry. Partial refreshes with missing source attribution now keep
existing evidence-bearing timestamp groups intact instead of stripping metadata
or assigning it to an uncertain match. Their core revisions wait for full
acquisition; newly observed timestamps still publish. The conservative failure
envelope may repeat availability checks between distant corrupt windows, but
successful individual windows remain complete. These fixes are staged in v35; 655 regressions and all 9 integration tests pass.

A separate-process v35 Docker run with concurrent full-model Signal K probes
measured anchored owned refinement at 3.86 s and underway at 2.89 s. All 60 HTTP
probes succeeded: p95 93.8 ms, worst 520.6 ms. This exercises shared Pi CPU/I/O
pressure while the server still runs v24; it does not verify v35's event loop
inside Signal K, live capture/backfill integration, or browser paint.

### November 25 — overlapping owned windows and explicit data failures

Follow-up review reproduced a correctness gap between nonaligned startup preview
windows and aligned refinement reads. Owned reads now reconcile overlapping
published manifests, including when the exact aligned receipt is empty after
provider retention. Source regressions cover retained observations on both sides
of an hour and deduplication of overlapping versions; an actual owned-source
refinement regression produces cells after provider pruning.

Permanent observation errors now retain their type across worker IPC, including
decompression failures and reconciliation limits. Preview leaves those windows
incomplete while continuing; provider failures still retry. Viewport retries
yield within a 250 ms wait slice when the view changes, retaining a coverage hole
for the abandoned window. Evidence inheritance requires uniqueness among both
old and incoming observations. Exact reimports can repair damaged compressed
chunks in place; missing derived spatial entries rebuild from verified originals.
Malformed manifests or unrecoverable original chunks still fail closed and require
backup recovery. These changes postdate staged v35 and need Pi performance checks.

The v36 overlapping-window benchmark exposed a main-thread regression: event-loop
stalls reached 274 ms and concurrent HTTP p95 reached 264 ms (80 samples). That
candidate was not activated. Merged reads now run in the archive worker with two
active-reader slots and 512-point replies, and archive CPU work uses lower Linux
scheduling priority. Preview also continues acquisition after showing retained
partial overlap; it does not treat partial coverage as a complete receipt.

The same fixture on staged v37, with merged reads in the archive worker, measured
peak event-loop delay 94 ms (39/23 ms for anchored/underway owned rebuilds),
HTTP p95 203 ms across 76 successful samples, and worst HTTP 556 ms. Anchored
owned refinement took 4.01 s and underway 3.20 s. This is one comparison under
shared Pi load, not integrated-plugin acceptance or a browser-paint measurement.
The v36/v37 JSON includes all four pipeline phases, separate seed time and raw
HTTP samples. Current validation is 670 regressions plus 9 integration tests.

### November 25: v39 private deployment and initial checks

The overlap fixture completed all four phases with identical rebuilt cells.
Maximum event-loop stalls were 82/46 ms anchored and 96/35 ms underway for
first import/rebuild. HTTP p95 was 252 ms over 81 successful samples, exceeding
the 250 ms gate; the slowest sample was 879 ms. This fixture ran alongside the
previous active v24 server, before switching the plugin. Raw samples are in
`pi-owned-chart-nov25.json` under `v39OverlapConcurrentHttp`.

v39 was activated through Docker with backup
`pre-progressive-v39-2026-11-25T18-14-27-596Z`; the previous v24 package is retained.
A browser reload after restart loaded Freeboard in 480 ms and requested six
My Soundings tiles in 112–168 ms, then 15–50 ms on repeat. These are **warm**
measurements: an already-open browser requested tiles during startup. They do
not establish the cold viewport or useful-content acceptance criteria.

The active-v39 five-round cold viewport gate failed at both north Lake Worth and
the previously passing Lake Worth location. North: 64 successful HTTP requests,
p95 218 ms; Lake Worth: 41 successful requests, p95 216 ms. Server responsiveness
passed, but first-content and full-viewport render limits did not. Raw results are
in `pi-v39-active-viewport-nov25.json`. Archive counts grew from 12,853 to 12,933
observations in the initial checks; `depth_since` stayed
`2026-11-22T14:06:46.969401946Z`.

### November 25: retained revision origins (v40, isolated)

Working-tree schema v7 separates retained timestamp-group acquisition origins
from receipt freshness. Empty and partial refresh regressions both reproduced
obsolete depth replacement before the fix; they now pass across reopen, and a
genuinely newer acquisition of the original bytes still wins. Old receipts are
forced stale because their original version ages cannot be reconstructed.

A real v39/schema-v6 to v40/schema-v7 synthetic upgrade on the Pi passed old-build
refusal, backup rollback readability and preservation of later observations for
roll-forward. v40 remains staged only; v39/schema-v6 is still active. The isolated
overlap workload alongside v39 recorded 86 successful HTTP requests at p95
159 ms. This is not the loaded browser/cold viewport release gate.

### November 25: recovery follow-up (v41, staged)

v41 remains staged inside Docker; v39 is active. All 682 regressions and nine
Signal K E2E tests pass. The real v39-to-v41 synthetic upgrade now checks
legacy overlap ordering through an empty refresh, stale-receipt semantics and
spatial discovery, as well as older-build refusal, readable backup rollback and
retention of later observations for roll-forward. All passed on the Pi.

Unlike the superseded v40 migration, v41 preserves legacy ordering timestamps
and forces revalidation with a separate flag. Corrupt pre-v4 imports are
quarantined without blocking capture; unknown spatial bounds remain worldwide
hints so affected intervals cannot silently become empty coverage. Tests include
continued capture/reopen, a migration across 70 healthy imports after corruption,
and repair after identical reimport. Versioned preview completion sources also
prevent rollback writes from being accepted as owned-history coverage.

### November 25: reviewed archive checkpoint

The checkpoint passes 685 tests across 57 files and all nine real Signal K E2E
tests (48 seconds), plus build, plugin lint/publint, scoped oxlint and formatting.
A fixture generated by the actual v2 implementation verifies migration through
the built worker and preservation of the original compressed bytes.

Focused review 53 compared the completed round-52 snapshot with the acquisition
recovery change and genuine-v2 fixture. Codex and Sonnet completed their maps;
Opus and Copilot failed quota. Codex found no issues. Sonnet correctly identified
that a malformed exact manifest still prevents publication of newly archived
chunks. This remains an explicit recovery limitation: overwriting unknown owned
coverage with a possibly pruned provider response would risk losing evidence.
Acquisition preservation is not automatic replay recovery. The broad recovery
catch and concurrent retry diagnostics remain low-priority follow-up findings.
The fixture covers v2 migration, not every upgrade; separate corruption tests and
real-module Pi rollback checks provide the other evidence. Rollback restrictions
are explicitly documented in the observation-store README.

No new Docker activation accompanies this checkpoint: v39 remains active, v41
is staged, and the active cold-viewport failures remain release blockers.

The pushed checkpoint `9134fa3` passed GitHub CI: 685 tests/57 files, nine E2E
tests, lint, and Worker startup. The separate Windows Node 26 plugin job timed
out while constructing 257 durable receipts for the pagination test. That
query-only test now uses an in-memory SQLite store with the same index and
assertions; the 35 store tests pass locally. File-backed durability, migration
and reopen tests are unchanged. Cross-platform validation is pending.

A low-priority serial CPU profile of active v39 at north Lake Worth (three cold
rounds each at z13–15, nine tiles per view) identifies work across interpolation
and contour generation, rather than one dominant function. Nearest-neighbour
search accounted for about 1.9 seconds inclusive; the enclosing surface build
for 4.4 seconds, and `buildTile` for 12.9 seconds across the profile. These are
profiled serial totals, not viewport/HTTP acceptance measurements. The summary
and per-tile timings are in `pi-v39-cold-profile-nov25.json`; raw profile remains
`/tmp/pi-cold-v39.cpuprofile` locally and `/tmp/cold-v39.cpuprofile` in Docker.

### November 25: rejected subtree-bounds experiment (v42, staged only)

A candidate stored each nearest-neighbour subtree's bounds to prune empty water
between tracks. All 25 surface tests passed, and 54 active-Pi tile comparisons
were byte-identical. The alternating-order kernel benchmark improved the sparse
track median from 17.50 to 10.34 ms, but the complete serial cold-tile comparison
was mixed: z13 total 2793→2488 ms, z14 3385→3389 ms, z15 3071→3459 ms.
No reliable viewport improvement was established, so the production-source
change was reverted. The isolated v42 package remains staged only; v39 is active.
Raw timings and independent full-search checks are in
`pi-v42-search-experiment-nov25.json`. These serial measurements include active
server contention and are not the viewport acceptance gate.

Checkpoint `82e3d2f` passed the complete Signal K plugin CI matrix, including
Windows Node 24 and 26. Its integration job is explicitly skipped by that
workflow; the repository's own real Signal K E2E job provides separate coverage.

### November 25: independent startup acquisition and viewport replay

Recent acquisition and stored viewport reads now start independently, allowing
either to publish when the other stalls. Both startup tasks are observed before
returning a timeout. Interrupted viewport passes clear their in-memory marker,
so returning to the view retries unfinished stored pages and spatial hints.
No schema or persisted coverage-marker change is involved.

Focused Open Waters review: round 54 completed Codex/Opus maps (Sonnet partial;
Copilot quota failure); rounds 55 and 56 completed Opus/Sonnet maps. Findings
about sequential stored-first starvation and incomplete paged-pan markers were
fixed with regressions that fail before the fix. Final reviewers found no high
or medium findings. Low follow-ups added spatial-hint pan coverage and clarified
that source timeouts stop the scan after its startup sibling settles; hint
timeouts instead disable spatial hints. These test/doc-only follow-ups were not
sent through another model round. Non-timeout retries can still delay temporal
scanning while the healthy startup sibling supplies first content.

Before the final test-only addition, 692 tests/57 files and nine real Signal K
E2E tests passed, with build, plugin lint/publint and scoped oxlint. A local
synthetic benchmark using the real archive worker, source adapter and preview
writer, with 18,000 retained observations and a stalled recent provider, reached
first preview in 22–28 ms across three cold worker opens. This is host evidence,
not Pi/browser acceptance. SSH agent signing blocked Pi verification; v39
remains the last verified active Docker package.

### November 25: v43 active in Docker

After SSH access resumed, reviewed commit `0a99d98` (package SHA-1
`ef6b906f9c20ab955a1fdaf755b2948a1d8d5523`) was staged and checked inside Docker.
The real v39-to-v43 synthetic upgrade/rollback checks passed. The same
18,000-observation stalled-provider startup fixture reached first preview in
138, 135 and 120 ms on the Pi. These are worker/source/preview measurements, not
full browser-paint acceptance. All 693 local tests passed, plus nine E2E tests
and package validation.

Before activation, both SQLite backups passed quick_check in
`pre-progressive-v43-2026-11-25T19-24-01-464Z`; v39 and its configuration remain
retained. Docker was restarted and the active link/schema verified as v43/v7.
Archive counts subsequently increased from 26,985 to 54,261 points, while
`depth_since` remained `2026-11-22T14:06:46.969401946Z`.

Loaded cold viewport acceptance still fails. North Lake Worth: 15 views, 46
successful full-model HTTP probes, p95 450 ms; the first populated z13 tile and
one subsequent z13 viewport also failed their limits. That run overlapped a
Freeboard navigation. Lake Worth: 15 views, 33 HTTP probes, p95 807 ms; the first
populated z13 tile and one subsequent z13 viewport failed. These failures remain
release blockers, not superseded by the fast synthetic preview result. Raw
results are in `pi-v43-active-nov25.json`.

Freeboard navigation during the north run reached DOMContentLoaded in 918 ms,
load in 1326 ms and first contentful paint in 164 ms. A later screenshot showed
My Soundings tracks in the current Tybee Island viewport. This was not a cold
browser-cache experiment and does not measure first useful sounding latency.

### November 25: live server profile after viewport benchmarks exited

The host still showed load 6.6, about 1.28 GiB of occupied swap, and 30–60% I/O
wait in four one-second samples. Signal K's process RSS was initially about
3 GiB by `ps`, then about 2 GiB during a ten-second internal inspector profile.
The main isolate held 409–531 MB of used heap inside an 857 MB heap; process RSS
also includes workers and native allocations, so those quantities differ.

The profile's largest self-time was InfluxDB `parseInner` (1968 ms). Our history
`createReader` accounted for 1843 ms inclusive, and GC for 492 ms; idle samples
accounted for 1309 ms. This identifies provider response parsing and main-thread
history conversion as concrete targets alongside rendering. It does not prove
that those functions account for all resident memory or all I/O pressure.
The temporary inspector was closed after collection. Aggregate memory/sample
evidence is in `pi-v43-runtime-profile-nov25.json`; the full local profile is
`/tmp/pi-signalk-v43-main.cpuprofile`.

The next change should bound detailed provider response sizes while retaining
original acquisition/window semantics, source provenance, completeness flags
and cancellation. Merely yielding after a whole response has been parsed will
not bound the provider's synchronous parsing cost.

### Bounded history acquisition — v44

The live v43 main-thread profile motivates five-minute provider requests within
one hourly archive receipt. Each segment is saved before the next request, so a
later failure retains already acquired data. This means twelve chunk commits
per fully populated 1-Hz hour rather than eight, and additional provider metadata
queries. The change is not a measured Pi performance improvement yet.

Review reproduced a healthy three-second-per-segment provider failing the old
thirty-second whole-hour deadline after ten requests. Preview/refinement now
allow thirty seconds per segment for the enclosing read, with separate
thirty-second request-creation and stream-consumption deadlines. Reader destruction
aborts acquisition before async-generator cleanup: no subsequent requests or
completion publication, while uncancellable provider reservations remain held
until settlement. Targeted regressions include slow healthy completion, stalled
streams, all four public reader cancellation paths, segment boundary duplication,
and late empty metadata failure.

The same review found interval-wide deletion of unmatched local previews. History
coverage now checkpoints without deleting unrelated local points; newer observations
still replace previews in their cell. A new local coverage namespace retries old
local input windows incrementally, preserving already populated previews. A persisted
cell-deletion trigger sets one recovery flag when an older writer removes local
cells after rollback; the next startup invalidates local:v2 coverage and rescans
retained inputs. The trigger avoids scanning coverage for each deleted cell. Canonical
live/history reconciliation remains unresolved: a live pass can still suppress a
distinct historical pass in the same cell/hour. This candidate does not fix that
release blocker or establish the loaded viewport acceptance gates.

[Remote v43 HTTP samples](pi-v43-remote-health-nov25.json) contain thirty successful
full-model responses with p95 387.99 ms. Network latency is included, and no
simultaneous viewport workload was applied; this does not replace the Docker
acceptance runs. SSH initially reached key acceptance but could not sign. Access subsequently resumed; v44 deployment and measurements follow.

### Active v44 Docker comparison, November 25

[Raw measurements and activation evidence](pi-v44-active-nov25.json) record the
reviewed c974578 package (SHA1 6ec99a11ddff33de68bc49eb7867def5786d9a86), active
through Docker after restart at 20:07:05 UTC. Both databases were backed up and
verified in pre-progressive-v44-2026-11-25T20-06-22-193Z. The archive remains schema 7,
with more than 5.4 million observations present and depth_since unchanged.

The fresh pre-activation v43 north viewport baseline failed: 15 views, 57 HTTP samples,
p95 1015.6 ms and one HTTP timeout. v44 north also failed: 15 views, 75 successful HTTP
samples, p95 414.8 ms. v44 LakeWorth failed: 15 views, 46 successful HTTP samples, p95 414.2 ms.
Both v44 runs still exceed the first-populated-tile/cold-viewport gates. These are
before/after observations, not a controlled attribution: restart and changing
backfill activity affect the comparison. The failed runs remain in the evidence.

The synthetic 18,000-observation cold archive-to-preview test, with recent history
stalled, returned first preview in 231.3, 320.0, and 186.1 ms. This verifies that focused
startup path, not browser paint or arbitrary real-archive viewport latency.

A new CPU profiling attempt timed out in Profiler.start; no CPU profile was
produced, and the temporary inspector was verified closed. Initial statistics
showed 2.73 GB RSS and 724 MB main-thread heap used. Host samples showed active swap
traffic and 32–56% I/O wait; swap is backed by /var/swap. RSS includes worker memory,
so these numbers do not assign all memory to the main thread or this plugin.
Host samples overlapped attempted profiler startup. A subsequent filtered worker
heap report also timed out; no per-worker attribution was obtained. The following
full-model health request succeeded in 1078 ms and the inspector was closed.

Local validation passed 706 tests/57 files and nine real Signal K E2E tests. Exact-checkpoint
GitHub CI 45691317564 passed. Plugin CI 45691318163 passed all eight platform/Node jobs,
each executing 674 tests/54 files; its shared integration job was explicitly skipped,
while the repository E2E suite passed separately. Three external Codex rounds and
supplementary focused reviews covered batching, timeouts, cancellation, local
preview preservation and rollback recovery. The final reviews found no new
high/medium issue in those fixes. Canonical raw/live/history routing, production
thinning, and loaded performance acceptance remain release blockers.
