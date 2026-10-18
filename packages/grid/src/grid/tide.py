"""Tide: each sounding's water level above chart datum, so depths reduce to it.

Levels come from the Slackwater engine, the predictor the signalk-tides plugin runs,
so a boat sees the water level its soundings were reduced with. The engine runs in
Node (slackwater/predict.mjs), which is called rather than ported. Each 0.02° tide
cell takes the nearest station within STATION_KM whose license allows commercial use
and whose harmonics Slackwater accepts; NOAA's subordinate stations carry the time
and height corrections to their control station that discrete tide zones would. Where
a CO-OPS water level gauge is within GAUGE_KM of the station, its observed minus
predicted level, the weather's part of the water level, is added to the prediction.
Levels are relative to each station's chart datum: MLLW in US waters, LAT in most
others.

Levels are kept per station and half hour, for the days soundings need, with the
slope to the next half hour, so a sounding's level is interpolated at its own time
when depths are read (catalog's `corrected_points_in`). Raw depths are never changed.
"""

import json
import logging
import math
import os
import subprocess
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from . import cells
from .catalog import TIDE_CELL

log = logging.getLogger(__name__)

STATION_KM = 50
GAUGE_KM = 100
SLOT_S = 1800
# Starting values for a level's uncertainty, until held-out gauges measure them: a
# prediction alone misses the weather's part, which is 0.1 to 0.3 m in the Chesapeake;
# with a gauge's residual, what's left grows with the distance to the gauge.
PREDICTED_SIGMA = 0.25
OBSERVED_SIGMA = 0.10
GAUGE_KM_SIGMA = 0.002
# The image installs the helper with its modules outside the mounted package.
PREDICT = Path(
    os.environ.get("GRID_SLACKWATER")
    or Path(__file__).resolve().parents[2] / "slackwater" / "predict.mjs"
)
COOPS = "https://api.tidesandcurrents.noaa.gov"
FETCHERS = 4
# CO-OPS errors that mean a gauge has no residual to give, rather than a failed request.
NO_RESIDUAL = ("no data", "no mllw", "don't have predictions")
# CO-OPS lists about 300 water level gauges.
MIN_GAUGES = 100
# Storm surges reach about 4 m (Sandy, 2012); a larger residual is a faulty reading.
MAX_RESIDUAL_M = 5.0
# Low-water chart datums, and mean sea level where charts use it (the Baltic). A station
# with only its own station datum would reduce depths to roughly mean sea level, deeper
# than chart datum.
CHART_DATUMS = {"MLLW", "LAT", "NLLW", "LLWLT", "MLWS", "TLT", "CD", "MSL"}
# Diurnal range (MHHW - MLLW) under which an LLWLT station is a lake gauge: the Great
# Lakes' run 0.08 to 0.14 m.
LAKE_RANGE_M = 0.15
# Seconds a batch of Slackwater predictions may take before the run gives up.
NODE_TIMEOUT_S = 3600
# A gauge month is final this long after its end, once late and verified data is in.
RECENT_DAYS = 45
# Of the stations a store uses, more than this share leaving in one run is refused.
MAX_LEAVING = 0.1
GUARDED_STATIONS = 100
EARTH_KM = 6371.0


def node(mode: str, lines=()) -> list:
    """Run the Slackwater helper in `mode`, sending `lines` as JSON; its JSON lines back."""
    out = subprocess.run(
        ["node", str(PREDICT), mode],
        input="".join(json.dumps(x) + "\n" for x in lines),
        capture_output=True,
        text=True,
        check=True,
        timeout=NODE_TIMEOUT_S,
    ).stdout
    return [json.loads(x) for x in out.splitlines()]


def slackwater_stations() -> list[dict]:
    return node("stations")


def slackwater_version() -> str:
    """The engine and station database versions the helper runs."""
    [version] = node("version")
    return version


def slackwater_levels(requests: list[dict]) -> list[list]:
    """Each request's [[epoch s, level], ...], for requests of {station, start, end, step}."""
    return [series for _, series in node("levels", requests)]


def _get(url: str, params: dict) -> dict:
    url = f"{url}?{urllib.parse.urlencode(params)}"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.load(r)
        except OSError:
            if attempt == 3:
                raise
            time.sleep(2**attempt)


