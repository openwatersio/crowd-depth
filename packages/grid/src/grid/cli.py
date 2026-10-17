"""grid: build the crowd-depth point store.

    grid --store DIR_OR_S3_URL ingest [--source noaa|openwaters] [--prefix YYYY/MM/DD] [--max-files N]
    grid --store DIR_OR_S3_URL confirm-withdrawals SOURCE
    grid --store DIR_OR_S3_URL stats

Sources default to the NOAA CSB bucket and the Open Waters R2 bucket. R2 access
reads S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.
"""

import argparse
import logging
import sys

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
    for name in SOURCES:
        i.add_argument(
            f"--{name}-url", default=SOURCES[name][0], help=f"Where to list {name} files"
        )
    c = sub.add_parser(
        "confirm-withdrawals", help="Let held withdrawals apply once two listings agree"
    )
    c.add_argument("source", choices=SOURCES)
    sub.add_parser("stats", help="Count files by source and status")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    alert = False
    with open_store(open_objects(args.store), write=args.command != "stats") as con:
        if args.command == "ingest":
            for name in args.source or SOURCES:
                url = getattr(args, f"{name}_url")
                objects = open_objects(url, public=SOURCES[name][1])
                alert |= (
                    Ingest(con, name, objects, args.prefix, max_files=args.max_files).run().alert
                )
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
