import os

# DuckDB's Linux build allocates through a bundled jemalloc, which keeps freed pages for
# a second before returning them, and only when the arena that freed them runs again.
# DuckDB's memory limit stops counting a block once it's freed, so a run that spills
# can hold up to 0.9 GB of these past the limit. Hand them back at once, as pages the
# kernel takes when memory runs short (jemalloc's muzzy pages, MADV_FREE), so reusing
# one costs no fault. jemalloc reads this when DuckDB loads, so it's set here, before
# any grid module imports duckdb.
os.environ["DUCKDB_JE_MALLOC_CONF"] = os.environ.get("DUCKDB_JE_MALLOC_CONF") or "dirty_decay_ms:0"

# That jemalloc serves DuckDB's own blocks alone. An operator's working state, such as the
# values a median holds, comes from glibc's malloc, outside the limit, and glibc's per-thread
# arenas keep what it freed: on the Chesapeake, calibrate held 1.3 GB past DuckDB's limit
# that way between queries, and was killed in a 2 GB cgroup. malloc_trim(0) hands every
# arena's free pages back. Capping arenas (MALLOC_ARENA_MAX=2) worked too, but must be set
# before the process starts and holds for every command's threads.
try:
    import ctypes

    _malloc_trim = ctypes.CDLL(None).malloc_trim
except (AttributeError, OSError, TypeError):
    _malloc_trim = None


def release():
    """Return memory the process has freed to the system, where the allocator is glibc's."""
    if _malloc_trim:
        _malloc_trim(0)


def ranges(sizes, limit):
    """`sizes`, as (key, rows) in key order, in runs of keys (first, last) of about `limit`
    rows each: a key with more is a run of its own."""
    out, size = [], 0
    for key, n in sizes:
        if out and size + n <= limit:
            out[-1][1] = key
            size += n
        else:
            out.append([key, key])
            size = n
    return [tuple(r) for r in out]
