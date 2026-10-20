import numpy as np

from grid import statistic


def harness(px, py, m, s, central):
    """σ_b as surface-statistic.md measured it: a loop over each pixel's window."""
    by = {}
    for x, y, mm, ss in zip(px, py, m, s):
        by.setdefault((x, y), []).append((mm, ss))
    out = {}
    for (x, y), c in central.items():
        near = [(dx, dy, mm, ss) for dx in range(-2, 3) for dy in range(-2, 3)
                for mm, ss in by.get((x + dx, y + dy), ())]  # fmt: skip
        a = np.array(near)
        spread = np.nan
        if len(a) >= 5 and len(np.unique(a[:, :2], axis=0)) >= 3:
            A = np.column_stack([np.ones(len(a)), a[:, 0], a[:, 1]])
            coef, *_ = np.linalg.lstsq(A, a[:, 2], rcond=None)
            res = a[:, 2] - A @ coef
            spread = 1.4826 * np.median(np.abs(res - np.median(res)))
        elif len(a) >= 3:
            spread = 1.4826 * np.median(np.abs(a[:, 2] - c))
        out[(x, y)] = (spread, np.median(a[:, 3]))
    return out


def test_sigma_b_matches_the_measured_definition():
    rng = np.random.default_rng(1)
    n = 3000
    px, py = rng.integers(0, 40, n), rng.integers(0, 40, n)
    m = 5 + 0.1 * px + rng.normal(0, 0.3, n)
    s = rng.uniform(0.05, 0.5, n)
    upx, upy, central, spread, csig = statistic.sigma_b(px, py, m, s)
    want = harness(px, py, m, s, dict(zip(zip(upx.tolist(), upy.tolist()), central)))
    got = {(x, y): (sp, cs) for x, y, sp, cs in zip(upx.tolist(), upy.tolist(), spread, csig)}
    assert got.keys() == want.keys()
    for key, (sp, cs) in want.items():
        assert np.isclose(got[key][1], cs)
        assert np.isnan(sp) == np.isnan(got[key][0]) and (
            np.isnan(sp) or np.isclose(got[key][0], sp)
        )


def test_sigma_b_handles_entries_on_a_line_and_thin_windows():
    # Five vessels along one row: the plane is underdetermined, the line still fits. The
    # end pixels' windows hold 3 or 4 and fall back to the spread around each pixel.
    px, py = np.arange(5), np.zeros(5, dtype=int)
    m = 10 + 0.5 * px
    *_, spread, _ = statistic.sigma_b(px, py, m, np.full(5, 0.1))
    assert spread[2] == 0 and np.allclose(spread[[0, 4]], 1.4826 * 0.5)
    # Two entries: too few for any spread.
    *_, spread, _ = statistic.sigma_b([0, 1], [0, 0], [10, 11], [0.1, 0.1])
    assert np.isnan(spread).all()


def test_sigma_b_widens_on_slopes():
    # The same vessels, each a few metres off its pixel's centre: on a flat bottom they
    # agree; on a slope those few metres are depth they disagree by.
    rng = np.random.default_rng(2)
    px, py = np.repeat(np.arange(10), 4), np.zeros(40, dtype=int)
    jitter = rng.uniform(-0.5, 0.5, 40)
    flat = statistic.sigma_b(px, py, np.full(40, 10.0), np.full(40, 0.1))[3]
    slope = statistic.sigma_b(px, py, 10 + 2.0 * (px + jitter), np.full(40, 0.1))[3]
    assert np.nanmedian(slope) > np.nanmedian(flat) + 0.3
    # A clean slope, however steep, is no disagreement.
    clean = statistic.sigma_b(px, py, 10 + 2.0 * px, np.full(40, 0.1))[3]
    assert np.allclose(clean, 0)


def test_sigma_fills_from_the_nearest_pixel_and_widens_with_distance(monkeypatch):
    px, py = np.array([0, 10]), np.array([0, 0])
    at = statistic.sigma_at(px, py, np.array([0.3, np.nan]), np.array([0.4, 0.2]))
    assert np.allclose(at(np.array([9, 1]), np.array([0, 0])), [np.hypot(0.3, 0.2), 0.5])
    monkeypatch.setattr(statistic, "SIGMA_PER_M", 0.01)
    near, far = at(np.array([1, 1]), np.array([0, 0]), np.array([20.0, 150.0]))
    assert near < far and np.isclose(far, np.sqrt(0.5**2 + 1.5**2))


def test_chunks_give_the_same_sigma(monkeypatch):
    rng = np.random.default_rng(3)
    px, py = rng.integers(0, 30, 2000), rng.integers(0, 30, 2000)
    m, s = 5 + rng.normal(0, 0.5, 2000), rng.uniform(0.1, 0.5, 2000)
    whole = statistic.sigma_b(px, py, m, s)
    monkeypatch.setattr(statistic, "CHUNK", 50)
    chunked = statistic.sigma_b(px, py, m, s)
    for a, b in zip(whole, chunked):
        assert np.array_equal(a, b, equal_nan=True)


def test_no_entries_give_no_pixels():
    upx, *_, spread, _ = statistic.sigma_b([], [], [], [])
    assert len(upx) == len(spread) == 0


def test_votes_are_smoothed_along_each_vessels_own_coverage():
    # A reads 9 and 11 m alternately along a row; B sounds only pixel 2, beside A's track.
    px = np.array([0, 1, 2, 3, 4, 2])
    py = np.array([0, 0, 0, 0, 0, 1])
    vessel = np.array([1, 1, 1, 1, 1, 2], dtype=np.uint64)
    m = np.array([9.0, 11.0, 9.0, 11.0, 9.0, 10.0])
    sx, sy, sm, _ = statistic.smoothed(px, py, vessel, m, np.full(6, 0.1))
    got = {(x, y): [] for x, y in zip(sx.tolist(), sy.tolist())}
    for x, y, v in zip(sx.tolist(), sy.tolist(), sm.tolist()):
        got[(x, y)].append(v)
    # Only pixels someone sounded get entries.
    assert set(got) == {(0, 0), (1, 0), (2, 0), (3, 0), (4, 0), (2, 1)}
    # A's alternation is smoothed: its median within a pixel, 10 at the ends, 9 at pixels
    # 1 and 3, 11 at 2. B, beside the track, joins the pixels around its own, and A reaches it.
    assert {k: sorted(v) for k, v in got.items()} == {
        (0, 0): [10.0],
        (1, 0): [9.0, 10.0],
        (2, 0): [10.0, 11.0],
        (3, 0): [9.0, 10.0],
        (4, 0): [10.0],
        (2, 1): [10.0, 11.0],
    }


def test_smoothing_in_bands_gives_the_same_entries(monkeypatch):
    rng = np.random.default_rng(4)
    n = 3000
    px, py = rng.integers(0, 60, n), rng.integers(0, 60, n)
    vessel = rng.integers(0, 8, n).astype(np.uint64)
    m, s = rng.normal(10, 1, n), rng.uniform(0.1, 0.5, n)

    def rows(out):
        return sorted(zip(*(a.tolist() for a in out)))

    whole = rows(statistic.smoothed(px, py, vessel, m, s))
    monkeypatch.setattr(statistic, "CHUNK", 90)
    assert rows(statistic.smoothed(px, py, vessel, m, s)) == whole
