"""Overlay layers: the grid as S-57 features in line-delimited GeoJSON, for tippecanoe.

SOUNDG follows Seascape's soundings (pipelines/soundings_run.py) so its sounding style
draws the layer unchanged: the same depth labels, rounded toward shoal, and the same
shoalest-wins pyramid. Each sounding sits at the position of the sounding that set its
cell's depth, never at a cell center, and unconfirmed shoals publish alongside the
cells' soundings with a flag of their own.
"""

import contextlib
import json
import math
import os
import sqlite3
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import rasterio
import rasterio.features
import shapely
import shapely.geometry
from pmtiles.convert import mbtiles_to_pmtiles
from scipy.ndimage import binary_dilation

from . import cells, surface
from .cells import GRID_VERSION
from .qc import MAX_DEPTH_M

M_PER_FT = 0.3048
M_PER_FATHOM = 1.8288

# S-4, Ed 4.10.0, B-412 rounds by depth band, always toward shoal: decimetres to 21 m,
# half metres from 21 to 31, whole metres beyond.
DECIMETRE_MAX_M = 21.0
HALF_METRE_MAX_M = 31.0

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
    if d < DECIMETRE_MAX_M:
        m = _floor(d * 10) / 10
    elif d < HALF_METRE_MAX_M:
        m = _floor(d * 2) / 2
    else:
        m = _floor(d)
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


