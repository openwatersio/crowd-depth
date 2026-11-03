"""Overlay layers: the grid as S-57 features in line-delimited GeoJSON, for tippecanoe.

SOUNDG follows Seascape's soundings (pipelines/soundings_run.py) so its sounding style
draws the layer unchanged: the same depth labels, rounded toward shoal, and the same
shoalest-wins pyramid. Each sounding sits at the accepted sounding nearest its cell's
depth, a confirmed shoal's own position when one set it, never at a cell center, and
unconfirmed shoals publish alongside the cells' soundings with a flag of their own.
"""

import contextlib
import json
import math
import os
import re
import sqlite3
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import rasterio
import rasterio.features
import rasterio.windows
import shapely
import shapely.geometry
from pmtiles.convert import mbtiles_to_pmtiles
from scipy.ndimage import (
    binary_closing,
    binary_dilation,
    binary_erosion,
    distance_transform_edt,
    label,
    minimum_filter,
)

from . import cells, surface
from .catalog import MIN_DEPTH_M, TIDE_CELL
from .cells import GRID_VERSION
from .definitions import PORTRAYAL
from .qc import MAX_DEPTH_M

M_PER_FT = PORTRAYAL["m_per_ft"]
M_PER_FATHOM = PORTRAYAL["m_per_fathom"]

# S-4, Ed 4.10.0, B-412 rounds by depth band, always toward shoal: decimetres to 21 m,
# half metres from 21 to 31, whole metres beyond. Each rule rounds to 1/per_m of a metre
# below its below_m; the last has none.
ROUNDING = PORTRAYAL["sounding_rounding"]

# Soundings per tile side at every zoom: Seascape's 64 px cells of a 512 px tile.
CELLS_PER_TILE = 8
# The finest level, also the tileset's last zoom: at z15 a tile's 4096 units resolve
# about 0.3 m, so the grid's 10 m cells keep their shape and clients overzoom past it,
# and its pyramid cells, about 150 m, show at every zoom past it. Every zoom further
# multiplies the tiles a long, thin track touches.
MAX_ZOOM = 15
MIN_ZOOM = 6
# At or beyond each depth a sounding displays from a 2^shift coarser level, so deep
# water reads sparse while navigable depths keep full density (Seascape's defaults).
THIN_TIERS = [(200.0, 1), (1000.0, 2)]

# S-57 quality attributes: the grid's soundings are reported, not surveyed, and an
# unconfirmed shoal is reported but not confirmed. TECSOU 1 is an echo-sounder.
QUALITY = {False: {"QUASOU": 8, "QUAPOS": 7}, True: {"QUASOU": 9, "QUAPOS": 8}}
TECSOU = 1

# Written coordinate precision: about 0.11 m, well under a sounding's positional meaning.
COORD_DECIMALS = 6


def _floor(x):
    """Floor a quotient that should have landed on a whole number: 0.3 * 10 is
    2.9999999999999996, which a bare floor charts as 0.2 m. A nanometre of slack recovers
    the intended digit and is far too small to chart a deeper value shoaler."""
    return math.floor(x + 1e-9)


def depths(d):
    """Depth (metres, positive down) to chart labels, each floored toward shoal so the
    printed number is never deeper than measured (S-4 B-412)."""
    per = next((r for r in ROUNDING if d < r.get("below_m", math.inf)), ROUNDING[-1])["per_m"]
    m = _floor(d * per) / per
    return {
        "depth_m": int(m) if m == int(m) else m,  # integral values stay ints in the tiles
        "depth_ft": _floor(d / M_PER_FT),
        "depth_fm": _floor(d / M_PER_FATHOM),
    }


def thin_shift(d):
    shift = 0
    for depth, s in THIN_TIERS:
        if d >= depth:
            shift = s
    return shift


def zooms(display):
    """Tippecanoe zooms for a lattice sounding: a level shows at exactly its zoom and is
    swapped out by the next finer one, except the finest, which shows at every zoom past it."""
    return {"minzoom": display} if display == MAX_ZOOM else {"minzoom": display, "maxzoom": display}


# What SOUNDG is made of: every cell at the accepted sounding nearest its depth, and every
# unconfirmed shoal, which the cells build keeps.
# ponytail: reads every cell; split by 10° partition when the overlay builds by region
# Web Mercator stops at about 85.05°; soundings past it have no tile to go in.
MERCATOR_MAX_LAT = 85.0511
SOURCES = f"""
SELECT * FROM (
  SELECT depth_lon AS lon, depth_lat AS lat, depth AS d, false AS unconfirmed
  FROM lake.cells WHERE depth IS NOT NULL
  UNION ALL
  SELECT lon, lat, depth, true FROM lake.shoals
) WHERE abs(lat) <= {MERCATOR_MAX_LAT}
"""

# Web Mercator x and y in [0, 1), north at 0, as tiles are numbered.
MERCATOR = """
  (lon + 180) / 360 AS mx,
  (1 - ln(tan(radians(lat)) + 1 / cos(radians(lat))) / pi()) / 2 AS my"""


