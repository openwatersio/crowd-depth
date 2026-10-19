"""Track QC: flag impossible values, position jumps, lost bottom, stuck sounders, noise and
depth spikes along each track.

QC runs on each ingest batch as it lands, along each file's soundings: a submitted
file is a contiguous piece of one vessel's track. The checks are pure functions over
one file's soundings held whole, with thresholds from definitions.json. The plugin has
a port of them, checked against the same definitions and test vectors
(tests/qc_vectors.json), for its live layer. A transit's first and last few soundings
are judged against one side only.

Follows NOAA Office of Coast Survey's CSB processing tool, with its thresholds as
starting values. Rejection is one-sided: a spike deeper than the track around it is
rejected, a shoaler one is kept as `unconfirmed`, because it may be a rock or a
new shoal. QC writes flags and never deletes points.

Times are int64 microseconds since the epoch, UTC, and depths float32, as the store
holds them. Depth arithmetic rounds through float32 and position arithmetic is
float64, so flags match those DuckDB computes from the same columns (the reference SQL
in tests/reference_qc.py, which has every check but the steep and noise checks).
"""

import itertools
import logging
from datetime import UTC, datetime

import numpy as np

from .catalog import checkpoint
from .definitions import QC

log = logging.getLogger(__name__)

QC_VERSION = QC["version"]

# Flags: reject (left out of everything), review (kept, looked at later),
# unconfirmed (a shoal kept out of cell depths, areas and contours, and published by
# the overlay as a low-reliability sounding), and confirmed (written by the cells step
# for a track spike that its cell agrees with, or that other shoals of another vessel
# or pass, or enough of them, confirm; it then counts like any other sounding). A
# point can carry both an unconfirmed and a confirmed flag: confirmed wins. A reject
# flag wins over both. noisy (a sounding on a track hunting between echoes) votes in
# consensus but sets no depth (see NOISE_REL).
TRACK_REASONS = [
    "sentinel",
    "time",
    "very_shallow",
    "jump",
    "steep",
    "flatline",
    "track_noise",
    "spike",
]
# What track_qc returns, in order: each check's flag and reason.
CHECKS = [
    ("reject", "sentinel"),
    ("reject", "time"),
    ("review", "very_shallow"),
    ("reject", "jump"),
    ("reject", "steep"),
    ("unconfirmed", "flatline"),
    ("reject", "flatline"),
    ("noisy", "track_noise"),
    ("unconfirmed", "track_noise"),
    ("reject", "spike"),
    ("unconfirmed", "spike"),
]

US = 1_000_000
MAX_DEPTH_M = QC["max_depth_m"]
SHALLOW_M = QC["shallow_m"]
# Soundings before this, or more than ARRIVAL_SLACK_S after their file arrived, are rejected.
EARLIEST = QC["earliest"]
EARLIEST_US = int(datetime.fromisoformat(EARLIEST).replace(tzinfo=UTC).timestamp()) * US
ARRIVAL_SLACK_S = QC["arrival_slack_s"]
TRANSIT_GAP_S = QC["transit_gap_s"]
TRANSIT_SPAN_S = QC["transit_span_s"]
MAX_SPEED_KN = QC["max_speed_kn"]
SPIKE_WINDOW = QC["spike_window"]  # soundings either side
SPIKE_ABS_M = QC["spike_abs_m"]
SPIKE_REL = QC["spike_rel"]
SPIKE_MIN_SOUNDINGS = QC["spike_min_soundings"]  # in a transit, to judge spikes at all
# A sounder that has lost bottom often holds its last depth: the same value over this
# far is a stuck reading, not a flat seabed. On the Lynn Canal sample, runs this long
# were a median 17% off the other vessels' depths there, against 5% for shorter ones.
FLAT_M = QC["flat_m"]
FLAT_MIN_SOUNDINGS = QC["flat_min_soundings"]
# A reading shallower than this may be a hazard, so a rule that can't tell it from noise
# keeps it as an unconfirmed shoal rather than rejecting it: a stuck run there may be a
# flat shoal read by a coarse sounder.
HAZARD_M = QC["hazard_m"]
# Shallower than HAZARD_M, a stuck run must also span this far. A boat sitting at its
# mooring adds a kilometre of GPS jitter in minutes while its depth honestly holds; and a
# sounder stuck while the boat stays this close still holds a reading from within this
# distance, so its error is at most the depth change across it. Deeper, a sounder that
# loses bottom holds anything, so the path alone decides.
FLAT_SPAN_M = QC["flat_span_m"]
# A sounding deeper than STEEP_FACTOR times the depth before it, plus STEEP_ABS_M, plus
# STEEP_SLOPE metres for every metre between them, came faster than any seabed falls:
# a sounder that lost bottom. Judged against the last sounding before it that wasn't, so
# a lost-bottom stretch is caught whole, and from both directions, so a real descent,
# which stays deep, is kept. Deep side only: a sudden shoal is left to the spike check,
# which keeps it as unconfirmed.
STEEP_FACTOR = QC["steep_factor"]
STEEP_ABS_M = QC["steep_abs_m"]
STEEP_SLOPE = QC["steep_slope"]
# The depth before counts as at least this much, so a sounder reading junk near the
# surface, or a shallow spike, can't make the real depth after it look steep.
STEEP_FLOOR_M = QC["steep_floor_m"]
# A track whose soundings zig-zag by more than NOISE_REL of its depth (and NOISE_ABS_M)
# is noisy: a sounder hunting between echoes, where a spike check would reject the deep
# side, the true bottom as often as not. Noisy soundings vote in consensus but don't set
# cell depths, cap the surface, stop it filling or feed calibration. A shoaler spike on a
# noisy track is kept as an unconfirmed shoal, since it may be a rock, but one that
# neither confirms nor is confirmed (reason track_noise): the shoal side of a sounder
# hunting between echoes agrees with itself.
NOISE_WINDOW = QC["noise_window"]  # soundings either side; wide, so a few spikes aren't noise
NOISE_REL = QC["noise_rel"]
NOISE_ABS_M = QC["noise_abs_m"]
# Spike windows sorted at once, to bound memory on the largest files.
SPIKE_CHUNK = 65_536


