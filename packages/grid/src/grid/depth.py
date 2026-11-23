"""Depth COG: a `grid tiles` run's depths as one cloud-optimized GeoTIFF, for QGIS.

`build(run)` copies each tile's depth band to `depth/{tile}.tif`, rounded to the centimetre,
for each tile whose surface or this module's code changed since it was copied, removes those
whose surface is gone, and merges them into `depth.tif`: float32 metres, positive down, NODATA
where there are none, with averaged overviews, so QGIS reads only the part of the planet it
draws. Colours and contours are QGIS's to draw: see qgis/depth-chart.qgs.

It holds the run directory's lock, as `grid tiles` does, so it never reads surfaces a build is
rewriting. With `objects`, it then uploads `depth.tif` there, if it changed, holding the lock
`grid tiles --publish` takes there, and only from the run whose tiles are published there.
"""

import fcntl
import hashlib
import json
import logging
import multiprocessing
import os
import signal
import subprocess
import threading
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path

import numpy as np
import rasterio
import rasterio.shutil
from rasterio.windows import Window

from . import publish, surface, tiles
from .catalog import Lock, Locked
from .objects import Conflict

log = logging.getLogger(__name__)

# The surface's σ is a few decimetres where the data is good: digits past the centimetre are
# noise, and dropping them lets the merged file compress better.
DECIMALS = 2
PARALLEL = 4
# Rows copied at once: about 100 MB for a 5,400-column tile, where a whole band takes 0.5 GB.
STRIP = 1024
# The merge's block cache: the planet's merge peaked at 1.3 GB with it.
MERGE_CACHE = 2048 * 2**20
# The process that started this copy worker, if it is one.
_parent = None


def copy_tile(surface_path: Path, out: Path):
    """Write `surface_path`'s depth band, rounded, to `out`, through a temporary file, so a
    copy is never left half written under its own name."""
    part = out.with_name(f"{out.name}.{os.getpid()}.tmp")
    with rasterio.open(surface_path) as src, rasterio.open(
        part, "w", driver="GTiff", width=src.width, height=src.height, count=1,
        dtype="float32", nodata=surface.NODATA, crs=src.crs, transform=src.transform,
        tiled=True, blockxsize=512, blockysize=512, compress="deflate", predictor=3,
        sparse_ok=True,
    ) as dst:  # fmt: skip
        for r0 in range(0, src.height, STRIP):
            window = Window(0, r0, src.width, min(STRIP, src.height - r0))
            depth = src.read(1, window=window, masked=True)
            empty = np.ma.getmaskarray(depth)
            if empty.all():
                continue
            values = np.where(empty, surface.NODATA, np.round(depth.data, DECIMALS))
            dst.write(values.astype(np.float32), 1, window=window)
    if _parent is not None and os.getppid() != _parent:
        # Its parent is gone, and its lock with it: another run may own this directory now.
        part.unlink()
        os._exit(1)
    part.replace(out)


def check_published(run: Path, objects) -> dict:
    """What's published at `objects`, if it's `run`'s tiles as `grid tiles --publish` last
    published them there: the same tiles, of the same inputs. A run that failed or stopped
    since, or another run, may hold surfaces of soundings withdrawn there."""
    got = objects.get(publish.MANIFEST)
    manifest = json.loads(got[0]) if got else {}
    publish.check_store(run, objects, manifest)
    there = {t: e["fingerprint"] for t, e in manifest.get("tiles", {}).items()}
    here = {str(t): tiles.fp_path(run, t).read_text().strip() for t in tiles.counts(run)}
    if here != there:
        raise RuntimeError(
            f"{run} isn't what `grid tiles --publish` last published to {objects.url}: "
            "nothing published"
        )
    return manifest


def build(run: Path, workers: int = PARALLEL, objects=None, take_down=False) -> dict:
    """Bring `run`'s `depth.tif` up to date with its surfaces, copying `workers` tiles at
    once, and with `objects`, publish it there. A tile that can't be copied doesn't stop the
    others or the merge of those that are; the call raises once they're done, naming it, and
    publishes nothing. A run with no tiles left takes the published one down only with
    `take_down`."""
    run = run.resolve()
    if not (run / "surface").is_dir():
        # Rather than take a missing directory for one emptied and delete every copy.
        raise FileNotFoundError(f"{run / 'surface'} is missing: not a `grid tiles` run")
    with open(run / ".lock", "w") as lock, tiles.terminating():
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError(f"another `grid tiles` or `grid depth` is using {run}") from None
        if objects is not None:
            if not tiles.counts(run):
                # As `grid tiles` asks: a catalog read empty by mistake looks the same.
                if not take_down:
                    raise RuntimeError(f"{run} has no tiles; --take-down unpublishes depth.tif")
                if any((run / "surface").glob("*.tif")):
                    # Surfaces with no tile list: not a run `grid tiles` emptied.
                    raise RuntimeError(f"{run} has surfaces but no tiles.txt: nothing published")
            # Before the copies and merge, as well as under the publish lock.
            check_published(run, objects)
        done = build_locked(run, workers)
        if done["failed"]:
            raise RuntimeError(f"couldn't copy {len(done['failed'])} tiles: {done['failed']}")
        if objects is not None:
            done["published"] = publish_depth(run, objects)
    return done


