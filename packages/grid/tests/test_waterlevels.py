import hashlib
import threading
from datetime import date, datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import ClassVar

import duckdb
import pytest

from grid import tide, waterlevels


class Handler(SimpleHTTPRequestHandler):
    """Serves the lake's files with an ETag, as its bucket does, and counts the GETs."""

    gets: ClassVar[list[str]] = []

    def end_headers(self):
        path = self.translate_path(self.path)
        try:
            with open(path, "rb") as f:
                self.send_header("ETag", f'"{hashlib.md5(f.read()).hexdigest()}"')
        except OSError:
            pass
        super().end_headers()

    def do_GET(self):
        Handler.gets.append(self.path)
        super().do_GET()

    def log_message(self, *args):
        pass


@pytest.fixture
def lake(tmp_path, monkeypatch):
    root = tmp_path / "lake"
    root.mkdir()
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setattr(waterlevels, "LAKE", f"http://127.0.0.1:{server.server_port}")
    waterlevels.stations.cache_clear()
    waterlevels.years.cache_clear()
    Handler.gets = []
    stations(root)
    yield root
    server.shutdown()
    waterlevels.stations.cache_clear()
    waterlevels.years.cache_clear()


def sql(query):
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    con.execute(query)


def stations(root):
    """g1 in one epoch; g2 moved to a new reference at the start of July 2024, its earlier
    levels 0.5 m below the current datum."""
    sql(
        f"""COPY (
          SELECT * FROM (VALUES
            ('coops', 'g1', MAP {{'MLLW': -1.0::DOUBLE}},
              [{{'id': 1, 'since': NULL::TIMESTAMPTZ, 'until': NULL::TIMESTAMPTZ,
                'to_current': 0.0, 'state': 'accepted'}}]),
            ('coops', 'g2', MAP {{'MLLW': -1.0::DOUBLE}},
              [{{'id': 1, 'since': NULL::TIMESTAMPTZ, 'until': TIMESTAMPTZ '2024-07-01 00:00:00+00',
                'to_current': -0.5, 'state': 'accepted'}},
               {{'id': 2, 'since': TIMESTAMPTZ '2024-07-01 00:00:00+00', 'until': NULL::TIMESTAMPTZ,
                'to_current': 0.0, 'state': 'accepted'}}])
          ) t(source, source_id, datums, epochs)
        ) TO '{root}/stations.parquet'"""
    )


def obs(root, path, rows):
    """A year file of (time, level_m, flag)."""
    dest = root / "obs" / "coops" / path
    dest.parent.mkdir(parents=True, exist_ok=True)
    values = ", ".join(f"(TIMESTAMPTZ '{t}+00', {v}::FLOAT, {f}::UTINYINT)" for t, v, f in rows)
    sql(
        f"""COPY (SELECT time, level_m, flag, flag AS source_flag, NULL::TIMESTAMPTZ AS received,
          'STND' AS datum FROM (VALUES {values}) t(time, level_m, flag))
        TO '{dest}'"""
    )


def years(root, rows):
    (root / "stations" / "years").mkdir(parents=True, exist_ok=True)
    values = ", ".join(f"('{i}', {e}, {y}, '{v}')" for i, e, y, v in rows)
    sql(
        f"""COPY (SELECT * FROM (VALUES {values}) t(id, epoch, year, version))
        TO '{root}/stations/years/coops.parquet'"""
    )


def test_levels_leave_out_suspect_and_bad_values(lake):
    obs(
        lake,
        "g1/2024.parquet",
        [
            ("2024-03-01 00:00:00", 1.5, 0),
            ("2024-03-01 00:06:00", 1.6, 2),
            ("2024-03-01 00:12:00", 9.0, 3),
            ("2024-03-01 00:18:00", 9.0, 4),
            ("2024-04-01 00:00:00", 1.7, 0),
        ],
    )
    got = waterlevels.observed("coops", "g1", datetime(2024, 3, 1), datetime(2024, 4, 1))
    assert got == [
        (datetime(2024, 3, 1, 0, 0), pytest.approx(1.5)),
        (datetime(2024, 3, 1, 0, 6), pytest.approx(1.6)),
    ]


def test_an_earlier_epochs_levels_are_put_in_the_current_datum(lake):
    obs(lake, "g2/2024.parquet", [("2024-06-30 23:54:00", 2.0, 0), ("2024-07-01 00:00:00", 9.0, 0)])
    obs(lake, "g2/2/2024.parquet", [("2024-07-01 00:00:00", 1.4, 0)])
    got = waterlevels.observed("coops", "g2", datetime(2024, 6, 30), datetime(2024, 7, 2))
    # Epoch 1's row past its `until` isn't part of the series.
    assert got == [
        (datetime(2024, 6, 30, 23, 54), pytest.approx(1.5)),
        (datetime(2024, 7, 1, 0, 0), pytest.approx(1.4)),
    ]


