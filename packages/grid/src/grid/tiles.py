"""The per-tile rebuild: cells, surface and overlay per 1° tile, web tiles per z8 tile, then
the low zooms and one archive, as a Snakemake workflow (the Snakefile beside this module).

`prepare` is the store-level step before it. It brings the store's QC, offsets and
`file_tiles` up to date, freezes the catalog the pointer names into the run directory, and
writes each tile's fingerprint to `fp/{tile}.txt`, rewriting a file only when its
fingerprint moved. A moved fingerprint is what reruns a tile; a tile whose soundings are all
withdrawn loses its fingerprint and its outputs, and the neighbors and web tiles that read
it rerun because their inputs changed.

Each job reads the frozen catalog read-only and works in an in-memory `lake` holding only
what it writes, so jobs run side by side and never write to the store. Jobs run in children
forked from a warm worker (worker.py), so each pays a fork rather than a Python start.

    python -m grid.tiles STAGE RUN THREADS [KEY...]
"""

import contextlib
import fcntl
import functools
import hashlib
import importlib.metadata
import json
import math
import os
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from . import calibrate, catalog, cells, manifest, overlay, qc, surface
from .catalog import ACTIVE_POINTS, MIGRATIONS, SCHEMA, open_store
from .cells import CELL_REASONS
from .sources import literal

SNAKEFILE = Path(__file__).with_name("Snakefile")
# The zoom web jobs are cut at: every pyramid level shown at it or past it nests in its
# tiles, so they are exact; the levels shown below it are reduced in the low job.
Z = 8
# DuckDB's budget in each job; the peaks below were measured with it.
JOB_MEMORY_LIMIT = "1200MB"
# Tables a job writes; everything else is a view over the frozen catalog.
WRITTEN = ("cells", "qc_flags", "shoals", "cells_built", "store_meta", "tile_changes")
# Peak memory of a job, Python and the tools it runs, by its tile's active soundings:
# (fewer than, MB). The Chesapeake's peaks with 1 thread, rounded up; a stage's last
# entry covers the rest. Overlay peaks follow the tile's surface more than its soundings.
# ponytail: measured on one region; refit once the planet's densest tiles have run
MEMORY_MB = {
    "cells": [(100_000, 512), (1_000_000, 1024), (10_000_000, 3072), (None, 4096)],
    "surface": [(100_000, 2048), (1_000_000, 2560), (10_000_000, 3584), (None, 4608)],
    "overlay": [(100_000, 3584), (1_000_000, 4096), (None, 7168)],
}
WEB_MEMORY_MB = 2048
# DuckDB threads by soundings: dense tiles set the run's critical path.
THREADS = [(1_000_000, 1), (10_000_000, 2), (None, 4)]
# The tools and libraries a run's outputs are built with, besides this package.
TOOLS = (
    ["tippecanoe", "--version"],
    ["gdal_grid", "--version"],
    ["gdal_contour", "--version"],
    ["potrace", "--version"],
)
LIBRARIES = ("duckdb", "numpy", "scipy", "shapely", "rasterio", "pmtiles")


@functools.cache
def code() -> str:
    """What a run's outputs are built with, past what fingerprints cover (cells.CODE): this
    code, the tools it runs and the libraries it draws with. A change reruns every job."""
    import rasterio

    parts = [Path(f).read_bytes() for f in (__file__, surface.__file__, overlay.__file__)]
    parts.append(SNAKEFILE.read_bytes())
    for cmd in TOOLS:
        try:
            done = subprocess.run(cmd, capture_output=True, text=True, check=False)
            parts.append((done.stdout + done.stderr).strip().encode())
        except OSError:
            parts.append(f"{cmd[0]} missing".encode())
    parts += [f"{lib} {importlib.metadata.version(lib)}".encode() for lib in LIBRARIES]
    parts.append(f"GDAL {rasterio.__gdal_version__}".encode())
    return hashlib.sha256(b"\0".join(parts)).hexdigest()[:16]


def resources(stage, soundings):
    """(mem_mb, threads) for a tile's job."""

    def pick(table):
        return next(v for below, v in table if below is None or soundings < below)

    mem = pick(MEMORY_MB[stage]) if stage in MEMORY_MB else WEB_MEMORY_MB
    return mem, pick(THREADS)


# Tile geometry --------------------------------------------------------------------------------


def corner(tile):
    """A 1° tile's south-west corner, (lat0, lon0)."""
    return tile // 360 - 90, tile % 360 - 180


