"""Publish a `grid tiles` run: the archive, and each tile's surface, cells and depth areas.

    overlay.pmtiles                          the archive, at a key that never changes
    tiles/{kind}/{tile}-{sha256[:16]}.{ext}  a tile's surface, cells or areas, named by content
    manifest.json                            what is published now, written last
    lock                                     held while a run publishes

A tile's files are named by their content, so a file that didn't change keeps its key and
isn't uploaded again, and a new one never overwrites what a reader of the last manifest is
reading. The manifest names every tile's current files, so a reader that goes through it
sees one run's tile files throughout. A changed tile's old files stay RETIRED_FOR longer,
listed under `retired`, for readers still on the last manifest; a gone tile's go at once.
Then every file under tiles/ that the manifest doesn't name is deleted, whatever left it.
The manifest names the store its tiles came from, and a run from another store is refused.

The archive is replaced whole at its own key, as clients expect of a PMTiles URL: one PUT,
or a multipart upload that appears only when complete, so a reader sees the old archive or
the new one, and a reader by range that sent the old ETag gets a 412 and starts over.

The lock is renewed on its own thread throughout, and checked before each tile file, each
part of the archive, the archive's completion, the manifest and each delete. A run that lost
it stops at the next check, before it replaces the archive or writes the manifest. Both
those writes are conditional too, on the archive as listed before its upload and the manifest
as read at the start, so a run that stalled past its last check can't overwrite another
run's archive or manifest. Deletes can't be conditional, so they rely on the checks alone.
"""

import hashlib
import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path

from . import tiles
from .catalog import Lock, Locked
from .objects import Conflict

log = logging.getLogger(__name__)

ARCHIVE = "overlay.pmtiles"
MANIFEST = "manifest.json"
LOCK = "lock"
# How long a changed tile's old files stay for readers of the last manifest. Short, since
# they may hold soundings withdrawn since.
RETIRED_FOR = timedelta(days=1)
LICENSE = "CC-BY-4.0"
# The tile files a reader needs: Seascape's surface and cells, and the depth areas.
KINDS = ("surface", "cells", "areas")
TYPES = {
    ".pmtiles": "application/vnd.pmtiles",
    ".tif": "image/tiff",
    ".parquet": "application/vnd.apache.parquet",
    # Newline-delimited GeoJSON features, as tippecanoe reads them.
    ".geojsons": "application/x-ndjson",
}
# Named by content, a tile file never changes, but one deleted for a withdrawal shouldn't
# outlive it in caches by long. The archive and manifest change at their key.
TILE_CACHE = "public, max-age=3600"
REVALIDATE = "no-cache"
# The tile files a publish wrote: the only files under tiles/ it ever deletes.
OURS = re.compile(r"tiles/(surface|cells|areas)/[0-9]+-[0-9a-f]{16}\.(tif|parquet|geojsons)")
# Uploads at once; S3Objects' pool has room for them.
PARALLEL = 16


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(2**20):
            h.update(chunk)
    return h.hexdigest()


def stored(objects, key):
    """The object at `key`, or None."""
    objs, complete = objects.list(key)
    if not complete:
        raise RuntimeError(f"couldn't list {objects.url}{key}")
    return next((o for o in objs if o.key == key), None)


def publish(run: Path, objects, now=None) -> dict:
    """Make what's published at `objects` match `run`, one publisher at a time: upload the
    tile files the manifest doesn't name yet and the archive if what's stored isn't this
    run's, write the manifest, and delete what it no longer names. A run with no tiles left
    takes everything down. Returns what it did."""
    lock = Lock(objects, key=LOCK)
    try:
        lock.acquire()
    except Locked as e:
        raise RuntimeError(f"another run is publishing to {objects.url}: {e}") from None
    try:
        return publish_locked(run, objects, lock, now or datetime.now(UTC))
    finally:
        lock.release()


def tile_of(key):
    """The tile a tile file's key names: tiles/{kind}/{tile}-{hash}.{ext}."""
    return key.rsplit("/", 1)[1].split("-", 1)[0]


