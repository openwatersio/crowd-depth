"""The published depth: the median of vessels' medians, less K times σ.

σ combines two things on the surface's 2/3″ pixels. The corrections' uncertainty is the
median of the vessels' median `sigma` within WINDOW pixels. The vessels' disagreement is
the robust spread of their medians around a plane fitted to them over that window, so a
slope doesn't count as noise. Each vessel counts once per pixel, however fast it logs.

A pixel's σ is measured where its window holds enough entries, and taken from the
nearest pixel that has one elsewhere. Measured in surface-statistic.md, which this
matches on a pixel's own votes: K = 1.75 is the smallest that keeps Thimble Shoal Channel's
channel under 0.5% of pixels more than 1 m too deep. Votes are smoothed along each vessel's
coverage (`smoothed`) before the statistic sees them.
"""

import itertools

import numpy as np
from scipy.spatial import cKDTree

from .definitions import STATISTIC

K = STATISTIC["k"]
WINDOW = STATISTIC["window_px"]
# How fast an interpolated pixel's σ grows with its distance from the nearest sounding.
SIGMA_PER_M = STATISTIC["sigma_per_m"]
MAD = 1.4826
# Window entries a call holds at once, about 150 bytes each: a busy harbour's pixels hold
# many vessels, so work is cut by entries, not pixels.
CHUNK = 2_000_000


def group_median(groups, values, n):
    """Median of `values` per group id in [0, n); NaN for an empty group."""
    if not n:
        return np.empty(0)
    order = np.lexsort((values, groups))
    g, v = groups[order], values[order]
    counts = np.bincount(g, minlength=n)
    starts = np.concatenate([[0], np.cumsum(counts)[:-1]])
    lo = starts + (counts - 1) // 2
    hi = starts + counts // 2
    out = np.full(n, np.nan)
    has = counts > 0
    out[has] = (v[lo[has]] + v[hi[has]]) / 2
    return out


