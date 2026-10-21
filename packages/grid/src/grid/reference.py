"""Surveyed references for calibration: S-102 and BlueTopo, sampled at calibration pixels.

Each calibration pixel with soundings is sampled once: the mean of reference cells
within about 10 m of its centre, their relief (highest minus lowest) within about
20 m, which picks flat seabed, and the reference's own uncertainty there. Depths are
below MLLW, the chart datum tides reduce US soundings to: S-102 is published on it,
and BlueTopo's NAVD88 heights are taken to it with the nearest CO-OPS gauge's
separation, good to about 0.1 m. Each source is sampled at every pixel; where several
cover one, calibration takes the one with the least uncertainty.

A source is `s102` or `bluetopo`, read from NOAA's buckets through each one's tile
scheme, or a local file or directory of their rasters. NOAA's rasters are downloaded
whole into the shared cache (cache.py) on first use, keyed by the SHA-256 the tile
scheme gives, and checked against it.
"""

import contextlib
import functools
import hashlib
import http.client
import logging
import os
import re
import shutil
import sqlite3
import tempfile
import time
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
import rasterio.errors
from rasterio.warp import transform, transform_bounds
from rasterio.windows import Window
from scipy.ndimage import maximum_filter, minimum_filter, uniform_filter

from . import cache, tide
from .catalog import checkpoint
from .cells import BASE, k_for

log = logging.getLogger(__name__)

# Bucket, the tile scheme's key prefix, and its columns of tile links and their SHA-256.
CATALOGS = {
    "s102": (
        "https://noaa-s102-pds.s3.amazonaws.com",
        "ed3.0.0/_CATALOG/Navigation_Tile_Scheme_",
        "S102V30",
        "S102V30_SHA256",
    ),
    "bluetopo": (
        "https://noaa-ocs-nationalbathymetry-pds.s3.amazonaws.com",
        "BlueTopo/_BlueTopo_Tile_Scheme/BlueTopo_Tile_Scheme_",
        "GeoTIFF_Link",
        "GeoTIFF_SHA256_Checksum",
    ),
}
# A download that fails partway raises either.
FETCH_ERRORS = (OSError, http.client.HTTPException)
MEAN_M = 10
RELIEF_M = 20
BLOCK = 2048  # reference cells a side read at once
MISMATCH_RETRY_S = 86400


def catalog(name):
    """A catalog's newest tile scheme, from the cache once fetched: its path, table, link
    and checksum columns, and whether it is stale. With the bucket out of reach, or its
    newest scheme damaged, it is the newest readable one cached, and stale: a newer one
    may cover more. A cached scheme that isn't a whole database is removed. A whole one
    NOAA changed the shape of fails the run when it is the newest the bucket lists, and
    is passed over when the bucket can't be listed."""
    bucket, prefix, column, checksum = CATALOGS[name]
    try:
        with urllib.request.urlopen(f"{bucket}/?list-type=2&prefix={prefix}", timeout=60) as r:
            key = max(re.findall(r"<Key>([^<]+\.gpkg)</Key>", r.read().decode()))
        path = cache.path("reference", name, "catalogs", key.rsplit("/", 1)[-1])
        # A damaged copy of the newest scheme is downloaded again.
        if path.exists():
            try:
                gpkg_table(path)
            except (ValueError, sqlite3.DatabaseError) as e:
                if damaged(e):
                    log.warning("reference: %s damaged (%s); downloading again", path.name, e)
                    path.unlink(missing_ok=True)
        if not path.exists():
            try:
                download(f"{bucket}/{key}", path)
            except FETCH_ERRORS:
                # A cache this run can't write to: the scheme goes in the run's own
                # directory. A download that failed fails again, and lands below.
                path = Path(scratch().name, path.name)
                download(f"{bucket}/{key}", path)
    except (*FETCH_ERRORS, ValueError) as e:
        error = e
    else:
        try:
            return path, gpkg_table(path), column, checksum, False
        except sqlite3.DatabaseError as e:
            if not damaged(e):
                raise
            error = e
    for path in reversed(cached_catalogs(name)):
        try:
            table = gpkg_table(path)
        except (OSError, ValueError, sqlite3.DatabaseError) as e:
            if damaged(e):
                log.warning("reference: %s damaged (%s); removed", path.name, e)
                with contextlib.suppress(OSError):
                    path.unlink()
            else:
                log.warning("reference: %s unreadable (%s); skipped", path.name, e)
            continue
        log.warning("reference: %s tile scheme not fetched (%s); using %s", name, error, path.name)
        return path, table, column, checksum, True
    raise error


