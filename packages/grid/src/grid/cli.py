"""grid: build the crowd-depth point store.

    grid --store DIR_OR_S3_URL ingest [--source noaa|openwaters] [--prefix YYYY/MM/DD] [--max-files N]
                                       [--keys FILE]
    grid --store DIR_OR_S3_URL confirm-withdrawals SOURCE
    grid --store DIR_OR_S3_URL qc
    grid --store DIR_OR_S3_URL tide
    grid --store DIR_OR_S3_URL calibrate [--reference s102|bluetopo|PATH]...
    grid --store DIR_OR_S3_URL cells [--bbox=W,S,E,N | --changed]
    grid --store DIR_OR_S3_URL overlay --out DIR
    grid --store DIR_OR_S3_URL tiles --out DIR [--cores N] [--memory-gb N] [--dry-run]
    grid --store DIR_OR_S3_URL benchmark --surface DIR --out DIR [--bbox=W,S,E,N | --tiles=ID,...]
                                          [--source NAME]... [--cells] [--qc-version N]
    grid --store DIR_OR_S3_URL compact
    grid --store DIR_OR_S3_URL stats
    grid cache [--prune]

Sources default to the NOAA CSB bucket and the Open Waters R2 bucket. R2 access
reads S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY. Downloads are kept in
GRID_CACHE_DIR, shared by every store on the machine (see cache.py).
"""

import argparse
import json
import logging
import math
import sys
from pathlib import Path

from . import benchmark, cache, calibrate, catalog, cells, overlay, qc, reference, tide, tiles
from .catalog import open_store
from .ingest import Ingest, confirm_withdrawals
from .objects import open_objects

SOURCES = {
    "noaa": ("s3://noaa-dcdb-bathymetry-pds", True),
    "openwaters": ("s3://crowd-depth-injest", False),
}


def positive(value: str) -> int:
    n = int(value)
    if n < 1:
        raise argparse.ArgumentTypeError("must be 1 or more")
    return n


def memory_gb(value: str) -> float:
    n = float(value)
    # Under 1 MB is 0 MB, which would mean the machine's memory.
    if not n * 1024 >= 1:
        raise argparse.ArgumentTypeError("must be 1 MB (0.001) or more")
    if not math.isfinite(n):
        raise argparse.ArgumentTypeError("must be a number of GB")
    return n


def bbox(text: str) -> list[int]:
    """The tile ids of the 1° tiles a west,south,east,north box touches."""
    west, south, east, north = map(float, text.split(","))
    # No tiles would mean every tile to the cells build.
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise argparse.ArgumentTypeError(
            f"{text} is no box: west must be less than east and south less than north, within"
            " ±180° and ±90°, and a box can't cross the antimeridian"
        )
    return [
        (lat + 90) * 360 + lon + 180
        for lat in range(math.floor(south), math.ceil(north))
        for lon in range(math.floor(west), math.ceil(east))
    ]


