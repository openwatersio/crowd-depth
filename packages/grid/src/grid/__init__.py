import os

# DuckDB's Linux build allocates through a bundled jemalloc, which keeps freed pages for
# a second before returning them, and only when the arena that freed them runs again.
# DuckDB's memory limit stops counting a block once it's freed, so a run that spills
# can hold up to 0.9 GB of these past the limit. Hand them back at once, as pages the
# kernel takes when memory runs short (jemalloc's muzzy pages, MADV_FREE), so reusing
# one costs no fault. jemalloc reads this when DuckDB loads, so it's set here, before
# any grid module imports duckdb.
os.environ["DUCKDB_JE_MALLOC_CONF"] = os.environ.get("DUCKDB_JE_MALLOC_CONF") or "dirty_decay_ms:0"