def coops_gauges() -> list[dict]:
    """CO-OPS water level gauges: {id, lon, lat}."""
    body = _get(f"{COOPS}/mdapi/prod/webapi/stations.json", {"type": "waterlevels"})
    gauges = [{"id": s["id"], "lon": s["lng"], "lat": s["lat"]} for s in body["stations"]]
    # A cut-off listing would strip most stations of their gauge's weather.
    if len(gauges) < MIN_GAUGES:
        raise RuntimeError(f"CO-OPS listed only {len(gauges)} water level gauges")
    return gauges


def coops_residuals(gauge: str, month: date) -> list[tuple[datetime, float]]:
    """A gauge's observed minus predicted level, 6-minute, through one month."""
    end = (month.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    params = {
        "station": gauge,
        "begin_date": month.strftime("%Y%m%d"),
        "end_date": end.strftime("%Y%m%d"),
        "datum": "MLLW",
        "units": "metric",
        "time_zone": "gmt",
        "format": "json",
        "application": "crowd-depth",
    }
    series = {}
    for product, key in (("water_level", "data"), ("predictions", "predictions")):
        body = _get(f"{COOPS}/api/prod/datagetter", params | {"product": product})
        # A month the gauge has no data for, or a gauge without MLLW or predictions (the
        # Great Lakes'), is an answer: no residual. Any other error is not.
        error = (body.get("error") or {}).get("message", "")
        if error and not any(x in error.lower() for x in NO_RESIDUAL):
            raise RuntimeError(f"CO-OPS {product} for {gauge} {month}: {error}")
        series[product] = {
            r["t"]: float(r["v"]) for r in body.get(key, []) if r.get("v") not in (None, "")
        }
    observed, predicted = series["water_level"], series["predictions"]
    # A residual past MAX_RESIDUAL_M is a gauge fault, not weather.
    return [
        (datetime.strptime(t, "%Y-%m-%d %H:%M"), observed[t] - predicted[t])
        for t in sorted(observed.keys() & predicted.keys())
        if abs(observed[t] - predicted[t]) <= MAX_RESIDUAL_M
    ]


def _xyz(lon, lat):
    lon, lat = np.radians(np.asarray(lon, float)), np.radians(np.asarray(lat, float))
    return np.column_stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])


def nearest(lon, lat, to_lon, to_lat, within_km):
    """Index into `to` of the nearest point within `within_km` of each point, or -1, and the km."""
    if not len(to_lon) or not len(lon):
        return np.full(len(lon), -1), np.full(len(lon), np.inf)
    chord, i = cKDTree(_xyz(to_lon, to_lat)).query(_xyz(lon, lat))
    km = 2 * EARTH_KM * np.arcsin(np.minimum(chord / 2, 1))
    return np.where(km <= within_km, i, -1), km


def insert(con, table, columns):
    """Append numpy columns to a table, in its column order."""
    con.register("insert_np", columns)
    con.execute(f"INSERT INTO {table} SELECT * FROM insert_np")
    con.unregister("insert_np")


def eligible(station) -> bool:
    """A station levels may come from: openly licensed, harmonics Slackwater accepts, and
    levels on a chart datum. A lake gauge's lowest low water comes from its level record,
    not the tide, so a lake (LLWLT with almost no diurnal range) isn't tidal."""
    lake = station.get("chart_datum") == "LLWLT" and not (
        (station.get("diurnal_range") or 0) >= LAKE_RANGE_M
    )
    return bool(
        station["commercial_use"]
        and station["accepted"]
        and station.get("has_datums")
        and station.get("chart_datum") in CHART_DATUMS
        and not lake
    )