def damaged(e):
    """Whether a tile scheme's error is a file that isn't a whole database, not a passing
    fault or a scheme of another shape."""
    return isinstance(e, sqlite3.DatabaseError) and not isinstance(e, sqlite3.OperationalError)


@functools.cache
def scratch():
    """The run's own directory, removed when it exits."""
    return tempfile.TemporaryDirectory(dir=os.environ.get("GRID_TEMP_DIR") or None)


def cached_catalogs(name):
    """A source's cached tile schemes, oldest first: their names carry their date."""
    return sorted(cache.path("reference", name, "catalogs").glob("*.gpkg"))


def gpkg_table(path):
    """A tile scheme's table, once the whole file reads as a database."""
    # SQLite takes an empty file for an empty database.
    if not path.stat().st_size:
        raise sqlite3.DatabaseError(f"{path.name} is empty")
    with contextlib.closing(sqlite3.connect(path)) as db:
        if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise sqlite3.DatabaseError(f"{path.name} is damaged")
        [(table,)] = db.execute("SELECT table_name FROM gpkg_contents").fetchall()
    return table


def download(url, entry, sha=None):
    """Download `url` into the cache as `entry`, whole: as long as the server says, and
    with the SHA-256 given, if one is."""
    digest, size = hashlib.sha256(), 0
    with cache.writing(entry) as tmp, urllib.request.urlopen(url, timeout=300) as r:
        with open(tmp, "wb") as f:
            while chunk := r.read(2**20):
                digest.update(chunk)
                f.write(chunk)
                size += len(chunk)
        # A connection that drops early ends the body without an error.
        expected = r.headers.get("Content-Length")
        if expected is not None and int(expected) != size:
            raise OSError(f"{size} bytes of {expected}")
        if sha and digest.hexdigest() != sha:
            raise Mismatch(f"SHA-256 {digest.hexdigest()}, catalog gives {sha}")


class Mismatch(ValueError):
    """A raster that isn't the one its tile scheme lists."""


# Rasters that couldn't be cached this run, and what stands for each: its URL, read
# remotely, or None for one that isn't what its scheme lists. Either way it isn't
# downloaded again for every 1° tile it touches.
uncached = {}


def fetch(name, link, sha):
    """A catalog raster's path in the cache, downloaded and checked against its SHA-256 on
    first use; its URL through /vsicurl, read remotely, when it can't be; None when the
    download isn't the raster its checksum names, so its tiles wait for it."""
    remote = f"/vsicurl/{link}"
    sha = (sha or "").lower()
    # The checksum names the entry's folder, so it must be one.
    if not re.fullmatch("[0-9a-f]{64}", sha):
        return remote
    if link in uncached:
        return uncached[link]
    path = cache.path("reference", name, sha, link.rsplit("/", 1)[-1])
    # One this user can't read is a miss, like a missing one.
    if os.access(path, os.R_OK):
        return str(path)
    # A raster found unlike its checksum is tried again a day later, not every run: NOAA
    # may list a raster before uploading it, or upload it before listing it.
    mismatch = path.with_name(path.name + ".mismatch")
    with contextlib.suppress(OSError):
        # Either way: a clock ahead of this one may have written it.
        if abs(time.time() - mismatch.stat().st_mtime) < MISMATCH_RETRY_S:
            log.warning("reference: %s skipped, unlike its checksum a day ago", link)
            uncached[link] = None
            return None
    try:
        download(link, path, sha)
    except Mismatch as e:
        log.warning("reference: %s skipped for a day, unlike its checksum (%s)", link, e)
        cache.write_json(mismatch, str(e))
        uncached[link] = None
        return None
    except FETCH_ERRORS as e:
        # One that didn't match before isn't read unchecked now.
        if mismatch.exists():
            log.warning("reference: %s skipped, unlike its checksum before (%s)", link, e)
            uncached[link] = None
            return None
        log.warning("reference: %s not cached (%s); read remotely", link, e)
        uncached[link] = remote
        return remote
    with contextlib.suppress(OSError):
        mismatch.unlink(missing_ok=True)
    log.info("reference: cached %s", link)
    return str(path)


