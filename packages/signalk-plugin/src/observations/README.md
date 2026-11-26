# Owned observations

`observations.sqlite` is separate from the disposable chart database. The plugin
records selected live depth/position pairs even when a history provider supplies
reports. Accepted finite depth samples paired with a valid position no older than two
seconds are saved before depth-offset correction, coordinate correction, tide
correction, track QC, or report rounding. True heading and course over ground
are separate fields. Timestamps invented by this plugin are marked as estimated; timestamps
provided or rewritten by Signal K cannot be independently identified as sensor
times. Actual source IDs accompany each pair;
configured source choices are acquisition settings, never proof of provenance.
History aggregates and legacy corrected inputs have separate acquisition kinds.

A worker owns SQLite and compression. Each live transaction seals at most 512 points
into a compressed, checksummed JSON chunk and adds its spatial bounding box
atomically. ISO timestamp strings retain their original precision and may include
an explicit UTC offset. Identical
chunk retries are idempotent and can restore damaged compressed bytes under the
same content hash and chunk ID. Missing spatial bounds are rebuilt from verified
originals during import indexing. Corrupt original data without an identical replacement and malformed manifests
remain explicit recovery holes. During older-index migration, unreadable imports
are quarantined with a logged warning while live capture stays available. Their
original bytes/receipts remain intact and their time windows use worldwide
spatial hints until bounds can be repaired; they cannot become empty coverage.
An identical reimport can repair chunk bytes and restore precise bounds.
Irrecoverable originals still require backup recovery. Chunk-ID cursors allow late imports to be visited;
chunk candidates are not chronological output or a display summary. Spatial
queries return at most 128 candidate chunks; exact point/time filtering is the
reader's responsibility. A bounded result count does not guarantee bounded SQL
scan time for arbitrary overlapping chunk bounds.

Live chunks now also maintain a derived capture index in the same append transaction.
Existing originals are discovered newest-ID-first in resumable batches of at most
16 chunks, with one second between worker transactions. Startup does not decode
the archive. Corrupt unindexed originals are quarantined without deleting their
bytes; an identical append repairs compressed bytes and derived time/count headers.
Migration errors are logged separately from capture failures.

`capturedPageInView` bounds spatial candidate selection before exact time filtering,
returns at most 64 chunk headers, and can return an empty page with a continuation.
Consumers must preserve that cursor across their own work budgets; only an absent
cursor means exhaustion. It is currently a storage foundation, not connected to
production chart reads. The migration high-water mark assumes original IDs are not
reused: before introducing pruning, handle deletion followed by older-writer ID
reuse. No pruning is enabled here. Derived-index repair is not proof that all
originals have been recovered or that chart coverage is complete.

WAL with FULL synchronization protects acknowledged commits, subject to the
filesystem/device honoring synchronization. Live batches seal every ten seconds
or 512 points. An abrupt process/power failure can lose the unsealed batch and
queued samples; the plugin stop hook flushes accepted observations before closing the
worker. Signal K 2.33 does not call that hook on server shutdown; such a restart
also loses unsealed samples. This is a durability/SD-write tradeoff, not a zero-loss claim. Pending
worker requests and capture buffers are bounded. Overload or persistence failure
retries transient writes for up to thirty seconds with the batch retained.
Exhausted retries or overload stop that capture attempt, report an admin error,
and restart with bounded exponential backoff. Samples during an outage and an
uncommitted batch at final failure can be lost; a successful commit clears the
error. Normal shutdown unsubscribes first, then drains both stream queues.

Before appending, it reserves 256 MiB of filesystem free space; insufficient
space reports an error and stops that attempt, with periodic retries. This is
not a quota or a guarantee against other applications filling the disk.

The store grows without automatic deletion (including when upload sharing is
disabled); source IDs and precise locations remain local. At ten-second
batching, continuous capture makes up to 8,640 FULL commits/day, potentially
more if batches reach 512 points sooner. A Pi measurement of 10,000 synthetic
5-Hz points in 200 accelerated commits used 462,848 database bytes (46.3 bytes
per point), with a 4,140,632-byte peak WAL; this is not a long-duration storage
or wear bound. A new store uses a regular indexed bounds table on SQLite builds
without RTree. An existing RTree store still requires a runtime with that module.

The chart acquires raw history through this store when the provider exposes
original observations. History acquisition uses sequential requests of at most five minutes, preserving
one completion receipt for the caller's hourly window. Each segment is committed
before the next request, with at most 512 observations per chunk. At one observation
per second this is twelve commits per populated hour rather than eight. Request
creation and segment consumption each have a thirty-second deadline; the enclosing
preview/refinement stream allows thirty seconds per segment. Destroying a reader
aborts its acquisition before generator teardown, prevents subsequent requests,
and discards late streams while retaining reservations until provider calls settle.
This changes request/commit overhead and still requires loaded Pi acceptance.
The segment setting is internal; production History callers use hourly windows
and one-second aggregate buckets. Arbitrary longer/high-rate segmented imports can
exceed the archive's 196-chunk manifest bound before the point bound and are not a
supported extension without revisiting that limit.