def load_stations(con, stations=slackwater_stations, gauges=coops_gauges, version=None):
    """Bring `tide_stations` up to Slackwater's current list. New eligible stations join
    with new ids; a station gone from the list or no longer eligible leaves, with its
    levels. When the engine or database `version` changes, every station's details and
    gauge are taken again and every level is dropped, to be predicted again. Returns
    whether levels were dropped for that."""
    rows = {s["id"]: s for s in stations() if eligible(s)}
    if not rows:
        raise RuntimeError("no tide station passes the license, quality and datum filter")
    have = dict(con.execute("SELECT station, station_id FROM lake.tide_stations").fetchall())
    gone = [sid for st, sid in have.items() if st not in rows]
    # A changed filter or a broken release, not stations retired one by one.
    if len(have) >= GUARDED_STATIONS and len(gone) > MAX_LEAVING * len(have):
        raise RuntimeError(
            f"{len(gone)} of {len(have)} tide stations would leave at once; check the release"
        )
    stored = con.execute("SELECT value FROM lake.store_meta WHERE key = 'slackwater'").fetchone()
    refresh = bool(have) and version is not None and (stored is None or stored[0] != version)
    if gone:
        for table in ("tide_levels", "tide_stations"):
            con.execute(
                f"DELETE FROM lake.{table} WHERE list_contains($gone, station_id)", {"gone": gone}
            )
    if refresh:
        con.execute("DELETE FROM lake.tide_levels")
        con.execute("DELETE FROM lake.tide_stations")
    write = [s for st, s in rows.items() if refresh or st not in have]
    if write:
        g = gauges()
        lon, lat = np.array([s["lon"] for s in write]), np.array([s["lat"] for s in write])
        gi, gkm = nearest(lon, lat, [x["lon"] for x in g], [x["lat"] for x in g], GAUGE_KM)
        next_id = max(have.values(), default=-1) + 1
        ids = []
        for s in write:
            if s["id"] in have:
                ids.append(have[s["id"]])
            else:
                ids.append(next_id)
                next_id += 1
        insert(
            con,
            "lake.tide_stations",
            {
                "station_id": np.array(ids, dtype=np.int32),
                "station": np.array([s["id"] for s in write]),
                "lon": lon,
                "lat": lat,
                "chart_datum": np.array([s.get("chart_datum") for s in write], dtype=object),
                "gauge": np.array([g[i]["id"] if i >= 0 else None for i in gi], dtype=object),
                "gauge_km": np.where(gi >= 0, gkm, np.nan).astype(np.float32),
                "license": np.array([s.get("license") for s in write], dtype=object),
                "attribution": np.array([s.get("attribution") for s in write], dtype=object),
            },
        )
        con.execute("UPDATE lake.tide_stations SET gauge_km = NULL WHERE isnan(gauge_km)")
    if version is not None:
        con.execute("DELETE FROM lake.store_meta WHERE key = 'slackwater'")
        con.execute("INSERT INTO lake.store_meta VALUES ('slackwater', ?)", [version])
    if gone or write:
        log.info("tide: %d stations written, %d left", len(write), len(gone))
    return refresh