def publish_locked(run, objects, lock, now):
    got = objects.get(MANIFEST)
    old, etag = (json.loads(got[0]), got[1]) if got else ({}, None)
    built = run / "store.txt"
    # Hashed: the manifest is public, and the store's endpoint and path aren't.
    store = hashlib.sha256(built.read_bytes()).hexdigest()[:16] if built.exists() else ""
    if old.get("store", store) != store:
        raise RuntimeError(f"{objects.url} holds another store's tiles: publish elsewhere")
    counts = tiles.counts(run)
    archive = run / ARCHIVE
    if counts and not archive.exists():
        raise RuntimeError(f"{archive} is missing: the run didn't finish")

    current, uploads = {}, []
    for tile, soundings in sorted(counts.items()):
        entry = {
            "fingerprint": tiles.fp_path(run, tile).read_text().strip(),
            "soundings": soundings,
        }
        for kind in KINDS:
            path = run / tiles.TILE_FILES[kind].format(tile)
            if path.exists():
                key = f"tiles/{kind}/{tile}-{sha256(path)[:16]}{path.suffix}"
                entry[kind] = key
                uploads.append((key, path))
            elif kind != "surface":
                # A tile with no cells has no surface, but every live tile has cells and
                # areas: without them its published files would be withdrawn.
                raise RuntimeError(f"{path} is missing: the run didn't finish")
        current[str(tile)] = entry

    def keys(entries):
        return {v for e in entries.values() for k, v in e.items() if k in KINDS}

    after = keys(current)
    # A changed tile's old files stay a while; a gone tile's don't, nor its older ones.
    retired = {
        k: t for k, t in old.get("retired", {}).items() if k not in after and tile_of(k) in current
    }
    for tile, entry in old.get("tiles", {}).items():
        if tile in current:
            retired |= {k: now.isoformat() for k in keys({tile: entry}) - after}
    retired = {k: t for k, t in retired.items() if datetime.fromisoformat(t) > now - RETIRED_FOR}
    # What the bucket holds, not what the last manifest says it does.
    listed, complete = objects.list("tiles/")
    if not complete:
        raise RuntimeError(f"couldn't list {objects.url}tiles/")
    there = {o.key for o in listed}
    todo = [(k, p) for k, p in uploads if k not in there]

    def upload(kp):
        # A tile file can't clobber anything, but a run that lost the lock stops here.
        lock.check()
        objects.upload(kp[0], kp[1], TYPES[kp[1].suffix], TILE_CACHE, threads=False)

    pool = ThreadPoolExecutor(PARALLEL)
    try:
        for _ in pool.map(upload, todo):
            pass
    finally:
        # Stopped or failed, the uploads still queued don't start.
        pool.shutdown(cancel_futures=True)

    # The archive as stored, not as the last manifest says: a publish stopped between the
    # archive and the manifest leaves them apart.
    was = old.get("archive")
    live = stored(objects, ARCHIVE)
    if counts:
        digest = sha256(archive)
        replaced = not (was and live and was["sha256"] == digest and was.get("etag") == live.etag)
        if replaced:
            # A planet's archive takes an hour or two to go up. The lock is checked before
            # each part and again just before the new archive replaces the live one. That
            # replacement is conditional on the archive this run listed just now, so a run
            # that stalled past those checks can't overwrite one another run published since.
            try:
                objects.upload(
                    ARCHIVE,
                    archive,
                    TYPES[".pmtiles"],
                    REVALIDATE,
                    check=lock.check,
                    if_match=live.etag if live else None,
                    if_none_match=live is None,
                )
            except Conflict:
                raise RuntimeError(f"{objects.url}{ARCHIVE} changed while publishing") from None
            live = stored(objects, ARCHIVE)
        about = {"key": ARCHIVE, "sha256": digest, "size": live.size, "etag": live.etag}
    else:
        # Every tile withdrawn: nothing of them stays published.
        replaced = live is not None
        if replaced:
            lock.check()
            objects.delete(ARCHIVE)
        about = None

    credits = run / "credits.txt"
    manifest = {
        "published": now.isoformat(),
        "store": store,
        "license": LICENSE,
        "attribution": credits.read_text().strip() if credits.exists() else "",
        "archive": about,
        "tiles": current,
        "retired": dict(sorted(retired.items())),
    }
    body = (json.dumps(manifest, indent=1) + "\n").encode()
    lock.check()
    try:
        # The lock already keeps a second publisher out; this catches one that ignored it.
        objects.put(
            MANIFEST,
            body,
            if_match=etag,
            if_none_match=etag is None,
            cache_control=REVALIDATE,
            content_type="application/json",
        )
    except Conflict:
        raise RuntimeError(f"{objects.url}{MANIFEST} changed while publishing") from None

    # Whatever no manifest names now goes: retired files past their time, a gone tile's,
    # and what a publish that stopped early or a delete that failed left behind. Files
    # this run uploaded are all named.
    keep = after | retired.keys()
    deleted = sorted(k for k in there - keep if OURS.fullmatch(k))
    for key in deleted:
        # Another publisher may have taken a lapsed lock and named these since.
        lock.check()
        objects.delete(key)
    return {
        "uploaded": len(todo),
        "bytes": sum(p.stat().st_size for _, p in todo)
        + (about["size"] if replaced and about else 0),
        "kept": len(uploads) - len(todo),
        "archive": "replaced" if replaced and about else "deleted" if replaced else "kept",
        "deleted": len(deleted),
    }