def smoothed(px, py, vessel, m, s, reach=1):
    """Each vessel's votes smoothed along its own coverage: at every pixel anyone voted
    in, one entry per vessel with a vote within `reach` pixels, its median there and its
    median correction σ. Which vessels sound a pixel then changes gradually along a lane
    instead of pixel by pixel, and no entry lands where nobody sounded.

    Worked in bands of pixel rows holding about CHUNK votes, each with `reach` rows of
    halo, so memory follows the band, not the tile.
    """
    px, py = np.asarray(px, dtype=np.int64), np.asarray(py, dtype=np.int64)
    m, s = np.asarray(m, dtype=np.float64), np.asarray(s, dtype=np.float64)
    if not len(px):
        return px, py, m, s
    codes = np.unique(np.asarray(vessel), return_inverse=True)[1].ravel().astype(np.int64)
    order = np.argsort(py, kind="stable")
    px, py, codes, m, s = px[order], py[order], codes[order], m[order], s[order]
    rows, counts = np.unique(py, return_counts=True)
    # Band edges, in rows, every CHUNK / (2 reach + 1)^2 votes: each vote is held that
    # many times while its band is worked.
    per = max(1, CHUNK // (2 * reach + 1) ** 2)
    edges = rows[np.searchsorted(np.cumsum(counts), np.arange(per, counts.sum(), per))]
    bounds = np.unique(np.concatenate([[rows[0]], edges, [rows[-1] + 1]]))
    out = []
    for lo, hi in itertools.pairwise(bounds):
        a, b = np.searchsorted(py, [lo - reach, hi + reach])
        out.append(_smooth_band(px[a:b], py[a:b], codes[a:b], m[a:b], s[a:b], lo, hi, reach))
    return tuple(np.concatenate(c) for c in zip(*out))


def _smooth_band(px, py, codes, m, s, lo, hi, reach):
    """`smoothed` for the pixels in rows [lo, hi), from the votes within `reach` of them."""
    n = int(codes.max()) + 1
    x0, y0 = int(px.min()) - reach, int(py.min()) - reach
    span = int(px.max()) - x0 + reach + 1
    pixel = (py - y0) * span + (px - x0)
    voted = np.unique(pixel[(py >= lo) & (py < hi)])
    owners, values, sigmas = [], [], []
    for dy in range(-reach, reach + 1):
        for dx in range(-reach, reach + 1):
            # A vote at (px, py) reaches the pixel at (px - dx, py - dy).
            at = pixel - dy * span - dx
            hit = np.isin(at, voted)
            owners.append(at[hit] * n + codes[hit])
            values.append(m[hit])
            sigmas.append(s[hit])
    keys, group = np.unique(np.concatenate(owners), return_inverse=True)
    group = group.ravel()
    m2 = group_median(group, np.concatenate(values), len(keys))
    s2 = group_median(group, np.concatenate(sigmas), len(keys))
    at = keys // n
    return at % span + x0, at // span + y0, m2, s2


def pixels(px, py, m):
    """The distinct pixels of entries, each entry's pixel index, and each pixel's median
    of its entries."""
    keys, inverse = np.unique(np.stack([py, px], axis=1), axis=0, return_inverse=True)
    inverse = inverse.ravel()
    return keys[:, 1], keys[:, 0], inverse, group_median(inverse, m, len(keys))


def sigma_b(px, py, m, s, central=None):
    """Spread and correction σ at each pixel with entries.

    Entries are one per vessel per pixel: `m` its median depth there, `s` its median
    correction σ. `central`, one per pixel as `pixels` orders them, is the surface the
    spread falls back to with too few entries for a plane; the pixel's own median by
    default. Returns (pixel px, pixel py, central, spread, csig): spread is NaN with fewer
    than 3 entries in the window, and where `central` is NaN both are.
    """
    px, py = np.asarray(px, dtype=np.int64), np.asarray(py, dtype=np.int64)
    m, s = np.asarray(m, dtype=np.float64), np.asarray(s, dtype=np.float64)
    upx, upy, of, own = pixels(px, py, m)
    central = own if central is None else np.asarray(central, dtype=np.float64)
    n = len(upx)
    if not n:
        return upx, upy, central, np.empty(0), np.empty(0)
    # Entries grouped by pixel, and pixels findable by key.
    order = np.argsort(of, kind="stable")
    counts = np.bincount(of, minlength=n)
    starts = np.concatenate([[0], np.cumsum(counts)[:-1]])
    span = int(max(px.max(), upx.max()) - min(px.min(), upx.min()) + 2 * WINDOW + 1)
    x0 = int(upx.min()) - WINDOW
    y0 = int(upy.min()) - WINDOW
    keys = (upy - y0) * span + (upx - x0)
    by_key = np.argsort(keys)
    sorted_keys = keys[by_key]
    spread, csig = np.full(n, np.nan), np.full(n, np.nan)
    offsets = [(dx, dy) for dy in range(-WINDOW, WINDOW + 1) for dx in range(-WINDOW, WINDOW + 1)]

    def neighbours(p, dx, dy):
        """The pixels of `p` with a neighbour at (dx, dy), and that neighbour."""
        want = (upy[p] + dy - y0) * span + (upx[p] + dx - x0)
        i = np.minimum(np.searchsorted(sorted_keys, want), n - 1)
        hit = sorted_keys[i] == want
        return hit, by_key[i[hit]]

    # Each pixel's window entries, so chunks end before CHUNK of them.
    held = np.zeros(n, dtype=np.int64)
    for dx, dy in offsets:
        hit, q = neighbours(np.arange(n), dx, dy)
        held[hit] += counts[q]
    ends = np.searchsorted(np.cumsum(held), np.arange(CHUNK, held.sum() + CHUNK, CHUNK))
    bounds = np.unique(np.concatenate([[0], np.maximum(ends, 1), [n]]))
    # ponytail: one pixel whose window alone passes CHUNK still runs alone
    for lo, hi in itertools.pairwise(bounds):
        p = np.arange(lo, hi)
        parts = []
        for dx, dy in offsets:
            hit, q = neighbours(p, dx, dy)
            c = counts[q]
            # Every entry of each neighbouring pixel, against the pixel it's a neighbour of.
            owner = np.repeat(p[hit], c)
            first = np.repeat(starts[q], c)
            within = np.arange(c.sum()) - np.repeat(np.cumsum(c) - c, c)
            parts.append((owner.astype(np.int32), order[first + within].astype(np.int32),
                          np.full(len(owner), dx, dtype=np.int8),
                          np.full(len(owner), dy, dtype=np.int8)))  # fmt: skip
        owner, entry, dxs, dys = (np.concatenate(a) for a in zip(*parts))
        del parts
        g = (owner - lo).astype(np.int64)
        k = len(p)
        ok = ~np.isnan(central[p])
        csig[p] = np.where(ok, group_median(g, s[entry], k), np.nan)
        many = np.bincount(g, minlength=k)
        distinct = np.bincount(
            np.unique(np.stack([g, dxs, dys], axis=1), axis=0)[:, 0], minlength=k
        )
        # Spread around the central surface, for windows too thin for a plane.
        around = MAD * group_median(g, np.abs(m[entry] - central[p][g]), k)
        # A least-squares plane z = a + b·dx + c·dy per window, from its normal equations;
        # the pseudo-inverse gives lstsq's answer when the entries sit on a line.
        z = m[entry]
        cols = [np.ones_like(z), dxs.astype(np.float64), dys.astype(np.float64)]
        ata = np.empty((k, 3, 3))
        atz = np.empty((k, 3))
        for a in range(3):
            atz[:, a] = np.bincount(g, cols[a] * z, minlength=k)
            for b in range(3):
                ata[:, a, b] = np.bincount(g, cols[a] * cols[b], minlength=k)
        coef = np.einsum("kab,kb->ka", np.linalg.pinv(ata), atz)
        res = z - (coef[g, 0] + coef[g, 1] * dxs + coef[g, 2] * dys)
        mid = group_median(g, res, k)
        plane = MAD * group_median(g, np.abs(res - mid[g]), k)
        spread[p] = np.where(
            ~ok | (many < 3), np.nan, np.where((many >= 5) & (distinct >= 3), plane, around)
        )
    return upx, upy, central, spread, csig


def nearest(x, y, values):
    """A function of query points giving `values` at the point (x, y) nearest each; NaN
    values are skipped, and with none to take from, it gives NaN."""
    have = ~np.isnan(values)
    if not have.any():
        return lambda qx, qy: np.full(len(qx), np.nan)
    tree = cKDTree(np.stack([x[have], y[have]], axis=1))
    taken = values[have]
    return lambda qx, qy: taken[tree.query(np.stack([qx, qy], axis=1))[1]]


def sigma_at(px, py, spread, csig):
    """A function of query pixels, and their distances in metres from a sounding, giving σ:
    spread and correction σ each from the nearest pixel that has one, combined, and
    widened by the distance.

    # ponytail: a tile with no spread anywhere (every window too thin) takes none; a
    # floor if lone tracks prove too deep
    """
    sp, cs = nearest(px, py, spread), nearest(px, py, csig)

    def at(qx, qy, distance_m=0.0):
        s = np.nan_to_num(sp(qx, qy))
        return np.sqrt(s**2 + cs(qx, qy) ** 2 + (SIGMA_PER_M * np.asarray(distance_m)) ** 2)

    return at