def soundings(con, primes=None):
    """Yield SOUNDG features from a shoalest-wins pyramid, finest level first.

    Each level keeps the shoalest sounding of every pyramid cell, and its position, so a
    shoal is never hidden at coarse zoom; a level is built from the one below it, since
    pyramid cells nest. A sounding deep enough to thin shows from a coarser level.
    A sounding at a position in `primes`, {(lon, lat): minzoom}, is left out from that
    zoom on, where it publishes as a prime sounding; below it, the pyramid shows it.
    """
    primes = primes or {}
    max_shift = max(s for _, s in THIN_TIERS)
    n = 2**MAX_ZOOM * CELLS_PER_TILE
    # The shoalest per pyramid cell, as the least (depth, lon, lat): a grouped aggregate
    # spills past the memory limit, and ties break on position, not on read order.
    con.execute(
        f"""CREATE OR REPLACE TEMP TABLE pyramid AS
        SELECT px, py,
          min(struct_pack(d := d, lon := lon, lat := lat, unconfirmed := unconfirmed)) AS s
        FROM (SELECT floor(mx * {n})::BIGINT AS px, floor(my * {n})::BIGINT AS py, *
          FROM (SELECT *, {MERCATOR} FROM ({SOURCES})))
        GROUP BY px, py"""
    )
    for level in range(MAX_ZOOM - MIN_ZOOM + 1 + max_shift):
        if level:
            con.execute(
                """CREATE OR REPLACE TEMP TABLE pyramid AS
                SELECT px // 2 AS px, py // 2 AS py, min(s) AS s FROM pyramid GROUP BY ALL"""
            )
        zoom = MAX_ZOOM - level
        rows = con.execute("SELECT s.lon, s.lat, s.d, s.unconfirmed FROM pyramid ORDER BY px, py")
        while batch := rows.fetchmany(10_000):
            for lon, lat, d, unconfirmed in batch:
                display = zoom + thin_shift(d)
                at = (round(lon, COORD_DECIMALS), round(lat, COORD_DECIMALS))
                if MIN_ZOOM <= display <= MAX_ZOOM and display < primes.get(at, 99):
                    yield feature(lon, lat, d, unconfirmed, display)
    con.execute("DROP TABLE pyramid")


def written(d):
    """The decimal a float32 depth was written as: 20.9 is stored as 20.8999996, which
    would floor to 20.8."""
    return float(str(np.float32(d)))


def feature(lon, lat, d, unconfirmed, display, prime=False):
    """A SOUNDG feature. A prime sounding, the least depth inside a closed isobath, shows
    from `display` at every zoom past it, so a finer level never swaps it out."""
    d = written(d)
    properties = depths(d) | QUALITY[unconfirmed]
    properties |= {"VALSOU": _floor(d * 100) / 100, "TECSOU": TECSOU}
    if unconfirmed:
        properties["unconfirmed"] = 1
    if prime:
        properties["prime"] = 1
    return {
        "type": "Feature",
        "tippecanoe": {"layer": "SOUNDG", **({"minzoom": display} if prime else zooms(display))},
        "geometry": {
            "type": "Point",
            "coordinates": [round(lon, COORD_DECIMALS), round(lat, COORD_DECIMALS)],
        },
        "properties": properties,
    }


# S-4 B-411 isobaths in metres, positive down, as Seascape charts them. Each is also a
# depth-area band edge: a band holds depths from its level to the next. Tide-reduced
# depths can be negative, drying heights, so the first band holds everything that dries,
# and 0 m is the drying line.
DRYING_M = MIN_DEPTH_M
LEVELS = [DRYING_M, *PORTRAYAL["isobaths_m"]]
# Isobaths drawn below each zoom ceiling (Seascape's CONTOUR_TIERS); every one from the last on.
CONTOUR_TIERS = [(t["below_zoom"], t["isobaths_m"]) for t in PORTRAYAL["contour_tiers"]]
FIRST_AREA_ZOOM = 4
# Past this an enclosed rise is a seabed feature, not a least depth a vessel can touch.
PRIME_MAX_DEPTH_M = 200
# Crowd positions are good to about 10 m.
POSACC_M = 10
INFORM = (
    "Crowdsourced soundings from Open Waters and NOAA's CSB archive. Where tide levels and "
    "vessel calibrations are available, depths are reduced for tide and corrected for vessel "
    "offsets; they are not corrected for sound speed."
)


def level_minzoom(level):
    """The zoom an isobath first draws at; a prime sounding inside it shows from there too."""
    previous = FIRST_AREA_ZOOM
    for ceiling, levels in CONTOUR_TIERS:
        if level in levels:
            return previous
        previous = ceiling
    return previous


def band(d):
    """DRVAL1 and DRVAL2 of the band holding depth d; the deepest band has no lower edge."""
    i = int(np.searchsorted(LEVELS, d, side="right")) - 1
    return LEVELS[max(i, 0)], LEVELS[i + 1] if i + 1 < len(LEVELS) else None


# Areas and contours stop here: crowd soundings deeper than this are mostly sounders
# that have lost bottom, so deeper water shows soundings only.
MAX_AREA_DEPTH_M = 200