def distance(lon_a, lat_a, lon_b, lat_b):
    """Metres from a to b, equirectangular at a's latitude: well under 1% off at these
    spacings. Longitude wraps at the antimeridian."""
    dx = (np.fmod(lon_b - lon_a + 540, 360) - 180) * np.cos(np.radians(lat_a)) * 111320
    dy = (lat_b - lat_a) * 110540
    return np.sqrt(dx**2 + dy**2)


def speed(t_a, lon_a, lat_a, t_b, lon_b, lat_b):
    """Knots from a to b. Pairs less than a second apart count as one second, since most
    providers write whole seconds; it hides jumps of under about 10 m between them."""
    dt = np.maximum(np.abs(t_b / US - t_a / US), 1)
    return distance(lon_a, lat_a, lon_b, lat_b) / dt * 1.943844


def transits(time):
    """Transit id per sounding of a time-sorted track: a new one after a gap of more than
    TRANSIT_GAP_S, and every TRANSIT_SPAN_S from the start of each unbroken stretch."""
    starts = np.empty(len(time), bool)
    starts[:1] = True
    starts[1:] = np.diff(time) > TRANSIT_GAP_S * US
    seg = np.cumsum(starts)
    t0 = time[starts][seg - 1]
    return seg * 100_000 + (time - t0) // (TRANSIT_SPAN_S * US)


def _continues(transit):
    """True where a sounding is in the same transit as the one before it."""
    same = np.zeros(len(transit), bool)
    same[1:] = transit[1:] == transit[:-1]
    return same


def jumps(time, lon, lat, transit):
    """Positions off the line through their neighbors: both legs faster than MAX_SPEED_KN
    and than twice the speed straight past, so a fast ship's track isn't a jump. A
    transit's first and last soundings have one leg and can't be judged this way."""
    out = np.zeros(len(time), bool)
    if len(time) < 3:
        return out
    a, b, c = slice(0, -2), slice(1, -1), slice(2, None)
    inner = (transit[a] == transit[b]) & (transit[b] == transit[c])
    s_in = speed(time[a], lon[a], lat[a], time[b], lon[b], lat[b])
    s_out = speed(time[b], lon[b], lat[b], time[c], lon[c], lat[c])
    s_past = speed(time[a], lon[a], lat[a], time[c], lon[c], lat[c])
    out[1:-1] = inner & (np.minimum(s_in, s_out) > np.maximum(MAX_SPEED_KN, 2 * s_past))
    return out