# What SOUNDG is made of: every measured cell (filled cells have no sounding) at the
# position of the sounding that set its depth, and every unconfirmed shoal, which the
# cells build keeps.
# ponytail: reads every cell; split by 10° partition when the overlay builds by region
# Web Mercator stops at about 85.05°; soundings past it have no tile to go in.
MERCATOR_MAX_LAT = 85.0511
SOURCES = f"""
SELECT * FROM (
  SELECT depth_lon AS lon, depth_lat AS lat, depth AS d, false AS unconfirmed
  FROM lake.cells WHERE kind <> 'filled' AND depth IS NOT NULL
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
# depth-area band edge: a band holds depths from its level to the next.
LEVELS = [0, 2, 5, 10, 20, 30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 4000, 5000, 6000]
LEVELS += [8000, 10000]
# Isobaths drawn below each zoom ceiling (Seascape's CONTOUR_TIERS); every one from the last on.
CONTOUR_TIERS = [
    (6, [10, 20, 50, 100, 200, 1000, 2000, 4000]),
    (7, [10, 20, 50, 100, 200, 500, 1000, 2000, 3000, 4000]),
    (9, [10, 20, 50, 100, 200, 300, 500, 1000, 2000, 3000, 4000, 5000, 6000, 8000, 10000]),
    (11, [10, 20, 30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 4000, 5000, 6000, 8000, 10000]),
]
FIRST_AREA_ZOOM = 4
# Past this an enclosed rise is a seabed feature, not a least depth a vessel can touch.
PRIME_MAX_DEPTH_M = 200
# Crowd positions are good to about 10 m.
POSACC_M = 10
INFORM = (
    "Crowdsourced soundings from Open Waters and NOAA's CSB archive, not corrected for tide, "
    "datum or sound speed."
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


def areas(con, surfaces: Path):
    """Yield DEPARE, DEPCNT and M_QUAL features, and prime SOUNDG features, tile by tile.

    Each tile's depth surface is built into `surfaces`, and its depth areas are cut
    from it on the isobath ladder. A contour is the boundary the areas shoaler than its
    level share with those at or deeper than it, so the edge of coverage is never drawn
    as a contour. Work stays within a 1° tile, and a tile's memory is bounded by its
    surface's pixels.
    """
    for tile, partition in surface.tiles(con):
        built = surface.build_tile(con, tile, partition, surfaces)
        if built is None:
            continue
        path, (lon, lat, depth) = built
        params = {"partition": partition, "tile": tile}
        first, last, count, tvu = con.execute(TILE_QUALITY, params).fetchone()
        # Each sounded pixel's shoalest accepted sounding: a prime is the least depth
        # actually measured inside its isobath, the sounding that drew it.
        # ponytail: its cell's own sounding still shows beside it from the prime's zoom
        # when the two differ; median − kσ redefines both, so they're left apart until then
        shallow = (depth <= PRIME_MAX_DEPTH_M) & (np.abs(lat) <= MERCATOR_MAX_LAT)
        candidates = lon[shallow], lat[shallow], depth[shallow]
        bands, footprint, surfaced = surface_bands(path)
        properties = quality(first, last, count, tvu)
        yield from tile_areas(candidates, properties, bands, footprint, surfaced)


def surface_bands(path):
    """A tile surface's depth bands, {band: polygon} indexed into LEVELS; its coverage,
    where it has a depth or a sounding, grown by a pixel all round so a lone track's
    soundings sit inside it; and the surface itself, where it has a depth.

    Bands come from `gdal_contour -p`, which follows the surface between pixels rather
    than around them. All water past MAX_AREA_DEPTH_M is one more band, kept for the
    contour at its edge but never published: `gdal_contour -p` makes no polygon past
    its last level.
    """
    levels = [lv for lv in LEVELS if lv <= MAX_AREA_DEPTH_M] + [MAX_DEPTH_M]
    with rasterio.open(path) as src:
        depth, count = src.read(1), src.read(3)
        transform = src.transform
    bands = {}
    if (depth != surface.NODATA).any():
        with tempfile.TemporaryDirectory(dir=os.environ.get("GRID_TEMP_DIR") or None) as tmp:
            out = Path(tmp) / "bands.geojson"
            subprocess.run(
                ["gdal_contour", "-q", "-p", "-b", "1", "-amin", "lo", "-amax", "hi",
                 "-fl", *map(str, levels), str(path), str(out)],
                check=True,
            )  # fmt: skip
            features = json.loads(out.read_text())["features"]
        for f in features:
            b = int(np.searchsorted(LEVELS, f["properties"]["lo"], side="right")) - 1
            part = shapely.make_valid(shapely.from_geojson(json.dumps(f["geometry"])))
            bands[b] = shapely.union(bands[b], part) if b in bands else part
    valid = depth != surface.NODATA
    covered = binary_dilation(valid | (count > 0), structure=np.ones((3, 3), dtype=bool))
    return bands, polygons(covered, transform), polygons(valid, transform)


def polygons(mask, transform):
    """The pixels of `mask` as one geometry."""
    pieces = [
        shapely.geometry.shape(g)
        for g, v in rasterio.features.shapes(mask.astype("uint8"), transform=transform)
        if v
    ]
    return shapely.union_all(pieces) if pieces else shapely.Polygon()


def tile_areas(candidates, properties, bands, footprint, surfaced=None):
    """Features for one tile: its depth areas from the surface's `bands`, its coverage
    `footprint` with `properties`, the contours between bands, and prime soundings from
    `candidates`, the (lon, lat, depth) arrays of the tile's shoalest measured pixels. An isobath is
    closed when the surface, `surfaced` (the footprint if not given), has deeper water
    all round it."""
    surfaced = footprint if surfaced is None else surfaced
    deepest = int(np.searchsorted(LEVELS, MAX_AREA_DEPTH_M, side="right")) - 1
    for b, area in bands.items():
        if b < deepest:
            lo, hi = band(LEVELS[b])
            yield shape("DEPARE", area, {"DRVAL1": lo, "DRVAL2": hi}, FIRST_AREA_ZOOM)
    if footprint.is_empty:
        return
    yield shape("M_QUAL", footprint, properties, 0)
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
            inside = point[ring_of == r]
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
    built = datetime.now(UTC).strftime("%Y-%m-%d")
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
            *("-n", "Crowd Depth", "-N", f"Crowd Depth grid {GRID_VERSION}, built {built}"),
            *("-A", "Crowd Depth, NOAA DCDB crowdsourced bathymetry"),
            str(out / "soundings.geojsons"),
            str(out / "areas.geojsons"),
        ],
        check=True,
    )
    # Freeboard applies S-52 styling to a vector chart whose metadata says type=S-57, and
    # the version and date let a client tell when an extract is out of date. Tippecanoe
    # can't write custom metadata, so it goes in through MBTiles on the way to PMTiles.
    with contextlib.closing(sqlite3.connect(mbtiles)) as db, db:
        db.executemany(
            "INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)",
            [("type", "S-57"), ("version", str(GRID_VERSION)), ("built", built)],
        )
    mbtiles_to_pmtiles(str(mbtiles), str(out / "overlay.pmtiles"), None)
    mbtiles.unlink()
    return counts
