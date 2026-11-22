# Progressive My Soundings layer

Status: draft implementation; performance and release blockers remain, November 22, 2026. The live layer is unreleased;
derived storage and internal interfaces may change. Preserve unrelated work in
the current worktree and preserve the source sounding log and reporting state.

## User contract

First installation publishes useful observations in the viewport as soon as a
useful history batch arrives. Panning reprioritizes work. Without spatial source
queries, acquire recent tracks first and expand backward. Realtime observations
render without waiting for history, track QC, tides, or contour generation.
Provisional shading and soundings are visually distinct and refined in place.
All available history is considered; remove the history-range selector.

Refinement can remove invalid observations or change depths. Completeness,
quality, tide/reference status, and rendering detail are independent. Never
interpret an undiscovered region as known empty. No guaranteed latency before
a provider returns geographically useful data.

## System map

- src/plugin.ts starts chart before source settlement; reporting independently
  consumes sources/history.ts and sources/sqlite.ts. Changes to chart acquisition
  must not alter upload windows, checkpoints, or source selection.
- src/config.ts owns history range, sensor/reference configuration and schema;
  chart.ts hashes cell inputs, clears derived cells, connects live streams,
  waits for history lag, holds live writes and runs backfill.
- src/streams/live.ts and transforms.ts pair source-specific position/depth and
  correct sensor position; history.ts applies depth offsets during reads;
  sqlite.ts reads depths already corrected at collection time.
- src/storage.ts owns migrations, raw bathymetry, reports and derived tables.
  Preserve raw tables and reporting state. Schema additions must tolerate existing
  unreleased derived state and survive restart, without auto-deleting source data.
- src/tiles/writer.ts performs buffered QC, builds spatially overlapping pass
  medians, folds them into cells and advances chronological progress. Its hold
  buffer currently couples live writes to oldest-first history.
- src/qc.ts sorts tracks, splits transits, performs bidirectional steep checks,
  distance-based flatline checks and rolling noise/spike checks. Arbitrary hourly
  cuts and fixed tiny halos cannot be called final QC.
- src/tiles/tide.ts asynchronously selects station/day predictions; cache and
  availability are independent of raw preview eligibility.
- src/tiles/cells.ts stores quantized EMA/deviation and spatial overviews.
  backfill.ts/worker build oldest-first, skip overviews, and publish at completion.
- src/tiles/service.ts caches encoded empty/nonempty tiles and shared surfaces,
  builds tiles on workers and prebuilds nearby tiles; share(false) does not
  invalidate encoded caches or publish changes.
- src/tiles/kept.ts maintains on-disk tiles with SQL invalidation triggers.
- src/tiles/surface.ts/portray.ts interpolate, smooth, trace polygons/contours,
  with spatial halos and shared ancestor surfaces. Preview must bypass this work.
- src/tiles/api.ts protects routes and returns tiles, changes and provisional
  features. web/runtime.ts reports viewport and polls; web/batch.ts batches
  refreshes and retires provisional features after replacement.
- src/plotterext and tiles/style.ts register the overlay and its visual states.
- test/chart.test.ts, test/tiles/_, test/web/_, source tests and e2e cover these
  paths; current tests miss incremental cold-start visibility and arbitrary-order
  recovery. Existing workspace edits also affect these files.

## Architecture

Use SQLite for durable indexed acquisition units, preview aggregates, QC/pass
results and refined cells. Avoid a global rebuild barrier. Use separate versions
for source/config interpretation, QC, aggregation and presentation.

### Immediate observations

Perform cheap finite/range/sentinel/source checks and available reference/position
correction. Publish bounded spatially distributed observations, narrow continuous
track ribbons and measured coarse bins (count, sum, spread, range). Do not average
positions independently from depths, invent track connections across gaps, or
mix raw and chart-datum depths. Preview uses GeoJSON at bounded viewport sizes;
dense historical coverage is tiled. Retain old presentation until replacements
are ready, except explicit QC rejection, which must retract it.

### Acquisition and scheduling

Priorities: live/blank visible area, visible preview coverage, visible refinement,
nearby prefetch, remaining history. Share work across viewers and reserve bounded
background capacity. Panning cancels obsolete rendering between bounded jobs.
Use capability-detected spatial track queries only as window discovery unless
provider pairing/source/reference semantics are verified. Fetch QC context beyond
viewport edges. Fall back to small recent windows, expanding backward adaptively;
never scan all availability before publishing. Late provider tail is retried
separately; old history never waits five minutes for recent samples to settle.
Provider failures remain retryable; never mark missing data successfully complete.
Bound requests, deadlines, concurrency, worker messages, buffers and transactions.

