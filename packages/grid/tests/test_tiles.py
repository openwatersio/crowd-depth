import contextlib
import fcntl
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import duckdb
import pytest
import test_grid
from pmtiles.reader import MmapSource, Reader, all_tiles
from test_ingest import env  # noqa: F401  (env is a fixture)

from grid import cells, cli, overlay, tiles
from grid.catalog import open_store
from grid.objects import LocalObjects

SOUTH = (test_grid.LAT0 + 90) * 360 + test_grid.LON0 + 180
NORTH = SOUTH + 360


def track(r, depth, lat_shift=0):
    """A track along base row `r` of the fixture's tile, or the tile `lat_shift` north."""
    return [
        (i, lon, lat + lat_shift, 3.0 if i < 30 else depth)
        for i, (lon, lat) in enumerate(test_grid.at(r, c) for c in range(60))
    ]


def key_of(n):
    """The key test_grid.put stores file `n` under."""
    return f"csb/csv/2026/10/14/20261014{n:06d}000000_{n}_pointData.csv"


def two_tiles(env):  # noqa: F811
    """A shoaling bank on two tracks in the south tile, one track in the north tile."""
    test_grid.put(env, 1, track(5000, 12.0), "A")
    test_grid.put(env, 2, track(5012, 12.0), "B")
    test_grid.put(env, 3, track(200, 20.0, lat_shift=1), "C")
    env.run("noaa")


def test_resources_grow_with_soundings():
    assert tiles.resources("cells", 50_000) == (512, 1)
    assert tiles.resources("surface", 5_000_000) == (3584, 2)
    assert tiles.resources("overlay", 30_000_000) == (7168, 4)
    assert tiles.resources("web", 10) == (tiles.WEB_MEMORY_MB, 1)


def test_tile_geometry_wraps_the_antimeridian():
    east = (10 + 90) * 360 + 179 + 180
    assert (10 + 90) * 360 + 0 in tiles.neighbors(east)  # lon -180
    assert len(tiles.neighbors(east)) == 9
    assert len(tiles.neighbors(5)) == 6  # the southmost row has no row south of it
    # z8 tiles are 1.4° wide: 78°W–77°W crosses the line between columns 72 and 73.
    assert {k.split("_")[0] for k in tiles.tile_z8s(SOUTH)} == {"72", "73"}
    assert tiles.tile_z8s((86 + 90) * 360) == []  # past Web Mercator
    # A sounding on the equator is the north tile's, in the z8 row south of the line.
    assert {k.split("_")[1] for k in tiles.tile_z8s(90 * 360 + 185)} == {"127", "128"}


def test_prepare_writes_fingerprints_only_when_they_move(env, tmp_path):  # noqa: F811
    two_tiles(env)
    run = tmp_path / "run"
    got = tiles.prepare(env.store, run)
    assert (got["tiles"], got["moved"], got["gone"]) == (2, [SOUTH, NORTH], [])
    assert tiles.counts(run) == {SOUTH: 120, NORTH: 60}
    assert (run / "snapshot.ducklake").exists()
    assert (run / "credits.txt").read_text().startswith("Crowd Depth")
    written = {t: tiles.fp_path(run, t).stat().st_mtime_ns for t in (SOUTH, NORTH)}
    time.sleep(0.01)
    assert tiles.prepare(env.store, run)["moved"] == []
    assert {t: tiles.fp_path(run, t).stat().st_mtime_ns for t in (SOUTH, NORTH)} == written
    # A file arriving in the north tile moves its fingerprint alone.
    test_grid.put(env, 4, track(400, 20.0, lat_shift=1), "D")
    env.run("noaa")
    assert tiles.prepare(env.store, run)["moved"] == [NORTH]
    assert tiles.fp_path(run, SOUTH).stat().st_mtime_ns == written[SOUTH]


