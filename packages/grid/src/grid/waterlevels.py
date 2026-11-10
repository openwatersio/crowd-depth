"""Observed water levels from the Open Waters water-levels lake.

The lake (https://water-levels.openwaters.io, documented in openwatersio/water-levels
`docs/data.md`) keeps each station's observations as one Parquet file per year, in the
station's own datum, with each datum epoch's files apart. A year file is downloaded once
into the shared cache and kept under the `version` the lake's years listing gives it, so
it is downloaded again only when its rows change. Where a source has no years listing yet,
or lists a station as being rewritten, the file's ETag stands in for its version. A file
with neither, or one the cache can't take, is read from the lake instead.
"""

import contextlib
import functools
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

import duckdb

from . import cache

LAKE = "https://water-levels.openwaters.io"
# The flags kept: good, interpolated and preliminary; suspect and bad are left out.
MAX_FLAG = 2
# Each read is a few year files; several run at once beside the Slackwater helper.
MEMORY_LIMIT = "256MB"


def _sql(query: str, params=None) -> list:
    con = duckdb.connect()
    try:
        con.execute("SET TimeZone = 'UTC'")
        con.execute("SET memory_limit = ?", [MEMORY_LIMIT])
        return con.execute(query, params or []).fetchall()
    finally:
        con.close()


@functools.cache
def stations(source: str) -> dict[str, dict]:
    """A source's stations by `source_id`: {datums, epochs}, each epoch {id, since, until,
    to_current, rejected}, times as naive UTC."""
    rows = _sql(
        f"""SELECT source_id, datums,
          [{{'id': e.id, 'since': timezone('UTC', e.since), 'until': timezone('UTC', e.until),
            'to_current': e.to_current, 'rejected': coalesce(e.state = 'rejected', false)}}
           for e in epochs] AS epochs
        FROM '{LAKE}/stations.parquet' WHERE source = $1""",
        [source],
    )
    return {sid: {"datums": datums or {}, "epochs": epochs or []} for sid, datums, epochs in rows}


@functools.cache
def years(source: str) -> dict[str, dict[tuple[int, int], str]] | None:
    """Each station's year files, {(epoch, year): version}, by `source_id`; None where the
    source has no years listing. A station the listing marks as being rewritten is left
    out, as is one with a row lacking its version, so its files are checked one by one."""
    try:
        rows = _sql(
            f"""SELECT id, epoch, year, version
            FROM '{LAKE}/stations/years/{source}.parquet'"""
        )
    except duckdb.HTTPException as e:
        if "404" in str(e):
            return None
        raise
    out, marked = {}, set()
    for sid, epoch, year, version in rows:
        sid = sid.removeprefix(f"{source}/")
        if epoch is None or year is None or version is None:
            marked.add(sid)
        else:
            out.setdefault(sid, {})[(epoch, year)] = version
    for sid in marked:
        out.pop(sid, None)
    return out


def url(source: str, station: str, epoch: int, year: int) -> str:
    part = "" if epoch == 1 else f"/{epoch}"
    return f"{LAKE}/obs/{source}/{urllib.parse.quote(station, safe='')}{part}/{year}.parquet"


def _etag(href: str) -> str | None:
    """The file's ETag, or None where there is no file."""
    req = urllib.request.Request(href, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.headers.get("ETag") or ""
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def year_file(source: str, station: str, epoch: int, year: int) -> Path | str | None:
    """A local copy of one year file, current with the lake, or its URL where it can't be
    cached; None where it has no file."""
    href = url(source, station, epoch, year)
    listed = years(source)
    if listed is not None and station in listed:
        version = listed[station].get((epoch, year))
    else:
        version = _etag(href)
    if version is None:
        return None
    tag = re.sub(r"[^A-Za-z0-9]", "", version)
    if not tag:
        return href
    folder = cache.path("water-levels", "obs", source, urllib.parse.quote(station, safe=""), epoch)
    dest = folder / f"{year}.{tag}.parquet"
    if dest.exists():
        return dest
    try:
        with cache.writing(dest) as tmp, urllib.request.urlopen(href, timeout=300) as r:
            tmp.write_bytes(r.read())
    except OSError:
        return href
    for old in folder.glob(f"{year}.*.parquet"):
        if old != dest:
            with contextlib.suppress(OSError):
                old.unlink()
    return dest


def observed(source: str, station: str, start: datetime, end: datetime) -> list[tuple]:
    """A station's levels from `start` to before `end` (naive UTC), in its current datum,
    as (time, level_m), leaving out values flagged suspect or bad and epochs that can't be
    converted to the current one."""
    try:
        return _observed(source, station, start, end)
    except duckdb.IOException:
        # Another run replaced a year file between finding it and reading it.
        return _observed(source, station, start, end)


def _observed(source, station, start, end):
    row = stations(source).get(station)
    if row is None:
        return []
    parts = []
    for e in row["epochs"]:
        if e["to_current"] is None:
            continue
        if (e["since"] and e["since"] >= end) or (e["until"] and e["until"] <= start):
            continue
        for year in range(start.year, (end - timedelta(microseconds=1)).year + 1):
            path = year_file(source, station, e["id"], year)
            if path is not None:
                parts.append((path, e))
    if not parts:
        return []

    def quoted(path):
        return str(path).replace("'", "''")

    union = " UNION ALL ".join(
        f"""SELECT time, level_m::DOUBLE + {float(e["to_current"])} AS level, {int(e["rejected"])} AS rejected
        FROM read_parquet('{quoted(p)}') WHERE flag <= {MAX_FLAG}
          {f"AND time >= TIMESTAMPTZ '{e['since']}+00'" if e["since"] else ""}
          {f"AND time < TIMESTAMPTZ '{e['until']}+00'" if e["until"] else ""}"""
        for p, e in parts
    )
    # After a rejected epoch, its files and the epoch before it can share a time; the
    # latter wins.
    return _sql(
        f"""SELECT timezone('UTC', time) AS t, level FROM ({union})
        WHERE time >= $1::TIMESTAMP AT TIME ZONE 'UTC' AND time < $2::TIMESTAMP AT TIME ZONE 'UTC'
        QUALIFY row_number() OVER (PARTITION BY time ORDER BY rejected) = 1
        ORDER BY t""",
        [start, end],
    )