### Durable and replaceable contributions

An acquisition unit has stable source identity and half-open time bounds,
completion/empty/failure state, source configuration version and spatial coverage.
Overlapping queries must not duplicate samples or passes. Replacing a unit replaces
its derived contribution transactionally, never appends the same observations.
Reuse existing local raw data; cache external chunks with explicit retention and
recoverability policy. Do not evict the only recoverable input implicitly.
Index chunks/segments spatially, including antimeridian cases. Keep stable pass
identities and timestamps. QC edits replace affected pass summaries and recompute
cells; out-of-order jobs and restarts converge to the same state.

### QC and aggregation

Use the same revisable stages for live and history. QC jobs consume chronological
track segments even when acquired newest-first. Preserve run/transit context and
leave boundary results provisional until sufficient context is available.
Tide corrections are another revision, not a display gate.

The exact current EMA mean can be evaluated newest-first with expanded weights,
but its sequential absolute deviation, centimetre rounding and reference resets
cannot be merged by averaging partial cell states. Candidate replacement is a
normalized exponentially weighted mean of chronological pass medians, q=0.8:
mean = sum(q^k * pass[newest-k]) / sum(q^k)
Retain summaries so inserted/rejected passes rerank correctly. Compare weighted
spread against existing deviation and validate margins before replacing the
published statistic. Do not claim a weight bound is a depth-error bound. Do not
use log-depth means: zero and negative chart-datum depths are legitimate.

### Publication

Publish cells and overview updates consistently, then invalidate affected encoded
and shared caches, including empty tiles. Revision-check worker results and reject
obsolete results. Retire previews only after the matching replacement is loaded;
rejected samples may be removed immediately. Preserve patch-edge interpolation
context. First useful paint bypasses normal 5–30s refinement batching. Filter and
bound preview responses by viewport; retain authorization on all new routes.

## Delivery sequence and verification gates

1. Record baseline acquisition/first paint/QC/tile latency, event-loop delay,
   memory and DB size on underway/anchored synthetic tracks and Pi when accessible.
2. Implement independent persistent preview acquisition/publication and viewport
   prioritization, recent-first fallback and realtime pre-QC preview.
3. Add durable arbitrary-order completion and idempotent replacement; test late
   samples, restart during commit, source/config change, dateline and empty windows.
4. Unify QC/refinement with pass summaries and evidence-backed estimator selection.
5. Incremental overview/cache publication; verify stale in-flight tiles cannot
   overwrite new data and preview retirement survives failed refreshes.
6. Remove history selector/old holds after replacement paths are verified; update
   maintained docs and mark outstanding work honestly.

Target live preview within 2s, historical preview within 2s of first useful batch;
measure end-to-end provider latency separately. Cached panning needs no history
request. Test actual worker/file-backed paths, deterministic interrupted versus
uninterrupted results, bounded queues under rapid pan and multiple viewers, and
slow/failed history/tides. Run plugin build/tests and repository checks. No deploy
to pi.local or package release is part of this implementation.

## Review and implementation record

One Open Waters review round requested before implementation. Findings and
verified dispositions will be recorded here; later implementation is not implied
to have received that same independent review.

### Review disposition

External Open Waters reviewers all failed to start in the sandbox. Automatic
approval rejected escalation because external CLIs could transmit the private
worktree to third-party services. No external review completed. One internal
read-only substitute review completed using the same review checklist.

Applied findings before implementation:

- Canonical historical acquisition windows are aligned, half-open UTC intervals.
  Source/config epochs identify interpretation. Live observations are provisional,
  not additional historical evidence; a settled historical interval owns its
  representation and replaces provisional contributions for that interval.
  QC halo samples supply context only. Persistent passes need deterministic
  ownership independent of requested windows before changing final aggregation.
- Legacy SQLite depths already include offsets. Enforce depth_since on previews
  as on refinement. Include selected depth/GNSS sources and geometry in config
  identity. No recovery of an unknown historical correction is assumed.
- Start local-history preview before settleSource completes; reporting source
  settlement is unchanged. External history discovery can supersede local
  intervals only after successfully reading them.
- Fence every async write by a persisted generation checked within the publishing
  transaction. Aborted or superseded jobs cannot publish data or completion.
- Current host refresh acknowledgement is not proven to mean all tiles loaded.
  Initial preview composition must not claim exact loaded-tile retirement.
  A future retirement protocol must associate patches and revisions and test
  partial/failed refreshes. Preserve current final statistic until validated.