def test_prepare_freezes_the_catalog_it_checked(env, tmp_path, monkeypatch):  # noqa: F811
    two_tiles(env)
    checked = tiles.open_store

    @contextlib.contextmanager
    def then_ingest(store, *args, **kwargs):
        with checked(store, *args, **kwargs) as con:
            yield con
        # Another writer publishes between prepare's checks and its freeze.
        test_grid.put(env, 4, track(400, 20.0, lat_shift=1), "D")
        env.run("noaa")

    monkeypatch.setattr(tiles, "open_store", then_ingest)
    got = tiles.prepare(env.store, tmp_path)
    assert (tmp_path / "snapshot.ducklake").read_bytes() == env.store.get(got["catalog"])[0]
    assert tiles.counts(tmp_path) == {SOUTH: 120, NORTH: 60}


def test_a_relative_store_is_read_from_the_run_directory(env, tmp_path, monkeypatch):  # noqa: F811
    two_tiles(env)
    monkeypatch.chdir(env.store.root.parent)
    tiles.prepare(LocalObjects(env.store.root.name), tmp_path / "run")
    monkeypatch.chdir(tmp_path / "run")
    with tiles.open_job(Path("."), [SOUTH]) as con:
        assert con.execute("SELECT count(*) FROM lake.points").fetchone()[0] == 120


def test_one_run_at_a_time_in_a_run_directory(env, tmp_path):  # noqa: F811
    with open(tmp_path / ".lock", "w") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        with pytest.raises(RuntimeError, match="another"):
            tiles.build(env.store, tmp_path, dry_run=True)
    assert not (tmp_path / "snapshot.ducklake").exists()


def test_prepare_fills_file_tiles_first(env, tmp_path):  # noqa: F811
    two_tiles(env)
    with open_store(env.store) as con:
        con.execute("DELETE FROM lake.file_tiles")
    assert tiles.prepare(env.store, tmp_path)["tiles"] == 2


def test_a_tile_whose_soundings_are_withdrawn_is_gone_with_its_outputs(env, tmp_path):  # noqa: F811
    two_tiles(env)
    run = tmp_path / "run"
    tiles.prepare(env.store, run)
    north_only = set(tiles.tile_z8s(NORTH)) - set(tiles.tile_z8s(SOUTH))
    assert north_only
    # What a run left for the north tile, and for the web tiles only it reaches.
    left = [run / p.format(NORTH) for p in tiles.TILE_FILES.values()]
    left += [run / "done" / stage / str(NORTH) for stage in tiles.STAGES]
    shared = set(tiles.tile_z8s(NORTH)) & set(tiles.tile_z8s(SOUTH))
    south_only = set(tiles.tile_z8s(SOUTH)) - set(tiles.tile_z8s(NORTH))
    assert shared and south_only
    # Every archive holding its soundings goes too, before any job runs: the web tiles it
    # shares with the south tile, the low zooms and the whole archive.
    for key in north_only | shared:
        left += [run / f"web/{key}.pmtiles", run / f"lowsnd/{key}.geojsons"]
        left += [run / f"done/web/{key}"]
    left += [run / p for p in ("overlay.pmtiles", "low.pmtiles", "done/low", "done/assemble")]
    kept = [run / f"web/{key}.pmtiles" for key in south_only]
    for path in left + kept:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
    env.noaa.delete(key_of(3))
    env.run("noaa")
    got = tiles.prepare(env.store, run)
    assert (got["tiles"], got["moved"], got["gone"]) == (1, [], [NORTH])
    assert tiles.counts(run) == {SOUTH: 120}
    assert [p for p in left if p.exists()] == []
    assert all(p.exists() for p in kept)
    assert tiles.fp_path(run, SOUTH).exists()


CLIENT = Path(tiles.__file__).with_name("worker_client.py")


def test_a_failed_job_reports_its_status_and_log(tmp_path):
    with tiles.warm_worker() as (sock, _):
        # A client that goes before sending its job leaves the worker serving.
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.connect(str(sock))
        log = tmp_path / "job.log"
        done = subprocess.run(
            [sys.executable, "-S", str(CLIENT), str(sock), str(log), "cells", str(tmp_path), "1"]
            + ["123"],
            cwd=tmp_path,
            check=False,
        )
        assert done.returncode == 1
        assert "Traceback" in log.read_text() and "data_url" in log.read_text()