def test_a_year_file_is_downloaded_again_only_when_its_version_changes(lake):
    obs(lake, "g1/2024.parquet", [("2024-03-01 00:00:00", 1.5, 0)])
    years(lake, [("coops/g1", 1, 2024, "aaa")])
    first = waterlevels.year_file("coops", "g1", 1, 2024)
    assert waterlevels.year_file("coops", "g1", 1, 2024) == first
    # Listed as missing: no request at all.
    assert waterlevels.year_file("coops", "g1", 1, 2023) is None
    assert Handler.gets.count("/obs/coops/g1/2024.parquet") == 1
    years(lake, [("coops/g1", 1, 2024, "bbb")])
    waterlevels.years.cache_clear()
    second = waterlevels.year_file("coops", "g1", 1, 2024)
    assert second != first and second.exists() and not first.exists()
    assert Handler.gets.count("/obs/coops/g1/2024.parquet") == 2


def test_without_a_years_listing_the_etag_versions_a_year_file(lake):
    obs(lake, "g1/2024.parquet", [("2024-03-01 00:00:00", 1.5, 0)])
    first = waterlevels.year_file("coops", "g1", 1, 2024)
    assert waterlevels.year_file("coops", "g1", 1, 2024) == first
    assert waterlevels.year_file("coops", "g1", 1, 2023) is None
    obs(lake, "g1/2024.parquet", [("2024-03-01 00:00:00", 1.6, 0)])
    assert waterlevels.year_file("coops", "g1", 1, 2024) != first
    assert Handler.gets.count("/obs/coops/g1/2024.parquet") == 2


def test_a_station_the_listing_marks_is_checked_by_its_etag(lake):
    obs(lake, "g1/2024.parquet", [("2024-03-01 00:00:00", 1.5, 0)])
    (lake / "stations" / "years").mkdir(parents=True)
    years_rows = "('coops/g1', 1, 2023, 'aaa'), ('coops/g1', NULL, NULL, NULL)"
    sql(
        f"""COPY (SELECT * FROM (VALUES {years_rows}) t(id, epoch, year, version))
        TO '{lake}/stations/years/coops.parquet'"""
    )
    # The listing has no 2024 row, but a marked station's rows may be out of date.
    assert waterlevels.year_file("coops", "g1", 1, 2024) is not None


def test_lake_residuals_are_observed_in_mllw_minus_slackwater(lake, monkeypatch):
    obs(
        lake,
        "g1/2024.parquet",
        [
            ("2024-03-01 00:00:00", 1.5, 0),
            ("2024-03-01 00:06:00", 1.6, 0),
            ("2024-03-01 00:12:00", 9.9, 4),
        ],
    )
    asked = []

    def levels(requests):
        asked.extend(requests)
        return [[[t, 0.3] for t in range(r["start"], r["end"] + 1, r["step"])] for r in requests]

    monkeypatch.setattr(tide, "slackwater_levels", levels)
    got = tide.lake_residuals("g1", date(2024, 3, 1))
    assert got == [
        (datetime(2024, 3, 1, 0, 0), pytest.approx(0.2)),
        (datetime(2024, 3, 1, 0, 6), pytest.approx(0.3)),
    ]
    [req] = asked
    assert req["station"] == "noaa/g1" and req["step"] == 360 and req["datum"] == "MLLW"
    assert req["end"] - req["start"] == 31 * 86400 - 360
    # A gauge the lake has no MLLW for, or no station at all, has no residual.
    assert tide.lake_residuals("nowhere", date(2024, 3, 1)) == []


def test_december_reads_only_its_own_year(lake):
    obs(lake, "g1/2024.parquet", [("2024-12-31 23:54:00", 1.5, 0)])
    obs(lake, "g1/2025.parquet", [("2025-01-01 00:00:00", 1.6, 0)])
    got = waterlevels.observed("coops", "g1", datetime(2024, 12, 1), datetime(2025, 1, 1))
    assert len(got) == 1
    assert "/obs/coops/g1/2025.parquet" not in Handler.gets


def test_a_year_file_the_cache_cant_take_is_read_from_the_lake(lake, monkeypatch):
    obs(lake, "g1/2024.parquet", [("2024-03-01 00:00:00", 1.5, 0)])

    def unwritable(dest):
        raise PermissionError(dest)

    monkeypatch.setattr(waterlevels.cache, "writing", unwritable)
    assert waterlevels.year_file("coops", "g1", 1, 2024) == waterlevels.url("coops", "g1", 1, 2024)
    got = waterlevels.observed("coops", "g1", datetime(2024, 3, 1), datetime(2024, 4, 1))
    assert got == [(datetime(2024, 3, 1), pytest.approx(1.5))]


def test_an_unknown_water_levels_source_is_refused(monkeypatch):
    monkeypatch.setenv("GRID_WATER_LEVELS", "Lake")
    with pytest.raises(ValueError):
        tide.residual_source()
