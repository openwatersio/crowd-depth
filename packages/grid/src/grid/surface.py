"""Depth surface: a raster per 1° tile, interpolated between nearby tracks.

The surface is on the cells' latitude and longitude grid: rows 2/3″ of latitude (about
20 m), columns widened by latitude band as the cells' are. A tile is gridded in an
equirectangular projection centred on it, a linear rescaling of latitude and
longitude, so `gdal_grid`'s search radius is in metres (within about 3% across a tile up to 70°, 5% at 80°)
and its pixels are exactly the latitude and longitude grid's. Interpolation needs a
sounding in every quadrant around a pixel, so it fills between tracks and never runs
past their ends. Depth areas and contours are cut from it; soundings never are.

Each tile is a cloud-optimized GeoTIFF with three bands: depth (positive down), the
distance in metres to the nearest sounding, and the soundings in the pixel. The whole
tile is interpolated, but only blocks with a sounding within the search radius are
blurred, guarded, measured and written; the rest are left out of the file, and read
as no data in every band.
"""

import math
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import rasterio
import rasterio.shutil
from rasterio.transform import from_bounds
from rasterio.windows import Window
from scipy.ndimage import distance_transform_edt, gaussian_filter, minimum_filter

from .catalog import MIN_DEPTH_M
from .cells import BASE, CELL_SAMPLE, k_for
from .qc import MAX_DEPTH_M, QC_VERSION

NODATA = -9999.0
# Rows per tile: 2/3″ of latitude, two base rows.
ROWS = BASE // 2
RADIUS_M = 200
ALGORITHM = (
    f"invdistnn:power=2:radius={RADIUS_M}:max_points=12:min_points=3"
    f":min_points_per_quadrant=1:nodata={NODATA}"
)
# The blur, in pixels: light, about the positional accuracy of a crowd sounding.
SIGMA_PX = 1.0
# Base rows per pixel row and per pixel column.
PIXEL_BASE = 2
EARTH_M = 6378137.0
# Pixels a side of the blocks a tile is worked and stored in; blocks with no sounding
# within reach are skipped, and left out of the file.
BLOCK = 512

# Each surface pixel's corrected soundings, from those QC accepted (not rejected, and not an
# unconfirmed shoal unless something confirmed it), within the depths cells trust:
# the 10th percentile to interpolate from, as cells take it, over a fixed sample so a
# moored boat costs fixed memory; the shoalest, which no pixel may be deeper than;
# how many; and whether an unconfirmed shoal is there. One row per sounded pixel, so
# what Python holds of a tile is bounded by its pixels, not its soundings. Pixels are numbered on
# this tile's grid from its south-west corner; a neighboring tile's soundings get
# numbers outside it, which interpolation reads as a margin.
PIXELS = f"""
WITH wanted AS MATERIALIZED (
  SELECT * FROM (
    SELECT p.point_id, p.lon, p.lat, p.depth AS d,
      floor((p.lat - $lat0) * {BASE} / 2)::INTEGER AS py,
      floor((p.lon - $lon0) * {BASE} / $k / 2)::INTEGER AS px
    FROM corrected_points_in($partition, [$tile], $rlo, $rhi) p
    WHERE p.depth_raw > 0 AND p.depth_raw <= {MAX_DEPTH_M} AND p.depth >= {MIN_DEPTH_M}
      AND NOT p.excluded AND NOT p.awaiting_tide
  )
  -- Only the pixels wanted: a neighbor's strip within the search radius, say.
  WHERE py BETWEEN $pylo AND $pyhi AND px BETWEEN $pxlo AND $pxhi
),
-- Only these points' flags, so memory follows the tile, not its whole partition.
flags AS (
  SELECT point_id, bool_or(flag = 'reject') AS rejected,
    bool_or(flag = 'unconfirmed') AND NOT bool_or(flag = 'confirmed') AS unconfirmed
  FROM lake.qc_flags WHERE cell_id = $partition AND qc_version = {QC_VERSION}
    AND point_id IN (SELECT point_id FROM wanted)
  GROUP BY point_id
),
pts AS (
  SELECT w.*, coalesce(f.unconfirmed, false) AS unconfirmed
  FROM wanted w LEFT JOIN flags f USING (point_id) WHERE NOT coalesce(f.rejected, false)
),
sampled AS (
  SELECT a.*, hash(a.point_id) % greatest(1, ceil(n.n / {CELL_SAMPLE}))::UBIGINT = 0 AS keep
  FROM pts a JOIN (SELECT py, px, count(*) AS n FROM pts WHERE NOT unconfirmed GROUP BY ALL) n
    USING (py, px)
  WHERE NOT a.unconfirmed
)
SELECT py, px, quantile_disc(d, 0.1) FILTER (WHERE keep AND NOT unconfirmed) AS d,
  min(d) FILTER (WHERE NOT unconfirmed) AS shoalest,
  -- Both from one sounding, the same one every run, whatever the ties.
  arg_min(lon, (d, point_id)) FILTER (WHERE NOT unconfirmed) AS shoalest_lon,
  arg_min(lat, (d, point_id)) FILTER (WHERE NOT unconfirmed) AS shoalest_lat,
  count(*) AS n, bool_or(unconfirmed) AS unconfirmed
FROM (SELECT * FROM sampled UNION ALL BY NAME
  SELECT *, false AS keep FROM pts WHERE unconfirmed)
GROUP BY py, px
"""