def blocking_job(sock, run):
    """Start a cells job that blocks reading its run's data_url, a pipe. Returns its client
    and the pipe's write end, once the job holds the other end."""
    run.mkdir()
    os.mkfifo(run / "data_url")
    client = subprocess.Popen(
        [sys.executable, "-S", str(CLIENT), str(sock), str(run / "log"), "cells", str(run)]
        + ["1", "123"]
    )
    for _ in range(400):
        try:
            return client, os.open(run / "data_url", os.O_WRONLY | os.O_NONBLOCK)
        except OSError:  # no reader yet
            time.sleep(0.05)
    raise AssertionError("the job never started")


@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGINT])
def test_stopping_the_worker_stops_every_job(tmp_path, sig):
    with tiles.warm_worker() as (sock, pid):
        jobs = [blocking_job(sock, tmp_path / f"run{i}") for i in range(3)]
        os.kill(pid, sig)
        for client, pipe in jobs:
            assert client.wait(timeout=30) != 0
            # Nobody reads the pipe: the job is gone.
            with pytest.raises(BrokenPipeError):
                os.write(pipe, b"x")
            os.close(pipe)


def test_the_worker_stops_its_jobs_when_its_parent_is_killed(tmp_path):
    # A `grid tiles` stand-in, killed outright once its worker is serving.
    parent = subprocess.Popen(
        [
            sys.executable,
            "-c",
            (
                "import time; from grid import tiles\n"
                "with tiles.warm_worker() as (sock, pid):\n"
                "    print(sock, pid, flush=True); time.sleep(600)"
            ),
        ],
        stdout=subprocess.PIPE,
        text=True,
    )
    sock, pid = parent.stdout.readline().split()
    client, pipe = blocking_job(sock, tmp_path / "run")
    parent.kill()
    parent.wait()
    assert client.wait(timeout=30) != 0
    with pytest.raises(BrokenPipeError):
        os.write(pipe, b"x")
    os.close(pipe)
    for _ in range(100):
        with contextlib.suppress(ProcessLookupError):
            os.kill(int(pid), 0)
            time.sleep(0.1)
            continue
        break
    else:
        raise AssertionError("the worker outlived its parent")


def test_sigterm_ends_a_run_through_its_cleanup():
    before = signal.getsignal(signal.SIGTERM)
    cleaned = []
    with pytest.raises(SystemExit), tiles.terminating():
        try:
            os.kill(os.getpid(), signal.SIGTERM)
            time.sleep(5)
        finally:
            cleaned.append(True)
    assert cleaned == [True]
    assert signal.getsignal(signal.SIGTERM) == before


def test_a_code_change_reruns_everything(monkeypatch):
    got = set()
    for version in ("2.79", "2.80"):
        monkeypatch.setattr(tiles, "TOOLS", ([sys.executable, "-c", f"print('{version}')"],))
        tiles.code.cache_clear()
        got.add(tiles.code())
    tiles.code.cache_clear()
    assert len(got) == 2


@pytest.mark.parametrize("gb", ["0", "0.0005"])
def test_memory_must_be_a_megabyte_or_more(gb):
    with pytest.raises(SystemExit):
        cli.main(["--store", "store", "tiles", "--out", "run", "--memory-gb", gb])


def test_the_client_fails_without_a_worker(tmp_path):
    client = Path(tiles.__file__).with_name("worker_client.py")
    done = subprocess.run(
        [sys.executable, "-S", str(client), str(tmp_path / "none.sock"), "log", "low", ".", "1"],
        capture_output=True,
        check=False,
    )
    assert done.returncode != 0


def jobs(run):
    path = run / "jobs.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def ran(run, since):
    """{stage: sorted keys} of the jobs run after the first `since`."""
    got = {}
    for j in jobs(run)[since:]:
        got.setdefault(j["stage"], []).extend(j["keys"])
    return {s: sorted(k) for s, k in got.items()}


def layers(path):
    with open(path, "rb") as f:
        return {(z, x, y) for (z, x, y), _ in all_tiles(MmapSource(f))}


