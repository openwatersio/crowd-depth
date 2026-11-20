"""Rainbow chart: each tile's surface drawn as a hydrographic survey chart draws its depths.

Depth runs from dark red at 0 m through yellow and cyan to dark blue at SHALLOW_M, the
reversed jet ramp single-beam survey charts use, then darkens toward black at DEEP_M.
Drying heights are dark red, and water deeper than DEEP_M isn't drawn: crowd sounders there
are mostly lone ships' navigation sounders, good to a few percent at best. The colour is
shaded by an exaggerated hillshade, so the ridges and steps the interpolation leaves
between tracks show. A thin dark contour is drawn every CONTOUR_M down to SHALLOW_M, and
every DEEP_CONTOUR_M below it.

`render(run)` writes `rainbow/{tile}.tif`, an RGBA cloud-optimized GeoTIFF on the surface's
grid, for each tile whose surface or this module's code changed since it was drawn, removes those whose surface
is gone, and mosaics them into `rainbow.vrt`, which QGIS opens as it is. It holds the run
directory's lock, as `grid tiles` does, so it never reads surfaces a build is rewriting.
"""

import fcntl
import hashlib
import json
import logging
import math
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
from rasterio.enums import ColorInterp
from rasterio.windows import Window

from . import surface, tiles

log = logging.getLogger(__name__)

# Where the coastal data is: 99% of a typical Chesapeake tile's pixels are shoaler.
SHALLOW_M = 30.0
DEEP_M = 200.0
CONTOUR_M = 1.0
DEEP_CONTOUR_M = 10.0
# Seabed slopes are a few degrees at most: unexaggerated, a 20 m pixel's relief barely shades.
Z_FACTOR = 5.0
# How dark the hillshade can make a colour: 0 leaves the ramp flat, 1 can take it to black.
SHADE = 0.5
# The light: from the northwest, as charts and maps light relief.
AZIMUTH, ALTITUDE = 315.0, 45.0
CONTOUR_RGB = (40, 40, 40)
# Jet's dark blue at SHALLOW_M fades to this at DEEP_M.
ABYSS_RGB = (0.03, 0.03, 0.12)
# matplotlib's jet, as (position, value) stops per channel.
JET = (
    ((0, 0), (0.35, 0), (0.66, 1), (0.89, 1), (1, 0.5)),
    ((0, 0), (0.125, 0), (0.375, 1), (0.64, 1), (0.91, 0), (1, 0)),
    ((0, 0.5), (0.11, 1), (0.34, 1), (0.65, 0), (1, 0)),
)
PARALLEL = 4
# Rows drawn at once: drawing takes about 180 bytes a pixel, 250 MB for a 5,400-column strip.
STRIP = 256
# Metres per degree of latitude, and of longitude at the equator, as the surface grids them.
M_PER_DEG = surface.EARTH_M * math.pi / 180


def colours(depth):
    """RGB in [0, 1] for each depth: jet from dark red at 0 m and shoaler to dark blue at
    SHALLOW_M, then toward ABYSS_RGB at DEEP_M."""
    t = 1 - np.clip(depth / SHALLOW_M, 0, 1)
    rgb = np.stack([np.interp(t, *zip(*stops)).astype(np.float32) for stops in JET], axis=-1)
    deep = np.clip((depth - SHALLOW_M) / (DEEP_M - SHALLOW_M), 0, 1)[..., None]
    return rgb * (1 - deep) + np.float32(ABYSS_RGB) * deep


def hillshade(depth, dx, dy, azimuth=AZIMUTH, altitude=ALTITUDE):
    """Lambertian shade in [0, 1] of the seabed lit from `azimuth` (degrees clockwise from
    north) at `altitude`, `dx` and `dy` its pixel size in metres."""
    south, east = np.gradient(-depth * Z_FACTOR, dy, dx)
    # The seabed's upward normal, (east, north, up), as rows run south.
    normal = np.stack([-east, south, np.ones_like(east)])
    az, alt = np.radians(azimuth), np.radians(altitude)
    light = np.array([np.sin(az) * np.cos(alt), np.cos(az) * np.cos(alt), np.sin(alt)])
    shade = np.tensordot(light, normal, axes=1) / np.linalg.norm(normal, axis=0)
    return np.clip(shade, 0, 1)