def main(argv=None):
    p = argparse.ArgumentParser(prog="grid", description=__doc__.split("\n")[0])
    p.add_argument("--store", help="Point store: a local directory or s3://bucket/prefix on R2")
    sub = p.add_subparsers(dest="command", required=True)
    i = sub.add_parser("ingest", help="List the sources and ingest new, changed and removed files")
    i.add_argument("--source", choices=SOURCES, action="append", help="Default: both")
    i.add_argument(
        "--prefix", default="", help="Only list keys under this date prefix, e.g. 2026/10/14"
    )
    i.add_argument(
        "--max-files", type=positive, help="Ingest at most N files per source; for backfills"
    )
    i.add_argument(
        "--keys",
        type=Path,
        help="Only these keys, one per line, e.g. a region's from NOAA's track index; nothing"
        " else is withdrawn",
    )
    for name in SOURCES:
        i.add_argument(
            f"--{name}-url", default=SOURCES[name][0], help=f"Where to list {name} files"
        )
    c = sub.add_parser(
        "confirm-withdrawals", help="Let held withdrawals apply once two listings agree"
    )
    c.add_argument("source", choices=SOURCES)
    sub.add_parser(
        "qc",
        help="Rerun QC on every batch; `grid cells` QCs only batches not yet done at this version",
    )
    td = sub.add_parser(
        "tide", help="Tide levels for the soundings' station days, from Slackwater and CO-OPS"
    )
    td.add_argument(
        "--accept-departures",
        action="store_true",
        help="Let more than a tenth of the store's stations leave in one run",
    )
    ca = sub.add_parser("calibrate", help="Solve each vessel step segment's vertical offset")
    ca.add_argument(
        "--reference",
        action="append",
        default=[],
        help="Sample this surveyed reference at new pixels first: s102, bluetopo, or a file or"
        " directory of their rasters; repeat for more, and the least uncertain at a pixel wins",
    )
    ca.add_argument(
        "--accept-losses",
        action="store_true",
        help="Let a run drop more than half of the store's calibrated segments",
    )
    cl = sub.add_parser("cells", help="Run QC, then rebuild every grid cell, or a region's")
    where = cl.add_mutually_exclusive_group()
    where.add_argument(
        "--changed",
        action="store_true",
        help="Only the tiles a calibration or tide change made stale",
    )
    where.add_argument(
        "--bbox",
        type=bbox,
        help="Only the 1° tiles this box touches: west,south,east,north in degrees, given as"
        " --bbox=W,S,E,N since a west longitude starts with -",
    )
    o = sub.add_parser("overlay", help="Build the overlay layers and their PMTiles from the cells")
    o.add_argument("--out", required=True, type=Path, help="Directory for the layers and PMTiles")
    t = sub.add_parser(
        "tiles",
        help="Rebuild the cells, surfaces and overlay of the tiles whose inputs moved since the"
        " last run into DIR, and its PMTiles, through Snakemake",
    )
    t.add_argument(
        "--out", required=True, type=Path, help="The run directory, kept from run to run"
    )
    t.add_argument("--cores", type=positive, help="Default: every core")
    t.add_argument(
        "--memory-gb",
        type=memory_gb,
        help="The jobs' memory budget; default: three quarters of the machine's",
    )
    t.add_argument("--dry-run", action="store_true", help="Prepare, then list the jobs to run")
    b = sub.add_parser(
        "benchmark", help="Score a render's depth surface against the surveyed references"
    )
    b.add_argument("--surface", required=True, type=Path, help="The render's surface COGs")
    b.add_argument("--out", required=True, type=Path, help="Directory for benchmark.json and .md")
    which = b.add_mutually_exclusive_group()
    which.add_argument(
        "--bbox", type=bbox, help="Only the 1° tiles this box touches: --bbox=W,S,E,N"
    )
    which.add_argument(
        "--tiles", type=lambda t: [int(x) for x in t.split(",")], help="Only these tile ids"
    )
    b.add_argument(
        "--source", action="append", default=[], help="Only this reference source; repeatable"
    )
    b.add_argument("--cells", action="store_true", help="Score the cells' depths too")
    b.add_argument(
        "--qc-version",
        type=int,
        default=qc.QC_VERSION,
        help="The QC flags that pick accepted soundings and confirmed shoals; default: this code's",
    )
    sub.add_parser(
        "compact", help="Rewrite each partition's points sorted by tile, once per store layout"
    )
    sub.add_parser("stats", help="Count files by source and status")
    k = sub.add_parser("cache", help="Show the download cache's size by kind")
    k.add_argument(
        "--prune",
        action="store_true",
        help="First remove reference rasters and tile schemes of old releases, source files"
        " past GRID_CACHE_FILES_GB, and what dead writes left",
    )
    args = p.parse_args(argv)
    if args.command == "cache":
        return show_cache(args.prune)
    if not args.store:
        p.error("--store is required")
    if args.command == "ingest" and args.keys and len(set(args.source or SOURCES)) != 1:
        # Keys name one source's files; listed in the other's bucket, they're all missing.
        p.error("--keys needs exactly one --source")

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    if args.command == "tiles":
        # Prepare opens the store itself; the jobs read a frozen copy of its catalog.
        memory = int(args.memory_gb * 1024) if args.memory_gb else None
        return tiles.build(open_objects(args.store), args.out, args.cores, memory, args.dry_run)
    alert = False
    with open_store(
        open_objects(args.store), write=args.command not in ("stats", "overlay", "benchmark")
    ) as con:
        if args.command == "ingest":
            for name in args.source or SOURCES:
                url = getattr(args, f"{name}_url")
                objects = open_objects(url, public=SOURCES[name][1])
                keys = set(args.keys.read_text().split()) if args.keys else None
                alert |= (
                    Ingest(con, name, objects, args.prefix, max_files=args.max_files, keys=keys)
                    .run()
                    .alert
                )
        elif args.command == "qc":
            qc.run(con)
        elif args.command == "tide":
            tide.build(con, accept_departures=args.accept_departures)
        elif args.command == "calibrate":
            # Calibration reads track QC's flags and tide-reduced depths.
            qc.run(con, missing_only=True)
            calibrate.run(con, args.reference, args.accept_losses)
        elif args.command == "cells":
            # Cells read QC's flags: QC any batch that hasn't been at this version.
            qc.run(con, missing_only=True)
            # Stuck runs found under another calibration would set the wrong soundings aside.
            if not calibrate.runs_current(con):
                raise SystemExit(
                    "stuck runs weren't found under this calibration: run `grid calibrate` first"
                )
            # Files that arrived since calibration take their segment's offset.
            calibrate.assign(con)
            if args.changed:
                changed = cells.changed(con)
                if changed:
                    cells.build(con, changed)
                # With every marked tile rebuilt, or none marked, settled cells are current.
                cells.done(con, changed)
            else:
                cells.build(con, args.bbox)
        elif args.command == "overlay":
            print(overlay.build(con, args.out))
        elif args.command == "benchmark":
            result = benchmark.run(
                con, args.surface, args.bbox or args.tiles, args.source, args.qc_version, args.cells
            )
            result = {"store": args.store, **result}
            args.out.mkdir(parents=True, exist_ok=True)
            (args.out / "benchmark.json").write_text(json.dumps(result, indent=1) + "\n")
            table = benchmark.markdown(result)
            (args.out / "benchmark.md").write_text(table)
            print(table)
        elif args.command == "compact":
            # QC the batches a layout change left unchecked first, while each batch's
            # points still sit together: once sorted by tile, each batch reads them all.
            qc.run(con, missing_only=True)
            print(f"compacted {catalog.compact(con, con.publish)} partitions")
        elif args.command == "confirm-withdrawals":
            print(f"confirmed {confirm_withdrawals(con, args.source)} held withdrawals")
        else:
            for row in con.execute(
                """SELECT source, status, reason, count(*), sum(point_count) FROM lake.files
                GROUP BY ALL ORDER BY ALL"""
            ).fetchall():
                print(*row, sep="\t")
    # Held withdrawals, incomplete listings, unreadable files and unknown keys need an operator.
    return 2 if alert else 0


def show_cache(prune):
    if prune:
        reference.prune()
        cache.trim("files", cache.files_cap())
        cache.remove_stale_parts()
    print(cache.root())
    for kind, (n, size) in cache.sizes().items():
        print(f"{kind}\t{n} entries\t{size / 2**30:.2f} GB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
