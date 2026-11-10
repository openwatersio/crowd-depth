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


def version(source: str, station: str, epoch: int, year: int) -> str | None:
    """A year file's version from the years listing, or its ETag; None where it has no
    file, and "" where it has neither."""
    listed = years(source)
    if listed is not None and station in listed:
        return listed[station].get((epoch, year))
    return _etag(url(source, station, epoch, year))


def year_file(source: str, station: str, epoch: int, year: int) -> Path | str | None:
    """A local copy of one year file, current with the lake, or its URL where it can't be
    cached; None where it has no file."""
    href = url(source, station, epoch, year)
    ver = version(source, station, epoch, year)
    if ver is None:
        return None
    tag = re.sub(r"[^A-Za-z0-9]", "", ver)
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


def spans(source: str, station: str, start: datetime, end: datetime) -> list[tuple]:
    """The (epoch, year) year files that could hold a station's levels from `start` to
    before `end`, in epochs that convert to the current datum."""
    row = stations(source).get(station)
    if row is None:
        return []
    last = (end - timedelta(microseconds=1)).year
    return [
        (e, year)
        for e in row["epochs"]
        if e["to_current"] is not None
        and not ((e["since"] and e["since"] >= end) or (e["until"] and e["until"] <= start))
        for year in range(start.year, last + 1)
    ]


def versions(source, station, start, end, version=version) -> str | None:
    """What `observed` would read, as each year file's version, so a change to any of
    them shows; None where no file covers the span."""
    found = [
        (e["id"], y, version(source, station, e["id"], y))
        for e, y in spans(source, station, start, end)
    ]
    if all(v is None for *_, v in found):
        return None
    return ";".join(f"{e}/{y}={'-' if v is None else v}" for e, y, v in found)


def observed(source: str, station: str, start: datetime, end: datetime) -> list[tuple] | None:
    """A station's levels from `start` to before `end` (naive UTC), in its current datum,
    as (time, level_m), leaving out values flagged suspect or bad and epochs that can't be
    converted to the current one; None where no year file holds a value in the span."""
    try:
        return _observed(source, station, start, end)
    except duckdb.IOException:
        # Another run replaced a year file between finding it and reading it.
        return _observed(source, station, start, end)


def _observed(source, station, start, end):
    parts = []
    for e, year in spans(source, station, start, end):
        path = year_file(source, station, e["id"], year)
        if path is not None:
            parts.append((path, e))
    if not parts:
        return None

    def quoted(path):
        return str(path).replace("'", "''")

    union = " UNION ALL ".join(
        f"""SELECT time, level_m::DOUBLE + {float(e["to_current"])} AS level, flag,
          {int(e["rejected"])} AS rejected
        FROM read_parquet('{quoted(p)}') WHERE true
          {f"AND time >= TIMESTAMPTZ '{e['since']}+00'" if e["since"] else ""}
          {f"AND time < TIMESTAMPTZ '{e['until']}+00'" if e["until"] else ""}"""
        for p, e in parts
    )
    # After a rejected epoch, its files and the epoch before it can share a time; the
    # latter wins, flagged or not.
    rows = _sql(
        f"""SELECT timezone('UTC', time) AS t, level, flag FROM ({union})
        WHERE time >= $1::TIMESTAMP AT TIME ZONE 'UTC' AND time < $2::TIMESTAMP AT TIME ZONE 'UTC'
        QUALIFY row_number() OVER (PARTITION BY time ORDER BY rejected, flag, level) = 1
        ORDER BY t""",
        [start, end],
    )
    if not rows:
        return None
    return [(t, level) for t, level, flag in rows if flag <= MAX_FLAG]