def contours(depth, valid):
    """Pixels where a contour lies between them and the next pixel east or south."""
    band = np.where(
        depth < SHALLOW_M,
        np.floor(depth / CONTOUR_M) * CONTOUR_M,
        np.floor(depth / DEEP_CONTOUR_M) * DEEP_CONTOUR_M,
    )
    edge = np.zeros(depth.shape, bool)
    for axis in (0, 1):
        step = np.diff(band, axis=axis) != 0
        both = valid.take(range(1, depth.shape[axis]), axis) & valid.take(
            range(depth.shape[axis] - 1), axis
        )
        if axis == 0:
            edge[:-1] |= step & both
        else:
            edge[:, :-1] |= step & both
    return edge


def draw(depth, valid, dx, dy):
    """The RGBA chart of a depth raster, as uint8 bands first."""
    valid = valid & (depth <= DEEP_M)
    # Empty pixels take their neighbours' slope from 0 m otherwise; a pixel beside one is
    # shaded as flat.
    filled = np.where(valid, depth, np.nan)
    flat = np.sin(np.radians(ALTITUDE))
    shade = np.nan_to_num(hillshade(filled, dx, dy), nan=flat)
    rgb = colours(np.where(valid, depth, 0)) * (1 - SHADE + SHADE * shade[..., None])
    rgb[contours(depth, valid)] = np.array(CONTOUR_RGB) / 255
    alpha = np.where(valid, 255, 0).astype(np.uint8)
    return np.concatenate([np.moveaxis((rgb * 255).round().astype(np.uint8), -1, 0), alpha[None]])


def render_tile(surface: Path, out: Path):
    """Draw a surface's chart to `out` a strip of rows at a time, each read with a row of its
    neighbours' for the slope and contours across its edges. Written to temporary files and
    renamed, so a chart is never left half written under its own name."""
    tmp, part = out.with_name(out.stem + ".draw.tmp"), out.with_name(out.name + ".tmp")
    with rasterio.open(surface) as src:
        rows, cols, t = src.height, src.width, src.transform
        lat = t.f + t.e * rows / 2
        dx, dy = t.a * M_PER_DEG * np.cos(np.radians(lat)), -t.e * M_PER_DEG
        with rasterio.open(
            tmp, "w", driver="GTiff", width=cols, height=rows, count=4, dtype="uint8",
            crs=src.crs, transform=t, tiled=True, blockxsize=512, blockysize=512,
            compress="deflate", photometric="RGB", sparse_ok=True,
        ) as dst:  # fmt: skip
            dst.colorinterp = [
                ColorInterp.red,
                ColorInterp.green,
                ColorInterp.blue,
                ColorInterp.alpha,
            ]
            for r0 in range(0, rows, STRIP):
                r1 = min(r0 + STRIP, rows)
                a, b = max(r0 - 1, 0), min(r1 + 1, rows)
                depth = src.read(1, window=Window(0, a, cols, b - a), masked=True)
                valid = ~np.ma.getmaskarray(depth)
                if not valid[r0 - a : r0 - a + r1 - r0].any():
                    continue
                image = draw(depth.data, valid, dx, dy)[:, r0 - a : r0 - a + r1 - r0]
                dst.write(image, window=Window(0, r0, cols, r1 - r0))
    rasterio.shutil.copy(tmp, part, driver="COG", compress="deflate", overview_resampling="average")
    part.replace(out)
    tmp.unlink()


def render(run: Path, workers: int = PARALLEL) -> dict:
    """Bring `run`'s rainbow tiles and `rainbow.vrt` up to date with its surfaces, drawing
    `workers` tiles at once. A tile that can't be drawn doesn't stop the others or the
    mosaic of those that are; the call raises once they're done, naming it."""
    run = run.resolve()
    if not (run / "surface").is_dir():
        # Rather than take a missing directory for one emptied and delete every chart.
        raise FileNotFoundError(f"{run / 'surface'} is missing: not a `grid tiles` run")
    with open(run / ".lock", "w") as lock, tiles.terminating():
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError(f"another `grid tiles` or `grid rainbow` is using {run}") from None
        done = render_locked(run, workers)
    if done["failed"]:
        raise RuntimeError(f"couldn't draw {len(done['failed'])} tiles: {done['failed']}")
    return done