Implementation is staged: the first independently testable deliverable is cheap
persisted recent-first observations, pre-settlement local preview and pre-tide live
preview, with distinct viewport-bounded presentation. Pass-summary storage,
spatial provider discovery and the replacement estimator remain separate gates;
none is represented as complete by the presence of a preview.

### Implemented in the first delivery

- `tiles/preview.ts`: persistent latest observation per geographic cell, bounded
  viewport responses (1,200 points), antimeridian queries, cheap validity checks,
  source/reference configuration identity, and transactional generation fences.
  This is a sample preview, not a mean or an input to the final depth statistic.
- Recent-first acquisition publishes the first hour before availability scanning;
  settled half-open windows are checkpointed, partial reads remain retryable.
  Empty periods expand discovery to at most a year. Source calls are bounded at
  30 seconds; an uncancellable timed-out temporal query stops preview acquisition
  until restart instead of piling up more queries. Stream reads are bounded too.
- Spatial Track API support supplies prioritized own-vessel visit hours for the
  active viewport (boat area before a viewport arrives). This is a hint, never
  evidence that the rest of history is empty. Unsupported spatial providers fall
  back to temporal discovery. Preview history skips optional GNSS metadata reads.
- Local preview starts before provider selection, enforces legacy `depth_since`,
  and is superseded by successfully read historical intervals. New realtime
  observations are exposed before asynchronous tide lookup completes.
- Distinct orange translucent preview observations and labels are updated without
  tile-refresh batching. Panning requests cached observations immediately. The
  browser retains bounded old preview during batched/failed replacement refreshes.
  This still uses host refresh acknowledgement, not per-tile load acknowledgement.
- Refined backfill consumes discovery batches progressively, updates overviews
  with cell commits, reports worker changes and resets tile caches every five
  seconds while changing. Workers are fenced by the current build generation.
- Removed the history-range UI/type/helpers; all recorded history is eligible.
  Failed refinement no longer discards pending history after three restarts.
- Tests cover pre-provider local preview, reference cutoffs, stale generations,
  half-open replacement, idempotence, viewport limits/dateline, newest-first reads,
  blocked discovery, cancellation, spatial hints/fallback, first browser update,
  failed refresh retention and real worker publication before source completion.

### Measurement and validation

`npm run build -w crowd-depth` then
`node packages/signalk-plugin/scripts/benchmark-preview.mjs` reproduces a
file-backed synthetic comparison. On this Mac with 20,000 observations:

| Track    | First preview commit | All preview writes | First refined commit | All refinement |
| -------- | -------------------: | -----------------: | -------------------: | -------------: |
| Underway |                 8 ms |              75 ms |                61 ms |         250 ms |
| Anchored |                 4 ms |              64 ms |             1,153 ms |       1,153 ms |

These measure database publication, not provider/network/browser latency. The
process RSS was 155/294 MB respectively; the second case includes earlier V8 heap
allocation and is not an isolated peak-memory comparison. Pi validation remains
pending because SSH authentication failed. No live server was changed.

The final full suite passed 397 tests across 37 files. Builds, oxlint, browser
TypeScript, changed-file formatting and package validation pass. `npm run check`'s unrestricted Prettier traversal
entered nested `.claude/worktrees` and generated datasets and failed on huge
unrelated files; it was interrupted. Changed files are checked explicitly instead.
Package validation uses `npm_config_cache=/tmp/crowd-depth-npm-cache` because the
normal cache is outside the sandbox.

### Remaining work before calling the architecture complete

- Shared durable input chunks and deterministic pass contributions. Preview and
  refinement currently fetch independently; the final chronological writer and
  its live hold remain. No normalized estimator or new uncertainty model shipped.
- Viewport-prioritized detailed QC with correct transit/run context and replacement
  contributions; current priority applies to preview acquisition only.
- Fair scheduling across simultaneous viewers, bounded preemption of slow provider
  calls, and explicit user-facing discovery/completeness/error status.
- Per-patch generation-aware loaded-tile acknowledgements, targeted invalidation
  instead of the current bounded full-cache refresh, and tile-based dense preview.
- Source-provider identity changes beyond selected sensor/config identity, raw
  input retention policy, late provider corrections after settled intervals, and
  production-scale storage/latency benchmarks.

Do not interpret the first delivery as complete implementation of those remaining
items. Subsequent external review and implementation are recorded below. Existing
unrelated workspace edits were preserved; no commit, PR or deployment was made.

## External review and second delivery (November 22)