def tiles(con):
    """Every tile with cells, with its 10° partition."""
    return con.execute(
        "SELECT DISTINCT tile_id, cell_id FROM lake.cells ORDER BY tile_id"
    ).fetchall()


def partition_of(lat0: int, lon0: int) -> int:
    """The 10° partition holding the 1° tile at (lat0, lon0), as ingest numbers them."""
    return min(lat0 // 10 + 9, 17) * 36 + min(lon0 // 10 + 18, 35)


def margin(con, lat0, lon0, k, cols, scale_x, scale_y):
    """Pixels of the eight neighboring tiles within the search radius of this tile's
    edges, numbered on this tile's grid: interpolation input only, so tracks either
    side of a whole-degree line are interpolated between as anywhere else."""
    rows_m = math.ceil(RADIUS_M / (scale_y / ROWS))
    cols_m = math.ceil(RADIUS_M / (scale_x / cols))
    edge = math.ceil(RADIUS_M / (scale_y / BASE))  # in the neighbor's base rows
    parts = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            lat, lon = lat0 + dy, (lon0 + dx + 180) % 360 - 180
            if (dy, dx) == (0, 0) or not -90 <= lat <= 89:
                continue
            rlo, rhi = {-1: (BASE - edge, BASE), 0: (0, BASE), 1: (0, edge)}[dy]
            # Across the antimeridian a neighbor's longitudes are a turn away from this
            # tile's: east of 179°E is -180°, so this tile's origin moves a turn west.
            turn = -360 if lon - lon0 < -1 else 360 if lon - lon0 > 1 else 0
            px = con.execute(
                PIXELS,
                {"partition": partition_of(lat, lon), "tile": (lat + 90) * 360 + lon + 180,
                 "lat0": lat0, "lon0": lon0 + turn, "k": k, "rlo": rlo, "rhi": rhi,
                 "pylo": -rows_m, "pyhi": ROWS + rows_m - 1,
                 "pxlo": -cols_m, "pxhi": cols + cols_m - 1},
            ).fetchnumpy()  # fmt: skip
            py, pxs, d = (np.asarray(px[c], dtype=np.float64) for c in ("py", "px", "d"))
            known = ~np.isnan(d)
            parts.append((py[known], pxs[known], d[known]))
    if not parts:
        return np.empty(0), np.empty(0), np.empty(0)
    return tuple(np.concatenate(c) for c in zip(*parts))


def build_tile(con, tile_id: int, partition: int, out: Path):
    """Grid one tile into `out/{tile_id}.tif`. Returns its path and each sounded pixel's
    shoalest accepted sounding as (lon, lat, depth) arrays, or None when the tile has no
    soundings."""
    lat0, lon0 = tile_id // 360 - 90, tile_id % 360 - 180
    k = k_for(lat0)
    # ponytail: past about 86° a tile has an odd number of base columns, so its last
    # surface column holds one; pad the grid if polar tiles ever matter
    cols = math.ceil(BASE / k / PIXEL_BASE)
    params = {"partition": partition, "tile": tile_id, "lat0": lat0, "lon0": lon0, "k": k,
              "rlo": 0, "rhi": BASE, "pylo": -ROWS, "pyhi": 2 * ROWS, "pxlo": -cols,
              "pxhi": 2 * cols}  # fmt: skip
    px = con.execute(PIXELS, params).fetchnumpy()
    if not len(px["py"]):
        return None
    # The tile in metres east and north of its south-west corner, scaled at its centre.
    scale_x = EARTH_M * math.cos(math.radians(lat0 + 0.5)) * math.pi / 180
    scale_y = EARTH_M * math.pi / 180
    # A tile's own soundings always land on its pixels, even on its north or east edge.
    py = np.clip(px["py"].astype(np.int64), 0, ROWS - 1)
    columns = np.clip(px["px"].astype(np.int64), 0, cols - 1)
    rows = ROWS - 1 - py
    values = np.asarray(px["d"], dtype=np.float64)
    known = ~np.isnan(values)
    my, mx, md = margin(con, lat0, lon0, k, cols, scale_x, scale_y)
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{tile_id}.tif"
    with tempfile.TemporaryDirectory(dir=os.environ.get("GRID_TEMP_DIR") or None) as tmp:
        points = Path(tmp) / "points.csv"
        # Each sounded pixel's centre, in metres.
        np.savetxt(
            points,
            np.column_stack(
                [
                    np.concatenate([columns[known], mx]) + 0.5,
                    np.concatenate([py[known], my]) + 0.5,
                    np.concatenate([values[known], md]),
                ]
            )
            * [scale_x / cols, scale_y / ROWS, 1],
            delimiter=",", header="x,y,d", comments="", fmt="%.3f",
        )  # fmt: skip
        vrt = Path(tmp) / "points.vrt"
        vrt.write_text(
            f"""<OGRVRTDataSource><OGRVRTLayer name="points"><SrcDataSource>{points}</SrcDataSource>
<GeometryType>wkbPoint</GeometryType>
<GeometryField encoding="PointFromColumns" x="x" y="y" z="d"/></OGRVRTLayer></OGRVRTDataSource>"""
        )
        grid = Path(tmp) / "grid.tif"
        subprocess.run(
            [
                "gdal_grid", "-q", "-a", ALGORITHM, "-zfield", "d", "-l", "points",
                "-txe", "0", str(scale_x), "-tye", str(scale_y), "0",
                "-outsize", str(cols), str(ROWS), "-ot", "Float32", str(vrt), str(grid),
            ],
            check=True,
        )  # fmt: skip
        # Accumulated, not assigned: a sounding on the tile's north or east edge is its
        # own group in SQL but shares the last pixel, and must not overwrite its values.
        shape = (ROWS, cols)
        shoal = np.asarray(px["shoalest"], dtype=np.float64)
        has_shoalest = ~np.isnan(shoal)
        shoalest = np.full(shape, np.inf, dtype=np.float32)
        np.minimum.at(shoalest, (rows[has_shoalest], columns[has_shoalest]), shoal[has_shoalest])
        count = np.zeros(shape, dtype=np.float32)
        np.add.at(count, (rows, columns), np.asarray(px["n"], dtype=np.float32))
        unconfirmed = np.zeros(shape, dtype=bool)
        np.logical_or.at(unconfirmed, (rows, columns), np.asarray(px["unconfirmed"], dtype=bool))
        dx, dy = scale_x / cols, scale_y / ROWS
        # A pixel has a depth only within the search radius of a point, and then has one
        # of the tile's own soundings within it too: the quadrant facing into the tile
        # needs one. So only blocks within that reach of a point have data, and a block's
        # depths and distances depend only on pixels within that reach of it, or within
        # the blur's (4σ), whichever is wider.
        reach = (math.ceil(RADIUS_M / dy) + 1, math.ceil(RADIUS_M / dx) + 1)
        blur = math.ceil(4 * SIGMA_PX)
        halo = (max(reach[0], blur), max(reach[1], blur))
        at = (np.concatenate([rows, ROWS - 1 - my.astype(np.int64)]),
              np.concatenate([columns, mx.astype(np.int64)]))  # fmt: skip
        # A point's reach touches at most two blocks each way, so its four corners'
        # blocks are every block it reaches.
        assert 2 * max(reach) < BLOCK, "the search radius reaches past a block"
        blocks = set()
        for sr in (-1, 1):
            for sc in (-1, 1):
                r = np.clip(at[0] + sr * reach[0], 0, ROWS - 1) // BLOCK
                c = np.clip(at[1] + sc * reach[1], 0, cols - 1) // BLOCK
                blocks |= set(zip(r.tolist(), c.tolist()))
        sparse = Path(tmp) / "sparse.tif"
        with rasterio.open(grid) as src, open_sparse(sparse, lon0, lat0, shape) as dst:
            for br, bc in sorted(blocks):
                r0, c0 = br * BLOCK, bc * BLOCK
                r1, c1 = min(r0 + BLOCK, ROWS), min(c0 + BLOCK, cols)
                wr0, wc0 = max(r0 - halo[0], 0), max(c0 - halo[1], 0)
                wr1, wc1 = min(r1 + halo[0], ROWS), min(c1 + halo[1], cols)
                win = np.s_[wr0:wr1, wc0:wc1]
                depth = src.read(1, window=Window(wc0, wr0, wc1 - wc0, wr1 - wr0))
                depth = finish(depth, shoalest[win], unconfirmed[win])
                distance = distance_m(count[win] > 0, dx, dy)
                distance[depth == NODATA] = NODATA
                inner = np.s_[r0 - wr0 : r1 - wr0, c0 - wc0 : c1 - wc0]
                dst.write(
                    np.stack([depth[inner], distance[inner], count[r0:r1, c0:c1]]),
                    window=Window(c0, r0, c1 - c0, r1 - r0),
                )
        rasterio.shutil.copy(sparse, path, driver="COG", compress="deflate", sparse_ok=True)
    candidates = tuple(
        np.asarray(px[c], dtype=np.float64)[has_shoalest]
        for c in ("shoalest_lon", "shoalest_lat", "shoalest")
    )
    return path, candidates


def finish(depth, shoalest, unconfirmed):
    """Blur lightly, never deeper than the interpolation; never deeper in any pixel than
    the shoalest sounding in it or a pixel next to it; and leave a pixel holding an
    unconfirmed shoal empty rather than draw deeper water over it, as hole filling leaves
    such a cell unfilled.

    Depth areas follow the surface between pixel centres, so a shoal held at its own
    pixel's centre alone would cover only part of that pixel; carried to the pixels
    around it, it covers all of its own, and every sounding in it is inside its band.
    Shoals may be enlarged, never drawn deeper. A pixel the interpolator leaves empty
    stays empty, shoal or not, as at a lone track or a track's end: the shoal shows
    there only as a sounding.
    """
    valid = depth != NODATA
    weights = gaussian_filter(valid.astype(np.float32), SIGMA_PX)
    blurred = gaussian_filter(np.where(valid, depth, 0), SIGMA_PX)
    with np.errstate(invalid="ignore", divide="ignore"):
        smooth = np.where(valid, np.minimum(blurred / weights, depth), NODATA)
    around = minimum_filter(shoalest, size=3, mode="constant", cval=np.inf)
    guarded = np.where(valid, np.minimum(smooth, around), NODATA)
    return np.where(unconfirmed, NODATA, guarded).astype(np.float32)


def distance_m(sounded, dx, dy):
    """Metres from each pixel to the nearest pixel with a sounding."""
    if not sounded.any():
        return np.full(sounded.shape, NODATA, dtype=np.float32)
    return distance_transform_edt(~sounded, sampling=(dy, dx)).astype(np.float32)


def open_sparse(path, lon0, lat0, shape):
    """A tiled GeoTIFF for a 1° tile's bands, which leaves out blocks never written."""
    rows, cols = shape
    dst = rasterio.open(
        path, "w", driver="GTiff", width=cols, height=rows, count=3, dtype="float32",
        crs="EPSG:4326", transform=from_bounds(lon0, lat0, lon0 + 1, lat0 + 1, cols, rows),
        nodata=NODATA, tiled=True, blockxsize=BLOCK, blockysize=BLOCK, sparse_ok=True,
    )  # fmt: skip
    for band, name in enumerate(("depth", "distance_m", "soundings"), start=1):
        dst.set_band_description(band, name)
    return dst