Completed imports publish ordered chunk manifests;
replays and spatial hints use only current published manifests. Reads resolve
all overlapping windows, so whole-hour refinement retains observations acquired
by a nonaligned preview even after provider pruning. Overlapping versions are
reconciled by acquisition time (then start/end bounds for ties); deliberate
preview groups cannot replace partial/full groups. Metadata matching uses the
same unambiguous-source rules as import reconciliation. A multi-manifest read runs in the archive worker, with at most two active reads
and 512-point replies. Each buffers at most 100,000 resulting observations, visits at most 64 pages of 64
manifests, and decodes at most one million input observations; exceeding a limit
leaves the window incomplete instead of claiming empty coverage. QC validates even a single cached manifest before emitting observations, so a
repair cannot duplicate an already emitted prefix. Single-manifest previews and
initial provider acquisition still stream in bounded chunks. Reader admission
waits behind at most two active reads, with a bounded queue; page completion or
explicit close releases capacity. Shutdown rejects queued readers. A
partial overlap is shown immediately by preview, then the requested interval is
acquired; preview can emit revised observations at the same timestamp, while QC
receives a single deduplicated snapshot. Cached corrupt reads attempt reacquisition
before failing. Chunks outside the requested time range are not decoded, so their
damage does not affect reads outside those chunks. QC deliberately requests
adjacent track context; unrecoverable damage in that requested context keeps
refinement incomplete rather than silently treating missing context as valid. Abandoned and replaced
chunks remain archival data and do not contribute to those reads. Previews can
replay stale receipts immediately. New previews acquire original position/depth
without optional GNSS metadata and publish an explicit `preview` receipt. A full
read attempts metadata acquisition; unavailable or unattributed metadata marks
its observations incomplete and publishes a `partial` receipt, while the usable core observations remain
available for track refinement. It does not turn an optional metadata outage into
empty coverage or block track QC. A deliberately metadata-free `preview` cannot
replace a `partial` or `full` receipt, even across independent store clients.
A partial refresh can update core observations and add late rows while preserving
matching stored evidence; its short freshness period avoids retrying a known
metadata outage for every neighbouring QC window. `full` means the acquisition queries completed, not
that every observation has GNSS fields: missing values remain unknown, including
older retained observations that the provider no longer returns.
Reconciliation preserves missing GNSS fields, heading, COG and speed only for an
unambiguous observation with the same timestamp, actual depth/position sources,
coordinates and position timestamp. New supplied fields supersede old values;
unknown or changed provenance and duplicate matches never inherit metadata.
For a partial refresh with unattributed old or new readings, a timestamp group
that already contains optional evidence keeps its previous observations intact.
Core revisions to that group wait for a full acquisition; new timestamps still
land, and the incoming version remains archived. This preserves the old
calibration evidence without attaching it to a potentially different instrument.
QC reads revalidate preview-stage or expired receipts and
snapshots acquired before the provider's write-buffer delay elapsed. Receipt
timestamps identify acquisition, not consumer completion. Partial and empty
receipts are fresh for five minutes; nonempty full receipts for one day. Revalidation merges
timestamp groups: new readings replace matching timestamps, while observations
missing from a shorter or empty provider response remain owned locally. Original
versions remain archived. A failed reconciliation leaves the old manifest intact.
Reporting retains its existing source selection. Providers without original
observations retain the old chart cache path.
Preview and full acquisition each have two provider reservations and separate
in-flight coordination, so a hung optional request cannot occupy preview's slots.

Schema v7 retains the v4 index of published import windows by location, acquisition identity,
day, and window ID in a five-dimensional integer RTree. Viewport hints read the
spatial index first. Indexed ID ranges are bisected until a complete page fits
within 64 windows; a cursor advances past that range, including across refinement
retries. This prevents completed windows from starving older pending work without
sorting every match. A page is not a complete coverage list or necessarily the
globally newest 64 windows. Dateline views use two bounded lookups per range.
This avoids sorting or testing every matching raw
chunk before returning a small hint set. See SQLite's [RTree dimensions](https://www.sqlite.org/rtree.html)
and [CROSS JOIN ordering](https://www.sqlite.org/optoverview.html#manual_control_of_query_plans_using_cross_join).
Versions 1–3 migrate derived import indexes without rewriting raw chunks;
versions 1–2 completion-time receipts become stale, but remain preview-readable.
The v5 migration marks older receipts whose acquisition stage was not recorded as
preview-stage; their original chunks and spatial indexes remain available.
Version 6 adds the distinct partial stage, so older builds refuse its changed
publication semantics instead of accidentally downgrading partial receipts.
Historical reconciliation commits all merged chunks and their manifest together;
it is bounded to 100,000 observations per import window.

Schema v7 stores compressed, checksummed acquisition-origin exceptions for retained
timestamp groups. Receipt freshness no longer promotes those groups over newer
observations in overlapping windows. A corrupt origin blob can be replaced when all timestamp groups are freshly
reacquired; a partial or empty response cannot safely reconstruct missing ages.
Decoding and revision merging stay in the archive worker; readers exchange the compressed metadata. An empty refresh
preserves original stage and age for replay precedence, even though its receipt
records that the acquisition request completed.

Pre-v7 receipts cannot distinguish original acquisition from refresh time, so
upgrading marks them stale using a separate flag and preserves their existing
ordering timestamps. This retains the available evidence instead of replacing
it with arbitrary ties. Previously ambiguous ages remain ambiguous for groups
pruned upstream; only freshly reacquired groups gain new acquisition evidence.

Older owned-store previews cannot open schema v7. Before upgrading, take a verified
SQLite backup and retain the package/configuration needed for rollback. To use an
older owned-store build, stop capture, preserve the v7 archive separately, and restore
its matching pre-upgrade backup. Observations acquired after that backup remain in
the preserved v7 file and become available again on roll-forward; do not delete or
overwrite it. The released plugin and the previous v24 preview do not open this archive.
Restoring a snapshot does not merge observations recorded independently by the older
build; preserve both files if either has accepted new observations.

No originals are deleted or thinned. Canonical live/history overlap selection,
derived stationary thinning/tide statistics, background migration of already
refined history, and refresh of already published chart summaries remain
unfinished. Do not judge final performance from this intermediate architecture.

Preview coverage markers use a versioned source namespace separately from
preview-cell provenance. Old builds can write provider-only markers after a
rollback without those markers being accepted by the new owned-history scan.