The user explicitly authorized sending the worktree to external Open Waters
reviewers. Round one returned Codex, Opus and Sonnet reports; Copilot failed
because its monthly quota was exhausted. Reports are in
`/tmp/review-YqBQws`. Sonnet's final report refers to findings not fully repeated
in its output, so it is not treated as an exhaustive independent checklist.

Confirmed and fixed: obsolete worker checkpoint writes (metadata and cell writes
now share a fenced transaction), selected-source subscription fan-out, startup
when GPS arrives after depth, zero-depth sentinel acceptance, GPSD provider
representations/hostname precedence, offline converter validation, E2E discovery
and GNSS settings fixtures, manual upload HTTP failure handling, stale capability
documentation, and unnecessary reporting-only GNSS reads during refinement.

The server GNSS geometry requirement and automatic depth-path selection are
intentional existing sensor-configuration changes; they are not silently reverted.
Missing geometry still requires configuration. Startup with neither live nor
historical source identity still waits, including access to derived charts.
Full preservation of historical sensor identities/reference epochs is unresolved.
The legacy chronological pass fold can still double-count overlapping restart
coverage; generation fencing prevents cross-build corruption but does not make
those contributions idempotent. These remain release blockers for the complete
architecture, alongside real Pi measurements.

Added `tiles/inputs.ts`: preview and refinement share compressed, paged,
settled-hour paired inputs before position correction/QC/tide processing.
The initial consumer streams samples as they arrive; concurrent consumers wait
for that hour's completion and reuse it. Completed hours survive restart and QC
changes; depth/source interpretation changes select a separate namespace.
Partial reads, errors, unavailable readers, and the mutable provider tail do not
publish completed chunks. Inputs retain at most 100,000 rows per hour and write
pages of 1,000 rows; larger reads still render but are not cached. No completed
input is evicted automatically. Crash-orphan page reclamation, source-provider
identity/versioning and total disk retention policy remain to be completed.

After these changes the unit/integration suite passed 402 tests in 38 files.
End-to-end verification and subsequent review results follow below.

### Follow-up review

Round two returned full static reports from Opus and Sonnet in
`/tmp/review-kccNub`. Fixed Sonnet's hung units lookup: it no longer blocks
startup or polling, and concurrent units lookups are coalesced. Fixed Opus's
global backfill invalidation and skipped prebuild: worker messages now carry
changed positions, batched with a 4,096-position bound, and sharing resumes
before the final reset/prebuild scan.

Cached input storage now stops adding compressed pages at 256 MiB and continues
streaming without caching; completed recoverable inputs are not automatically
evicted. Empty reads are not persisted as completed input chunks. This bounds
payload growth but does not solve provider revisions/late imports, old namespace
retention or crash-orphan reclamation. Those remain open review findings.

The Signal K 2.33.0 server implementation does await async schema/uiSchema and
honors the top-level sourcePolicy setting, so the reviewers' conditional concerns
on these contracts were checked against its installed code. Live and history
E2E tests both pass on that version after using an explicit plugin source type
(the untyped fixture label had become e2e.XX). The adjacent development server
could not boot due to a missing undici dependency; it was not modified.

All-history discovery and retained retry debt are intentional user requirements;
a permanently failing hour still blocks chronological detailed refinement and
needs the planned independent-job scheduler. Provisional latest observations
are intentionally unverified, distinctly styled, and not the final estimator.
The unreleased derived layer's rebuild on format change is allowed by the user.
The existing sensor migration, missing geometry, source alias and offline CLI
concerns are recorded separately from these accepted layer changes; they are
not claimed to be resolved.

### Final review checkpoint

Round three returned Opus and Sonnet reports in `/tmp/review-ITGich`.
Both were static reviews and did not run the test suite. The prescribed three-round
limit has been reached with material findings still open; this work is **not
release-ready** and has not been committed, published or deployed.

Confirmed open blockers:

- **Input freshness and retention:** cached positive hours and completed preview
  windows have no provider revision/revalidation protocol. Late imports and
  historical corrections can remain invisible even after derived-data rebuilds.
  Old configuration namespaces and crash-orphan pages consume the cache cap;
  reaching it safely bypasses caching but never reclaims that space.
- **Independent refinement/recovery:** detailed QC is still chronological, so a
  permanently failing window blocks later detailed work. Restart overlap is not
  yet represented by idempotent pass contributions. The next implementation
  needs a durable job ledger and replaceable pass summaries before viewport-first
  detailed refinement or a new estimator can be safely enabled.
- **Existing sensor changes:** missing per-source server geometry prevents startup;
  old saved depth paths are overridden; raw stored readings lack reference epochs
  needed to relabel an unreported backlog safely; renamed CAN source aliases can
  silently stop selected-source collection. Offline conversion and rollback config
  compatibility also remain unresolved. These changes predated the progressive
  layer work and must be reconciled before releasing the combined worktree.
