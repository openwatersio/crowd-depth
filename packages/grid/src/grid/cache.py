"""The download cache every store and worktree on a machine shares.

It lives at GRID_CACHE_DIR, or $XDG_CACHE_HOME/crowd-depth-grid, or
~/.cache/crowd-depth-grid, and holds one directory per kind:

- `reference`: BlueTopo and S-102 rasters, keyed by the SHA-256 their catalog gives, so
  a new release adds entries beside the old ones, and the catalogs themselves.
- `files`: source files (NOAA's CSVs, Open Waters uploads), keyed by bucket, key and
  ETag, trimmed to GRID_CACHE_FILES_GB, least recently used first.
- `coops`: CO-OPS gauge months, once final.

An entry is written to a temporary file beside it and renamed into place, so another
process sees a whole entry or none, and an interrupted write leaves only a `.part` file.
The cache is a convenience: a run that can't write to it, or remove from it, goes on
without it.
"""

import contextlib
import json
import logging
import os
import shutil
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

log = logging.getLogger(__name__)

PART = ".part"
# A `.part` file this old is a write that died, not one still going.
STALE_PART_S = 86400
FILES_GB = 20


def root() -> Path:
    if os.environ.get("GRID_CACHE_DIR"):
        return Path(os.environ["GRID_CACHE_DIR"])
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "crowd-depth-grid"


def path(*parts) -> Path:
    return root().joinpath(*map(str, parts))


def files_cap() -> int:
    return int(float(os.environ.get("GRID_CACHE_FILES_GB") or FILES_GB) * 2**30)


@contextmanager
def writing(dest: Path):
    """A temporary path to write `dest`'s contents to; renamed to `dest` if the block
    finishes, removed if it raises."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=dest.parent, prefix=f".{dest.name}.", suffix=PART)
    os.close(fd)
    # mkstemp's file is the owner's alone; an entry is for every user of the machine, such
    # as a container's root and the host's.
    os.chmod(tmp, 0o644)
    try:
        yield Path(tmp)
        os.replace(tmp, dest)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def share(src: Path, dest: Path):
    """A hard link to `src` at `dest`, or a copy where a link can't be made: across file
    systems, or of a file another user owns."""
    try:
        os.link(src, dest)
    except FileNotFoundError:
        raise
    except OSError:
        shutil.copyfile(src, dest)


def publish(src: Path, entry: Path) -> bool:
    """Add a finished file to the cache as `entry`; False if the cache can't take it."""
    try:
        with writing(entry) as tmp:
            tmp.unlink()
            share(src, tmp)
    except OSError as e:
        log.warning("cache: %s not kept (%s)", entry, e)
        return False
    return True


def read_json(entry: Path):
    """An entry's JSON, or None if there's none."""
    try:
        return json.loads(entry.read_text())
    except (OSError, ValueError):
        return None


def write_json(entry: Path, value):
    try:
        with writing(entry) as tmp:
            tmp.write_text(json.dumps(value))
    except OSError as e:
        log.warning("cache: %s not kept (%s)", entry, e)


def entries(kind: str):
    """A kind's complete entries: (path, stat)."""
    for dirpath, _, names in os.walk(path(kind)):
        for name in names:
            if not name.endswith(PART):
                p = Path(dirpath, name)
                try:
                    yield p, p.stat()
                except FileNotFoundError:
                    continue  # pruned by another process meanwhile


def sizes() -> dict[str, tuple[int, int]]:
    """Each kind's entry count and bytes."""
    if not root().is_dir():
        return {}
    out = {}
    for kind in sorted(d.name for d in root().iterdir() if d.is_dir()):
        stats = [s for _, s in entries(kind)]
        out[kind] = (len(stats), sum(s.st_size for s in stats))
    return out


def trim(kind: str, cap: int) -> int:
    """Remove a kind's least recently used entries until it holds at most `cap` bytes;
    returns the bytes it holds."""
    found = sorted(entries(kind), key=lambda e: e[1].st_mtime)
    total = sum(s.st_size for _, s in found)
    for p, s in found:
        if total <= cap:
            break
        try:
            p.unlink(missing_ok=True)
            total -= s.st_size
        except OSError:
            continue  # another user's entry
        # A key's folder goes with its last entry, so the walk doesn't grow with them.
        with contextlib.suppress(OSError):
            p.parent.rmdir()
    return total


def remove_stale_parts(now=None) -> int:
    """Remove `.part` files writes left when they died; returns how many."""
    now, n = now or time.time(), 0
    for dirpath, _, names in os.walk(root()):
        for name in names:
            p = Path(dirpath, name)
            try:
                if name.endswith(PART) and now - p.stat().st_mtime > STALE_PART_S:
                    p.unlink()
                    n += 1
            except OSError:
                continue
    return n