# A tile's cells for its coverage's properties. Cells keep only the month, or the
# year of a single vessel's cell, so a survey ends at the end of that period, never
# after today.
TILE_QUALITY = """
SELECT min(first),
  least(max(CASE WHEN kind = 'single' THEN last + INTERVAL 1 YEAR ELSE last + INTERVAL 1 MONTH
    END - INTERVAL 1 DAY), current_date),
  sum(count), max(tvu)
FROM lake.cells WHERE cell_id = $partition AND tile_id = $tile AND depth IS NOT NULL"""

# A tile's published cell soundings shallow enough to be primes: a prime is the least
# depth published inside its isobath, at that cell's sounding. In order, so of equal
# depths the first, which tile_areas takes, is the westmost, then southmost, as the
# pyramid breaks ties, however the store's files hold the rows.
PRIME_CANDIDATES = f"""
SELECT depth_lon AS lon, depth_lat AS lat, depth FROM lake.cells
WHERE cell_id = $partition AND tile_id = $tile AND depth <= $max
  AND abs(depth_lat) <= {MERCATOR_MAX_LAT}
ORDER BY depth, lon, lat"""


# Every published sounding, cell or shoal, in a tile or within a margin of it, from the
# tile and its neighbors: the depths carried past the surface's edge are capped by them.
# Longitudes are taken east of the tile's west edge, so a neighbor across the
# antimeridian lines up with it.
NEARBY_SOUNDINGS = """
SELECT $lon0 + east AS lon, lat, d FROM (
  SELECT (depth_lon - $lon0 + 540) % 360 - 180 AS east, depth_lat AS lat, depth AS d
  FROM lake.cells
  WHERE list_contains($partitions, cell_id) AND list_contains($tiles, tile_id)
    AND depth IS NOT NULL
  UNION ALL
  SELECT (lon - $lon0 + 540) % 360 - 180, lat, depth FROM lake.shoals
  WHERE list_contains($partitions, cell_id) AND list_contains($tiles, tile_id)
) WHERE east BETWEEN -$margin_lon AND 1 + $margin_lon
  AND lat BETWEEN $lat0 - $margin_lat AND $lat0 + 1 + $margin_lat"""


def nearby_soundings(con, tile, transform):
    """The published soundings in `tile`, or in the pixels beside it in its neighbors
    (by `transform`, its surface's), as (lon, lat, depth)."""
    lat0, lon0 = tile // 360 - 90, tile % 360 - 180
    around = [(lat0 + dy, (lon0 + dx + 180) % 360 - 180) for dy in (-1, 0, 1) for dx in (-1, 0, 1)]
    around = [(lat, lon) for lat, lon in around if -90 <= lat < 90]
    got = con.execute(
        NEARBY_SOUNDINGS,
        {
            "partitions": sorted({surface.partition_of(lat, lon) for lat, lon in around}),
            "tiles": [(lat + 90) * 360 + lon + 180 for lat, lon in around],
            "lon0": lon0,
            "lat0": lat0,
            "margin_lon": 1.5 * abs(transform.a),
            "margin_lat": 1.5 * abs(transform.e),
        },
    ).fetchnumpy()
    return got["lon"], got["lat"], got["d"]


def areas(con, surfaces: Path):
    """Yield DEPARE, DEPCNT and M_QUAL features, and prime SOUNDG features, tile by tile.

    Each tile's depth surface is built into `surfaces`, and its depth areas are cut
    from it on the isobath ladder. A contour is the boundary the areas shoaler than its
    level share with those at or deeper than it, so the edge of coverage is never drawn
    as a contour. Work stays within a 1° tile, and a tile's memory is bounded by its
    surface's pixels.
    """
    for tile, partition in surface.tiles(con):
        path = surface.build_tile(con, tile, partition, surfaces)
        if path is None:
            continue
        params = {"partition": partition, "tile": tile}
        first, last, count, tvu = con.execute(TILE_QUALITY, params).fetchone()
        got = con.execute(PRIME_CANDIDATES, params | {"max": PRIME_MAX_DEPTH_M}).fetchnumpy()
        candidates = got["lon"], got["lat"], got["depth"]
        with rasterio.open(path) as src:
            nearby = nearby_soundings(con, tile, src.transform)
        bands, footprint, surfaced, interpolated, interpolated_tvu = surface_bands(path, nearby)
        properties = quality(first, last, count, tvu)
        estimated = (interpolated, quality(first, last, 0, interpolated_tvu))
        yield from tile_areas(candidates, properties, bands, footprint, surfaced, estimated)


