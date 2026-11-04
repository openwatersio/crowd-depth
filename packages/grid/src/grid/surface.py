"""Depth surface: a raster per 1° tile, interpolated between nearby tracks.

The surface is on the cells' latitude and longitude grid: rows 2/3″ of latitude (about
20 m), columns widened by latitude band as the cells' are. A tile is gridded in an
equirectangular projection centred on it, a linear rescaling of latitude and
longitude, so `gdal_grid`'s search radius is in metres (within about 3% across a tile up to 70°, 5% at 80°)
and its pixels are exactly the latitude and longitude grid's. Interpolation needs a
sounding in every quadrant around a pixel, so it fills between tracks and never runs
past their ends. Within NEAR_M of a sounded pixel, a pixel interpolation leaves empty
takes the shoalest median within that reach instead, so a lone track draws a narrow
band and a track's end stops a short way past it. Depth areas and contours are cut from
it; soundings never are.

What is interpolated is each pixel's median of vessels' medians; the depth is that
surface less K times σ (statistic.py). A pixel with a depth and no sounding is
interpolated, and its σ widens with its distance from the nearest sounding.

Each tile is a cloud-optimized GeoTIFF with four bands: depth (positive down), the
distance in metres to the nearest sounding, the soundings in the pixel, and σ. The whole
tile is worked in 512-pixel blocks: only the extent of the blocks with a sounding within
the search radius is interpolated, and only those blocks are blurred, guarded, measured
and written; the rest are left out of the file, and read as no data in every band.
"""

import contextlib
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
from scipy.ndimage import gaussian_filter, minimum_filter
from scipy.spatial import cKDTree

from . import statistic
from .catalog import MIN_DEPTH_M
from .cells import BASE, CELL_SAMPLE, k_for
from .definitions import SURFACE
from .qc import HAZARD_M, MAX_DEPTH_M, QC_VERSION, SHALLOW_M

NODATA = -9999.0
# Rows per tile: 2/3″ of latitude, two base rows.
ROWS = BASE // 2
RADIUS_M = SURFACE["interpolation_radius_m"]
# Smoothing, in metres, is added to every point's distance, so a sounded pixel takes its
# neighbours' depths too and doesn't keep its own value whole.
SMOOTHING_M = SURFACE["smoothing_m"]
ALGORITHM = (
    f"invdistnn:power=2:smoothing={SMOOTHING_M}:radius={RADIUS_M}:max_points=12:min_points=3"
    f":min_points_per_quadrant=1:nodata={NODATA}"
)
# The reach, in metres between pixel centres, of the band beside a track. Measured on the
# Chesapeake by drawing each vessel's band alone and scoring it against other vessels'
# medians in pixels it never sounded: after the margin's distance and correction terms,
# 0.7-0.8% of its own pixels read more than 1 m too deep, about 1% within 20 m, 2.3% at
# 30-40 m, 3% at 40-50 m and 3.3-3.8% at 50-60 m. Past 40 m it passes three times its
# own pixels' rate.
NEAR_M = SURFACE["near_radius_m"]
assert NEAR_M <= RADIUS_M, "the band reaches past the blocks the search radius picks"
# The blur, in pixels: never toward deeper water, wide enough that busy and quiet water both
# read clearly.
SIGMA_PX = SURFACE["blur_px"]
# Base rows per pixel row and per pixel column.
PIXEL_BASE = 2
EARTH_M = 6378137.0
# Pixels a side of the blocks a tile is worked and stored in; blocks with no sounding
# within reach are skipped, and left out of the file.
BLOCK = 512

# An unconfirmed shoal QC judged improbable against its context (its track, its cell's
# median, other vessels nearby) doesn't affect the surface: it publishes as an unconfirmed
# sounding, the chart's warning there, and the surface is drawn from the other votes. One
# with no context to judge against, a cell shoal in a cell with no accepted median,
# votes like any accepted sounding.
UNJUDGED = "cell_unjudged"