def assign_cells(con):
    """Give every tide cell with points its nearest station, or none past STATION_KM, so a
    station that joins nearer takes its cells over. Only cells whose station changed are
    rewritten; their tiles go in the temp table `moved_cells`."""
    cells_ = con.execute(
        f"SELECT DISTINCT {TIDE_CELL} AS tide_cell, tile_id FROM lake.points p"
    ).fetchnumpy()
    con.execute("CREATE OR REPLACE TEMP TABLE moved_cells (tide_cell BIGINT, tile_id INTEGER)")
    if not len(cells_["tide_cell"]):
        return
    lat = (cells_["tide_cell"] // 18000 + 0.5) / 50 - 90
    lon = (cells_["tide_cell"] % 18000 + 0.5) / 50 - 180
    st = con.execute("SELECT station_id, lon, lat FROM lake.tide_stations").fetchnumpy()
    i, km = nearest(lon, lat, st["lon"], st["lat"], STATION_KM)
    con.register(
        "assign_np",
        {
            "tide_cell": cells_["tide_cell"],
            "tile_id": cells_["tile_id"],
            "station_id": np.where(i >= 0, st["station_id"][np.maximum(i, 0)], -1),
            "km": np.where(i >= 0, km, np.nan),
        },
    )
    con.execute(
        """INSERT INTO moved_cells
        SELECT a.tide_cell, a.tile_id FROM assign_np a
        LEFT JOIN lake.tide_cells c USING (tide_cell)
        WHERE c.tide_cell IS NULL
          OR c.station_id IS DISTINCT FROM CASE WHEN a.station_id >= 0 THEN a.station_id END
          OR abs(c.km - a.km) > 0.01"""
    )
    # A cell new to the table had no levels to change; its days' levels mark it if it gets any.
    con.execute(
        """CREATE OR REPLACE TEMP TABLE new_cells AS SELECT tide_cell FROM moved_cells
        WHERE tide_cell NOT IN (SELECT tide_cell FROM lake.tide_cells)"""
    )
    con.execute(
        "DELETE FROM lake.tide_cells WHERE tide_cell IN (SELECT tide_cell FROM moved_cells)"
    )
    # A cell past every station's reach has none.
    con.execute(
        """INSERT INTO lake.tide_cells
        SELECT tide_cell, tile_id, CASE WHEN station_id >= 0 THEN station_id END,
          CASE WHEN station_id >= 0 THEN km END
        FROM assign_np WHERE tide_cell IN (SELECT tide_cell FROM moved_cells)"""
    )
    con.unregister("assign_np")
    con.execute("DELETE FROM moved_cells WHERE tide_cell IN (SELECT tide_cell FROM new_cells)")
    con.execute("DROP TABLE new_cells")


def month_end(month: date) -> date:
    return (month.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)


def fetch_residuals(con, days, today, residuals=coops_residuals):
    """Fetch the gauge months that `days` (gauge, day) need and don't have."""
    have = set(con.execute("SELECT gauge, month FROM lake.tide_residual_months").fetchall())
    months = sorted({(g, d.replace(day=1)) for g, d in days if g} - have)
    # A few at a time: each month is two requests of a few seconds.
    with ThreadPoolExecutor(FETCHERS) as pool:
        for (gauge, month), rows in zip(months, pool.map(lambda m: residuals(*m), months)):
            if rows:
                times, values = zip(*rows)
                insert(
                    con,
                    "lake.tide_residuals",
                    {
                        "gauge": np.full(len(times), gauge),
                        "time": np.array(times, dtype="datetime64[us]"),
                        "residual": np.array(values, dtype=float),
                    },
                )
            con.execute(
                "INSERT INTO lake.tide_residual_months VALUES (?, ?, ?)", [gauge, month, today]
            )
    if months:
        log.info("tide: fetched %d gauge months", len(months))


def build(
    con,
    stations=slackwater_stations,
    gauges=coops_gauges,
    residuals=coops_residuals,
    levels=slackwater_levels,
    version=None,
    batch_days=2000,
    today=None,
):
    """Tide levels for every station day soundings need and don't have yet; returns how
    many days.

    A gauge month isn't final until RECENT_DAYS past its end: its data arrives late and is
    verified later. Until then it is fetched again on every run, and its stations' levels
    for that month are done again. Tiles whose soundings' levels changed are marked stale
    for `grid cells --changed`.
    """
    # ponytail: scans every point for new cells and days; read only new batches at planet scale
    today = today or datetime.now(UTC).date()
    version = version or slackwater_version()
    # Before anything changes: new cells change the cells' inputs too.
    was_settled = cells.settled(con)
    con.execute("CREATE OR REPLACE TEMP TABLE old_levels AS SELECT * FROM lake.tide_levels LIMIT 0")
    if (
        con.execute("SELECT count(*) FROM lake.tide_stations").fetchone()[0]
        and version
        != (
            con.execute("SELECT value FROM lake.store_meta WHERE key = 'slackwater'").fetchone()
            or [None]
        )[0]
    ):
        con.execute("INSERT INTO old_levels SELECT * FROM lake.tide_levels")
    load_stations(con, stations, gauges, version)
    assign_cells(con)
    # Gauge months that aren't final are fetched again, and their levels done again.
    con.execute(
        f"""CREATE OR REPLACE TEMP TABLE open_months AS SELECT gauge, month
        FROM lake.tide_residual_months
        WHERE fetched < last_day(month) + INTERVAL {RECENT_DAYS} DAY"""
    )
    con.execute(
        """INSERT INTO old_levels SELECT l.* FROM lake.tide_levels l
        JOIN lake.tide_stations s USING (station_id)
        JOIN open_months m ON m.gauge = s.gauge AND m.month = date_trunc('month', l.slot)::DATE"""
    )
    con.execute(
        """DELETE FROM lake.tide_levels WHERE (station_id, slot) IN (
          SELECT station_id, slot FROM old_levels)"""
    )
    con.execute(
        """DELETE FROM lake.tide_residuals WHERE (gauge, date_trunc('month', time)::DATE) IN (
          SELECT gauge, month FROM open_months)"""
    )
    con.execute(
        """DELETE FROM lake.tide_residual_months WHERE (gauge, month) IN (
          SELECT gauge, month FROM open_months)"""
    )
    need = con.execute(
        f"""SELECT DISTINCT c.station_id, s.station, s.gauge,
          date_trunc('day', p.time)::DATE AS day
        FROM lake.points p JOIN lake.tide_cells c ON c.tide_cell = {TIDE_CELL}
        JOIN lake.tide_stations s USING (station_id)
        WHERE p.time IS NOT NULL AND (c.station_id, date_trunc('day', p.time)::DATE) NOT IN (
          SELECT DISTINCT station_id, slot::DATE FROM lake.tide_levels)
        ORDER BY ALL"""
    ).fetchall()
    fetch_residuals(con, [(g, d) for _, _, g, d in need], today, residuals)
    for i in range(0, len(need), batch_days):
        chunk = need[i : i + batch_days]
        starts = [int(datetime.combine(d, datetime.min.time(), UTC).timestamp()) for *_, d in chunk]
        series = levels(
            [
                {"station": station, "start": t0, "end": t0 + 86400, "step": SLOT_S}
                for (_, station, _, _), t0 in zip(chunk, starts)
            ]
        )
        # A level the engine couldn't give (null, NaN) leaves its day without levels.
        rows = [
            (sid, day, t, h)
            for (sid, _, _, day), s in zip(chunk, series)
            for t, h in s
            if h is not None and math.isfinite(h)
        ]
        if not rows:
            continue
        sid, day, t, h = zip(*rows)
        con.execute(
            """CREATE OR REPLACE TEMP TABLE predicted
            (station_id INTEGER, day DATE, t BIGINT, level DOUBLE)"""
        )
        insert(
            con,
            "predicted",
            {
                "station_id": np.array(sid, dtype=np.int32),
                "day": np.array(day, dtype="datetime64[D]").astype("datetime64[us]"),
                "t": np.array(t, dtype=np.int64),
                "level": np.array(h, dtype=float),
            },
        )
        con.execute("BEGIN")
        con.execute(LEVELS)
        con.execute("COMMIT")
        con.checkpoint()
    # Station days whose levels were gained, changed or lost, and cells that changed
    # station, make their soundings' tiles stale.
    con.register(
        "need_np",
        {
            "station_id": np.array([sid for sid, *_ in need], dtype=np.int32),
            "day": np.array([d for *_, d in need], dtype="datetime64[D]").astype("datetime64[us]"),
        },
    )
    changed = cells.stale(
        con,
        f"""WITH days AS (
          SELECT DISTINCT station_id, slot::DATE AS day FROM (
            (SELECT * FROM lake.tide_levels
              WHERE (station_id, slot::DATE) IN (SELECT station_id, day::DATE FROM need_np)
              EXCEPT SELECT * FROM old_levels)
            UNION ALL
            (SELECT * FROM old_levels EXCEPT SELECT * FROM lake.tide_levels))
        )
        SELECT p.tile_id FROM lake.points p
        LEFT JOIN lake.tide_cells c ON c.tide_cell = {TIDE_CELL}
        WHERE p.tile_id IN (SELECT tile_id FROM moved_cells)
          OR (c.station_id, date_trunc('day', p.time)::DATE) IN (SELECT station_id, day FROM days)
          -- Days a station that left had levels for: its cells moved, and are in moved_cells.
        """,
        {},
        "tide",
        was_settled,
    )
    con.unregister("need_np")
    for table in ("predicted", "old_levels", "moved_cells", "open_months"):
        con.execute(f"DROP TABLE IF EXISTS {table}")
    log.info("tide: %d station days, %d tiles changed", len(need), changed)
    return len(need)


# Each predicted half hour of a station day, plus its gauge's residual where the gauge
# has one then, with the prediction's slope to the next half hour, so a level is
# interpolated within its slot. The day's last point, the next midnight, only ends its
# last slot.
LEVELS = f"""
INSERT INTO lake.tide_levels
WITH j AS (
  SELECT p.station_id, p.day, make_timestamp(p.t * 1000000) AS slot, p.level AS predicted,
    p.level + coalesce(r.residual, 0) AS level, r.residual IS NOT NULL AS observed, s.gauge_km
  FROM predicted p JOIN lake.tide_stations s USING (station_id)
  LEFT JOIN lake.tide_residuals r
    ON r.gauge = s.gauge AND r.time = make_timestamp(p.t * 1000000) AND r.residual IS NOT NULL
)
SELECT station_id, slot, level,
  -- The tide's own slope; the weather's residual holds across the slot, so a slot next to
  -- one without a residual, such as the next month's first, keeps its own.
  (lead(predicted) OVER w - predicted) / {SLOT_S} AS slope,
  CASE WHEN observed THEN sqrt({OBSERVED_SIGMA} ^ 2 + (gauge_km * {GAUGE_KM_SIGMA}) ^ 2)
    ELSE {PREDICTED_SIGMA} END AS sigma,
  CASE WHEN observed THEN 'observed' ELSE 'predicted' END AS method
FROM j
WINDOW w AS (PARTITION BY station_id, day ORDER BY slot)
QUALIFY lead(slot) OVER w = slot + INTERVAL {SLOT_S} SECOND
"""