def surface_bands(path, soundings=None):
    """A tile surface's depth bands, {band: polygon} indexed into LEVELS; its coverage,
    where it has a depth or a sounding, grown by a pixel all round so a lone track's
    soundings sit inside it; the surface itself, grown the same way; the part of the
    surface interpolated, more than a pixel from any sounding; and that part's largest
    vertical uncertainty at 95%, as cells' `tvu`.

    Bands come from `gdal_contour -p`, which follows the surface between pixels rather
    than around them, on the surface's depths carried FILL_PX past its edge, and are cut
    to the surface's `outline`. A carried depth is never deeper than one of `soundings`,
    (lon, lat, depth) arrays of the published soundings in and beside the tile, in its
    pixel or next to it, as the surface guards its own pixels. All water past
    MAX_AREA_DEPTH_M is one more band, kept for the contour at its edge but never
    published: `gdal_contour -p` makes no polygon past its last level.
    """
    levels = [lv for lv in LEVELS if lv <= MAX_AREA_DEPTH_M] + [MAX_DEPTH_M]
    with rasterio.open(path) as src:
        depth, count = src.read(1), src.read(3)
        # Worked on the window the tile's depths and soundings reach, WINDOW_PX past them:
        # outside it every band is empty, and nothing here looks further than that.
        # By rows and columns that hold any, not by pixel: a covered tile has 29M pixels.
        data = (depth != surface.NODATA) | (count > 0)
        rows, cols = np.flatnonzero(data.any(axis=1)), np.flatnonzero(data.any(axis=0))
        del data
        if len(rows):
            r0, c0 = max(rows[0] - WINDOW_PX, 0), max(cols[0] - WINDOW_PX, 0)
            r1 = min(rows[-1] + 1 + WINDOW_PX, depth.shape[0])
            c1 = min(cols[-1] + 1 + WINDOW_PX, depth.shape[1])
        else:
            r0, c0, r1, c1 = 0, 0, 1, 1
        window = rasterio.windows.Window(c0, r0, c1 - c0, r1 - r0)
        tile_shape = depth.shape
        # Copies, so the whole tile's bands are freed while the window is worked.
        depth, count = depth[r0:r1, c0:c1].copy(), count[r0:r1, c0:c1].copy()
        sigma = src.read(4, window=window)
        transform = src.window_transform(window)
        profile = src.profile | {"width": c1 - c0, "height": r1 - r0, "transform": transform}
    valid = depth != surface.NODATA
    around = np.ones((3, 3), dtype=bool)
    # Grown a pixel all round, as coverage is, so the two trace alike.
    surfaced = outline(binary_dilation(valid, structure=around), transform)
    bands = {}
    if valid.any():
        # Each empty pixel near the surface takes its nearest pixel's depth, so the bands
        # reach past the outline, which cuts them.
        far, (rows, cols) = distance_transform_edt(~valid, return_indices=True)
        grown = depth[rows, cols]
        grown[far > FILL_PX] = surface.NODATA
        if soundings is not None and len(soundings[2]):
            lon, lat, d = (np.asarray(a, dtype=float) for a in soundings)
            row, col = (np.asarray(a) for a in rasterio.transform.rowcol(transform, lon, lat))
            # One in the pixel beside the tile caps the edge pixels next to it; the window
            # is the only part of the tile with pixels to cap.
            row = np.clip(row + r0, 0, tile_shape[0] - 1) - r0
            col = np.clip(col + c0, 0, tile_shape[1] - 1) - c0
            inside = (row >= 0) & (row < depth.shape[0]) & (col >= 0) & (col < depth.shape[1])
            row, col, d = row[inside], col[inside], d[inside]
            cap = np.full(depth.shape, np.inf, dtype=np.float32)
            np.minimum.at(cap, (row, col), d)
            cap = minimum_filter(cap, footprint=around)
            grown[~valid] = np.minimum(grown[~valid], cap[~valid])
            del cap
        reach = shapely.MultiPolygon(
            [
                shapely.geometry.shape(g)
                for g, v in rasterio.features.shapes(
                    (far <= FILL_PX).astype("uint8"), transform=transform
                )
                if v
            ]
        )
        del far, rows, cols
        with tempfile.TemporaryDirectory(dir=os.environ.get("GRID_TEMP_DIR") or None) as tmp:
            src_path, out = Path(tmp) / "depth.tif", Path(tmp) / "bands.geojson"
            profile.update(driver="GTiff", count=1, dtype="float32", nodata=surface.NODATA)
            with rasterio.open(src_path, "w", **profile) as dst:
                dst.write(grown, 1)
            del grown
            subprocess.run(
                ["gdal_contour", "-q", "-p", "-b", "1", "-amin", "lo", "-amax", "hi",
                 "-fl", *map(str, levels), str(src_path), str(out)],
                check=True,
            )  # fmt: skip
            features = json.loads(out.read_text())["features"]
        for f in features:
            b = int(np.searchsorted(LEVELS, f["properties"]["lo"], side="right")) - 1
            part = shapely.make_valid(shapely.from_geojson(json.dumps(f["geometry"])))
            bands[b] = shapely.union(bands[b], part) if b in bands else part
        # Where the outline bulges past the depths' reach, as at a corner it rounds on the
        # tile's edge, the shoalest band beside it takes the rest.
        rest = shapely.get_parts(polygonal(shapely.difference(surfaced, reach)))
        rest = rest[shapely.area(rest) > 1e-4 * abs(transform.a * transform.e)]
        tree, taken = shapely.STRtree(rest), np.zeros(len(rest), dtype=bool)
        for b in sorted(bands):
            band = polygonal(shapely.intersection(surfaced, bands[b]))
            near = tree.query(band, predicate="dwithin", distance=1e-6 * abs(transform.a))
            near = near[~taken[near]]
            taken[near] = True
            bands[b] = shapely.union(band, shapely.MultiPolygon(list(rest[near])))
        bands = {b: a for b, a in bands.items() if not a.is_empty}
    # Where interpolation starts is drawn more loosely than the edge of the water, on the
    # surface as it's grown, so the growth is measured only beside a sounding. It's grown a
    # pixel into the measured part too: rounding would lose a strip a pixel wide, and
    # interpolated water must never be drawn as measured.
    far_from_soundings = ~binary_dilation(count > 0, structure=around)
    grown_interpolated = binary_dilation(valid, structure=around) & far_from_soundings
    grown_interpolated = binary_dilation(grown_interpolated, structure=around)
    # Its uncertainty is the largest of the surface's pixels it's drawn over or beside.
    interpolated = valid & binary_dilation(grown_interpolated, structure=around)
    d, s = depth[interpolated], sigma[interpolated]
    tvu = (
        float(np.maximum(cells.TOLERANCE_M + cells.TOLERANCE_PER_M * d, 1.96 * s).max())
        if len(d)
        else None
    )
    between = outline(grown_interpolated, transform, INTERPOLATED_TOLERANCE_PX)
    between = polygonal(shapely.intersection(between, surfaced))
    # Coverage is the surface, and the soundings off it grown a pixel all round and traced
    # on their own: tracing them together would bend the surface's edge wherever a sounding
    # sits beside it, and could cut a sounding's corner.
    lone = binary_dilation((count > 0) & ~valid, structure=around)
    footprint = polygonal(shapely.union(surfaced, outline(lone, transform)))
    # Rounding can shave a sounding's pixel at a sharp tip; such a pixel joins whole. Only
    # pixels within a few of the edge can be.
    covered = binary_dilation(valid | (count > 0), structure=around)
    rim = covered & ~binary_erosion(covered, structure=around, iterations=3)
    row, col = np.nonzero((count > 0) & rim)
    x0, y0 = rasterio.transform.xy(transform, row, col, offset="ul")
    x1, y1 = rasterio.transform.xy(transform, row, col, offset="lr")
    pixels = shapely.box(x0, y0, x1, y1)
    shapely.prepare(footprint)
    shaved = pixels[~shapely.covers(footprint, pixels)]
    if len(shaved):
        footprint = polygonal(shapely.union(footprint, shapely.union_all(shaved)))
    return bands, footprint, surfaced, between, tvu