def exit_with(parent: int):
    """In a copy worker: exit once `parent` has, so none writes on after its lock is gone."""
    global _parent
    _parent = parent

    def watch():
        while os.getppid() == parent:
            time.sleep(1)
        os._exit(1)

    threading.Thread(target=watch, daemon=True).start()


def copied_from(surface_path: Path, code: str) -> str:
    """What a copy of `surface_path` by `code` is current for."""
    st = surface_path.stat()
    return f"{code}:{st.st_size}:{st.st_mtime_ns}"


def build_locked(run: Path, workers: int) -> dict:
    # The default is 5% of the machine's memory per process.
    os.environ["GDAL_CACHEMAX"] = os.environ.get("GDAL_CACHEMAX") or tiles.GDAL_CACHE_MB
    surfaces = {p.stem: p for p in (run / "surface").glob("*.tif")}
    out = run / "depth"
    out.mkdir(exist_ok=True)
    # What a killed copy or merge left, the merge's overviews' scratch file too.
    for p in [*out.glob("*.tmp"), *run.glob("depth.tif.tmp*")]:
        p.unlink()
    gone = [p for p in out.glob("*.tif") if p.stem not in surfaces]
    for p in gone:
        p.unlink()
    # Each copy's surface, by its size and time as recorded, and code: a synced or restored
    # surface can be older than its copy, so newer-than isn't enough.
    record = out / "copied.json"
    copied = json.loads(record.read_text()) if record.exists() else {}
    code = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()[:16]
    want = {stem: copied_from(s, code) for stem, s in surfaces.items()}
    stale = [
        stem
        for stem in surfaces
        if copied.get(stem) != want[stem] or not (out / f"{stem}.tif").exists()
    ]
    copied = {stem: v for stem, v in copied.items() if stem in surfaces and stem not in stale}
    failed, broken = [], None
    if stale:
        # Spawned, not forked, so no worker inherits the run directory's lock.
        pool = ProcessPoolExecutor(
            workers,
            mp_context=multiprocessing.get_context("spawn"),
            initializer=exit_with,
            initargs=(os.getpid(),),
        )
        try:
            futures = {
                pool.submit(copy_tile, surfaces[stem], out / f"{stem}.tif"): stem for stem in stale
            }
            for future in as_completed(futures):
                stem, error = futures[future], future.exception()
                if isinstance(error, BrokenProcessPool):
                    # A worker died, as when killed for memory: every tile left fails with it.
                    broken = error
                    break
                if error is not None:
                    log.error("couldn't copy tile %s", stem, exc_info=error)
                    failed.append(stem)
                else:
                    copied[stem] = want[stem]
        finally:
            # A second Ctrl-C or SIGTERM waits for the tiles being copied: raised here, it
            # would free the lock with workers still writing.
            held = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
            try:
                pool.shutdown(cancel_futures=True)
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, held)
                write_json(record, copied)
    if broken is not None:
        raise broken
    # A tile that failed keeps no copy, so no older copy of it is merged.
    for stem in failed:
        (out / f"{stem}.tif").unlink(missing_ok=True)
    tifs = sorted(str(p) for p in out.glob("*.tif"))
    merged = merge(run, tifs, copied)
    return {
        "copied": len(stale) - len(failed),
        "removed": len(gone),
        "tiles": len(tifs),
        "merged": merged,
        "failed": sorted(failed),
    }


