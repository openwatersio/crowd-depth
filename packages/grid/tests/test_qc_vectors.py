"""Track QC test vectors: one file's soundings each, with the flags QC must give them.

qc_vectors.json is shared with the plugin, whose TypeScript port of the QC runs the
same cases with vitest. Its flags are grid.qc's. The reference SQL, written apart from
grid.qc, has every rule but the steep and noise checks, and must agree with grid.qc on
every case with those two switched off.

To change a case or add one, edit `cases()` and write the file again:

    uv run python tests/test_qc_vectors.py
"""

import hashlib
import json
import math
import random
from datetime import UTC, datetime
from pathlib import Path

import duckdb
import numpy as np
import pytest
import reference_qc

from grid import cells, qc
from grid.definitions import DEFINITIONS

VECTORS = Path(__file__).with_name("qc_vectors.json")
T0 = datetime(2026, 10, 13, 18, tzinfo=UTC).timestamp()  # six hours before midnight
DAY = 86_400
STEP = 1 / 10_800  # a base cell, about 10 m


def at(i, row=0, lon0=-78.0, lat0=33.0):
    return lon0 + (i + 0.5) * STEP, lat0 + (row + 0.5) * STEP


def line(depths, start=0, step=10, row=0):
    """One sounding every `step` seconds along a row, a base cell apart (about 2 kn)."""
    return [[T0 + start + i * step, *at(i, row), d] for i, d in enumerate(depths)]


def track(seed, n=900):
    """A wandering track with noisy depths, spikes, jumps, repeated seconds and gaps,
    crossing midnight."""
    rng = random.Random(seed)
    rows, lon, lat, s = [], -77.8, 33.2, T0 - 6 * 3600
    for _ in range(n):
        s += 60 * rng.choice([1, 1, 1, 1, 0, 2])
        if rng.random() < 0.01:
            s += 5 * 3600
        lon += rng.uniform(-1, 1) * (0.004 if rng.random() < 0.05 else 0.0002)
        lat += rng.uniform(-1, 1) * 0.0002
        d = 12 + rng.uniform(-0.5, 0.5)
        if rng.random() < 0.04:
            d = rng.choice([3.0, 40.0])
        rows.append([s, round(lon, 7), round(lat, 7), round(d, 2)])
    return rows


def wrap(lon):
    return lon - 360 if lon > 180 else lon