# Pixels past the surface's edge its depths are carried, for the bands to reach its
# outline, which is grown a pixel and fills small gaps.
FILL_PX = 2
# Pixels past a tile's depths and soundings its bands are worked to: wider than the
# furthest anything looks, coverage grown a pixel and then eroded three for its rim.
WINDOW_PX = 16
# Potrace keeps a corner where a turn is sharper than this; past 4/3 it keeps none, but
# then rounds a corner between long sides over half their length.
POTRACE_ALPHAMAX = 1.2
# The radius, in pixels, every corner is rounded to after tracing: a corner is unnatural
# in bathymetry, and a fixed radius moves the edge a fraction of a pixel at most.
CORNER_PX = 0.5
POTRACE_OPTTOLERANCE = 1.0
# Pixels a mask is carried past the raster's edge before tracing.
PAD_PX = 4
# Gaps in a mask this many pixels or smaller are filled, not traced.
MAX_GAP_PX = 4
# The window reaches past everything that looks beyond the data: the carried depths and
# the cap beside them, the rim's growth and erosion, and the tracer's padding and gaps.
assert WINDOW_PX > max(FILL_PX + 1, 1 + 3, PAD_PX + MAX_GAP_PX), "WINDOW_PX is too narrow"
# How far, in pixels, an outline's points may stray from its curve.
EDGE_TOLERANCE_PX = 0.1
INTERPOLATED_TOLERANCE_PX = 0.5


def outline(mask, transform, tolerance=None):
    """The edge of `mask` as one geometry, traced by Potrace as smooth curves rather than
    pixel steps, with gaps of up to MAX_GAP_PX pixels and notches up to two pixels wide
    filled. The mask's pixels past the raster's edge are taken to repeat its last, so the
    edge meets the raster's edge square and stops there."""
    if not mask.any():
        return shapely.Polygon()
    pad = PAD_PX
    padded = np.pad(mask, pad, mode="edge")
    # Inlets and notches a pixel or two wide would trace as sharp V's; they're filled.
    padded = binary_closing(padded, structure=np.ones((3, 3), bool)) | padded
    # Gaps of a few pixels, as between tracks, are filled rather than traced as holes.
    gaps, n = label(~padded)
    padded |= (np.bincount(gaps.ravel(), minlength=n + 1) <= MAX_GAP_PX)[gaps] & (gaps > 0)
    tolerance = tolerance or EDGE_TOLERANCE_PX
    # A step for each 30° a curve turns on the water's edge, each 60° on looser edges.
    turn_step = np.pi / 6 if tolerance <= EDGE_TOLERANCE_PX else np.pi / 3
    rows, cols = mask.shape
    traced = potrace(padded, tolerance, turn_step)
    # Closing then opening by a disc rounds concave and convex corners alike.
    segments = int(np.ceil((np.pi / 2) / turn_step))
    for r in (CORNER_PX, -2 * CORNER_PX, CORNER_PX):
        traced = shapely.buffer(traced, r, quad_segs=segments)
    # Every turn now has at least that radius, so dropping points within `tolerance` of
    # the curve leaves no sharp angle.
    traced = shapely.simplify(traced, tolerance)
    shape = polygonal(shapely.clip_by_rect(traced, pad, pad, cols + pad, rows + pad))
    # Traced shapes a fraction of a pixel apart, as an island in a hole, can cross.
    if not shape.is_valid:
        shape = polygonal(shapely.make_valid(shape))
    a, b, c, d, e, f = transform[:6]
    return shapely.transform(
        shape, lambda xy: (xy - pad) @ np.array([[a, d], [b, e]]) + np.array([c, f])
    )


