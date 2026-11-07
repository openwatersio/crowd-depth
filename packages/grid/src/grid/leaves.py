"""Leaves: a dense 1° tile cut into a quadtree of leaves that rebuild on their own, so a day's
new files rebuild the parts of a tile near them, not the whole tile (sub-tile-rebuild.md).

A tile past SPLIT active soundings is split into quarters until each leaf holds at most
LEAF or is MIN_STEPS a side; every other tile is one leaf, ROOT. Leaf edges fall on whole steps of STEP base rows
and columns (6″): two consensus blocks and nine surface pixels, so no block, cell or pixel
straddles two leaves. A leaf is a box of steps, (first row, end row, first column, end
column), and a quadkey under ROOT. A node stays split until its soundings fall under a
quarter of its bound, so a day's arrivals rarely change the partition.

A leaf's cells read the points within `reach(tile, "cells")` of it and its surface the
votes within `reach(tile, "surface")`, and those reaches are also how near a change must
land to make it dirty: what an output reads is what can change it.
"""

import math

import numpy as np

from . import statistic, surface
from .cells import BASE, k_for

STEP = 18
STEPS = BASE // STEP
SPLIT = 1_000_000
LEAF = 250_000
ROOT = "r"
# Steps a side a leaf never splits below: 1/8°. A leaf's jobs read its reach around it again
# for each leaf, so a small leaf in a busy harbour reads many times its own soundings. On the
# Chesapeake's last 30 arrival days, a day's leaf jobs read a median 50% of all soundings
# for cells and 56% for surfaces at 1/8°, against 52% and 63% at half that, 54% and 62% at
# twice it, and 573% and 855% with no floor (sub-tile-rebuild.md).
MIN_STEPS = 75
# Base rows past a sounding its cell-level flags read: consensus's 3x3 blocks of 9 rows
# (17), and the outvoted check's 3x3 pixels around it, whose soundings' own consensus reads
# that far again (3 more).
FLAGS_ROWS = 20


