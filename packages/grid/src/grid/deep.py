"""Deep water from GEBCO's global grid, where a sounder that lost the bottom reads far too
shallow and no survey covers it.

Offshore, a sounder past its range logs junk: a steady 0.5 to 0.7 m, or stray echoes at
tens to hundreds of metres, over water a kilometre or more deep. Track QC sees a smooth
track, and with no other vessel nearby nothing contradicts it, so it publishes as a
shoal. GEBCO (15″, about 460 m) says where water is deep. A sounding is judged where the
shoalest GEBCO depth within RADIUS_PX pixels is at least DEEP_M, and rejected where it
reads shallower than RATIO of that: a seamount or bank GEBCO holds reads near its
shoalest pixel, and one too narrow for GEBCO to hold rarely rises from that deep to half
its depth. GEBCO's grid is used with attribution, as the overlay's credits give it.

The grid is a 4.2 GB zip of GeoTIFFs, downloaded once into the shared cache (cache.py) and
read through a VRT over them, a 1° tile's window at a time.
"""

import hashlib
import logging
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import from_bounds
from scipy.ndimage import maximum_filter

from . import cache

log = logging.getLogger(__name__)

# The release: a new one gets a new NAME, so it downloads beside the old one.
NAME = "gebco_2026"
# A mirror of BODC's GEBCO 2026 ice-surface GeoTIFFs, which GitHub's runners can't reach.
URL = "https://data.openwaters.io/bathymetry/mirror/gebco_2026_geotiff.zip"
SHA256 = "39bb6eb45a785101da606749a00cf0ec3217f32160d25859b48fd5db9c6d9368"
CREDIT = "GEBCO Compilation Group (2026) GEBCO 2026 Grid"
PER_DEGREE = 240
DEEP_M = 200
RATIO = 0.5
RADIUS_PX = 2


def ensure() -> Path:
    """The grid: GRID_DEEP_REFERENCE, any raster of heights in EPSG:4326 (for tests and
    trials, and credited as GEBCO all the same), or GEBCO's VRT in the cache, downloaded
    first if the cache doesn't hold it.

    The download is checked against SHA256 and unpacked into a directory of its own, renamed
    into place whole, so a run beside it reads a whole grid or none. Every step that builds
    cells or surfaces reads it, so the first such run on a machine downloads it. The zip and its GeoTIFFs
    take about 12 GB of the cache's disk while it unpacks, 7.5 GB after.
    """
    if os.environ.get("GRID_DEEP_REFERENCE"):
        return Path(os.environ["GRID_DEEP_REFERENCE"])
    vrt = cache.path("gebco", f"{NAME}.vrt")
    if vrt.exists():
        return vrt
    try:
        return download(vrt)
    except OSError as e:
        raise RuntimeError(
            f"GEBCO can't be downloaded into {vrt.parent} ({e}): point GRID_CACHE_DIR at a "
            "writable cache with 12 GB free, or GRID_DEEP_REFERENCE at a copy of the grid"
        ) from e


def download(vrt):
    if not shutil.which("gdalbuildvrt"):
        raise RuntimeError("GEBCO needs GDAL's gdalbuildvrt, which isn't on the PATH")
    folder = vrt.parent / NAME
    if folder.is_dir():
        # Unpacked by a run that stopped before its VRT: no need to download it again.
        build_vrt(vrt, folder, sorted(p.name for p in folder.glob("*.tif")))
        return vrt
    log.info("deep: downloading %s", URL)
    vrt.parent.mkdir(parents=True, exist_ok=True)
    # What a run killed partway left, up to 12 GB: no live download is a day old.
    for left in vrt.parent.glob(f".{NAME}.*"):
        if left.is_dir() and time.time() - left.stat().st_mtime > cache.STALE_PART_S:
            shutil.rmtree(left, ignore_errors=True)
    with tempfile.TemporaryDirectory(dir=vrt.parent, prefix=f".{NAME}.") as tmp:
        zipped, digest = Path(tmp) / "grid.zip", hashlib.sha256()
        # The mirror refuses urllib's own User-Agent.
        req = urllib.request.Request(URL, headers={"User-Agent": "crowd-depth-grid"})
        with urllib.request.urlopen(req, timeout=60) as r, open(zipped, "wb") as f:
            while chunk := r.read(2**24):
                digest.update(chunk)
                f.write(chunk)
        if digest.hexdigest() != SHA256:
            raise RuntimeError(
                f"{URL} isn't the GEBCO grid it should be: SHA-256 {digest.hexdigest()}"
            )
        with zipfile.ZipFile(zipped) as z:
            tifs = sorted(n for n in z.namelist() if n.endswith(".tif"))
            z.extractall(Path(tmp) / NAME, tifs)
        # A run beside this one may have put its copy in place first; either is whole.
        try:
            os.rename(Path(tmp) / NAME, folder)
        except OSError:
            if not folder.is_dir():
                raise
    build_vrt(vrt, folder, tifs)
    return vrt


def build_vrt(vrt, folder, tifs):
    with cache.writing(vrt) as out:
        subprocess.run(
            ["gdalbuildvrt", "-q", str(out), *(str(folder / n) for n in tifs)], check=True
        )


def shoalest(tiles) -> dict:
    """Columns tile_id, gy, gx, ref: for each GEBCO pixel of the tiles where water is deep,
    numbered from the tile's south-west corner, the shoalest depth within RADIUS_PX of it.
    Past the grid's edge, as at the antimeridian, reads as land and judges nothing."""
    n = PER_DEGREE + 2 * RADIUS_PX
    pad = RADIUS_PX / PER_DEGREE
    out = {"tile_id": [], "gy": [], "gx": [], "ref": []}
    with rasterio.open(ensure()) as src:
        for tile in tiles:
            lat0, lon0 = tile // 360 - 90, tile % 360 - 180
            box = from_bounds(lon0 - pad, lat0 - pad, lon0 + 1 + pad, lat0 + 1 + pad, src.transform)
            z = src.read(
                1, window=box, out_shape=(n, n), boundless=True, fill_value=0,
                resampling=Resampling.nearest,
            )  # fmt: skip
            # No data, in a raster that has any, reads as land: it judges nothing. (A
            # boundless read drops the mask, so it's matched by value.)
            if src.nodata is not None:
                z[z == src.nodata] = 0
            ref = -maximum_filter(z, size=2 * RADIUS_PX + 1)[
                RADIUS_PX:-RADIUS_PX, RADIUS_PX:-RADIUS_PX
            ]
            row, gx = np.nonzero(ref >= DEEP_M)
            out["tile_id"].append(np.full(len(gx), tile, np.int32))
            out["gy"].append((PER_DEGREE - 1 - row).astype(np.int32))  # rows run north to south
            out["gx"].append(gx.astype(np.int32))
            out["ref"].append(ref[row, gx].astype(np.float32))
    return {k: np.concatenate(v) if v else np.empty(0) for k, v in out.items()}