def flatlines(depth, lon, lat, transit):
    """Runs of one depth along a transit held over FLAT_M of path and at least
    FLAT_MIN_SOUNDINGS soundings, and, shallower than HAZARD_M, spanning FLAT_SPAN_M."""
    n = len(depth)
    if n == 0:
        return np.zeros(0, bool)
    cont = _continues(transit)
    cont[1:] &= depth[1:] == depth[:-1]
    step = np.zeros(n)
    step[1:] = distance(lon[:-1], lat[:-1], lon[1:], lat[1:])
    step[~cont] = 0
    starts = np.flatnonzero(~cont)
    count = np.diff(np.append(starts, n))
    stuck = (np.add.reduceat(step, starts) >= FLAT_M) & (count >= FLAT_MIN_SOUNDINGS)
    # Across the run's bounding box, at its mean latitude; longitude wraps at the antimeridian.
    span = np.maximum.reduceat(lon, starts) - np.minimum.reduceat(lon, starts)
    mean_lat = np.add.reduceat(lat, starts) / count
    dx = np.minimum(span, 360 - span) * np.cos(np.radians(mean_lat)) * 111320
    dy = (np.maximum.reduceat(lat, starts) - np.minimum.reduceat(lat, starts)) * 110540
    stuck &= (depth[starts] >= HAZARD_M) | (np.sqrt(dx**2 + dy**2) >= FLAT_SPAN_M)
    return stuck[np.cumsum(~cont) - 1]