def prune():
    """Remove cached rasters the newest cached tile scheme of their source doesn't list,
    and older tile schemes; returns how many entries."""
    removed = 0
    for name, (*_, column, checksum) in CATALOGS.items():
        schemes = cached_catalogs(name)
        if not schemes:
            continue
        try:
            table = gpkg_table(schemes[-1])
        except (OSError, ValueError, sqlite3.DatabaseError) as e:
            log.warning("reference: %s unreadable (%s); nothing pruned", schemes[-1].name, e)
            continue
        with contextlib.closing(sqlite3.connect(schemes[-1])) as db:
            keep = {
                sha.lower()
                for (sha,) in db.execute(
                    f'SELECT "{checksum}" FROM "{table}" WHERE "{checksum}" IS NOT NULL'
                )
            }
        # A scheme with no checksums, or a renamed column (which SQLite reads as a string),
        # would otherwise prune every raster.
        if not keep or not all(re.fullmatch("[0-9a-f]{64}", sha) for sha in keep):
            log.warning("reference: %s has no checksums; nothing pruned", schemes[-1].name)
            continue
        for old in schemes[:-1]:
            old.unlink(missing_ok=True)
            removed += 1
        for entry in cache.path("reference", name).iterdir():
            if entry.is_dir() and entry.name != "catalogs" and entry.name not in keep:
                shutil.rmtree(entry, ignore_errors=True)
                removed += 1
    return removed


def rasters(source, box, catalogs, lon=None, lat=None):
    """The rasters of `source` that may cover a (west, south, east, north) box, and the
    boxes of catalog rows with no link yet: tiles still to come. Given points, only the
    catalog's rasters whose footprint holds one, as each is downloaded whole."""
    if source not in CATALOGS:
        path = Path(source)
        files = [path] if path.is_file() else sorted(path.rglob("*"))
        found = [str(p) for p in files if p.suffix.lower() in (".tif", ".tiff", ".h5")]
        # A path not mounted yet would otherwise record every pixel as uncovered for good.
        if not found:
            raise FileNotFoundError(f"no reference rasters at {source}")
        return found, []
    if source not in catalogs:
        catalogs[source] = catalog(source)
    path, table, column, checksum, _ = catalogs[source]
    w, s, e, n = box
    with contextlib.closing(sqlite3.connect(path)) as db:
        # A checksum column NOAA renamed is no checksum: those rasters are read remotely.
        columns = {c for _, c, *_ in db.execute(f'PRAGMA table_info("{table}")')}
        sha = f't."{checksum}"' if checksum in columns else "NULL"
        links = db.execute(
            f"""SELECT t."{column}", {sha}, r.minx, r.miny, r.maxx, r.maxy FROM "{table}" t
            JOIN "rtree_{table}_geom" r ON r.id = t.fid
            WHERE r.minx < ? AND r.maxx > ? AND r.miny < ? AND r.maxy > ? ORDER BY 1""",
            [e, w, n, s],
        ).fetchall()

    def holds_point(minx, miny, maxx, maxy):
        # A margin for a raster's own bounds, transformed from its grid, past the footprint.
        m = 0.01
        return lon is None or bool(
            ((lon >= minx - m) & (lon < maxx + m) & (lat >= miny - m) & (lat < maxy + m)).any()
        )

    found = [fetch(source, link, sha) for link, sha, *b in links if link and holds_point(*b)]
    return found, [bounds for link, _, *bounds in links if not link]


def coops_separation(gauges=None, datums=None):
    """A function giving MLLW's height above NAVD88 at the CO-OPS gauge nearest a point
    that has both, within tide.GAUGE_KM."""
    gauges = gauges or tide.coops_gauges()
    datums = datums or gauge_datums
    known = {}

    lons = np.radians([g["lon"] for g in gauges])
    lats = np.radians([g["lat"] for g in gauges])

    def at(lon, lat):
        lon, lat = np.radians(lon), np.radians(lat)
        h = (
            np.sin((lats - lat) / 2) ** 2
            + np.cos(lat) * np.cos(lats) * np.sin((lons - lon) / 2) ** 2
        )
        km = 2 * tide.EARTH_KM * np.arcsin(np.sqrt(h))
        for j in np.argsort(km):
            if km[j] > tide.GAUGE_KM:
                return None
            gid = gauges[j]["id"]
            if gid not in known:
                known[gid] = datums(gid)
            if known[gid] is not None:
                return known[gid]
        return None

    return at