def neighbors(tile):
    """The tile and its eight neighbors, across the antimeridian, short of the poles."""
    lat0, lon0 = corner(tile)
    out = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            lat, lon = lat0 + dy, (lon0 + dx + 180) % 360 - 180
            if -90 <= lat <= 89:
                out.append((lat + 90) * 360 + lon + 180)
    return out


def partition(tile):
    return surface.partition_of(*corner(tile))


def mercator_y(lat):
    r = math.radians(lat)
    return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2


def tile_z8s(tile):
    """The z8 web tiles a 1° tile overlaps, as 'x_y' keys."""
    lat0, lon0 = corner(tile)
    lat0, lat1 = max(lat0, -overlay.MERCATOR_MAX_LAT), min(lat0 + 1, overlay.MERCATOR_MAX_LAT)
    if lat0 >= lat1:
        return []
    n, eps = 2**Z, 1e-9
    xs = range(int((lon0 + 180) / 360 * n), int((lon0 + 1 - eps + 180) / 360 * n) + 1)
    # A sounding on the tile's south edge is the tile's, in the z8 row south of it when the
    # edge is a row's edge too, as on the equator.
    ys = range(int(mercator_y(lat1 - eps) * n), int(mercator_y(lat0) * n) + 1)
    return [f"{x}_{y}" for x in xs for y in ys]


def z8_bounds(key):
    x, y = map(int, key.split("_"))
    n = 2**Z

    def lat(yy):
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))

    return x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)


def counts(run: Path) -> dict[int, int]:
    """{tile: active soundings} for the run's tiles."""
    path = run / "tiles.txt"
    if not path.exists():
        return {}
    return {int(t): int(n) for t, n in (line.split() for line in path.read_text().splitlines())}


def web_keys(tiles) -> dict[str, list[int]]:
    """{z8 key: the tiles in it}."""
    keys = {}
    for t in sorted(tiles):
        for key in tile_z8s(t):
            keys.setdefault(key, []).append(t)
    return keys


# Prepare --------------------------------------------------------------------------------------

# A tile's files in the run directory, by kind.
TILE_FILES = {
    "cells": "cells/{}.parquet",
    "shoals": "shoals/{}.parquet",
    "flags": "flags/{}.parquet",
    "surface": "surface/{}.tif",
    "areas": "areas/{}.geojsons",
}
STAGES = ("cells", "surface", "overlay")


def write_if_changed(path: Path, text: str) -> bool:
    if path.exists() and path.read_text() == text:
        return False
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    tmp.replace(path)
    return True


def prepare(store, run: Path) -> dict:
    """Bring the store's corrections up to date, freeze its catalog into `run`, and write
    each tile's fingerprint. Returns the tiles, those whose fingerprints moved, and those
    gone: no active soundings left, whose outputs it removes."""
    run.mkdir(parents=True, exist_ok=True)
    # Absolute, as jobs run in the run directory.
    url = store.url if store.url.startswith("s3://") else str(Path(store.url).resolve()) + "/"
    url += "lake/"
    # Another store's tiles would all count as gone, and their outputs be removed. A bucket
    # is named by its endpoint too: staging and production can share a bucket name.
    ident = url + (" at " + os.environ.get("S3_ENDPOINT", "") if url.startswith("s3://") else "")
    built = run / "store.txt"
    if built.exists() and built.read_text().strip() != ident:
        raise RuntimeError(
            f"{run} holds tiles from {built.read_text().strip()}, not {ident}: use another --out"
        )
    write_if_changed(built, ident + "\n")
    with open_store(store) as con:
        # What `grid cells` does before a build: cells read QC's flags, the stuck runs and
        # every file's offset, and fingerprints read file_tiles.
        qc.run(con, missing_only=True)
        if not calibrate.runs_current(con):
            raise SystemExit(
                "stuck runs weren't found under this calibration: run `grid calibrate` first"
            )
        calibrate.assign(con)
        manifest.ensure_file_tiles(con)
        overlay.check_corrections(con)
        # The catalog just checked, published under a key of its own while the lock is
        # held, so another writer's catalog can't take its place. Jobs read it whatever the
        # store does next: a store keeps the files a catalog names for catalog.RETAIN after
        # replacing them.
        key = con.publish()
    tmp = run / "snapshot.ducklake.tmp"
    tmp.write_bytes(store.get(key)[0])
    tmp.replace(run / "snapshot.ducklake")
    write_if_changed(run / "data_url", url + "\n")
    with snapshot(run, "lake") as con:
        prints = manifest.fingerprints(con)
        # The archive's credit line, an input of assembly: a station's license can change
        # with no tile's fingerprint.
        write_if_changed(run / "credits.txt", overlay.attribution(con) + "\n")
    (run / "fp").mkdir(exist_ok=True)
    live = {t: (fp, n) for t, (fp, n) in prints.items() if n}
    moved = [t for t, (fp, _) in sorted(live.items()) if write_if_changed(fp_path(run, t), fp)]
    gone = sorted(int(p.stem) for p in (run / "fp").glob("*.txt") if int(p.stem) not in live)
    before = web_keys(counts(run))
    write_if_changed(
        run / "tiles.txt", "".join(f"{t}\t{n}\n" for t, (_, n) in sorted(live.items()))
    )
    for t in gone:
        forget(run, t)
    # Every archive holding a gone tile's data goes now, not when its job reruns: a run that
    # fails, is stopped or is a dry run would leave withdrawn soundings published. A z8 tile
    # with live tiles left reruns; the archive is rebuilt when the run gets that far.
    stale = {key for t in gone for key in tile_z8s(t)} | (before.keys() - web_keys(live).keys())
    for key in stale:
        for path in (
            f"web/{key}.pmtiles",
            f"lowsnd/{key}.geojsons",
            f"lowsnd/{key}.level4.jsonl",
            f"done/web/{key}",
        ):
            (run / path).unlink(missing_ok=True)
    if gone or not live:
        for path in ("low.pmtiles", "overlay.pmtiles", "done/low", "done/assemble"):
            (run / path).unlink(missing_ok=True)
    return {"tiles": len(live), "moved": moved, "gone": gone, "catalog": key}