def merge(run: Path, tifs: list, copied: dict) -> bool:
    """Merge the copies into `depth.tif` unless it already holds exactly these, with these
    credits, by the record of what it was merged from. Returns whether it was written or
    removed."""
    target, record = run / "depth.tif", run / "depth" / "merged.txt"
    if not tifs:
        removed = target.exists()
        target.unlink(missing_ok=True)
        record.unlink(missing_ok=True)
        return removed
    credits_path = run / "credits.txt"
    credits = credits_path.read_text().strip() if credits_path.exists() else ""
    # A station's licence can change with no tile's surface: its credit goes in the file.
    of = hashlib.sha256(
        json.dumps([copied, credits, publish.LICENSE], sort_keys=True).encode()
    ).hexdigest()
    if target.exists() and record.exists() and record.read_text() == of:
        return False
    listing, vrt = run / "depth" / "tifs.tmp", run / "depth" / "depth.vrt.tmp"
    listing.write_text("\n".join(tifs) + "\n")
    subprocess.run(
        # Tiles' columns widen with latitude, so their resolutions differ; keep the finest.
        [
            *("gdalbuildvrt", "-q", "-overwrite", "-resolution", "highest"),
            *("-input_file_list", str(listing), str(vrt)),
        ],
        check=True,
        env={**os.environ, "GDAL_PAM_ENABLED": "NO"},
    )
    listing.unlink()
    # gdalbuildvrt skips a file it can't mosaic, such as one in another CRS, and succeeds.
    sources = vrt.read_text().count("<SourceFilename")
    if sources != len(tifs):
        raise RuntimeError(f"gdalbuildvrt mosaicked {sources} of {len(tifs)} depth tiles")
    with rasterio.open(vrt, "r+") as v:
        v.set_band_description(1, "depth")
        v.update_tags(
            LICENSE=publish.LICENSE,
            DESCRIPTION="Crowd Depth surface: depth in metres below the chart datum, positive"
            f" down, to the centimetre. {surface.NODATA:g} is no data.",
            **({"ATTRIBUTION": credits} if credits else {}),
        )
    part = run / "depth.tif.tmp"
    # In this process, not a gdal_translate of its own, so it can't outlive the lock. A
    # planet's merge takes over an hour, and a signal waits for it.
    with rasterio.Env(GDAL_CACHEMAX=MERGE_CACHE, GDAL_NUM_THREADS="4"):
        rasterio.shutil.copy(
            vrt, part, driver="COG", compress="deflate", predictor="floating_point",
            blocksize=512, bigtiff="yes", overview_resampling="average", sparse_ok=True,
            num_threads=4,
        )  # fmt: skip
    part.replace(target)
    vrt.unlink()
    record.write_text(of)
    return True


def publish_depth(run: Path, objects) -> str:
    """Make publish.DEPTH at `objects` match `run`'s depth.tif, one publisher at a time: upload
    it if what's stored isn't this file as last uploaded there, or delete it if the run has
    none. Refuses a place another store's tiles are published at. Returns what it did."""
    lock = Lock(objects, key=publish.LOCK)
    try:
        lock.acquire()
    except Locked as e:
        raise RuntimeError(f"another run is publishing to {objects.url}: {e}") from None
    try:
        return publish_locked(run, objects, lock)
    finally:
        lock.release()


def publish_locked(run: Path, objects, lock) -> str:
    check_published(run, objects)
    key = publish.DEPTH
    path, record = run / "depth.tif", run / "depth" / "published.json"
    published = json.loads(record.read_text()) if record.exists() else {}
    live = publish.stored(objects, key)
    if not path.exists():
        if tiles.counts(run):
            # Surfaces cleared or lost, not tiles withdrawn: those take --take-down.
            raise RuntimeError(f"{run} has tiles but no depth.tif: nothing published")
        if live is None:
            return "none"
        lock.check()
        objects.delete(key)
        published.pop(objects.url, None)
        write_json(record, published)
        return "deleted"
    digest = publish.sha256(path)
    last = published.get(objects.url, {})
    if live and last.get("sha256") == digest and last.get("etag") == live.etag:
        return "kept"
    try:
        # Conditional on what was listed just now, so a run that stalled past its lock's
        # checks can't overwrite what another published since.
        objects.upload(
            key,
            path,
            publish.TYPES[".tif"],
            publish.REVALIDATE,
            check=lock.check,
            if_match=live.etag if live else None,
            if_none_match=live is None,
        )
    except Conflict:
        raise RuntimeError(f"{objects.url}{key} changed while publishing") from None
    live = publish.stored(objects, key)
    if live is None:
        raise RuntimeError(f"{objects.url}{key} was deleted just after it was uploaded")
    published[objects.url] = {"sha256": digest, "etag": live.etag}
    write_json(record, published)
    return "uploaded"


def write_json(path: Path, value: dict):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, sort_keys=True))
    tmp.replace(path)