# Each surface pixel's corrected soundings, from those QC accepted (not rejected, and not an
# unconfirmed shoal QC judged improbable, unless something confirmed it), within the depths
# cells trust, with the pixel numbered on this tile's grid from its south-west corner; a neighboring tile's
# soundings get numbers outside it, which interpolation reads as a margin. A fixed sample
# per pixel and vessel is marked `keep`, so a moored boat costs fixed memory and can't
# sample other vessels out of the pixel.
POINTS = f"""
CREATE OR REPLACE TEMP TABLE surface_points AS
WITH wanted AS MATERIALIZED (
  SELECT * FROM (
    SELECT p.point_id, p.content_key, p.unique_id AS vessel, p.depth AS d, p.sigma, p.lost_bottom,
      floor((p.lat - $lat0) * {BASE} / 2)::INTEGER AS py,
      floor((p.lon - $lon0) * {BASE} / $k / 2)::INTEGER AS px
    FROM corrected_points_in($partition, [$tile], $rlo, $rhi) p
    WHERE p.depth_raw > 0 AND p.depth_raw <= {MAX_DEPTH_M} AND p.depth >= {MIN_DEPTH_M}
      AND NOT p.excluded AND NOT p.awaiting_tide
      -- As cells publish them: a sounding after its sounder lost the bottom only where it
      -- reads shoal, and at least SHALLOW_M.
      AND NOT (p.lost_bottom AND (p.depth >= {HAZARD_M} OR p.depth_raw < {SHALLOW_M}))
  )
  -- Only the pixels wanted: a neighbor's strip within the search radius, say.
  WHERE py BETWEEN $pylo AND $pyhi AND px BETWEEN $pxlo AND $pxhi
),
-- Only these points' flags, so memory follows the tile, not its whole partition.
flags AS (
  -- A noisy track's soundings neither vote nor cap a pixel.
  SELECT point_id, bool_or(flag IN ('reject', 'noisy')) AS rejected,
    bool_or(flag = 'confirmed' AND reason = 'cell_shoal') AS confirmed,
    bool_or(flag = 'unconfirmed' AND reason <> '{UNJUDGED}') AND NOT bool_or(flag = 'confirmed')
      AS unconfirmed
  FROM lake.qc_flags WHERE cell_id = $partition AND tile_id = $tile AND qc_version = {QC_VERSION}
    AND point_id IN (SELECT point_id FROM wanted)
  GROUP BY point_id
),
pts AS (
  -- A sounding after its sounder lost the bottom never votes: it publishes as a shoal.
  SELECT w.* EXCLUDE (lost_bottom), coalesce(f.unconfirmed, false) OR w.lost_bottom AS unconfirmed,
    coalesce(f.confirmed, false) AS confirmed
  FROM wanted w LEFT JOIN flags f USING (point_id) WHERE NOT coalesce(f.rejected, false)
)
SELECT a.*, NOT a.unconfirmed
  AND a.content_key % greatest(1, ceil(n.n / {CELL_SAMPLE}))::UBIGINT = 0 AS keep
FROM pts a JOIN (SELECT py, px, vessel, count(*) AS n FROM pts GROUP BY ALL) n
  USING (py, px, vessel)
"""

# Each vessel's median in each pixel, and its median correction σ: what the statistic
# reads, one vote per vessel however fast it logs. One row per sounded pixel and vessel,
# so what Python holds of a tile is bounded by those, not its soundings.
ENTRIES = """
SELECT py, px, hash(vessel) AS v, median(d) AS m, median(sigma) AS s
FROM surface_points WHERE keep GROUP BY py, px, vessel ORDER BY py, px, v, m
"""

# Each sounded pixel's soundings, those of them that vote, and its shoalest confirmed
# shoal, which no pixel may be deeper than; north to south, as the raster's rows run.
COUNTS = """
SELECT py, px, count(*) AS n, count(*) FILTER (WHERE NOT unconfirmed) AS votes,
  min(d) FILTER (WHERE confirmed) AS confirmed
FROM surface_points GROUP BY ALL ORDER BY py DESC, px
"""