def fp_path(run, tile):
    return run / "fp" / f"{tile}.txt"


def forget(run: Path, tile: int):
    """Remove a tile's fingerprint and outputs, so nothing of it is read or published."""
    fp_path(run, tile).unlink(missing_ok=True)
    for pattern in TILE_FILES.values():
        (run / pattern.format(tile)).unlink(missing_ok=True)
    for stage in STAGES:
        (run / "done" / stage / str(tile)).unlink(missing_ok=True)


# Jobs -----------------------------------------------------------------------------------------


@contextlib.contextmanager
def scratch(run: Path, threads=1):
    """A connection with an empty in-memory `lake`, for a job's work."""
    data_url = (run / "data_url").read_text().strip()
    with tempfile.TemporaryDirectory(dir=os.environ.get("GRID_TEMP_DIR") or None) as spill:
        con = catalog.session(data_url, spill, JOB_MEMORY_LIMIT)
        try:
            con.execute("SET threads = ?", [threads])
            con.execute("ATTACH ':memory:' AS lake")
            con.execute(SCHEMA)
            con.execute(MIGRATIONS)
            yield con
        finally:
            con.close()


@contextlib.contextmanager
def snapshot(run: Path, alias="store", threads=1):
    """A connection with the run's frozen catalog attached read-only as `alias`; as `store`,
    beside an empty in-memory `lake`."""
    data_url = (run / "data_url").read_text().strip()
    if alias == "lake":
        with tempfile.TemporaryDirectory(dir=os.environ.get("GRID_TEMP_DIR") or None) as spill:
            con = catalog.session(data_url, spill)
            try:
                catalog.attach(con, str(run / "snapshot.ducklake"), data_url, read_only=True)
                yield con
            finally:
                con.close()
        return
    with scratch(run, threads) as con:
        catalog.attach(con, str(run / "snapshot.ducklake"), data_url, alias, read_only=True)
        yield con


@contextlib.contextmanager
def open_job(run: Path, tiles: list[int], threads=1):
    """A connection whose `lake` holds the frozen catalog's tables as views, points limited
    to `tiles`, track QC's flags for them copied in, and empty tables for what the job
    writes."""
    with snapshot(run, threads=threads) as con:
        tables = [
            t
            for (t,) in con.execute(
                "SELECT table_name FROM duckdb_tables() WHERE database_name = 'lake'"
            ).fetchall()
        ]
        parts = ",".join(map(str, sorted({partition(t) for t in tiles})))
        ids = ",".join(map(str, tiles))
        where = f"cell_id IN ({parts}) AND tile_id IN ({ids})"
        for t in tables:
            if t in WRITTEN:
                continue
            con.execute(f"DROP TABLE lake.{t}")
            only = f" WHERE {where}" if t == "points" else ""
            con.execute(f"CREATE VIEW lake.{t} AS SELECT * FROM store.{t}{only}")
        con.execute("INSERT INTO lake.store_meta SELECT * FROM store.store_meta")
        # Track QC's flags; cell-level ones are the cells jobs', read from their outputs.
        con.execute(
            f"""INSERT INTO lake.qc_flags SELECT * FROM store.qc_flags
            WHERE {where} AND NOT list_contains({CELL_REASONS}, reason)"""
        )
        con.execute(ACTIVE_POINTS)
        yield con