def planned(out):
    """{rule: jobs} from a dry run's job table."""
    rows = (line.split() for line in out.splitlines())
    return {
        r[0]: int(r[1])
        for r in rows
        if len(r) == 2 and r[1].isdigit() and r[0].isidentifier() and r[0] != "total"
    }


def test_a_run_rebuilds_only_what_moved_and_matches_the_whole_region_build(
    env,  # noqa: F811
    tmp_path,
    monkeypatch,
    capfd,
):
    two_tiles(env)
    run = tmp_path / "run"
    assert tiles.build(env.store, run, cores=2, memory_mb=8192) == 0
    first = ran(run, 0)
    assert first["cells"] == first["surface"] == first["overlay"] == [str(SOUTH), str(NORTH)]
    assert first["low"] == first["assemble"] == []
    # The same surfaces and areas as `grid cells` and `grid overlay` build.
    with open_store(env.store) as con:
        cells.build(con)
    whole = tmp_path / "whole"
    with open_store(env.store, write=False) as con:
        overlay.build(con, whole)
    for t in (SOUTH, NORTH):
        assert (run / f"surface/{t}.tif").read_bytes() == (whole / f"surface/{t}.tif").read_bytes()
    areas = sorted(
        line for t in (SOUTH, NORTH) for line in (run / f"areas/{t}.geojsons").read_text().split()
    )
    assert areas == sorted((whole / "areas.geojsons").read_text().split())
    with open(run / "overlay.pmtiles", "rb") as f:
        meta = Reader(MmapSource(f)).metadata()
    assert meta["type"] == "S-57" and meta["version"] == str(overlay.GRID_VERSION)
    found = {layer["id"] for layer in json.loads(meta["json"])["vector_layers"]}
    assert found >= {"SOUNDG", "DEPARE", "DEPCNT", "M_QUAL"}
    assert not list(run.glob("**/*.mbtiles"))
    # Every tile of the whole build is there, at z8 and past it from the web jobs.
    assert layers(run / "overlay.pmtiles") == layers(whole / "overlay.pmtiles")
    with open(run / "overlay.pmtiles", "rb") as f:
        assert Reader(MmapSource(f)).header()["clustered"]  # written in tile-id order

    # Nothing moved: nothing runs.
    seen = len(jobs(run))
    assert tiles.build(env.store, run, cores=2, memory_mb=8192) == 0
    assert ran(run, seen) == {}
    # A change to the code or the tools it runs: every job would run again.
    capfd.readouterr()
    with monkeypatch.context() as m:
        m.setattr(tiles, "code", lambda: "changed")
        assert tiles.build(env.store, run, cores=2, memory_mb=8192, dry_run=True) == 0
    assert planned(capfd.readouterr().out) == {
        "cells": 2,
        "surface": 2,
        "overlay": 2,
        "web": len(tiles.web_keys([SOUTH, NORTH])),
        "low": 1,
        "assemble": 1,
        "all": 1,
    }

    # A file in the north tile: its cells, and the surfaces and overlays that read them.
    test_grid.put(env, 4, track(400, 20.0, lat_shift=1), "D")
    env.run("noaa")
    seen = len(jobs(run))
    assert tiles.build(env.store, run, cores=2, memory_mb=8192) == 0
    again = ran(run, seen)
    assert again["cells"] == [str(NORTH)]
    assert again["surface"] == again["overlay"] == [str(SOUTH), str(NORTH)]
    assert "assemble" in again

    # The north tile withdrawn: gone, its neighbor and the archive rebuilt without it.
    for n in (3, 4):
        env.noaa.delete(key_of(n))
    env.run("noaa")
    seen = len(jobs(run))
    assert tiles.build(env.store, run, cores=2, memory_mb=8192) == 0
    gone = ran(run, seen)
    assert "cells" not in gone and gone["surface"] == [str(SOUTH)]
    assert not (run / f"surface/{NORTH}.tif").exists()
    north_only = set(tiles.tile_z8s(NORTH)) - set(tiles.tile_z8s(SOUTH))
    assert all(
        (x >> (z - 8), y >> (z - 8)) not in {tuple(map(int, k.split("_"))) for k in north_only}
        for z, x, y in layers(run / "overlay.pmtiles")
        if z >= 8
    )