- **Production performance:** no full-sized Pi benchmark or visual cold-start
  acceptance run has passed. Incremental overview maintenance is measured only
  synthetically. The conservative untided overview flag can remain set until a
  later explicit overview rebuild.

Additional unverified concerns: numeric GNSS quality aggregation support across
History providers and minimum supported server versions. The tested Signal K
2.33.0 code awaits schema/uiSchema, honors sourcePolicy, and explicitly defines
CCRP as centerline/midships (its gnssOffsetCorrector/leverArm implementation).
Those conditional reviewer concerns were checked, not accepted as defects.
The intentional unreleased-layer format rebuild, all-history scope, retained
retry debt, and visibly provisional unverified observations remain accepted
requirements; discarding history or silently mixing sensor geometry would not
be appropriate fixes.

Final verification after behavior changes:

- 403 tests passed across 38 files.
- Both real-server E2E scenarios passed on Signal K 2.33.0, including GPS arriving
  after depth and history-only startup.
- Build, browser TypeScript, oxlint, changed-file formatting, publint/package
  validation and git diff whitespace checks passed.
- File-backed synthetic input-cache experiment: 86,400 one-second samples in 24
  hourly chunks acquired in 380 ms, replayed in 98 ms with no additional provider
  reads; 1,769,278 compressed payload bytes in a 1,843,200-byte database.
  This excludes network/provider latency, browser paint and Pi SD-card behavior.
- Only this review/status documentation changed after the final model review.
  No scratch vessel data was staged or committed.

The next work should resolve input versioning/retention and deterministic pass
replacement first, then enable viewport-prioritized detailed QC and validate it
against uninterrupted chronological processing. Source/reference migration needs
its own explicit contract. The third-round reports are not an approval to ship.

## Continued review and Pi preview

The user explicitly authorized additional review rounds beyond the skill's
three-round default. Legacy saved depth paths are now retained; valid legacy GPS
offsets are used only when no server sensors are configured, correction is off,
and the legacy receiver matches. Server geometry remains authoritative.
Live depth and position selection recognize address/CAN-name aliases only when
the server identifies the same physical device.

At the user's request, the worktree package was installed **through Docker** on
pi.local on November 22, 2026. npm ran inside the signalk container under
/home/node/.signalk/local-pkgs/progressive-20261122-0905, and the main plugin path
points to that installation. Other plugins' dependency trees were not changed.
Package SHA-256:
`e1b0198757df6b923f85a97ba0bacb434f0b07c9f8427c43e2c825e2430ed651`.

Rollback assets (old plugin, configuration, root package manifests, identity and
an online SQLite backup) are in
`/home/node/.signalk/local-pkgs/progressive-20261122-0905-backup`
inside Docker, mounted from the same suffix under /home/pi/.signalk on the host.
Restore the previous plugin without overwriting new observations; the database
snapshot is for explicit recovery only.

After the container restart, logs showed the saved belowSurface selection and
live depth collection. The first history batch arrived about five seconds after
chart startup. The boat-area live endpoint returned HTTP 200 in 9.9 ms with two
historical preview points and 17 live features. This verifies API publication on
the Pi, not browser paint, first installation, or complete-history processing.
The preview remains experimental, with the open cache/refinement findings above.

## Resumed implementation and review round 5

The initial Docker preview remains at `progressive-20261122-0905` until a later
installation entry explicitly supersedes it. A later read observed 88,732 refined
cells but a chronological checkpoint still in April 2026 while the current boat
history was in November, confirming the prioritization gap.

Round 5: `/tmp/review-8GmD09`. Opus completed a full static map and reported 13
findings. Sonnet returned nine findings but omitted its required system map from
the retained final report; count that as a limited attempt, not a completed mapped
review. Neither reviewer ran tests.

Verified fixes since that review:

- Replaced full chronological pass replay with configurable exponential timestamp
  weighting and capped hourly summaries in an adaptive merge tree. Original pass
  records remain; independent hourly contributions support replacement/retraction.
- Empty/partial provider results do not erase live-derived passes. Existing live
  cells take precedence over imported passes for that hour until point-level
  provenance reconciliation is implemented. Successful empty reads now receive
  separate coverage receipts; provider errors do not. Nonfatal failed windows do
  not prevent independent older jobs.
