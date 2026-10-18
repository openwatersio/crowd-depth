"""Surveyed references for calibration: S-102 and BlueTopo, sampled at calibration pixels.

Each calibration pixel with soundings is sampled once: the mean of reference cells
within about 10 m of its centre, their relief (highest minus lowest) within about
20 m, which picks flat seabed, and the reference's own uncertainty there. Depths are
below MLLW, the chart datum tides reduce US soundings to: S-102 is published on it,
and BlueTopo's NAVD88 heights are taken to it with the nearest CO-OPS gauge's
separation, good to about 0.1 m. Each source is sampled at every pixel; where several
cover one, calibration takes the one with the least uncertainty.

A source is `s102` or `bluetopo`, read from NOAA's buckets through each one's tile
scheme, or a local file or directory of their rasters.
"""

import contextlib
import logging
import re
import sqlite3
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
import rasterio.errors
from rasterio.warp import transform, transform_bounds
from rasterio.windows import Window
from scipy.ndimage import maximum_filter, minimum_filter, uniform_filter

from . import tide
from .cells import BASE, k_for

log = logging.getLogger(__name__)

# Bucket, the tile scheme's key prefix, and its column of tile links.
CATALOGS = {
    "s102": (
        "https://noaa-s102-pds.s3.amazonaws.com",
        "ed3.0.0/_CATALOG/Navigation_Tile_Scheme_",
        "S102V30",
    ),
    "bluetopo": (
        "https://noaa-ocs-nationalbathymetry-pds.s3.amazonaws.com",
        "BlueTopo/_BlueTopo_Tile_Scheme/BlueTopo_Tile_Scheme_",
        "GeoTIFF_Link",
    ),
}
MEAN_M = 10
RELIEF_M = 20
BLOCK = 2048  # reference cells a side read at once


def catalog(name, tmp):
    """A catalog's newest tile scheme, downloaded into `tmp`: its path, table and link column."""
    bucket, prefix, column = CATALOGS[name]
    with urllib.request.urlopen(f"{bucket}/?list-type=2&prefix={prefix}", timeout=60) as r:
        key = max(re.findall(r"<Key>([^<]+\.gpkg)</Key>", r.read().decode()))
    path = Path(tmp) / f"{name}.gpkg"
    with urllib.request.urlopen(f"{bucket}/{key}", timeout=300) as r:
        path.write_bytes(r.read())
    with contextlib.closing(sqlite3.connect(path)) as db:
        [(table,)] = db.execute("SELECT table_name FROM gpkg_contents").fetchall()
    return path, table, column


def rasters(source, box, catalogs, tmp):
    """The rasters of `source` that may cover a (west, south, east, north) box, and whether
    that's all of them: a catalog row with no link yet is a tile still to come."""
    if source not in CATALOGS:
        path = Path(source)
        files = [path] if path.is_file() else sorted(path.rglob("*"))
        return [str(p) for p in files if p.suffix.lower() in (".tif", ".tiff", ".h5")], True
    if source not in catalogs:
        catalogs[source] = catalog(source, tmp)
    path, table, column = catalogs[source]
    w, s, e, n = box
    with contextlib.closing(sqlite3.connect(path)) as db:
        links = db.execute(
            f"""SELECT "{column}" FROM "{table}" WHERE fid IN (
              SELECT id FROM "rtree_{table}_geom"
              WHERE minx < ? AND maxx > ? AND miny < ? AND maxy > ?)
            ORDER BY 1""",
            [e, w, n, s],
        ).fetchall()
    found = [f"/vsicurl/{link}" for (link,) in links if link]
    return found, len(found) == len(links)


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
    with tempfile.TemporaryDirectory() as tmp, rasterio.Env(**http):
        for name in sources:
            tiles = con.execute(
                """SELECT DISTINCT tile_id FROM (SELECT DISTINCT tile_id, py, px FROM cal_obs
                  EXCEPT SELECT tile_id, py, px FROM lake.reference_pixels WHERE source = $name)
                ORDER BY 1""",
                {"name": name},
            ).fetchall()
            for (tile,) in tiles:
                n, got = sample_tile(con, tile, name, catalogs, tmp, shift_at)
                total, found = total + n, found + got
                con.checkpoint()
    log.info("reference: %d pixel samples, %d with a depth", total, found)
    return total


def sample_tile(con, tile, name, catalogs, tmp, shift_at):
    """Sample one source at one tile's pixels it hasn't been sampled at. Pixels it doesn't
    cover are recorded with no depth, so they aren't tried again, unless one of its
    rasters there was skipped."""
    px = con.execute(
        """SELECT DISTINCT py, px FROM cal_obs WHERE tile_id = $tile
        EXCEPT SELECT py, px FROM lake.reference_pixels WHERE tile_id = $tile AND source = $name""",
        {"tile": tile, "name": name},
    ).fetchnumpy()
    lat0, lon0 = tile // 360 - 90, tile % 360 - 180
    lat = lat0 + (px["py"] + 0.5) * 2 / BASE
    lon = lon0 + (px["px"] + 0.5) * 2 * k_for(lat0) / BASE
    depth, relief, unc = (np.full(len(lat), np.nan) for _ in range(3))
    paths, complete = rasters(name, (lon0, lat0, lon0 + 1, lat0 + 1), catalogs, tmp)
    # Finest first, so a 4 m harbour tile wins over the 16 m tile around it.
    for path in sorted(paths, key=resolution):
        try:
            complete &= sample_raster(path, lon, lat, depth, relief, unc, shift_at)
        except (rasterio.errors.RasterioError, OSError) as e:
            # One unreadable tile is tried again next run, not the end of this one.
            log.warning("reference: %s unreadable (%s); skipped", path, e)
            complete = False
    keep = np.ones(len(lat), bool) if complete else ~np.isnan(depth)
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
    """Fill the pixels one raster covers that no earlier raster did. False if it was
    skipped, so the pixels it may cover are tried again."""
    with rasterio.open(path, **open_options(path)) as src:
        how = kind(src)
        if how is None:
            log.warning("reference: %s has no vertical datum this build reads; skipped", path)
            return False
        w, s, e, n = transform_bounds(src.crs, "EPSG:4326", *src.bounds)
        todo = np.flatnonzero((lon >= w) & (lon < e) & (lat >= s) & (lat < n) & np.isnan(depth))
        if not len(todo):
            return True
        shift = 0.0
        if how == "navd88":
            shift = shift_at((w + e) / 2, (s + n) / 2)
            if shift is None:
                log.warning("reference: no gauge datums near %s; skipped", path)
                return False
        x, y = transform("EPSG:4326", src.crs, lon[todo], lat[todo])
        rows, cols = rasterio.transform.rowcol(src.transform, x, y)
        rows, cols = np.asarray(rows), np.asarray(cols)
        inside = (rows >= 0) & (rows < src.height) & (cols >= 0) & (cols < src.width)
        todo, rows, cols = todo[inside], rows[inside], cols[inside]
        res = abs(src.res[0])
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