def cases():
    """(name, soundings as [seconds since the epoch, lon, lat, depth] in file order)."""
    lon, lat = at(0)
    late, early = T0 + 3 * DAY, datetime(1999, 6, 1, tzinfo=UTC).timestamp()
    jump = line([10] * 9)
    jump[4][1] += 0.01  # about 1 km off the line, 10 s from its neighbors
    deep_stuck = [290.0, 291.0, 289.0, 290.0] + [601.5] * 13 + [290.0, 288.0, 291.0]
    flat_shoal = [3.0] * 9 + [2.0] * 126 + [3.0] * 9
    # 601.5 m held from 23:55 to 00:05: 1.2 km in all, under a kilometre each side of midnight.
    midnight = T0 + 6 * 3600
    across = [290.0, 291.0] + [601.5] * 15 + [290.0, 289.0]
    unsorted = line([10, 10, 10, 20, 10, 10, 10, 10, 3, 10, 10])
    unsorted[2][0] = unsorted[3][0]  # a repeated second keeps file order
    random.Random(1).shuffle(unsorted)
    east = [[T0 + i * 10, wrap(179.9993 + i * 0.0002), 10.0, 8] for i in range(9)]
    east[6][1] = wrap(east[6][1] + 0.01)  # off the line just past the antimeridian
    yield (
        "sentinels, implausible times and very shallow depths",
        [
            [T0, lon, lat, 0],
            [T0 + 1, lon, lat, -1e9],
            [T0 + 2, lon, lat, 12000],
            [T0 + 3, lon, lat, 0.3],
            [late, lon, lat, 5],
            [early, lon, lat, 0.2],
            [T0 + 4, lon, lat, 5],
        ],
    )
    yield "a position jump rejects only the jumping sounding", jump
    yield "a fast ship is not a jump", [[T0 + i * 10, *at(i * 13), 30] for i in range(9)]
    yield "spikes are one-sided", line([10, 10, 10, 20, 10, 10, 3, 10, 10, 10])
    yield "spikes at a transit's ends are judged against one side", line([20, 10, 10, 10, 3])
    yield "a transit of two soundings isn't judged for spikes", line([10, 30])
    yield (
        "transits split at gaps of more than four hours",
        line([10] * 6)
        + line([50, 50, 10], start=4 * 3600 + 50)  # exactly four hours on
        + line([50, 50, 10], start=8 * 3600 + 71),  # a second more
    )
    # A fix every three hours: the 57th, at seven days, starts a transit of two soundings.
    yield (
        "a transit ends every seven days",
        [[T0 + i * 3 * 3600, *at(i, 1000), 30.0 if i == 57 else 10.0] for i in range(58)],
    )
    yield "file order differs from time order", unsorted
    yield "crossing the antimeridian is no jump, but a jump past it is", east
    yield (
        "a boat moored on the antimeridian holding its depth isn't stuck",
        [[T0 + i, 179.99999 if i % 2 else -179.99999, 10.0, 4.2] for i in range(600)],
    )
    yield (
        "a depth held over a kilometre in deep water is a stuck sounder",
        [[T0 + i * 30, *at(i * 10), d] for i, d in enumerate(deep_stuck)],
    )
    yield (
        "a slow boat over a flat bottom isn't stuck",
        [[T0 + i * 10, *at(i), 5.0] for i in range(40)],
    )
    yield (
        "two equal soundings far apart are not a run",
        [
            [T0, *at(0), 20.0],
            [T0 + 600, *at(140), 20.0],
        ],
    )
    yield (
        "a moored boat holding its depth isn't stuck",
        [[T0 + i * 5, lon, lat - 0.2 * STEP + 0.3 * STEP * (i % 2), 4.2] for i in range(480)],
    )
    yield (
        "a sounder stuck on a boat drifting in shallow water isn't caught",
        [[T0 + i * 5, *at((i // 20) % 2, i % 20), 12.0] for i in range(480)],
    )
    yield (
        "a sounder stuck on a boat drifting in deep water is rejected",
        [[T0 + i * 5, *at((i // 20) % 2, i % 20), 601.5] for i in range(480)],
    )
    yield (
        "a flat shoal read by a coarse sounder stays unconfirmed",
        [[T0 + i * 4, *at(i), d] for i, d in enumerate(flat_shoal)],
    )
    yield (
        "a stuck run across midnight is one run",
        [[midnight - 300 + i * 35, *at(i * 9), d] for i, d in enumerate(across)],
    )
    # FARSND's sounder losing bottom: 20 m, then 661 m within seconds, then 20 m again.
    yield (
        "a sounder that loses bottom for a moment is steep",
        line([20, 20, 20, 20, 661, 640, 20, 20, 20], step=2),
    )
    # A channel edge: 4 m to 14 m over about 40 m, and it stays deep.
    yield (
        "a steep channel edge isn't steep",
        [
            [T0 + i * 4, *at(i), d]
            for i, d in enumerate([4, 4, 4, 5, 7, 10, 13, 14, 14, 14, 14, 14])
        ],
    )
    yield (
        "a long lost-bottom stretch is steep from end to end",
        line(
            [20 + i % 3 * 0.2 for i in range(10)]
            + [500] * 100
            + [20 + i % 3 * 0.2 for i in range(10)],
            step=1,
        ),
    )
    ok = [20 + i % 3 * 0.2 for i in range(20)]
    yield (
        "a file that starts in lost bottom is steep",
        line([370, 420, 480, 530, 590, 640] + ok, step=2),
    )
    yield "a file that ends in lost bottom is steep", line(ok + [370, 420, 480], step=2)
    yield "real water between junk near the surface isn't steep", line([0.5, 15] * 8)
    yield "a descent that stays deep isn't steep", line([5] * 10 + [25, 26] * 6)
    yield "a sounder hunting between 6 and 13 m is noisy", line([6, 13] * 15, step=2)
    yield (
        "two spikes among steady soundings aren't noise",
        line([10] * 6 + [20] + [10] * 6 + [3] + [10] * 6),
    )
    for seed in (1, 2, 3):
        yield f"a wandering track with noise, spikes and jumps ({seed})", track(seed)


def arrival(soundings):
    """When the file arrived: as its last row was written, and at least a day after T0."""
    return max(T0 + DAY, soundings[-1][0])


def reference_flags(con, soundings, arrival_s):
    """{(index, flag, reason)} from the reference SQL."""
    con.execute("DELETE FROM lake.points; DELETE FROM lake.files")
    con.execute("INSERT INTO lake.files VALUES (1, make_timestamp(?))", [round(arrival_s * 1e6)])
    con.executemany(
        "INSERT INTO lake.points VALUES (?, 1, ?, make_timestamp(?), ?, ?, ?, 1)",
        [(i, i, round(t * 1e6), lon, lat, d) for i, (t, lon, lat, d) in enumerate(soundings)],
    )
    return set(con.execute(reference_qc.TRACK_QC, {"batch": 1}).fetchall())


def qc_flags(soundings, arrival_s):
    """{(index, flag, reason)} from grid.qc."""
    t, lon, lat, d = zip(*soundings, strict=True)
    time = np.round(np.array(t) * 1e6).astype(np.int64)
    found = qc.track_qc(time, lon, lat, d, round(arrival_s * 1e6))
    return {(int(i), flag, reason) for flag, reason, idx in found for i in idx}


def lake():
    """A connection with the tables the reference SQL reads."""
    con = duckdb.connect()
    con.execute("ATTACH ':memory:' AS lake")
    con.execute(
        """CREATE TABLE lake.points (point_id INTEGER, file_id BIGINT, "row" INTEGER,
        time TIMESTAMP, lon DOUBLE, lat DOUBLE, depth_raw FLOAT, batch_id BIGINT)"""
    )
    con.execute("CREATE TABLE lake.files (file_id BIGINT, arrival TIMESTAMP)")
    return con


@pytest.fixture(scope="module")
def con():
    return lake()


VECTOR_CASES = json.loads(VECTORS.read_text())["cases"] if VECTORS.exists() else []


@pytest.mark.parametrize("case", VECTOR_CASES, ids=[c["name"] for c in VECTOR_CASES])
def test_qc_gives_the_vectors_flags(con, case):
    expected = {tuple(f) for f in case["flags"]}
    assert qc_flags(case["soundings"], case["arrival"]) == expected


# The steep and noise checks' flags, worked out by hand rather than read back from
# grid.qc, which writes the vectors.
BY_HAND = {
    "a sounder that loses bottom for a moment is steep": {
        (4, "reject", "steep"),
        (5, "reject", "steep"),
    },
    "a long lost-bottom stretch is steep from end to end": {
        (i, "reject", "steep") for i in range(10, 110)
    },
    "a steep channel edge isn't steep": set(),
    "a descent that stays deep isn't steep": set(),
    # The deep side votes as noise; the shallow side is kept as unconfirmed shoals that
    # neither confirm nor are confirmed.
    "a sounder hunting between 6 and 13 m is noisy": {
        (i, "noisy" if i % 2 else "unconfirmed", "track_noise") for i in range(30)
    },
    # 0.5 m isn't under shallow_m, so the junk isn't very_shallow.
    "real water between junk near the surface isn't steep": {
        (i, "noisy" if i % 2 else "unconfirmed", "track_noise") for i in range(16)
    },
    "a file that starts in lost bottom is steep": {(i, "reject", "steep") for i in range(6)},
    "a file that ends in lost bottom is steep": {(i, "reject", "steep") for i in range(20, 23)},
}


@pytest.mark.parametrize("name", BY_HAND)
def test_the_steep_and_noise_checks_flag_what_was_worked_out_by_hand(name):
    [case] = [c for c in VECTOR_CASES if c["name"] == name]
    assert qc_flags(case["soundings"], case["arrival"]) == BY_HAND[name]


@pytest.mark.parametrize("case", VECTOR_CASES, ids=[c["name"] for c in VECTOR_CASES])
def test_the_reference_sql_agrees_without_the_steep_and_noise_checks(con, case, monkeypatch):
    monkeypatch.setattr(qc, "STEEP_FACTOR", math.inf)
    monkeypatch.setattr(qc, "NOISE_REL", math.inf)
    soundings, arrival_s = case["soundings"], case["arrival"]
    assert reference_flags(con, soundings, arrival_s) == qc_flags(soundings, arrival_s)


def test_the_vectors_are_current():
    assert [(c["name"], c["soundings"], c["arrival"]) for c in VECTOR_CASES] == [
        (name, soundings, arrival(soundings)) for name, soundings in cases()
    ]


def test_changing_a_threshold_bumps_the_qc_version():
    # Flags depend on every threshold: a change without a new version leaves batches QC'd
    # under the old thresholds looking current. Bump qc.version, then pin the new hash.
    thresholds = {k: v for k, v in qc.QC.items() if k != "version"}
    digest = hashlib.sha256(json.dumps(thresholds, sort_keys=True).encode()).hexdigest()[:16]
    assert (qc.QC_VERSION, digest) == (6, "ad8db9ad341906fe")


def test_changing_a_grid_definition_bumps_the_grid_version():
    # Cells and the surface are built from these: a change without a new GRID_VERSION
    # leaves cells built under the old ones looking current.
    grid = {k: DEFINITIONS[k] for k in ("cells", "statistic", "surface")}
    digest = hashlib.sha256(json.dumps(grid, sort_keys=True).encode()).hexdigest()[:16]
    assert (cells.GRID_VERSION, digest) == (7, "61dc2992d70b2244")


def test_spike_chunks_give_the_same_flags(monkeypatch):
    soundings = track(4, 2000)
    whole = qc_flags(soundings, arrival(soundings))
    monkeypatch.setattr(qc, "SPIKE_CHUNK", 7)
    assert qc_flags(soundings, arrival(soundings)) == whole


def test_every_check_fires():
    fired = {(f[1], f[2]) for c in VECTOR_CASES for f in c["flags"]}
    assert fired == {
        ("reject", "sentinel"),
        ("reject", "time"),
        ("review", "very_shallow"),
        ("reject", "jump"),
        ("reject", "steep"),
        ("noisy", "track_noise"),
        ("unconfirmed", "track_noise"),
        ("reject", "flatline"),
        ("unconfirmed", "flatline"),
        ("reject", "spike"),
        ("unconfirmed", "spike"),
    }


def write():
    out = [
        {
            "name": name,
            "arrival": arrival(soundings),
            "soundings": soundings,
            "flags": sorted(qc_flags(soundings, arrival(soundings))),
        }
        for name, soundings in cases()
    ]
    doc = {
        "description": (
            "Track QC test vectors for grid.qc and the plugin's port, written by "
            "packages/grid/tests/test_qc_vectors.py. Each case is one file's soundings in "
            "file order, as [time in seconds since the epoch, lon, lat, depth in metres], "
            "with the file's arrival time in seconds since the epoch. Depths are float32 "
            "and times whole microseconds. Flags are [index, flag, reason]."
        ),
        "cases": out,
    }
    VECTORS.write_text(json.dumps(doc, indent=1) + "\n")


if __name__ == "__main__":
    write()
