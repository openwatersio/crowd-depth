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

A worker owns SQLite and compression. Each transaction seals at most 512 points
into a compressed, checksummed JSON chunk and adds its spatial bounding box
atomically. ISO timestamp strings retain their original precision and may include
an explicit UTC offset. Identical
chunk retries are idempotent. Chunk-ID cursors allow late imports to be visited;
chunk candidates are not chronological output or a display summary. Spatial
queries return at most 128 candidate chunks; exact point/time filtering is the
reader's responsibility. A bounded result count does not guarantee bounded SQL
scan time for arbitrary overlapping chunk bounds.

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
or wear bound. Spatial lookup degrades to a regular indexed bounds table on
SQLite builds without RTree; recording still works.

The chart acquires raw history through this store when the provider exposes
original observations. Completed imports publish ordered chunk manifests;
replays and spatial hints use only the current manifest. Abandoned and replaced
chunks remain archival data and do not contribute to those reads. Previews can
replay stale receipts immediately; QC reads revalidate expired receipts.
Reporting retains its existing source selection. Providers without original
observations retain the old chart cache path.

No originals are deleted or thinned. Canonical live/history overlap selection,
derived stationary thinning/tide statistics, background migration of already
refined history, and refresh of already published chart summaries remain
unfinished. Do not judge final performance from this intermediate architecture.