def test_a_dry_run_runs_no_job(env, tmp_path):  # noqa: F811
    two_tiles(env)
    assert tiles.build(env.store, tmp_path, cores=1, memory_mb=4096, dry_run=True) == 0
    assert jobs(tmp_path) == []


def sounding_lake(rows):
    """An in-memory `lake` with only the tables SOUNDG reads, holding cells (lon, lat, depth)."""
    con = duckdb.connect()
    con.execute("ATTACH ':memory:' AS lake")
    con.execute(
        """CREATE TABLE lake.cells (depth_lon DOUBLE, depth_lat DOUBLE, depth FLOAT);
        CREATE TABLE lake.shoals (lon DOUBLE, lat DOUBLE, depth FLOAT)"""
    )
    con.executemany("INSERT INTO lake.cells VALUES (?, ?, ?)", rows)
    return con


def test_split_soundings_match_the_whole_pyramid_across_web_tiles():
    # 500 m and 1,500 m in two z8 tiles of one level-4 pyramid cell, and deep water
    # elsewhere: the shallower one keeps the deeper from showing at z6, as in the pyramid.
    rows = [(0.1, 0.1, 500.0), (1.5, 0.1, 1500.0), (4.1, 0.2, 1200.0), (5.6, 0.3, 30.0)]
    whole = {json.dumps(f, sort_keys=True) for f in overlay.soundings(sounding_lake(rows))}
    keys = {}
    for lon, lat, d in rows:
        x = int((lon + 180) / 360 * 2**tiles.Z)
        y = int(tiles.mercator_y(lat) * 2**tiles.Z)
        keys.setdefault((x, y), []).append((lon, lat, d))
    assert len(keys) == 4
    split, candidates = set(), []
    for part in keys.values():
        con = sounding_lake(part)
        split |= {json.dumps(f, sort_keys=True) for _, f in tiles.web_soundings(con, {})}
        candidates += tiles.level4_candidates(con)
    split |= {json.dumps(f, sort_keys=True) for f in tiles.reduce_level4(candidates)}
    assert split == whole
    at_z6 = [json.loads(f) for f in whole if json.loads(f)["tippecanoe"]["minzoom"] == 6]
    assert 1500 not in {f["properties"]["VALSOU"] for f in at_z6}


def test_a_run_whose_tiles_are_all_withdrawn_publishes_nothing(env, tmp_path):  # noqa: F811
    for name in ("overlay.pmtiles", "low.pmtiles"):
        (tmp_path / name).write_bytes(b"old")
    with pytest.raises(RuntimeError, match="nothing to tile"):
        tiles.build(env.store, tmp_path, dry_run=True)
    assert not (tmp_path / "overlay.pmtiles").exists()
    assert not (tmp_path / "low.pmtiles").exists()


def test_a_tile_past_web_mercator_leaves_the_low_zooms_alone(tmp_path):
    polar = (87 + 90) * 360 + 10
    (tmp_path / "tiles.txt").write_text(f"{polar}\t5\n")
    tiles.do_low(tmp_path, 1)  # no web tile, so no areas read
    assert not (tmp_path / "low.pmtiles").exists()


def test_a_run_directory_takes_tiles_from_one_store(env, tmp_path):  # noqa: F811
    two_tiles(env)
    run = tmp_path / "run"
    tiles.prepare(env.store, run)
    typo = tmp_path / "stor"
    with pytest.raises(RuntimeError, match="another --out"):
        tiles.prepare(LocalObjects(typo), run)
    assert not typo.exists()
    assert tiles.counts(run) == {SOUTH: 120, NORTH: 60}


def test_outputs_go_to_paths_sql_would_misread(tmp_path):
    out = tmp_path / "boat's run" / "x.parquet"
    tiles.export(duckdb.connect(), "SELECT 1 AS one", out)
    assert duckdb.connect().execute("SELECT one FROM read_parquet(?)", [str(out)]).fetchall() == [
        (1,)
    ]