def gauge_datums(gauge):
    """MLLW above NAVD88 at a CO-OPS gauge, or None if it lacks either."""
    body = tide._get(
        f"{tide.COOPS}/mdapi/prod/webapi/stations/{gauge}/datums.json", {"units": "metric"}
    )
    d = {x["name"]: x["value"] for x in body.get("datums") or [] if x.get("value") is not None}
    return d["MLLW"] - d["NAVD88"] if "MLLW" in d and "NAVD88" in d else None


def kind(src):
    """How a raster's band 1 becomes depth below MLLW: 'depth', 'navd88', or None."""
    if src.driver == "S102":
        return "depth" if src.tags().get("VERTICAL_DATUM_ABBREV") == "MLLW" else None
    if "navd88" in src.tags().get("VERTICALDATUMWKT", "").lower():
        return "navd88"
    return None


def sample(con, sources, separation=None):
    """Sample each source at the calibration pixels (temp table `cal_obs`) it hasn't been
    sampled at, a tile at a time, so memory follows a tile's pixels."""

    def shift_at(lon, lat):
        # MLLW above NAVD88, from CO-OPS only once a NAVD88 raster needs it.
        nonlocal separation
        separation = separation or coops_separation()
        return separation(lon, lat)

    catalogs, total, found = {}, 0, 0
    # A stalled read fails rather than holding the store's lock for ever.
    http = {"GDAL_HTTP_TIMEOUT": 60, "GDAL_HTTP_MAX_RETRY": 3, "GDAL_HTTP_RETRY_DELAY": 5}
    with rasterio.Env(**http):
        for name in sources:
            tiles = con.execute(
                """SELECT DISTINCT tile_id FROM (SELECT DISTINCT tile_id, py, px FROM cal_obs
                  EXCEPT SELECT tile_id, py, px FROM lake.reference_pixels WHERE source = $name)
                ORDER BY 1""",
                {"name": name},
            ).fetchall()
            for (tile,) in tiles:
                n, got = sample_tile(con, tile, name, catalogs, shift_at)
                total, found = total + n, found + got
                checkpoint(con)
    log.info("reference: %d pixel samples, %d with a depth", total, found)
    return total


def sample_tile(con, tile, name, catalogs, shift_at):
    """Sample one source at one tile's pixels it hasn't been sampled at. Pixels it doesn't
    cover are recorded with no depth, so they aren't tried again; if one of its rasters
    there was skipped, none of the tile is kept, and it is all tried again."""
    px = con.execute(
        """SELECT DISTINCT py, px FROM cal_obs WHERE tile_id = $tile
        EXCEPT SELECT py, px FROM lake.reference_pixels WHERE tile_id = $tile AND source = $name""",
        {"tile": tile, "name": name},
    ).fetchnumpy()
    lat0, lon0 = tile // 360 - 90, tile % 360 - 180
    lat = lat0 + (px["py"] + 0.5) * 2 / BASE
    lon = lon0 + (px["px"] + 0.5) * 2 * k_for(lat0) / BASE
    depth, relief, unc = (np.full(len(lat), np.nan) for _ in range(3))
    paths, pending = rasters(name, (lon0, lat0, lon0 + 1, lat0 + 1), catalogs, lon, lat)
    # A raster that didn't match its checksum is skipped, like one that can't be read.
    complete = None not in paths
    paths = [p for p in paths if p]
    # Finest first, so a 4 m harbour tile wins over the 16 m tile around it.
    for path in sorted(paths, key=resolution):
        try:
            complete &= sample_raster(path, lon, lat, depth, relief, unc, shift_at)
        except (rasterio.errors.RasterioError, OSError) as e:
            # One unreadable tile is tried again next run, not the end of this one.
            log.warning("reference: %s unreadable (%s); skipped", path, e)
            complete = False
    # If any raster that may cover the tile couldn't be read, nothing is kept: a coarse
    # tile's value would otherwise stand for good where a finer one failed.
    if not complete:
        return 0, 0
    # A tile still to come holds back only the pixels it covers that nothing else did.
    keep = np.ones(len(lat), bool)
    for w, s, e, n in pending:
        keep &= ~((lon >= w) & (lon < e) & (lat >= s) & (lat < n) & np.isnan(depth))
    # A stale tile scheme may lack tiles a newer one has: what it doesn't cover is tried
    # again once the bucket answers, not recorded as uncovered.
    if name in catalogs and catalogs[name][-1]:
        keep &= ~np.isnan(depth)
    con.execute("BEGIN")
    con.register(
        "ref_np",
        {
            "py": px["py"][keep],
            "px": px["px"][keep],
            "depth": depth[keep],
            "relief": relief[keep],
            "uncertainty": unc[keep],
        },
    )
    con.execute(
        """INSERT INTO lake.reference_pixels SELECT $tile, py, px,
          CASE WHEN isnan(depth) THEN NULL ELSE depth END,
          CASE WHEN isnan(relief) THEN NULL ELSE relief END,
          CASE WHEN isnan(uncertainty) THEN NULL ELSE uncertainty END, $name FROM ref_np""",
        {"tile": tile, "name": name},
    )
    con.unregister("ref_np")
    con.execute("COMMIT")
    return int(keep.sum()), int((~np.isnan(depth)).sum())