def exit_with(parent: int):
    """In a draw worker: exit once `parent` has, so none draws on after its lock is gone."""

    def watch():
        while os.getppid() == parent:
            time.sleep(1)
        os._exit(1)

    threading.Thread(target=watch, daemon=True).start()


def drawn_from(surface: Path, code: str) -> str:
    """What a chart of `surface` drawn by `code` is current for."""
    st = surface.stat()
    return f"{code}:{st.st_size}:{st.st_mtime_ns}"


def render_locked(run: Path, workers: int) -> dict:
    # The default is 5% of the machine's memory per process, which one tile's COG copy fills.
    os.environ["GDAL_CACHEMAX"] = os.environ.get("GDAL_CACHEMAX") or tiles.GDAL_CACHE_MB
    surfaces = {p.stem: p for p in (run / "surface").glob("*.tif")}
    out = run / "rainbow"
    out.mkdir(exist_ok=True)
    # What a killed draw left.
    for p in out.glob("*.tmp"):
        p.unlink()
    gone = [p for p in out.glob("*.tif") if p.stem not in surfaces]
    for p in gone:
        p.unlink()
    # Each chart's surface and code, by content and not by time, as a synced or restored
    # surface can be older than its chart.
    record = out / "drawn.json"
    drawn = json.loads(record.read_text()) if record.exists() else {}
    code = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()[:16]
    want = {stem: drawn_from(s, code) for stem, s in surfaces.items()}
    stale = [
        stem
        for stem in surfaces
        if drawn.get(stem) != want[stem] or not (out / f"{stem}.tif").exists()
    ]
    drawn = {stem: v for stem, v in drawn.items() if stem in surfaces and stem not in stale}
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
                pool.submit(render_tile, surfaces[stem], out / f"{stem}.tif"): stem
                for stem in stale
            }
            for future in as_completed(futures):
                stem, error = futures[future], future.exception()
                if isinstance(error, BrokenProcessPool):
                    # A worker died, as when killed for memory: every tile left fails with it.
                    broken = error
                    break
                if error is not None:
                    log.error("couldn't draw tile %s", stem, exc_info=error)
                    failed.append(stem)
                else:
                    drawn[stem] = want[stem]
        finally:
            # A second Ctrl-C or SIGTERM waits for the tiles being drawn: raised here, it would
            # free the lock with workers still drawing.
            held = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
            try:
                pool.shutdown(cancel_futures=True)
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, held)
                write_record(record, drawn)
    if broken is not None:
        raise broken
    # A tile that failed keeps no chart, so no older chart of it shows.
    for stem in failed:
        (out / f"{stem}.tif").unlink(missing_ok=True)
    tifs = sorted(str(p) for p in out.glob("*.tif"))
    vrt = run / "rainbow.vrt"
    if tifs:
        listing, tmp = out / "tifs.tmp", run / "rainbow.vrt.tmp"
        listing.write_text("\n".join(tifs) + "\n")
        subprocess.run(
            # Tiles' columns widen with latitude, so their resolutions differ; keep the finest.
            [
                *("gdalbuildvrt", "-q", "-overwrite", "-resolution", "highest"),
                *("-input_file_list", str(listing), str(tmp)),
            ],
            check=True,
            env={**os.environ, "GDAL_PAM_ENABLED": "NO"},
        )
        tmp.replace(vrt)
        listing.unlink()
    else:
        vrt.unlink(missing_ok=True)
    return {
        "rendered": len(stale) - len(failed),
        "removed": len(gone),
        "tiles": len(tifs),
        "failed": sorted(failed),
    }


def write_record(path: Path, drawn: dict):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(drawn, sort_keys=True))
    tmp.replace(path)