def rolling_median(depth, transit, k=SPIKE_WINDOW):
    """Median of each sounding's window of k either side within its transit, as DuckDB's
    float median: the mean of the middle two, with the difference rounded to float32."""
    n = len(depth)
    med = np.empty(n, np.float32)
    if n == 0:
        return med
    first = ~_continues(transit)
    bounds = np.append(np.flatnonzero(first), n)
    run = np.cumsum(first) - 1
    lo_b, hi_b = bounds[run], bounds[run + 1] - 1
    offsets = np.arange(-k, k + 1)
    for s in range(0, n, SPIKE_CHUNK):
        i = np.arange(s, min(s + SPIKE_CHUNK, n))
        idx = i[:, None] + offsets
        valid = (idx >= lo_b[i, None]) & (idx <= hi_b[i, None])
        w = np.where(valid, depth[np.clip(idx, 0, n - 1)], np.float32(np.nan))
        w.sort(axis=1)  # NaN sorts last
        m = valid.sum(axis=1)
        rows = np.arange(len(i))
        lo, hi = w[rows, (m - 1) // 2], w[rows, m // 2]
        med[i] = (lo + (hi - lo).astype(np.float64) * 0.5).astype(np.float32)
    return med


def spikes(depth, transit):
    """(deeper, shoaler) masks: soundings off their window's median by more than
    SPIKE_ABS_M + SPIKE_REL of it, in transits of at least SPIKE_MIN_SOUNDINGS."""
    med = rolling_median(depth, transit)
    first = ~_continues(transit)
    starts = np.flatnonzero(first)
    size = np.diff(np.append(starts, len(depth)))[np.cumsum(first) - 1]
    off = np.abs(depth - med) > np.float32(SPIKE_ABS_M) + np.float32(SPIKE_REL) * med
    off &= size >= SPIKE_MIN_SOUNDINGS
    deeper = depth > med
    return off & deeper, off & ~deeper


def _steep_pass(d, lon, lat, transit):
    """Soundings deeper than the steep bound from the last one before them that wasn't."""
    n = len(d)
    out = np.zeros(n, bool)
    if n < 2:
        return out
    cont = _continues(transit)
    step = np.zeros(n)
    step[1:] = distance(lon[:-1], lat[:-1], lon[1:], lat[1:])
    bound = STEEP_FACTOR * np.maximum(d[:-1], STEEP_FLOOR_M) + STEEP_ABS_M + STEEP_SLOPE * step[1:]
    entries = np.flatnonzero(cont[1:] & (d[1:] > bound)) + 1
    ends = np.append(np.flatnonzero(~cont[1:]) + 1, n)  # each sounding's transit end
    end_of = ends[np.searchsorted(ends, np.arange(n), side="right")]
    # Most runs are one sounding long, the next back within the bound from the same anchor:
    # judged here at once, so a sounder flickering between bottom and junk costs no more
    # than a quiet one.
    nxt = np.minimum(entries + 1, n - 1)
    single = (nxt < end_of[entries]) & (
        d[nxt]
        <= STEEP_FACTOR * np.maximum(d[entries - 1], STEEP_FLOOR_M)
        + STEEP_ABS_M
        + STEEP_SLOPE * distance(lon[entries - 1], lat[entries - 1], lon[nxt], lat[nxt])
    )
    rejected = out.tolist()  # list indexing, since this loop can run once a sounding
    for e, one in zip(entries.tolist(), single.tolist(), strict=True):
        if rejected[e - 1]:
            continue  # judged with the run before it
        if one:
            rejected[e] = True
            continue
        a, end, k = e - 1, end_of[e], 64
        # The run of soundings beyond the bound from anchor a, read in growing chunks.
        while True:
            j = min(e + k, end)
            far = distance(lon[a], lat[a], lon[e:j], lat[e:j])
            limit = STEEP_FACTOR * max(d[a], STEEP_FLOOR_M) + STEEP_ABS_M + STEEP_SLOPE * far
            ok = np.flatnonzero(d[e:j] <= limit)
            if len(ok) or j == end:
                stop = e + (ok[0] if len(ok) else j - e)
                break
            k *= 2
        rejected[e:stop] = [True] * (stop - e)
    return np.array(rejected, bool)


def steep(depth, lon, lat, transit):
    """Soundings deeper than the steep bound from both directions along their transit. A
    stretch at a transit's start or end has no sounding before or after it to judge from,
    so it's judged from its one side: a sounder that comes on, or stays, in lost bottom."""
    d = depth.astype(np.float64)
    forward = _steep_pass(d, lon, lat, transit)
    backward = _steep_pass(d[::-1], lon[::-1], lat[::-1], transit[::-1])[::-1]
    return (
        (forward & backward)
        | (backward & _from_start(backward, transit))
        | (forward & _from_start(forward[::-1], transit[::-1])[::-1])
    )


def _from_start(flagged, transit):
    """True where every sounding from the transit's start to here is flagged."""
    i = np.arange(len(flagged))
    start = np.maximum.accumulate(np.where(~_continues(transit), i, 0))
    last_unflagged = np.maximum.accumulate(np.where(flagged, -1, i))
    return last_unflagged < start


def noisy(depth, transit):
    """Soundings where the track's median zig-zag is more than NOISE_REL of its median
    depth and NOISE_ABS_M. A sounding's zig-zag is the least of its distances from the
    middle of its neighbors and from each of them: none on a steady slope, and once, not
    three times, for a lone spike."""
    n = len(depth)
    rough = np.zeros(n, np.float32)
    if n >= 3:
        inner = _continues(transit)[1:-1] & _continues(transit)[2:]
        d, before, after = depth[1:-1], depth[:-2], depth[2:]
        mid = (before + after) / np.float32(2)
        least = np.minimum(np.abs(d - mid), np.minimum(np.abs(d - before), np.abs(d - after)))
        rough[1:-1] = np.where(inner, least, np.float32(0))
    level = rolling_median(rough, transit, NOISE_WINDOW)
    med = rolling_median(depth, transit, NOISE_WINDOW)
    return (level > np.float32(NOISE_REL) * med) & (level > np.float32(NOISE_ABS_M))


def track_qc(time, lon, lat, depth, arrival):
    """QC one file's soundings, given in the order they were written (their `row`).

    `time` and `arrival` (when the file arrived) are microseconds since the epoch.
    Returns [(flag, reason, indices)], each a check's soundings by index into the inputs.
    """
    time, lon, lat = np.asarray(time, np.int64), np.asarray(lon, float), np.asarray(lat, float)
    depth = np.asarray(depth, np.float32)
    sentinel = (depth <= 0) | (depth > MAX_DEPTH_M)
    bad_time = ~sentinel & ((time < EARLIEST_US) | (time > arrival + ARRIVAL_SLACK_S * US))
    # Along the track: by time, then the order soundings were written in.
    order = np.flatnonzero(~(sentinel | bad_time))
    order = order[np.argsort(time[order], kind="stable")]
    tt, lo, la, d = time[order], lon[order], lat[order], depth[order]
    transit = transits(tt)

    jump = jumps(tt, lo, la, transit)
    left = ~jump
    deep = np.zeros(len(order), bool)
    deep[left] = steep(d[left], lo[left], la[left], transit[left])
    left &= ~deep
    kept = order[left]
    flat = flatlines(d[left], lo[left], la[left], transit[left])
    clean = left.copy()
    clean[left] = ~flat
    noise = noisy(d[clean], transit[clean])
    deeper, shoaler = spikes(d[clean], transit[clean])
    deeper &= ~noise
    noisy_shoal = shoaler & noise
    shoaler &= ~noise
    noise &= ~noisy_shoal
    flat_shoal = depth[kept[flat]] < HAZARD_M
    found = [
        np.flatnonzero(sentinel),
        np.flatnonzero(bad_time),
        np.flatnonzero((depth > 0) & (depth < SHALLOW_M)),
        order[jump],
        order[deep],
        kept[flat][flat_shoal],
        kept[flat][~flat_shoal],
        order[clean][noise],
        order[clean][noisy_shoal],
        order[clean][deeper],
        order[clean][shoaler],
    ]
    return [(flag, reason, idx) for (flag, reason), idx in zip(CHECKS, found, strict=True)]


def run_batch(con, batch_id: int, fresh=False):
    """Replace one ingest batch's track flags. `fresh` batches have none to delete."""
    params = {"batch": batch_id}
    if not fresh:
        con.execute(
            f"""DELETE FROM lake.qc_flags WHERE qc_version = {QC_VERSION}
            AND list_contains({TRACK_REASONS}, reason)
            AND cell_id IN (SELECT DISTINCT cell_id FROM lake.points WHERE batch_id = $batch)
            AND point_id IN (SELECT point_id FROM lake.points WHERE batch_id = $batch)""",
            params,
        )
    con.execute(
        """CREATE OR REPLACE TEMP TABLE qc_points AS
        SELECT p.point_id, p.cell_id, p.file_id, p."row", epoch_us(p.time) AS t, p.lon, p.lat,
          p.depth_raw AS d, epoch_us(f.arrival) AS arrival
        FROM lake.points p JOIN lake.files f USING (file_id) WHERE p.batch_id = $batch""",
        params,
    )
    # ponytail: holds a batch's columns and one file's working arrays, about 200 bytes a
    # sounding, so memory follows the largest file; judge a huge file a few transits at a
    # time if one outgrows a worker
    a = con.execute(
        """SELECT file_id, "row", t, lon, lat, d, arrival FROM qc_points
        ORDER BY file_id, "row" """
    ).fetchnumpy()
    bounds = np.flatnonzero(np.diff(a["file_id"], prepend=-1, append=-1))
    # Each flag as its check's position in CHECKS: numbers, since DuckDB reads a numpy
    # array of strings one Python object at a time.
    found = {"file_id": [], "row": [], "check": []}
    for s, e in itertools.pairwise(bounds):
        flags = track_qc(a["t"][s:e], a["lon"][s:e], a["lat"][s:e], a["d"][s:e], a["arrival"][s])
        for check, (_, _, idx) in enumerate(flags):
            found["file_id"].append(a["file_id"][s + idx])
            found["row"].append(a["row"][s + idx])
            found["check"].append(np.full(len(idx), check + 1, np.int8))
    if found["row"]:
        con.register("qc_found", {k: np.concatenate(v) for k, v in found.items()})
        con.execute(
            f"""INSERT INTO lake.qc_flags BY NAME
            SELECT q.point_id, q.cell_id, {[f for f, _ in CHECKS]}[f."check"] AS flag,
              {[r for _, r in CHECKS]}[f."check"] AS reason, {QC_VERSION} AS qc_version
            FROM qc_found f JOIN qc_points q USING (file_id, "row")"""
        )
        con.unregister("qc_found")
    con.execute("DROP TABLE qc_points")
    con.execute("DELETE FROM lake.qc_batches WHERE batch_id = $batch", params)
    con.execute(f"INSERT INTO lake.qc_batches VALUES ($batch, {QC_VERSION})", params)


def run(con, missing_only=False) -> int:
    """QC every batch, or only those not yet QC'd at this version. Returns batches run."""
    batches = [
        b
        for (b,) in con.execute(
            f"""SELECT DISTINCT batch_id FROM lake.points
            WHERE NOT $missing_only OR batch_id NOT IN (
              SELECT batch_id FROM lake.qc_batches WHERE qc_version = {QC_VERSION})
            ORDER BY 1""",
            {"missing_only": missing_only},
        ).fetchall()
    ]
    # A batch's qc_batches row records it done, so a run that stops partway resumes,
    # with missing_only, from its last checkpoint.
    for batch_id in batches:
        con.execute("BEGIN")
        run_batch(con, batch_id)
        con.execute("COMMIT")
        checkpoint(con)
    log.info("qc: %d batches", len(batches))
    return len(batches)