- Preview responses carry a content revision and omit unchanged feature payloads;
  the browser retries payloads until host updates and retained-preview refreshes
  succeed. Idle live-writer ticks avoid empty write transactions. Failed commits
  preserve the writer's pending buffers for retry.
- Historical source discovery caches results for an hour, rather than rescanning
  the entire provider every minute while startup is unresolved. Failures retry
  after five seconds and successful empty discovery after one minute.
- Updated current-user documentation to describe hourly jobs, the tunable half-life
  and its independence from retention. Original EMA/backfill docs are marked as
  historical regression references.

The user's all-history requirement is intentional, not a regression to fix by
restoring the removed year selector. Existing sensor-selection/geometry migration
findings concern changes that predated this task and remain release blockers;
the tested Pi's legacy geometry and saved depth path work. Automatic source
failover requires a reference-epoch contract, not silently borrowing another
receiver's calibration. Async schema handling was verified against installed
Signal K 2.33.0 and is supported there.

Remaining release blockers: a continuously captured owned observation archive,
point-level live/history overlap handling, input cache namespace/freshness policy,
derived-ledger compaction, source/reference migration, and the full controlled
performance/recovery/browser-paint matrix. No destructive thinning or public
release is enabled. See [performance results and retention requirements](performance/README.md).

## Review round 6 and configurable weighting

Round 6: `/tmp/review-rWXFaA`. Opus supplied a complete static map; Sonnet's
report was limited by missing source reads and its incomplete map. Neither ran
tests. Verified fixes preserve earlier imported evidence when a partial hour is
extended after live capture, receipt successful hours without paired positions,
and separate weighting changes from geometry invalidation.

The half-life defaults to 365 days and is configurable from 1 to 36,500 days.
Changing it reweights retained hourly summaries in bounded cell batches without
deleting the pass ledger or coverage receipts and without requiring History.
Concurrent live updates apply the current weighting to each affected cell.
Raw observation retention is independent of this display setting.

Stationary provisional rendering retains the newest and shallowest sounding per
cell and depth reference. This reduces overlay payloads without thinning the
stored observations or QC input. These changes are local and are not yet in the
Pi's installed preview; SSH agent signing was unavailable during staging.

## Docker preview activation and review round 7

Activated `progressive-20261122-weighted` inside the Pi's `signalk` container on
2026-11-22. Package SHA-256:
`21a79c9c5a6cb292b97876ae150b4abcc0aca44014c36a8c9f3c6d60ee073495`.
The previous plugin, configuration, manifests, identity and a consistent online
SQLite backup are in
`/home/node/.signalk/local-pkgs/progressive-20261122-weighted-backup`.
Do not restore that database over subsequently collected observations.

An isolated Docker test replayed 24 cached history chunks into a temporary
candidate database: first refined cells 886.95 ms, total 14,678.59 ms, 40 cells,
24 committed windows, event-loop maximum 185.99 ms. Production backfill was
running concurrently and the test did not apply tide correction. This is evidence
of useful incremental publication, not a controlled browser-paint benchmark.
After activation Freeboard visibly displayed the provisional track; viewport HTTP
responses succeeded, with a repeat request taking 42.4 ms. A preview source query
also timed out. SSH authentication stalled again before database coverage could
be checked, so sustained full-history progress is not yet verified.

Round 7 reports: `/tmp/review-sSrjtT/{opus,sonnet}.md`. Both supplied static maps;
neither ran tests. They repeated the recorded source-migration, coarse live/history
overlap, unbounded derived storage and provider-timeout release blockers. Sonnet
also identified a verified crash-consistency gap when changing the half-life.
The local follow-up commits the weight and pending-reweight markers atomically,
with an injected SQLite failure regression test. That follow-up is not in the
installed package above. No source migrations, retention policy, or private
scratch files were silently changed as part of this preview installation.

Round 8: `/tmp/review-CKjpew/{opus,sonnet}.md`, both static mapped reviews, no
reviewer-run tests. Neither repeated the atomic half-life-marker defect. Local
validation after that fix: 431 tests, plugin build/lint/publint and diff checks
passed. Review is not clean: the previously recorded release blockers remain,
plus empty-coverage freshness and invalidating retained provisional features when
QC rejects an entire window. Production-path upgrade/tail tests must replace the
remaining reliance on legacy backfill tests. Async schema compatibility was
already verified against Signal K 2.33.0; the reviewer's uncertainty is not
additional evidence of a defect. NOAA antenna-location metadata describes the
physical sensor; it is not automatically wrong merely because coordinate
correction uses a different position origin.