def shape(tile):
    """A tile's (rows, columns) of steps; columns None where k doesn't divide its base
    columns into whole steps (past about 86°), so the tile stays one leaf."""
    k = k_for(tile // 360 - 90)
    cols = BASE // k
    return STEPS, cols // STEP if cols % STEP == 0 else None


def reach(tile, stage):
    """(base rows, base columns) a leaf's `stage` reads past its edges.

    Cells: a cell's σ may come from a pixel FALLBACK_PX away, whose spread reads the votes
    WINDOW pixels further, smoothed a pixel further, from soundings whose flags read
    FLAGS_ROWS further. A surface pixel's σ also comes from FALLBACK_PX away, and that
    pixel's spread is taken around the interpolated surface there, which reads votes
    within the search radius and the blur's reach of it; its depth reads less. Columns
    are as many as rows for what is counted in pixels, and the search radius, in metres,
    is however many columns it spans in the tile.
    """
    px = statistic.FALLBACK_PX + statistic.WINDOW + 1
    rows = cols = 2 * px
    flags_cols = FLAGS_ROWS
    if stage == "surface":
        # A neighbor's flags read 20 of its own columns, wider where its columns are.
        lat0 = tile // 360 - 90
        k = k_for(lat0)
        widest = max(k_for(a) for a in (lat0 - 1, lat0, lat0 + 1) if -90 <= a <= 89)
        flags_cols = -(-FLAGS_ROWS * widest // k)
        _, _, _, width, scale_x, scale_y = surface.geometry(tile)
        blur = math.ceil(4 * surface.SIGMA_PX)
        around = statistic.FALLBACK_PX + blur + 1
        rows = 2 * (around + math.ceil(surface.RADIUS_M / (scale_y / surface.ROWS)))
        cols = 2 * (around + math.ceil(surface.RADIUS_M / (scale_x / width)))
    # A pixel's two base rows: a sounding anywhere in it.
    return rows + FLAGS_ROWS + 2, cols + flags_cols + 2


def partition(tile, counts, old=None):
    """{quadkey: box} for a tile whose active soundings per step are `counts` (a rows by
    columns array of steps, or None for a tile under SPLIT), given its last partition `old`
    (an iterable of quadkeys)."""
    old = set(old or ())
    rows, cols = shape(tile)
    # A tile that doesn't divide into steps is one leaf, a step wider than it.
    root = (0, rows, 0, cols or -(-BASE // k_for(tile // 360 - 90) // STEP))
    if counts is None or cols is None:
        return {ROOT: root}
    total = np.zeros((rows + 1, cols + 1), dtype=np.int64)
    total[1:, 1:] = np.cumsum(np.cumsum(counts, axis=0), axis=1)

    def n(box):
        r0, r1, c0, c1 = box
        return int(total[r1, c1] - total[r0, c1] - total[r1, c0] + total[r0, c0])

    def node(key, box, bound):
        r0, r1, c0, c1 = box
        rm, cm = (r0 + r1) // 2, (c0 + c1) // 2
        parts = [(a, b) for a in ((r0, rm), (rm, r1)) for b in ((c0, cm), (cm, c1))]
        parts = [(*a, *b) for a, b in parts if a[0] < a[1] and b[0] < b[1]]
        was = any(k.startswith(key) and k != key for k in old)
        small = min(r1 - r0, c1 - c0) < 2 * MIN_STEPS
        if len(parts) > 1 and not small and (n(box) > bound or was and n(box) >= bound // 4):
            out = {}
            for i, part in enumerate(parts):
                out |= node(f"{key}{i}", part, LEAF)
            return out
        return {key: box}

    return node(ROOT, root, SPLIT)


def degrees(tile, box, pad=(0, 0)):
    """A box of steps, widened by `pad` base (rows, columns), as (south, north, west, east)."""
    lat0, lon0 = tile // 360 - 90, tile % 360 - 180
    k = k_for(lat0)
    r0, r1, c0, c1 = box
    return (
        lat0 + (r0 * STEP - pad[0]) / BASE,
        lat0 + (r1 * STEP + pad[0]) / BASE,
        lon0 + (c0 * STEP - pad[1]) * k / BASE,
        lon0 + (c1 * STEP + pad[1]) * k / BASE,
    )


def dirty(partitions, changes, stage, tiles=None):
    """{tile: [quadkeys]} of the leaves whose `stage` a change lands within reach of.

    `changes` is an array of boxes in degrees, one row each (south, north, west, east),
    and `tiles` the tile each is in, by default the one holding its south-west corner. Cells
    read only their own tile, so only its changes reach them; a surface reads its
    neighbors' too, across the antimeridian as anywhere. A change reaches no farther than
    the next tile, so each tile's leaves are compared with its neighborhood's changes.
    """
    changes = np.asarray(changes, dtype=np.float64).reshape(-1, 4)
    if tiles is None:
        tiles = tile_of(changes[:, 0], changes[:, 2])
    tiles = np.asarray(tiles, dtype=np.int64)
    # Each tile's changes, so a tile's leaves are compared with its neighborhood's alone.
    order = np.argsort(tiles, kind="stable")
    keys, starts = np.unique(tiles[order], return_index=True)
    ends = np.append(starts[1:], len(order))
    held = {int(k): order[a:b] for k, a, b in zip(keys, starts, ends)}
    out = {}
    for tile, leaves in partitions.items():
        lon0 = tile % 360 - 180
        around = [tile] if stage == "cells" else neighbors(tile)
        at = [held[t] for t in around if t in held]
        if not at:
            continue
        near = changes[np.concatenate(at)]
        # A neighbor across the antimeridian, a turn round.
        near[:, 2:] += np.where(near[:, 2] - lon0 > 180, -360, 0)[:, None]
        near[:, 2:] += np.where(lon0 - near[:, 2] > 180, 360, 0)[:, None]
        pad = reach(tile, stage)
        keys = list(leaves)
        boxes = np.array([degrees(tile, leaves[k], pad) for k in keys])
        hit = (
            (near[None, :, 0] <= boxes[:, None, 1]) & (near[None, :, 1] >= boxes[:, None, 0])
            & (near[None, :, 2] <= boxes[:, None, 3]) & (near[None, :, 3] >= boxes[:, None, 2])
        ).any(axis=1)  # fmt: skip
        if hit.any():
            out[tile] = [k for k, h in zip(keys, hit) if h]
    return out


def tile_of(lat, lon):
    """The 1° tile holding each (lat, lon)."""
    lat, lon = np.asarray(lat), np.asarray(lon)
    return ((np.floor(lat) + 90) * 360 + (np.floor(lon) + 180) % 360).astype(np.int64)


def neighbors(tile):
    """The tile and its eight neighbors, across the antimeridian, short of the poles."""
    lat0, lon0 = tile // 360 - 90, tile % 360 - 180
    return [
        (lat0 + dy + 90) * 360 + (lon0 + dx + 180) % 360
        for dy in (-1, 0, 1)
        for dx in (-1, 0, 1)
        if -90 <= lat0 + dy <= 89
    ]


def step_boxes(tiles, rows, cols):
    """Boxes in degrees, as `dirty` takes them, of the steps (row, column) of `tiles`."""
    tiles, rows, cols = (np.asarray(a, dtype=np.int64) for a in (tiles, rows, cols))
    lat0, lon0 = tiles // 360 - 90, tiles % 360 - 180
    k = np.array([k_for(int(a)) for a in range(-90, 90)])[lat0 + 90]
    s = lat0 + rows * STEP / BASE
    w = lon0 + cols * STEP * k / BASE
    return np.column_stack([s, s + STEP / BASE, w, w + STEP * k / BASE])
