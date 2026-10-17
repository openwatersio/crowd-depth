"""Depth surface: a raster per 1° tile, interpolated between nearby tracks.

The surface is on the cells' latitude and longitude grid: rows 2/3″ of latitude (about
20 m), columns widened by latitude band as the cells' are. A tile is gridded in an
equirectangular projection centred on it, a linear rescaling of latitude and
longitude, so `gdal_grid`'s search radius is in metres (within about 3% across a tile up to 70°, 5% at 80°)
and its pixels are exactly the latitude and longitude grid's. Interpolation needs a
sounding in every quadrant around a pixel, so it fills between tracks and never runs
past their ends. Depth areas and contours are cut from it; soundings never are.

Each tile is a cloud-optimized GeoTIFF with three bands: depth (positive down), the
distance in metres to the nearest sounding, and the soundings in the pixel.
"""

import math
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from scipy.ndimage import distance_transform_edt, gaussian_filter, minimum_filter

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

# Each surface pixel's soundings, from those QC accepted (not rejected, and not an
# unconfirmed shoal unless something confirmed it), within the depths cells trust:
# the 10th percentile to interpolate from, as cells take it, over a fixed sample so a
# moored boat costs fixed memory; the shoalest, which no pixel may be deeper than;
# how many; and whether an unconfirmed shoal is there. One row per sounded pixel, so
# what Python holds of a tile is bounded by its pixels, not its soundings. Pixels are numbered on
# this tile's grid from its south-west corner; a neighboring tile's soundings get
# numbers outside it, which interpolation reads as a margin.
PIXELS = f"""
WITH flags AS (
  SELECT point_id, bool_or(flag = 'reject') AS rejected,
    bool_or(flag = 'unconfirmed') AND NOT bool_or(flag = 'confirmed') AS unconfirmed
  FROM lake.qc_flags WHERE cell_id = $partition AND qc_version = {QC_VERSION}
  GROUP BY point_id
),
pts AS (
  SELECT * FROM (
    SELECT p.point_id, p.lon, p.lat, p.depth_raw AS d,
      floor((p.lat - $lat0) * {BASE} / 2)::INTEGER AS py,
      floor((p.lon - $lon0) * {BASE} / $k / 2)::INTEGER AS px,
      coalesce(f.unconfirmed, false) AS unconfirmed
    FROM active_points_in($partition, [$tile], $rlo, $rhi) p LEFT JOIN flags f USING (point_id)
    WHERE p.depth_raw > 0 AND p.depth_raw <= {MAX_DEPTH_M} AND NOT coalesce(f.rejected, false)
  )
  -- Only the pixels wanted: a neighbor's strip within the search radius, say.
  WHERE py BETWEEN $pylo AND $pyhi AND px BETWEEN $pxlo AND $pxhi
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
        with rasterio.open(grid) as src:
            depth = src.read(1)
    # Accumulated, not assigned: a sounding on the tile's north or east edge is its own
    # group in SQL but shares the last pixel, and must not overwrite that pixel's values.
    shoal = np.asarray(px["shoalest"], dtype=np.float64)
    has_shoalest = ~np.isnan(shoal)
    shoalest = np.full(depth.shape, np.inf, dtype=np.float32)
    np.minimum.at(shoalest, (rows[has_shoalest], columns[has_shoalest]), shoal[has_shoalest])
    count = np.zeros(depth.shape, dtype=np.float32)
    np.add.at(count, (rows, columns), np.asarray(px["n"], dtype=np.float32))
    unconfirmed = np.zeros(depth.shape, dtype=bool)
    np.logical_or.at(unconfirmed, (rows, columns), np.asarray(px["unconfirmed"], dtype=bool))
    depth = finish(depth, shoalest, unconfirmed)
    distance = distance_m(count > 0, scale_x / cols, scale_y / ROWS)
    distance[depth == NODATA] = NODATA
    write(path, lon0, lat0, depth, distance, count)
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


def write(path, lon0, lat0, depth, distance, count):
    """A 1° tile's bands as a cloud-optimized GeoTIFF, at whatever size they are."""
    rows, cols = depth.shape
    transform = from_bounds(lon0, lat0, lon0 + 1, lat0 + 1, cols, rows)
    profile = {
        "driver": "COG", "width": cols, "height": rows, "count": 3, "dtype": "float32",
        "crs": "EPSG:4326", "transform": transform, "nodata": NODATA, "compress": "deflate",
    }  # fmt: skip
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(np.stack([depth, distance, count]))
        dst.set_band_description(1, "depth")
        dst.set_band_description(2, "distance_m")
        dst.set_band_description(3, "soundings")