Browser checks after activation fetched two nonempty refined tiles near the boat,
which subsequently grew from 2,379/2,085 bytes to 3,567/3,158 bytes. A revision-aware
poll returned 1,299 bytes in 61 ms with unchanged preview features omitted. This
confirms refinement output and incremental overlay delivery, not completion of
all history. Follow-up SSH commands ultimately failed with the same key-agent
signing error, so the atomic-marker fix remains local and the activated package
hash above is still the installed version.

## Visible-preview handoff fix

The installed weighted preview still served 474 provisional points around the
user's northern Lake Worth viewport, dating from November–December 2025. The
raw-cache spatial index is not populated for older cached pages, so it could not
reliably prioritize those already-visible observations.

The follow-up schedules the hours represented by visible preview timestamps on a
separate bounded refinement worker, independent of global availability discovery.
It reads original observations (never preview depths as QC input), includes the
adjacent hours for context, preserves global pending coverage, and retries failed
visible hours with a cooldown. A previous empty read does not suppress work for
which visible observations exist. Explicit refinement receipts, rather than the
global chronological watermark, now control preview removal.

Bulk refinement retries without a restart, with exponential retry delays capped
at 15 minutes. Availability spans grow across empty history, with a saved smaller
cap after a provider failure. Cached source requests retain their in-flight slots after timeout until
the provider settles, preventing duplicate queries from piling up. Up to four
provider requests may be outstanding; cached reads bypass those slots. The client
also schedules a batched refresh when preview points disappear without a tile
revision, covering windows entirely rejected by QC.

Tests cover legacy previews without a spatial index or working discovery, retained
global coverage, empty-read recovery, non-stacking timeout retries, and retiring
QC-rejected previews without tile changes. This follow-up awaits deployment;
SSH key signing remains unavailable as of the initial checks for this fix.

Round 9 reports: `/tmp/review-yngdxI/{opus,sonnet}.md`. Opus supplied a full
static map; Sonnet omitted key new source/test reads and is a limited review.
Both identified the one-day discovery cap as a performance regression. Fixed it
with expanding empty-history spans, a smaller persisted cap after failed large
queries, and exponential bulk retry delays. A regression test checks logarithmic
empty-history discovery and the reduced span on retry. Existing source-migration,
source provenance, estimator uncertainty and cache-retention findings remain
release work outside this handoff patch.

Once SSH returned, the Pi reported 9,199 old cache pages without spatial index
rows. Its bulk run had meanwhile completed: all 667 preview observations in the
queried viewport had positive refinement receipts. This confirms that the earlier
wait was real, and retained browser features can outlive completed refinement.

## Handoff preview installed and verified

Installed `progressive-20261122-handoff` through Docker on 2026-11-22. Package
SHA-256: `6f2d9d883822c86eb45a1be3928e9eae591084f44ba990789639c9c248c02baf`.
Rollback files and a consistent database backup are in
`/home/node/.signalk/local-pkgs/progressive-20261122-handoff-backup`.
No database restoration or destructive thinning was performed.

An isolated test in the Pi's running Docker container used the reported
viewport's original cached observations with availability discovery disabled:
474 initial previews, 11 hours, zero remaining previews after 24.176 seconds,
first refined cells at 1.701 seconds. It produced 1,730 cells and 11 receipts;
maximum measured main-thread event-loop delay was 184.3 ms. Tide correction was
excluded. The temporary test database was deleted afterward. These are loaded-Pi
regression measurements, not a comprehensive performance acceptance result.
See [measured result](performance/pi-viewport-handoff.json).

After activation, Docker's active symlink points to the handoff package, the
viewport API returns zero historical preview features, and the served runtime
SHA-256 exactly matches the local fixed bundle. Recent logs show collection and
refinement without layer errors. Existing Freeboard tabs must reload their runtime.
Validation: 435 tests, two real Signal K e2e tests (before the final discovery-only
correction), plugin build/lint/publint, and diff checks passed.

Round 10: `/tmp/review-O4jr2N/{opus,sonnet}.md`. Opus supplied a full static map;
Sonnet's final response omitted six claimed findings and key module reads, so it
is a limited attempt. Neither reviewer ran tests. The one-day scan regression is
no longer reported. Broader source/geometry migration and CLI compatibility
findings remain, along with cache retention, empty-history freshness and poison
window recovery. Repeated poison-window failures also keep bulk surface sharing
disabled during backoff; that is a remaining performance issue, not observed in
this completed Pi backfill. Async schema support was previously checked against
Signal K 2.33.0. Review is not release-clean; this installation is a tested preview
of the requested visible-preview handoff fix.

## Pi load incident: eager tile warming