def resolution(path):
    """A raster's cell size, from its header; unreadable ones go last, to be skipped there."""
    try:
        with rasterio.open(path, **open_options(path)) as src:
            return abs(src.res[0])
    except (rasterio.errors.RasterioError, OSError):
        return float("inf")


def open_options(path):
    # S-102 reads as depths below its datum only when asked to.
    return {"DEPTH_OR_ELEVATION": "DEPTH"} if path.lower().endswith(".h5") else {}


def sample_raster(path, lon, lat, depth, relief, unc, shift_at):
    """Fill the pixels one raster covers that no earlier raster did. A raster on a datum
    this build doesn't read never will be, so it is left out without holding its tile
    back. False when it can't be used now, with no gauge datums near; one that can't be
    read raises. Either way the tile is tried again."""
    with rasterio.open(path, **open_options(path)) as src:
        how = kind(src)
        if how is None:
            log.warning("reference: %s has no vertical datum this build reads; skipped", path)
            return True
        w, s, e, n = transform_bounds(src.crs, "EPSG:4326", *src.bounds)
        todo = np.flatnonzero((lon >= w) & (lon < e) & (lat >= s) & (lat < n) & np.isnan(depth))
        if not len(todo):
            return True
        shift = 0.0
        if how == "navd88":
            shift = shift_at((w + e) / 2, (s + n) / 2)
            if shift is None:
                # The lookup can fail for now (CO-OPS down), so the tile is tried again.
                log.warning("reference: no gauge datums near %s; skipped", path)
                return False
        x, y = transform("EPSG:4326", src.crs, lon[todo], lat[todo])
        rows, cols = rasterio.transform.rowcol(src.transform, x, y)
        rows, cols = np.asarray(rows), np.asarray(cols)
        inside = (rows >= 0) & (rows < src.height) & (cols >= 0) & (cols < src.width)
        todo, rows, cols = todo[inside], rows[inside], cols[inside]
        res = abs(src.res[0])
        # Cells of a raster in degrees, measured in metres at its middle.
        if src.crs.is_geographic:
            res *= 111320 * np.cos(np.radians((s + n) / 2))
        near = max(1, round(RELIEF_M / res))
        mean_size = 2 * max(1, round(MEAN_M / res)) + 1
        blocks = (rows // BLOCK) * (src.width // BLOCK + 1) + cols // BLOCK
        for b in np.unique(blocks):
            sel = blocks == b
            r0 = max(0, (rows[sel].min() // BLOCK) * BLOCK - near)
            c0 = max(0, (cols[sel].min() // BLOCK) * BLOCK - near)
            r1 = min(src.height, r0 + BLOCK + 2 * near)
            c1 = min(src.width, c0 + BLOCK + 2 * near)
            win = Window(c0, r0, c1 - c0, r1 - r0)
            z = src.read(1, window=win, masked=True).astype(float).filled(np.nan)
            u = src.read(2, window=win, masked=True).astype(float).filled(np.nan)
            if how == "navd88":
                z = shift - z
            valid = ~np.isnan(z)
            filled = np.where(valid, z, 0)
            count = uniform_filter(valid.astype(float), mean_size)
            mean = np.where(
                count > 0.5, uniform_filter(filled, mean_size) / np.maximum(count, 1e-9), np.nan
            )
            hi = maximum_filter(np.where(valid, z, -np.inf), 2 * near + 1)
            lo = minimum_filter(np.where(valid, z, np.inf), 2 * near + 1)
            rr, cc, i = rows[sel] - r0, cols[sel] - c0, todo[sel]
            got = ~np.isnan(mean[rr, cc])
            i, rr, cc = i[got], rr[got], cc[got]
            depth[i] = mean[rr, cc]
            relief[i] = hi[rr, cc] - lo[rr, cc]
            unc[i] = u[rr, cc]
    return True