def potrace(mask, tolerance, turn_step):
    """`mask` traced by Potrace, in pixels from its top left, its curves flattened to
    within `tolerance` pixels and stepping at most `turn_step` radians at a time."""
    rows, cols = mask.shape
    with tempfile.TemporaryDirectory(dir=os.environ.get("GRID_TEMP_DIR") or None) as tmp:
        bitmap, out = Path(tmp) / "mask.pbm", Path(tmp) / "mask.svg"
        bitmap.write_bytes(b"P4\n%d %d\n" % (cols, rows) + np.packbits(mask, axis=1).tobytes())
        subprocess.run(
            ["potrace", "-b", "svg", "-t", "0", "-a", str(POTRACE_ALPHAMAX),
             "-O", str(POTRACE_OPTTOLERANCE), "-o", str(out), str(bitmap)],
            check=True,
        )  # fmt: skip
        paths = re.findall(r'<path d="([^"]*)"', out.read_text())
    shapes = []
    for d in paths:
        rings = [
            np.array(r) * [0.1, -0.1] + [0, rows] for r in svg_rings(d, tolerance * 10, turn_step)
        ]
        if not rings:
            continue
        # Each path is a shape and its holes; a shape inside a hole is a path of its own.
        rings.sort(key=lambda r: -abs(shapely.area(shapely.Polygon(r))))
        shapes.append(shapely.make_valid(shapely.Polygon(rings[0], rings[1:])))
    return polygonal(shapely.GeometryCollection(shapes))


def svg_rings(d, tolerance, turn_step):
    """The closed rings of a Potrace SVG path, in its units: an absolute move, then
    relative cubic Béziers, lines and moves, each ring closed by z. Each Bézier is cut
    into as few even steps as keep it within `tolerance` (Wang's bound), so a gentle
    curve takes few points, and a step for each `turn_step` radians it turns, so a short
    tight turn is never cut to a spike."""
    tokens = re.findall(r"[MmclzZ]|-?[\d.]+", d)
    rings, ring, at, start, cmd, i = [], [], np.zeros(2), np.zeros(2), "", 0
    while i < len(tokens):
        if tokens[i] in "MmclzZ":
            cmd = tokens[i]
            i += 1
            if cmd in "zZ":
                rings.append(ring)
                ring, at = [], start.copy()
            continue
        if cmd in "Mm":
            at = np.array(tokens[i : i + 2], float) + (at if cmd == "m" else 0)
            start, ring = at.copy(), [tuple(at)]
            i += 2
        elif cmd == "l":
            at = at + np.array(tokens[i : i + 2], float)
            ring.append(tuple(at))
            i += 2
        else:
            p1, p2, p3 = at + np.array(tokens[i : i + 6], float).reshape(3, 2)
            bend = max(np.linalg.norm(at - 2 * p1 + p2), np.linalg.norm(p1 - 2 * p2 + p3))
            u0, u1 = p1 - at, p3 - p2
            turn = np.arccos(
                np.clip(u0 @ u1 / (np.linalg.norm(u0) * np.linalg.norm(u1) + 1e-12), -1, 1)
            )
            steps = max(
                1, int(np.ceil(np.sqrt(0.75 * bend / tolerance))), int(np.ceil(turn / turn_step))
            )
            t = np.linspace(0, 1, steps + 1)[1:, None]
            u = 1 - t
            ring += map(tuple, u**3 * at + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t**3 * p3)
            at = p3
            i += 6
    return [r for r in rings if len(r) > 2]


def polygonal(geometry):
    """The polygons in `geometry`, one or many: where shapes only touch, cutting one
    with another leaves lines and points too."""
    parts = shapely.get_parts(shapely.get_parts(geometry))
    return shapely.MultiPolygon(list(parts[shapely.get_type_id(parts) == 3]))