The user reported slow page loads including Signal K admin, with system load 5–6.
Pi logs showed `built 28978 tiles ahead in 2161.0 s`, ending at 13:24 local time.
Later samples showed 79–89% CPU idle, no active swap or I/O wait, and API requests
at 22–44 ms; the sampled viewport tile took 179 ms initially and 21 ms on repeat.
These observations identify a large avoidable background workload consistent with
the earlier slowdown, rather than a persistent slow HTTP endpoint at sample time.

The chart no longer enables eager tile warming. Tile generation stays in workers,
and requested tiles retain persistent caching. Removing the chart's `ahead`
argument also avoids the synchronous whole-store tile enumeration at startup.
A file-backed startup regression checks that stored cells produce no speculative
kept-tile reservations. The test also exposed a late tide callback reading a
closed database after abort; the callback now checks abort before reading it.

## Cold-render candidate checkpoint (November 22)

The installed Pi Docker preview remains `progressive-20261122-demand`.
Read-only profiling confirmed rendering CPU time in interpolation/portrayal,
and fresh-worker nine-tile views varied from 1.4–1.8 s to 3.7–5.0 s under load.
These are not acceptable cold-view results, and the current task is not complete.

A local candidate now chooses a spatial tree for sparse tracks, retaining the
original raster search for dense coverage, small radii and clustered patches.
The search preserves radius, neighbour count, ordering and interpolation rules.
Its measured desktop kernels improve sparse cases without the dense-patch
regressions caught during review; see [results and limits](performance/README.md).
The committed benchmark harnesses cover worker viewports with optional concurrent
HTTP probes, repeated baseline/candidate search comparisons, and exact tile-byte
parity over 64 synthetic scenes.

Validation on the final candidate: 439 unit tests, two Signal K integration tests,
64 byte-identical tiles, repeated search comparisons with full-sort oracles,
build, package lint/publint, scoped Oxlint/Prettier and diff checks pass. Broad
review round 12 and focused rounds 13–15 completed; the empty initial focused
snapshot was not a review. Review findings, corrections, remaining limits and
post-review changes are recorded in the performance notes. Broader startup,
retention and history correctness release blockers remain unchanged.

Candidate package: `/tmp/crowd-depth-render-package/crowd-depth-1.3.0.tgz`,
SHA256 `c290c52835892df51980521c9a1a091c9becf36f8c353bc44ecbe10673a3e324`.
Compared with the installed demand package, runtime changes are confined to
`dist/tiles/surface.js` and its generated declarations/maps/build metadata;
the package README also changed. No schema, collector, history or browser-runtime
change is included in this candidate.

SSH signing through the 1Password agent stopped working during the investigation;
a direct-key attempt failed too, and bounded retries still time out. The pending
user request is to unlock/reconnect the SSH agent. No candidate was installed.
Next: restore SSH, stage the candidate beside the active package in Docker, compare
identical real Pi tile outputs and repeated viewports with Signal K HTTP probes,
then install and verify through Docker only once the measured targets are met.
Do not describe this candidate as Pi-validated or release-ready.

## Pi access restored; draft PR checkpoint

SSH access was restored on November 22. The candidate renderer was copied beside
`progressive-20261122-demand` inside the Docker volume, without changing the active
plugin. Real-data comparisons at zooms 13–15 checked 27 tiles, including worker
outputs, and found byte-identical output. Repeated cold viewport measurements
still miss the proposed acceptance targets; see the current performance notes.

A two-worker experiment was applied only to the isolated benchmark copy. It
improved concurrent Signal K HTTP latency but slowed some full viewports. The
worktree and active plugin retain their three-worker limit. No new candidate was
activated. SSH is no longer the blocker; rendering and resource contention need
more work. The user requested a draft PR of this state before further changes.

## Contour follow-up and query review

The next renderer change removes per-crossing contour case allocations. It passes
64 synthetic tile byte comparisons and 27 real Pi tile comparisons. The Pi contour
kernel is about 40% faster in sequential alternating runs; whole-view timings are
mixed against the live server, and fresh-worker views still exceed the target.
Details and raw measurements are in the performance notes. No active Docker
package switch was made.

Open Waters rounds 16–17 completed with Opus and Sonnet. The contour change has no
outstanding findings. A separate preview-starvation fix reproduced the correctness
bug but increased wide-viewport query work; both reviewers identified that cost,
and the attempted fix was withdrawn. The existing cap-before-filter starvation
remains a release blocker requiring bounded query work. Review limits and the
confirmed maximum-gap stationary-thinning requirement are recorded in the
performance notes. SSH was restored again for these Pi measurements.