def entries(con, params, counts=True):
    """The entries and, unless `counts` is false, per-pixel counts for one tile's or
    neighbor strip's soundings."""
    con.execute(POINTS, params)
    got = con.execute(ENTRIES).fetchnumpy(), counts and con.execute(COUNTS).fetchnumpy()
    con.execute("DROP TABLE surface_points")
    return got


def tiles(con):
    """Every tile with cells, with its 10° partition."""
    return con.execute(
        "SELECT DISTINCT tile_id, cell_id FROM lake.cells ORDER BY tile_id"
    ).fetchall()


def partition_of(lat0: int, lon0: int) -> int:
    """The 10° partition holding the 1° tile at (lat0, lon0), as ingest numbers them."""
    return min(lat0 // 10 + 9, 17) * 36 + min(lon0 // 10 + 18, 35)


def margin(con, lat0, lon0, k, cols, scale_x, scale_y):
    """Entries of the eight neighboring tiles within the search radius of this tile's
    edges, numbered on this tile's grid, as (py, px, vessel, m, s) arrays: interpolation and σ
    input only, so tracks either side of a whole-degree line are interpolated between
    as anywhere else."""
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
            got, _ = entries(
                con,
                {"partition": partition_of(lat, lon), "tile": (lat + 90) * 360 + lon + 180,
                 "lat0": lat0, "lon0": lon0 + turn, "k": k, "rlo": rlo, "rhi": rhi,
                 "pylo": -rows_m, "pyhi": ROWS + rows_m - 1,
                 "pxlo": -cols_m, "pxhi": cols + cols_m - 1},
                counts=False,
            )  # fmt: skip
            parts.append(
                (
                    np.asarray(got["py"], dtype=np.int64),
                    np.asarray(got["px"], dtype=np.int64),
                    np.asarray(got["v"], dtype=np.uint64),
                    np.asarray(got["m"], dtype=np.float64),
                    np.asarray(got["s"], dtype=np.float64),
                )
            )
    if not parts:
        return (np.empty(0, np.int64),) * 2 + (np.empty(0, np.uint64),) + (np.empty(0),) * 2
    return tuple(np.concatenate(c) for c in zip(*parts))


def build_tile(con, tile_id: int, partition: int, out: Path):
    """Grid one tile into `out/{tile_id}.tif`. Returns its path, or None when the tile has
    no soundings."""
    got = tile_entries(con, tile_id, partition)
    return grid_tile(tile_id, got, out) if got else None


def geometry(tile_id):
    """A tile's (lat0, lon0, k, columns, metres east and north across it, scaled at its
    centre, from its south-west corner)."""
    lat0, lon0 = tile_id // 360 - 90, tile_id % 360 - 180
    k = k_for(lat0)
    # ponytail: past about 86° a tile has an odd number of base columns, so its last
    # surface column holds one; pad the grid if polar tiles ever matter
    cols = math.ceil(BASE / k / PIXEL_BASE)
    scale_x = EARTH_M * math.cos(math.radians(lat0 + 0.5)) * math.pi / 180
    scale_y = EARTH_M * math.pi / 180
    return lat0, lon0, k, cols, scale_x, scale_y


def tile_entries(con, tile_id: int, partition: int):
    """What gridding a tile reads from the store: its entries and per-pixel counts, and
    its neighbors' entries within the search radius; None when it has no soundings. The
    rest needs no connection, so a job can close its own first: what DuckDB holds then
    goes back before the rasters are made."""
    lat0, lon0, k, cols, scale_x, scale_y = geometry(tile_id)
    params = {"partition": partition, "tile": tile_id, "lat0": lat0, "lon0": lon0, "k": k,
              "rlo": 0, "rhi": BASE, "pylo": -ROWS, "pyhi": 2 * ROWS, "pxlo": -cols,
              "pxhi": 2 * cols}  # fmt: skip
    own, counted = entries(con, params)
    if not len(counted["py"]):
        return None
    return own, counted, margin(con, lat0, lon0, k, cols, scale_x, scale_y)


def grid_tile(tile_id: int, got, out: Path):
    """Grid one tile from its `tile_entries` into `out/{tile_id}.tif`; returns its path."""
    lat0, lon0, _, cols, scale_x, scale_y = geometry(tile_id)
    own, counted, (my, mx, mv, mm, ms) = got
    dx, dy = scale_x / cols, scale_y / ROWS
    shape = (ROWS, cols)
    # A tile's own soundings always land on its pixels, even on its north or east edge.
    # Each vessel smoothed along its own coverage, this tile's and the margin's together.
    epx, epy, em, es = statistic.smoothed(
        np.concatenate([np.clip(own["px"].astype(np.int64), 0, cols - 1), mx]),
        np.concatenate([np.clip(own["py"].astype(np.int64), 0, ROWS - 1), my]),
        np.concatenate([np.asarray(own["v"], dtype=np.uint64), mv]),
        np.concatenate([np.asarray(own["m"], dtype=np.float64), mm]),
        np.concatenate([np.asarray(own["s"], dtype=np.float64), ms]),
    )
    upx, upy, _, medians = statistic.pixels(epx, epy, em)
    cpy = np.clip(counted["py"].astype(np.int64), 0, ROWS - 1)
    cpx = np.clip(counted["px"].astype(np.int64), 0, cols - 1)
    # NULL, a pixel without one, comes back masked: as NaN, never as its 0 fill.
    shoal = np.ma.filled(np.ma.asarray(counted["confirmed"], dtype=np.float32), np.nan)
    sounded_at = Sounded(ROWS - 1 - cpy, cpx, np.asarray(counted["n"], dtype=np.float32), shoal)
    # Every pixel with a vote, this tile's and its neighbors', in metres: distance is to
    # the nearest, wherever it is, and a pixel holding only shoals the surface ignores
    # isn't sounded for it.
    voted = np.asarray(counted["votes"]) > 0
    sounded = cKDTree(
        np.column_stack(
            [np.concatenate([cpx[voted], mx]) * dx, np.concatenate([cpy[voted], my]) * dy]
        )
    )
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{tile_id}.tif"
    # A pixel has a depth only within the search radius of a vote, this tile's or a
    # neighbor's, the band beside a track included (NEAR_M <= RADIUS_M). So only blocks
    # within that reach of a vote have data, and a block's depths and distances depend
    # only on pixels within that reach of it, or within the blur's (4σ), whichever is
    # wider.
    reach = (math.ceil(RADIUS_M / dy) + 1, math.ceil(RADIUS_M / dx) + 1)
    blur_px = math.ceil(4 * SIGMA_PX)
    halo = (max(reach[0], blur_px), max(reach[1], blur_px))
    # Blocks around the votes, and around every sounded pixel, so the soundings band
    # reaches each.
    at = (np.concatenate([ROWS - 1 - upy, ROWS - 1 - cpy]), np.concatenate([upx, cpx]))
    # A point's reach touches at most two blocks each way, so its four corners' blocks
    # are every block it reaches.
    assert 2 * max(reach) < BLOCK, "the search radius reaches past a block"
    blocks = set()
    for sr_ in (-1, 1):
        for sc_ in (-1, 1):
            r = np.clip(at[0] + sr_ * reach[0], 0, ROWS - 1) // BLOCK
            c = np.clip(at[1] + sc_ * reach[1], 0, cols - 1) // BLOCK
            blocks |= set(zip(r.tolist(), c.tolist()))
    windows = {}
    for br, bc in sorted(blocks):
        r0, c0 = br * BLOCK, bc * BLOCK
        r1, c1 = min(r0 + BLOCK, ROWS), min(c0 + BLOCK, cols)
        wr0, wc0 = max(r0 - halo[0], 0), max(c0 - halo[1], 0)
        wr1, wc1 = min(r1 + halo[0], ROWS), min(c1 + halo[1], cols)
        windows[br, bc] = (r0, c0, r1, c1, wr0, wc0, wr1, wc1)
    # Interpolated only over the windows' extent: every pixel outside it is no data.
    extent = tuple(
        f(w[i] for w in windows.values()) for f, i in ((min, 4), (min, 5), (max, 6), (max, 7))
    )
    with tempfile.TemporaryDirectory(dir=os.environ.get("GRID_TEMP_DIR") or None) as tmp:
        # A tile whose soundings are all contradicted shoals has no votes: nothing to draw.
        grid = (
            interpolate(Path(tmp), upx, upy, medians, scale_x, scale_y, cols, extent)
            if len(upx)
            else None
        )
        # The blurred surface first, block by block, with the band beside the tracks.
        central = {
            key: np.full((r1 - r0, c1 - c0), NODATA, dtype=np.float32)
            for key, (r0, c0, r1, c1, *_) in windows.items()
        }
        rows_at, cols_at = ROWS - 1 - upy, upx
        near = Near(rows_at, cols_at, medians, dy, dx)
        inside = (rows_at >= 0) & (rows_at < ROWS) & (cols_at >= 0) & (cols_at < cols)
        at_central = np.full(len(upx), np.nan)
        blocks_at = (rows_at // BLOCK) * (cols // BLOCK + 1) + cols_at // BLOCK
        with contextlib.ExitStack() as stack:
            src = stack.enter_context(rasterio.open(grid)) if grid else None
            for key, (r0, c0, r1, c1, wr0, wc0, wr1, wc1) in windows.items() if src else ():
                window = src.read(
                    1, window=Window(wc0 - extent[1], wr0 - extent[0], wc1 - wc0, wr1 - wr0)
                )
                inner = np.s_[r0 - wr0 : r1 - wr0, c0 - wc0 : c1 - wc0]
                between = blur(window)[inner]
                # σ's spread, where a window is too thin for a plane, is around the
                # interpolation alone, as the statistic was measured.
                mine = inside & (blocks_at == key[0] * (cols // BLOCK + 1) + key[1])
                value = between[rows_at[mine] % BLOCK, cols_at[mine] % BLOCK]
                at_central[mine] = np.where(value == NODATA, np.nan, value)
                # The band fills only what interpolation left empty, and never makes a
                # pixel it filled deeper: blurred together, an interpolated pixel takes
                # the shoaler of the two.
                banded = blur(np.where(window == NODATA, near.shoalest(wr0, wc0, wr1, wc1), window))
                central[key] = np.where(
                    between == NODATA, banded[inner], np.minimum(between, banded[inner])
                )
        # Interpolation needs a sounding in every quadrant, so the outermost tracks' own
        # pixels have no interpolated surface: there, as past the tile's edge, the pixel's
        # own median.
        at_central = np.where(np.isnan(at_central), medians, at_central)

        def sigma_of(qx, qy, distance):
            return np.empty(0)  # no votes, so no pixel has a depth

        if len(upx):
            upx, upy, _, spread, csig = statistic.sigma_b(epx, epy, em, es, central=at_central)
            sigma_of = statistic.sigma_at(upx, upy, spread, csig)
        sparse = Path(tmp) / "sparse.tif"
        with open_sparse(sparse, lon0, lat0, shape) as dst:
            for key, (r0, c0, r1, c1, wr0, wc0, wr1, wc1) in windows.items():
                inner = np.s_[r0 - wr0 : r1 - wr0, c0 - wc0 : c1 - wc0]
                surface = central[key]
                distance = np.full(surface.shape, NODATA, dtype=np.float32)
                sigma = np.full(surface.shape, NODATA, dtype=np.float32)
                rr, cc = np.nonzero(surface != NODATA)
                qx, qy = cc + c0, ROWS - 1 - (rr + r0)
                distance[rr, cc] = sounded.query(np.column_stack([qx * dx, qy * dy]))[0]
                sigma[rr, cc] = sigma_of(qx, qy, distance[rr, cc])
                count, confirmed = sounded_at.rasters(wr0, wc0, wr1, wc1)
                depth = finish(surface, sigma, around(confirmed)[inner])
                distance[depth == NODATA] = NODATA
                sigma[depth == NODATA] = NODATA
                dst.write(
                    np.stack([depth, distance, count[inner], sigma]),
                    window=Window(c0, r0, c1 - c0, r1 - r0),
                )
        rasterio.shutil.copy(sparse, path, driver="COG", compress="deflate", sparse_ok=True)
    return path


class Sounded:
    """The tile's sounded pixels, by row and column: each one's soundings and its shoalest
    confirmed shoal (NaN for none), rasterized a window at a time, so a tile holds its
    windows' rasters, not the whole tile's: 16 bytes a sounded pixel, against 8 a pixel."""

    def __init__(self, rows, cols, n, shoal):
        rows, cols = np.asarray(rows, dtype=np.int32), np.asarray(cols, dtype=np.int32)
        # COUNTS returns them in row order; sorted only if not.
        if len(rows) and (np.diff(rows) < 0).any():
            order = np.argsort(rows, kind="stable")
            rows, cols, n, shoal = rows[order], cols[order], n[order], shoal[order]
        self.rows, self.cols = rows, cols
        self.n = np.asarray(n, dtype=np.float32)
        self.shoal = np.asarray(shoal, dtype=np.float32)

    def rasters(self, r0, c0, r1, c1):
        """(soundings, shoalest confirmed shoal or inf) for rows [r0, r1), columns [c0,
        c1). Accumulated, not assigned: a sounding on the tile's north or east edge is its
        own group in SQL but shares the last pixel, and must not overwrite its values."""
        a, b = np.searchsorted(self.rows, [r0, r1])
        i = a + np.flatnonzero((self.cols[a:b] >= c0) & (self.cols[a:b] < c1))
        at = self.rows[i] - r0, self.cols[i] - c0
        count = np.zeros((r1 - r0, c1 - c0), dtype=np.float32)
        np.add.at(count, at, self.n[i])
        confirmed = np.full((r1 - r0, c1 - c0), np.inf, dtype=np.float32)
        has = ~np.isnan(self.shoal[i])
        np.minimum.at(confirmed, (at[0][has], at[1][has]), self.shoal[i][has])
        return count, confirmed


class Near:
    """The voted pixels' medians, by row and column, those past the tile's edges too, and
    each pixel's shoalest of them within NEAR_M of its centre, a window at a time."""

    def __init__(self, rows, cols, values, dy, dx):
        rows, cols = np.asarray(rows, dtype=np.int32), np.asarray(cols, dtype=np.int32)
        order = np.argsort(rows, kind="stable")
        self.rows, self.cols = rows[order], cols[order]
        self.values = np.asarray(values, dtype=np.float32)[order]
        self.pad = (math.floor(NEAR_M / dy), math.floor(NEAR_M / dx))
        i, j = np.mgrid[-self.pad[0] : self.pad[0] + 1, -self.pad[1] : self.pad[1] + 1]
        self.footprint = (i * dy) ** 2 + (j * dx) ** 2 <= NEAR_M**2

    def shoalest(self, r0, c0, r1, c1):
        """Rows [r0, r1), columns [c0, c1): each pixel's shoalest median within NEAR_M,
        or NODATA with none."""
        pr, pc = self.pad
        a, b = np.searchsorted(self.rows, [r0 - pr, r1 + pr])
        i = a + np.flatnonzero((self.cols[a:b] >= c0 - pc) & (self.cols[a:b] < c1 + pc))
        raster = np.full((r1 - r0 + 2 * pr, c1 - c0 + 2 * pc), np.inf, dtype=np.float32)
        np.minimum.at(raster, (self.rows[i] - r0 + pr, self.cols[i] - c0 + pc), self.values[i])
        got = minimum_filter(raster, footprint=self.footprint, mode="constant", cval=np.inf)
        got = got[pr : pr + r1 - r0, pc : pc + c1 - c0]
        return np.where(np.isfinite(got), got, NODATA).astype(np.float32)


def interpolate(tmp, px, py, values, scale_x, scale_y, cols, extent):
    """`values` at pixels (px, py) interpolated with `gdal_grid` over the tile's rows and
    columns `extent` (first row, first column, end row, end column); the raster's path."""
    points = tmp / "points.csv"
    # Each pixel's centre, in metres.
    np.savetxt(
        points,
        np.column_stack([px + 0.5, py + 0.5, values]) * [scale_x / cols, scale_y / ROWS, 1],
        delimiter=",", header="x,y,d", comments="", fmt="%.3f",
    )  # fmt: skip
    vrt = tmp / "points.vrt"
    vrt.write_text(
        f"""<OGRVRTDataSource><OGRVRTLayer name="points"><SrcDataSource>{points}</SrcDataSource>
<GeometryType>wkbPoint</GeometryType>
<GeometryField encoding="PointFromColumns" x="x" y="y" z="d"/></OGRVRTLayer></OGRVRTDataSource>"""
    )
    grid = tmp / "grid.tif"
    r0, c0, r1, c1 = extent
    dx, dy = scale_x / cols, scale_y / ROWS
    subprocess.run(
        [
            "gdal_grid", "-q", "-a", ALGORITHM, "-zfield", "d", "-l", "points",
            "-txe", str(c0 * dx), str(c1 * dx), "-tye", str((ROWS - r0) * dy), str((ROWS - r1) * dy),
            "-outsize", str(c1 - c0), str(r1 - r0), "-ot", "Float32", str(vrt), str(grid),
        ],
        check=True,
    )  # fmt: skip
    return grid


def blur(depth):
    """Blur lightly, never deeper than the interpolation."""
    valid = depth != NODATA
    weights = gaussian_filter(valid.astype(np.float32), SIGMA_PX)
    blurred = gaussian_filter(np.where(valid, depth, 0), SIGMA_PX)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(valid, np.minimum(blurred / weights, depth), NODATA).astype(np.float32)


def around(confirmed):
    """Each pixel's shoalest confirmed shoal in it or a pixel next to it."""
    return minimum_filter(confirmed, size=3, mode="constant", cval=np.inf)


def finish(surface, sigma, around):
    """The depth: the blurred `surface` less K `sigma`, never deeper in any pixel than a
    confirmed shoal `around` it (in it or a pixel next to it).

    Depth areas follow the surface between pixel centres, so a shoal held at its own
    pixel's centre alone would cover only part of that pixel; carried to the pixels
    around it, it covers all of its own. Shoals may be enlarged, never drawn deeper.
    A pixel the surface leaves empty, farther than NEAR_M from every vote, stays empty,
    shoal or not: a shoal there shows only as a sounding.
    """
    valid = surface != NODATA
    # The margin alone never makes water drying: below 0 only where the surface or a
    # confirmed shoal is. Never past the drying band's floor, which the overlay's bands
    # start from.
    floor = np.maximum(np.minimum(np.minimum(surface, around), 0), MIN_DEPTH_M)
    depth = np.maximum(np.minimum(surface - statistic.K * sigma, around), floor)
    return np.where(valid, depth, NODATA).astype(np.float32)


def open_sparse(path, lon0, lat0, shape):
    """A tiled GeoTIFF for a 1° tile's bands, which leaves out blocks never written."""
    rows, cols = shape
    dst = rasterio.open(
        path, "w", driver="GTiff", width=cols, height=rows, count=4, dtype="float32",
        crs="EPSG:4326", transform=from_bounds(lon0, lat0, lon0 + 1, lat0 + 1, cols, rows),
        nodata=NODATA, tiled=True, blockxsize=BLOCK, blockysize=BLOCK, sparse_ok=True,
    )  # fmt: skip
    for band, name in enumerate(("depth", "distance_m", "soundings", "sigma"), start=1):
        dst.set_band_description(band, name)
    return dst