def tile_areas(candidates, properties, bands, footprint, surfaced=None, interpolated=None):
    """Features for one tile: its depth areas from the surface's `bands`, its coverage
    `footprint` with `properties`, the contours between bands, and prime soundings from
    `candidates`, the (lon, lat, depth) arrays of the tile's published cell soundings, of
    which a tie goes to the first. An
    isobath is closed when the surface, `surfaced` (the footprint if not given), has
    deeper water all round it. `interpolated`, (geometry, properties), is the part of
    the footprint drawn between tracks: its coverage is a separate M_QUAL marked
    `interpolated`, so styles can show it, and the rest is marked `measured`."""
    surfaced = footprint if surfaced is None else surfaced
    deepest = int(np.searchsorted(LEVELS, MAX_AREA_DEPTH_M, side="right")) - 1
    for b, area in bands.items():
        if b < deepest:
            lo, hi = band(LEVELS[b])
            yield shape("DEPARE", area, {"DRVAL1": lo, "DRVAL2": hi}, FIRST_AREA_ZOOM)
    if footprint.is_empty:
        return
    if interpolated is None or interpolated[0].is_empty:
        yield shape("M_QUAL", footprint, properties | {"kind": "measured"}, 0)
    else:
        between, estimated = interpolated
        measured = shapely.difference(footprint, between)
        if not measured.is_empty:
            yield shape("M_QUAL", measured, properties | {"kind": "measured"}, 0)
        yield shape("M_QUAL", between, estimated | {"kind": "interpolated"}, 0)
    shapely.prepare(surfaced)
    lon, lat, depth = (np.asarray(a, dtype=float) for a in candidates)
    points = shapely.points(lon, lat)
    tree = shapely.STRtree(points)
    # The areas shoaler than each level and at or deeper than it, built up one band at
    # a time from each end rather than from every band at every level.
    shoaler, deeper = {}, {}
    area = shapely.Polygon()
    for i in range(1, deepest + 1):
        area = shapely.union(area, bands[i - 1]) if i - 1 in bands else area
        shoaler[i] = area
    area = shapely.Polygon()
    for i in reversed(range(1, len(LEVELS))):
        area = shapely.union(area, bands[i]) if i in bands else area
        deeper[i] = area
    primes = {}
    for i in range(1, deepest + 1):
        v = LEVELS[i]
        if shoaler[i].is_empty or deeper[i].is_empty:
            continue
        line = lines(shapely.intersection(shoaler[i].boundary, deeper[i].boundary))
        if line.is_empty:
            continue
        yield shape("DEPCNT", line, {"VALDCO": v, "QUAPOS": 4}, level_minzoom(v))
        if v > PRIME_MAX_DEPTH_M or not len(points):
            continue
        rings = shapely.get_parts(shoaler[i])
        # A closed isobath: deeper water all the way round, so the shoal grown by about
        # a centimetre is still all surface; touching the surface's edge, even at a
        # corner, leaves it open.
        closed = shapely.covers(surfaced, shapely.buffer(rings, 1e-7, quad_segs=1))
        ring_of, point = tree.query(rings[closed], predicate="contains")
        for r in np.unique(ring_of):
            # In the candidates' order, so a tie goes to the first, whatever order the
            # tree returns them in.
            inside = np.sort(point[ring_of == r])
            j = int(inside[np.argmin(depth[inside])])
            key = (float(lon[j]), float(lat[j]))
            primes[key] = min(primes.get(key, (99, 0))[0], level_minzoom(v)), depth[j]
    for (x, y), (z, d) in primes.items():
        yield feature(x, y, float(d), False, max(z, MIN_ZOOM), prime=True)


def lines(geometry):
    """The line parts of an intersection, merged; corners where areas only touch drop out."""
    parts = [g for g in shapely.get_parts(geometry) if g.geom_type == "LineString"]
    return shapely.line_merge(shapely.union_all(parts)) if parts else shapely.LineString()


def quality(first, last, count, tvu):
    """A tile's coverage: CATZOC D, its survey dates, the largest vertical uncertainty
    of its cells (SOUACC), rounded up, and the crowd's horizontal one (POSACC), and its
    soundings."""
    properties = {
        "CATZOC": 5,
        "POSACC": POSACC_M,
        # Through the decimal tvu was written as: float32 2.2 is 2.2000000477.
        "SOUACC": math.ceil(round(written(tvu) * 10, 6)) / 10 if tvu else None,
        "TECSOU": TECSOU,
        "soundings": int(count or 0),
        "INFORM": INFORM,
    }
    if first and last:
        properties |= {"SURSTA": first.strftime("%Y%m%d"), "SUREND": last.strftime("%Y%m%d")}
    return properties


def shape(layer, geometry, properties, minzoom):
    geometry = shapely.set_precision(geometry, 10**-COORD_DECIMALS)
    return {
        "type": "Feature",
        "tippecanoe": {"layer": layer, "minzoom": minzoom},
        "geometry": json.loads(shapely.to_geojson(geometry)),
        "properties": properties,
    }


def write(features, path):
    """Write features as line-delimited GeoJSON; returns how many."""
    count = 0
    with open(path, "w") as f:
        for feat in features:
            f.write(json.dumps(feat, separators=(",", ":")) + "\n")
            count += 1
    return count


def attribution(con):
    """The tiles' credit line: the soundings' sources, plus the tide stations and surveyed
    references the corrections used, whose licenses ask for credit."""
    credits = ["Crowd Depth, NOAA DCDB crowdsourced bathymetry"]
    if con.execute("SELECT count(*) FROM lake.tide_levels").fetchone()[0]:
        credits.append("tides from Slackwater (https://openwaters.io/tides/slackwater/)")
        credits += [
            a
            for (a,) in con.execute(
                """SELECT DISTINCT coalesce(attribution, concat_ws(', ', station, license))
                FROM lake.tide_stations
                WHERE lower(coalesce(license, '')) <> 'public domain'
                  AND station_id IN (SELECT DISTINCT station_id FROM lake.tide_levels)
                ORDER BY 1"""
            ).fetchall()
        ]
    if con.execute("SELECT count(*) FROM lake.calibration WHERE status = 'anchored'").fetchone()[0]:
        names = {"s102": "NOAA S-102", "bluetopo": "NOAA BlueTopo"}
        used = sorted(
            {
                names.get(source, "surveyed references")
                for (source,) in con.execute(
                    "SELECT DISTINCT source FROM lake.reference_pixels WHERE depth IS NOT NULL"
                ).fetchall()
            }
        )
        credits.append("vessels calibrated against " + " and ".join(used))
    return "; ".join(credits)


