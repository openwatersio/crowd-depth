"""grid: build the crowd-depth point store.

    grid --store DIR_OR_S3_URL ingest [--source noaa|openwaters] [--prefix YYYY/MM/DD] [--max-files N]
                                       [--keys FILE]
    grid --store DIR_OR_S3_URL confirm-withdrawals SOURCE
    grid --store DIR_OR_S3_URL qc
    grid --store DIR_OR_S3_URL cells [--bbox W,S,E,N]
    grid --store DIR_OR_S3_URL overlay --out DIR
    grid --store DIR_OR_S3_URL stats

Sources default to the NOAA CSB bucket and the Open Waters R2 bucket. R2 access
reads S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.
"""

import argparse
import logging
import math
import sys
from pathlib import Path

from . import cells, overlay, qc
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


def bbox(text: str) -> list[int]:
    """The tile ids of the 1° tiles a west,south,east,north box touches."""
    west, south, east, north = map(float, text.split(","))
    return [
        (lat + 90) * 360 + lon + 180
        for lat in range(math.floor(south), math.ceil(north))
        for lon in range(math.floor(west), math.ceil(east))
    ]


def main(argv=None):
    p = argparse.ArgumentParser(prog="grid", description=__doc__.split("\n")[0])
    p.add_argument(
        "--store", required=True, help="Point store: a local directory or s3://bucket/prefix on R2"
    )
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
    sub.add_parser("qc", help="Flag impossible values, jumps and spikes along each track")
    cl = sub.add_parser("cells", help="Run QC, then rebuild every grid cell, or a region's")
    cl.add_argument(
        "--bbox",
        type=bbox,
        help="Only the 1° tiles this box touches: west,south,east,north in degrees",
    )
    o = sub.add_parser("overlay", help="Build the overlay layers and their PMTiles from the cells")
    o.add_argument("--out", required=True, type=Path, help="Directory for the layers and PMTiles")
    sub.add_parser("stats", help="Count files by source and status")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    alert = False
    with open_store(
        open_objects(args.store), write=args.command not in ("stats", "overlay")
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
        elif args.command == "cells":
            # Cells read QC's flags: QC any batch that hasn't been at this version.
            qc.run(con, missing_only=True)
            cells.build(con, args.bbox)
        elif args.command == "overlay":
            print(overlay.build(con, args.out))
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


if __name__ == "__main__":
    sys.exit(main())
