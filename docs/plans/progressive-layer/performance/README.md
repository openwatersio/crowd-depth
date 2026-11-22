# Point-store and performance release gate

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

Desktop medians after one warm-up and five alternating-order rounds (Node
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
measurement confirmed the tree regression. The final implementation now checks
8×8-pixel blocks before constructing a tree; a block with at least 9 occupied
pixels keeps the tile on the original raster search. The measured harbour case
returns to baseline performance while sparse tracks retain their improvement.
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