def describe(con):
    """The archive's metadata: its name and credits, and the type, version and date a
    client reads. Freeboard applies S-52 styling to a vector chart whose type is S-57, and
    the version and date let a client tell when an extract is out of date."""
    built = datetime.now(UTC).strftime("%Y-%m-%d")
    return {
        "name": "Crowd Depth",
        "description": f"Crowd Depth grid {GRID_VERSION}, built {built}",
        "attribution": attribution(con),
        "type": "S-57",
        "version": str(GRID_VERSION),
        "built": built,
    }


def check_corrections(con):
    """Refuse a store whose tide or calibration is behind its soundings."""
    # Once a store reduces tide, every area must have been seen by `grid tide`: a sounding
    # in one it hasn't would publish raw, deeper than chart datum.
    if (
        con.execute("SELECT count(*) FROM lake.tide_stations").fetchone()[0]
        and con.execute(
            f"""SELECT count(*) FROM lake.points p
        WHERE {TIDE_CELL} NOT IN (SELECT tide_cell FROM lake.tide_cells)"""
        ).fetchone()[0]
    ):
        raise RuntimeError("soundings in areas `grid tide` hasn't seen; run `grid tide` first")
    # Offsets solved against other tide levels would leave a tide in, or take one out twice.
    solved = con.execute(
        "SELECT value FROM lake.store_meta WHERE key = 'calibration_tide'"
    ).fetchone()
    applied = con.execute("SELECT count(*) FROM lake.file_offsets").fetchone()[0]
    if applied and (solved is None or solved[0] != cells.tides(con)):
        raise RuntimeError("tide levels changed since calibration; run `grid calibrate` first")


def build(con, out):
    """Write the layers as line-delimited GeoJSON in `out`, then tile them into
    `out/overlay.pmtiles`. Returns the feature counts.

    The cells and their QC must be this build's: overlay reads them as they are, so
    run `grid cells` first after an upgrade.
    """
    # Cells, flags and points must all be from the last full `grid cells` run, by this
    # build's code: an ingest, withdrawal, QC run or upgrade since changes the inputs.
    built = con.execute("SELECT value FROM lake.store_meta WHERE key = 'cells'").fetchone()
    if built is None or built[0] != cells.inputs(con):
        raise RuntimeError("cells aren't current with the store; run `grid cells` first")
    check_corrections(con)
    out.mkdir(parents=True, exist_ok=True)
    surfaces = out / "surface"
    # Only last build's tiles: a tile with no soundings now must not linger.
    for old in surfaces.glob("*.tif"):
        old.unlink()
    # A failed build leaves no archive, rather than the last one beside new layers.
    (out / "overlay.pmtiles").unlink(missing_ok=True)
    # Areas first, so the prime soundings they find replace their copies in the pyramid.
    primes = {}

    def noting(features):
        for f in features:
            if f["properties"].get("prime"):
                primes[tuple(f["geometry"]["coordinates"])] = f["tippecanoe"]["minzoom"]
            yield f

    counts = {"areas": write(noting(areas(con, surfaces)), out / "areas.geojsons")}
    counts["soundings"] = write(soundings(con, primes), out / "soundings.geojsons")
    if not any(counts.values()):
        raise RuntimeError("nothing to tile: the store has no cells")
    meta = describe(con)
    mbtiles = out / "overlay.mbtiles"
    subprocess.run(
        [
            "tippecanoe",
            *("-o", str(mbtiles), "--force", "--quiet"),
            *("-Z0", f"-z{MAX_ZOOM}"),
            # Every sounding at its own zooms, never dropped for density or tile size: the
            # pyramid already thinned them, shoalest first.
            *("-r1", "--no-feature-limit", "--no-tile-size-limit"),
            # Depth areas share their edges, so simplify them alike and leave no gaps, and
            # a small shoal area is never merged away at low zoom.
            "--detect-shared-borders",
            "--no-tiny-polygon-reduction",
            *("-n", meta["name"], "-N", meta["description"], "-A", meta["attribution"]),
            str(out / "soundings.geojsons"),
            str(out / "areas.geojsons"),
        ],
        check=True,
    )
    # Tippecanoe can't write custom metadata, so it goes in through MBTiles on the way to
    # PMTiles.
    with contextlib.closing(sqlite3.connect(mbtiles)) as db, db:
        db.executemany(
            "INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)",
            [(k, meta[k]) for k in ("type", "version", "built")],
        )
    mbtiles_to_pmtiles(str(mbtiles), str(out / "overlay.pmtiles"), None)
    mbtiles.unlink()
    return counts