def load(con, run: Path, tiles, kinds):
    """Insert the tiles' outputs of `kinds` (cells, shoals, flags) into `lake`."""
    for t in tiles:
        for kind in kinds:
            f = run / TILE_FILES[kind].format(t)
            if f.exists():
                table = "qc_flags" if kind == "flags" else kind
                con.execute(
                    f"INSERT INTO lake.{table} BY NAME SELECT * FROM read_parquet(?)", [str(f)]
                )


def export(con, query, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    con.execute(f"COPY ({query}) TO {literal(str(tmp))} (FORMAT parquet)")
    tmp.replace(path)


def do_cells(run: Path, tile: int, threads):
    with open_job(run, [tile], threads) as con:
        if con.execute("SELECT count(*) FROM lake.points").fetchone()[0]:
            cells.build(con, [tile])
        export(
            con,
            f'SELECT * FROM lake.cells WHERE tile_id = {tile} ORDER BY level, "row", col',
            run / TILE_FILES["cells"].format(tile),
        )
        export(
            con,
            f'SELECT * FROM lake.shoals WHERE tile_id = {tile} ORDER BY "row", lon, lat',
            run / TILE_FILES["shoals"].format(tile),
        )
        export(
            con,
            f"""SELECT * FROM lake.qc_flags WHERE tile_id = {tile}
            AND list_contains({CELL_REASONS}, reason) ORDER BY point_id, flag, reason""",
            run / TILE_FILES["flags"].format(tile),
        )


def has_cells(con, run: Path, tile: int) -> bool:
    return bool(
        con.execute(
            "SELECT count(*) FROM read_parquet(?)", [str(run / TILE_FILES["cells"].format(tile))]
        ).fetchone()[0]
    )


def do_surface(run: Path, tile: int, threads):
    """A tile's surface from its and its neighbors' points; none for a tile with no cells,
    as `overlay.areas` builds none."""
    around = neighbors(tile)
    path = run / TILE_FILES["surface"].format(tile)
    path.unlink(missing_ok=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open_job(run, around, threads) as con:
        load(con, run, around, kinds=("flags",))
        if has_cells(con, run, tile):
            surface.build_tile(con, tile, partition(tile), path.parent)


def do_overlay(run: Path, tile: int, threads):
    """A tile's depth areas, contours, coverage and prime soundings, as `overlay.areas`
    writes them; an empty file for a tile with no surface."""
    import rasterio

    path = run / TILE_FILES["surface"].format(tile)
    out = run / TILE_FILES["areas"].format(tile)
    out.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        out.write_text("")
        return
    around = neighbors(tile)
    with scratch(run, threads) as con:
        load(con, run, around, kinds=("cells", "shoals"))
        params = {"partition": partition(tile), "tile": tile}
        first, last, count, tvu = con.execute(overlay.TILE_QUALITY, params).fetchone()
        got = con.execute(
            overlay.PRIME_CANDIDATES, params | {"max": overlay.PRIME_MAX_DEPTH_M}
        ).fetchnumpy()
        candidates = got["lon"], got["lat"], got["depth"]
        with rasterio.open(path) as src:
            nearby = overlay.nearby_soundings(con, tile, src.transform)
        bands, footprint, surfaced, interpolated, interpolated_tvu = overlay.surface_bands(
            path, nearby
        )
        properties = overlay.quality(first, last, count, tvu)
        estimated = (interpolated, overlay.quality(first, last, 0, interpolated_tvu))
        tmp = out.with_name(out.name + ".tmp")
        overlay.write(
            overlay.tile_areas(candidates, properties, bands, footprint, surfaced, estimated), tmp
        )
        tmp.replace(out)


def tippecanoe(out: Path, inputs, zooms, clip=None) -> bool:
    """Tile `inputs` into `out` (MBTiles) at `zooms`, as `overlay.build` does; False when
    nothing fell in the clip box, so there are no tiles."""
    cmd = [
        *("tippecanoe", "-o", str(out), "--force", "--quiet", f"-Z{zooms[0]}", f"-z{zooms[1]}"),
        *("-r1", "--no-feature-limit", "--no-tile-size-limit"),
        *("--detect-shared-borders", "--no-tiny-polygon-reduction"),
    ]
    if clip:
        cmd.append("--clip-bounding-box=" + ",".join(f"{v:.9f}" for v in clip))
    done = subprocess.run(cmd + [str(i) for i in inputs], check=False)
    # 110: "Did not read any valid geometries", all of it clipped away.
    if done.returncode == 110:
        return False
    done.check_returncode()
    return True


def to_pmtiles(mbtiles: Path, out: Path):
    from pmtiles.convert import mbtiles_to_pmtiles

    tmp = out.with_name(out.name + ".tmp")
    mbtiles_to_pmtiles(str(mbtiles), str(tmp), None)
    tmp.replace(out)
    mbtiles.unlink()


def do_web(run: Path, key: str, threads):
    """One z8 tile's archive at z8–15. A sounding shown at z8 or past it comes from pyramid
    cells inside the z8 tile, so it is the same as a whole-region build's; those shown
    below z8 go to the low job, in lowsnd/."""
    x, y = map(int, key.split("_"))
    mine = web_keys(counts(run)).get(key, [])
    out = run / "web" / f"{key}.pmtiles"
    out.parent.mkdir(exist_ok=True)
    (run / "lowsnd").mkdir(exist_ok=True)
    out.unlink(missing_ok=True)
    n = 2**Z
    with scratch(run, threads) as con:
        load(con, run, mine, kinds=("cells", "shoals"))
        for table, lon, lat in (("cells", "depth_lon", "depth_lat"), ("shoals", "lon", "lat")):
            con.execute(
                f"""DELETE FROM lake.{table} WHERE NOT (
                  floor(({lon} + 180) / 360 * {n}) = {x}
                  AND floor((1 - ln(tan(radians({lat})) + 1 / cos(radians({lat}))) / pi()) / 2
                    * {n}) = {y})"""
            )
        # Primes as the tiles' overlay jobs found them, so the pyramid leaves them out.
        primes, areas = {}, []
        for t in mine:
            f = run / TILE_FILES["areas"].format(t)
            if f.stat().st_size:
                areas.append(f)
                with open(f) as fh:
                    for line in fh:
                        if '"prime"' in line:
                            feat = json.loads(line)
                            if feat["properties"].get("prime"):
                                at = tuple(feat["geometry"]["coordinates"])
                                primes[at] = feat["tippecanoe"]["minzoom"]
        sounds = run / "web" / f"{key}.soundings.geojsons"
        count = 0
        with open(sounds, "w") as hi, open(run / "lowsnd" / f"{key}.geojsons", "w") as lo:
            for high, feat in web_soundings(con, primes):
                line = json.dumps(feat, separators=(",", ":")) + "\n"
                (hi if high else lo).write(line)
                count += high
        with open(run / "lowsnd" / f"{key}.level4.jsonl", "w") as f:
            f.writelines(json.dumps(row) + "\n" for row in level4_candidates(con))
    w, s, e, nn = z8_bounds(key)
    # Clipped to the z8 tile plus tippecanoe's buffer at z8, 5/256 of a tile.
    bx, by = (e - w) * 5 / 256, (nn - s) * 5 / 256
    mbtiles = out.with_suffix(".mbtiles")
    if (count or areas) and tippecanoe(
        mbtiles, [sounds, *areas], (Z, overlay.MAX_ZOOM), clip=(w - bx, s - by, e + bx, nn + by)
    ):
        to_pmtiles(mbtiles, out)
    mbtiles.unlink(missing_ok=True)
    sounds.unlink()


# The one pyramid level that shows below z8 and whose cells are wider than a z8 tile:
# zoom 4, shown at z6 past 1,000 m. Every finer level nests in one z8 tile.
LEVEL4 = 4


def web_soundings(con, primes):
    """Yield a web job's soundings as (shown at z8 or past it, feature): all of them but
    those from level 4, which the low job reduces across web jobs (level4_candidates)."""
    for feat in overlay.soundings(con, primes):
        display = feat["tippecanoe"]["minzoom"]
        if display - overlay.thin_shift(feat["properties"]["VALSOU"]) > LEVEL4:
            yield display >= Z, feat


def level4_candidates(con):
    """Every level-4 pyramid cell's shoalest sounding in `lake`, as [cx, cy, depth, lon,
    lat, unconfirmed], whatever depth: a shallow one that shows at no zoom still keeps a
    deeper one in another web job's part of the cell from showing, as in the pyramid."""
    n = 2**overlay.MAX_ZOOM * overlay.CELLS_PER_TILE
    step = 2 ** (overlay.MAX_ZOOM - LEVEL4)
    rows = con.execute(
        f"""SELECT cx, cy, s.d, s.lon, s.lat, s.unconfirmed FROM (
          SELECT floor(mx * {n})::BIGINT // {step} AS cx, floor(my * {n})::BIGINT // {step} AS cy,
            min(struct_pack(d := d, lon := lon, lat := lat, unconfirmed := unconfirmed)) AS s
          FROM (SELECT *, {overlay.MERCATOR} FROM ({overlay.SOURCES}))
          GROUP BY ALL
        ) ORDER BY cx, cy"""
    ).fetchall()
    return [list(r) for r in rows]


def reduce_level4(candidates):
    """Level 4's soundings from every web job's candidates: each cell's shoalest, ties
    broken on position as the pyramid breaks them, shown where its depth shows at level 4.
    None is a prime: those are 200 m or shallower, and level 4 shows only past 1,000 m."""
    best = {}
    for cx, cy, d, lon, lat, unconfirmed in candidates:
        if (cx, cy) not in best or (d, lon, lat, unconfirmed) < best[cx, cy]:
            best[cx, cy] = (d, lon, lat, unconfirmed)
    for (cx, cy), (d, lon, lat, unconfirmed) in sorted(best.items()):
        display = LEVEL4 + overlay.thin_shift(d)
        if overlay.MIN_ZOOM <= display <= overlay.MAX_ZOOM:
            yield overlay.feature(lon, lat, d, unconfirmed, display)


def do_low(run: Path, threads):
    """z0–7: every tile's areas shown below z8, and the web jobs' soundings shown below it,
    with the pyramid's zoom-4 level (shown at z6, past 1,000 m) reduced across them, as a
    whole-region pyramid would."""
    tiles = counts(run)
    keys = web_keys(tiles)
    feats = run / "low.areas.geojsons"
    with open(feats, "w") as out:
        # Tiles past Web Mercator have no web tile, and nothing of them shows.
        for t in sorted({t for ts in keys.values() for t in ts}):
            with open(run / TILE_FILES["areas"].format(t)) as fh:
                for line in fh:
                    if json.loads(line)["tippecanoe"].get("minzoom", 0) < Z:
                        out.write(line)
    sounds = run / "low.soundings.geojsons"

    def candidates():
        for key in sorted(keys):
            with open(run / "lowsnd" / f"{key}.level4.jsonl") as fh:
                yield from map(json.loads, fh)

    with open(sounds, "w") as out:
        for key in sorted(keys):
            with open(run / "lowsnd" / f"{key}.geojsons") as fh:
                shutil.copyfileobj(fh, out)
        out.writelines(
            json.dumps(feat, separators=(",", ":")) + "\n" for feat in reduce_level4(candidates())
        )
    mbtiles = run / "low.mbtiles"
    if tippecanoe(mbtiles, [sounds, feats], (0, Z - 1)):
        to_pmtiles(mbtiles, run / "low.pmtiles")
    else:
        (run / "low.pmtiles").unlink(missing_ok=True)
        mbtiles.unlink(missing_ok=True)
    feats.unlink()
    sounds.unlink()


def merge_layers(archives):
    """The archives' vector layers, from the JSON tippecanoe keeps them in, as one list: each
    layer's zooms widened, its fields joined."""
    layers = {}
    for meta in archives:
        for layer in json.loads(meta.get("json", "{}")).get("vector_layers", []):
            got = layers.setdefault(layer["id"], dict(layer, fields={}))
            got["minzoom"] = min(got.get("minzoom", 99), layer.get("minzoom", 99))
            got["maxzoom"] = max(got.get("maxzoom", 0), layer.get("maxzoom", 0))
            got["fields"] |= layer.get("fields", {})
    return [layers[k] for k in sorted(layers)]


def entries(get_bytes, header, offset=None, length=None):
    """Yield (tile id, data offset, length) of every tile in an archive, in tile-id order,
    without reading tile data."""
    from pmtiles.tile import deserialize_directory

    if offset is None:
        offset, length = header["root_offset"], header["root_length"]
    for entry in deserialize_directory(get_bytes(offset, length)):
        if entry.run_length:
            for i in range(entry.run_length):
                yield entry.tile_id + i, entry.offset, entry.length
        else:
            leaf = header["leaf_directory_offset"] + entry.offset
            yield from entries(get_bytes, header, leaf, entry.length)


def do_assemble(run: Path, threads):
    """One archive from the low job's z0–7 and each z8 job's own subtree, tile bytes
    copied as they are, in tile-id order. Tile ids run by zoom, then along a Hilbert curve,
    on which a z8 tile's subtree is one run at each zoom: so the low archive comes first,
    then zoom by zoom each web archive in its z8 tile's order, and no tile is held."""
    from pmtiles.reader import MmapSource, Reader
    from pmtiles.tile import Compression, TileType, deserialize_header, tileid_to_zxy, zxy_to_tileid
    from pmtiles.writer import Writer

    tiles = counts(run)
    webs = []
    for key in web_keys(tiles):
        path = run / "web" / f"{key}.pmtiles"
        if path.exists() and path.stat().st_size:
            x, y = map(int, key.split("_"))
            webs.append((zxy_to_tileid(Z, x, y), x, y, path))
    webs.sort()
    low = run / "low.pmtiles"
    metas, zooms = [], set()
    tmp = run / "overlay.pmtiles.tmp"
    with open(tmp, "wb") as f:
        writer = Writer(f)

        def copy(path, keep):
            with open(path, "rb") as fh:
                get = MmapSource(fh)
                header = deserialize_header(get(0, 127))
                for tid, offset, length in entries(get, header):
                    z, x, y = tileid_to_zxy(tid)
                    if keep(z, x, y):
                        writer.write_tile(tid, get(header["tile_data_offset"] + offset, length))
                        zooms.add(z)

        if low.exists() and low.stat().st_size:
            copy(low, lambda z, x, y: z < Z)
            with open(low, "rb") as fh:
                metas.append(Reader(MmapSource(fh)).metadata())
        for path in [p for *_, p in webs]:
            with open(path, "rb") as fh:
                metas.append(Reader(MmapSource(fh)).metadata())
        for zoom in range(Z, overlay.MAX_ZOOM + 1):
            for _, x8, y8, path in webs:
                copy(path, lambda z, x, y, x8=x8, y8=y8, zoom=zoom: z == zoom
                     and (x >> (z - Z), y >> (z - Z)) == (x8, y8))  # fmt: skip
        if not zooms:
            raise RuntimeError("nothing to tile: the run has no cells")
        with snapshot(run, "lake") as con:
            meta = overlay.describe(con)
        corners = [corner(t) for t in tiles]
        lim = overlay.MERCATOR_MAX_LAT
        west, east = min(lon for _, lon in corners), max(lon for _, lon in corners) + 1
        south = max(min(lat for lat, _ in corners), -lim)
        north = min(max(lat for lat, _ in corners) + 1, lim)
        writer.finalize(
            {
                "tile_type": TileType.MVT,
                "tile_compression": Compression.GZIP,
                "min_zoom": min(zooms),
                "max_zoom": max(zooms),
                "min_lon_e7": int(west * 1e7),
                "min_lat_e7": int(south * 1e7),
                "max_lon_e7": int(east * 1e7),
                "max_lat_e7": int(north * 1e7),
                "center_zoom": min(zooms),
                "center_lon_e7": int((west + east) / 2 * 1e7),
                "center_lat_e7": int((south + north) / 2 * 1e7),
            },
            # As tippecanoe writes it, less the tile statistics no merge can keep.
            meta
            | {
                "format": "pbf",
                "minzoom": str(min(zooms)),
                "maxzoom": str(max(zooms)),
                "json": json.dumps({"vector_layers": merge_layers(metas)}),
            },
        )
    tmp.replace(run / "overlay.pmtiles")


PER_KEY = {"cells": do_cells, "surface": do_surface, "overlay": do_overlay, "web": do_web}
WHOLE = {"low": do_low, "assemble": do_assemble}


def job(argv):
    """Run one job, STAGE RUN THREADS [KEY...], and log its time and peak memory to
    RUN/jobs.jsonl."""
    stage, run, threads, keys = argv[0], Path(argv[1]), int(argv[2]), argv[3:]
    started = time.time()
    if stage in PER_KEY:
        for k in keys:
            PER_KEY[stage](run, k if stage == "web" else int(k), threads)
    else:
        WHOLE[stage](run, threads)
    # ru_maxrss is in bytes on macOS and in KB on Linux.
    unit = 2**20 if sys.platform == "darwin" else 2**10
    record = {
        "stage": stage,
        "keys": keys,
        "seconds": round(time.time() - started, 3),
        "maxrss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / unit),
        # gdal_grid, potrace and tippecanoe.
        "tools_maxrss_mb": round(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / unit),
    }
    with open(run / "jobs.jsonl", "a") as f:
        f.write(json.dumps(record) + "\n")


# The run --------------------------------------------------------------------------------------


def machine():
    """(cores, MB) this process may use: the machine's, or its container's (cgroup v2 or
    v1)."""
    cores = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count()
    mb = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") // 2**20
    cgroup = Path("/sys/fs/cgroup")
    for quota, period in (("cpu.max", None), ("cpu/cpu.cfs_quota_us", "cpu/cpu.cfs_period_us")):
        with contextlib.suppress(OSError, ValueError):
            q, p = (
                (cgroup / quota).read_text().split()
                if period is None
                else ((cgroup / quota).read_text(), (cgroup / period).read_text())
            )
            if int(q) > 0:
                cores = min(cores, max(1, int(q) // int(p)))
    for limit in ("memory.max", "memory/memory.limit_in_bytes"):
        with contextlib.suppress(OSError, ValueError):
            mb = min(mb, int((cgroup / limit).read_text()) // 2**20)
    return cores, mb


def build(store, run: Path, cores=None, memory_mb=None, dry_run=False) -> int:
    """Prepare `run` from the store and rebuild what moved. Returns Snakemake's exit code."""
    run = run.resolve()
    run.mkdir(parents=True, exist_ok=True)
    with open(run / ".lock", "w") as lock:
        # One run per directory, from prepare to the end: a second run's prepare would
        # replace the snapshot and fingerprints the first one's jobs are reading.
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError(f"another `grid tiles` run is using {run}") from None
        with terminating():
            return run_locked(store, run, cores, memory_mb, dry_run)


def run_locked(store, run, cores, memory_mb, dry_run):
    prepared = prepare(store, run)
    print(json.dumps(prepared), flush=True)
    if not prepared["tiles"]:
        # Every tile's soundings withdrawn: prepare removed what they were published in.
        raise RuntimeError("nothing to tile: the store has no active soundings")
    # The machine's cores, and three quarters of its memory, by default: what runs beside
    # the jobs needs the rest.
    cores = cores or machine()[0]
    memory_mb = memory_mb or machine()[1] * 3 // 4
    with contextlib.ExitStack() as stack:
        config = [f"memory_mb={memory_mb}", f"code={code()}"]
        if not dry_run:
            sock, _ = stack.enter_context(warm_worker())
            config.append(f"socket={sock}")
        cmd = [
            *(sys.executable, "-m", "snakemake", "--snakefile", str(SNAKEFILE)),
            *("--directory", str(run), "--cores", str(cores)),
            *("--resources", f"mem_mb={memory_mb}"),
            # The ILP scheduler stalls with thousands of ready jobs, and its bundled solver
            # is x86 only.
            *("--scheduler", "greedy"),
            # A tile reruns when its fingerprint's file is rewritten, or its inputs or the
            # code change (`code` in the config), not on Snakemake's own code check.
            *("--rerun-triggers", "mtime", "params", "input", "software-env"),
            "--keep-going",
            # The run directory's flock already allows one run at a time, and a run killed
            # outright would leave Snakemake's own lock and block every run after it.
            "--nolock",
            "--rerun-incomplete",
            *("--config", *config),
        ]
        if dry_run:
            cmd.append("--dry-run")
        return subprocess.run(cmd, check=False).returncode


@contextlib.contextmanager
def warm_worker():
    """A worker.py process serving jobs while the run lasts; yields its socket's path and
    its pid. Leaving stops it, which stops its jobs and waits for them."""
    # In the system's temp directory: a unix socket's path is limited to about 100 bytes.
    with tempfile.TemporaryDirectory() as tmp:
        sock = Path(tmp) / "worker.sock"
        # In its own session, so only this stops it, after its jobs: a terminal's Ctrl-C
        # would end it on its own.
        proc = subprocess.Popen(
            [sys.executable, "-m", "grid.worker", str(sock)],
            stdout=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        try:
            ready = proc.stdout.readline()
            if not ready.startswith("ready"):
                raise RuntimeError(f"the worker didn't start: {ready!r}")
            yield sock, proc.pid
        finally:
            # A second Ctrl-C or SIGTERM waits until the worker has stopped its jobs: raised
            # here, it would free the run directory's lock with them still running.
            held = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
            try:
                proc.terminate()
                proc.wait()
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, held)


@contextlib.contextmanager
def terminating():
    """SIGTERM ends the run as Ctrl-C does, through every cleanup on the way out, the
    worker's and the run directory's lock among them."""

    def end(*_):
        raise SystemExit(128 + signal.SIGTERM)

    before = signal.signal(signal.SIGTERM, end)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, before)


if __name__ == "__main__":
    job(sys.argv[1:])
