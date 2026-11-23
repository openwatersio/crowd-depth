# Speckle in busy channels

Busy water can draw noisier than quiet water. Thimble Shoal Channel, at the mouth of the Chesapeake, is dredged to about 15 m and carries more traffic than anywhere else in the set: a 1 km box across it holds 41,561 soundings from 44 vessels and 295 files. Before the changes below, its depth areas in the per-tile build were salt-and-pepper, while the quieter water around it was smooth.

Measured in October 2026 on the Chesapeake NOAA CSB set, with QC version 5 and no vessel calibration.

## Causes

With the cells stage's flags applied, the deep pixels (median over 12 m) in that box broke down as:

- **Holes: 489 of 964.** Each held an unconfirmed shoal, a sounding shallower than its cell's median by more than max(1 m, 3 × MAD), and the surface left any pixel holding one empty. Between vessels, 1–3 m of disagreement in 13 m of water is ordinary, so a busy pixel almost always has one. A lone track sets its own cell's median, so in quiet water nothing stands out.
- **Capped below 9 m: 62 of 964.** The surface capped each pixel at the shallowest accepted sounding in it or next to it. Nearly all of these soundings come from one vessel, a Carnival ship, which reads 8.2–8.8 m on every pass on several days, where other vessels read 12–14 m. That is a constant per-vessel offset, most likely depth below the keel or a wrong transducer offset.
- **Tracks noisy throughout.** NOAA Ship Pisces reads anywhere from 6 m to 13 m second to second. The spike check rejects only readings deeper than the track's running median and keeps shallower ones as unconfirmed. On a track whose median is pulled shallow by noise, it rejected the true 13 m bottom (82 rejects in one file) and kept the shallow noise.

One-ping drops are handled by the spike check: a 6.4 m reading between 10–12 m readings is flagged unconfirmed.

## In the pipeline

Each cause has its own fix, and three of the four are built:

- **Holes.** The surface leaves no pixel empty for an unconfirmed shoal. Shoals QC judged improbable against their context don't vote, and the surface is drawn from the other votes as if they weren't there; each publishes as an unconfirmed sounding ([Interpolation](README.md#interpolation)). Among pixels mostly surrounded by drawn surface on Thimble's tile, the share left empty over 1,000 soundings is 0.0% ([surface-statistic.md](surface-statistic.md#legibility)).
- **The cap on the shoalest sounding** is gone. Confirmed shoals cap the surface instead, and only within 2 m + 5% of the other vessels' median in their pixel ([surface-statistic.md](surface-statistic.md)).
- **Offsets like the Carnival ship's** are corrected at the source: `grid calibrate` solves each vessel step segment's offset against S-102 and BlueTopo and at crossings, and the grid applies it before gridding ([Vessel calibration](README.md#vessel-calibration)).
- **Noisy tracks.** A track whose soundings zig-zag by more than 10% of its depth is `noisy`: its deep side votes in consensus but sets no depths, and its shoal side stays unconfirmed shoals that neither confirm nor are confirmed. On the Chesapeake it marks 109,277 soundings noisy ([qc.py](../../../packages/grid/src/grid/qc.py)).

Not built: widening the cell's tolerance for a candidate shoal from max(1 m, 3 × MAD) to the consensus check's max(2 m + 5%, 3 × MAD). Approximating cells with 3″ blocks across all 212 tiles, without calibration, it took most candidate shoals out:

| Tiles                              | Unconfirmed soundings | Still unconfirmed |      Hole pixels |
| ---------------------------------- | --------------------: | ----------------: | ---------------: |
| Sparse, under 100k soundings (172) |                10,563 |       1,253 (12%) |      8,402 → 968 |
| 100k–1M (30)                       |                27,740 |        2,445 (9%) |   21,048 → 1,876 |
| Dense, 1M or more (10)             |               621,595 |     142,942 (23%) | 358,241 → 80,752 |

Unconfirmed shoals punch no holes in the surface, so what the wider tolerance would change is which soundings publish as unconfirmed and which can confirm, not the surface's holes. On the calibrated, tide-reduced Chesapeake store at main 56620f4, every leaf's cells rebuilt with the wider tolerance on the candidate side only ([tolwide.py](../../../packages/grid/spikes/channel-speckle/tolwide.py)) give:

| Tiles                | Unconfirmed cell shoals | With the wider tolerance | Confirmed cell shoals | With the wider tolerance |
| -------------------- | ----------------------: | -----------------------: | --------------------: | -----------------------: |
| Under 100k soundings |                   9,472 |              1,329 (14%) |                39,976 |                   26,924 |
| 100k–1M              |                  21,301 |              3,185 (15%) |                42,653 |                   26,408 |
| 1M or more           |                 175,846 |             63,959 (36%) |               621,897 |                  124,833 |

A sounding within the wider tolerance isn't a candidate at all, so confirmed shoals fall with unconfirmed ones, by three quarters across the store. Confirmed shoals cap the surface, so the surface is benchmarked with it before it is adopted ([backlog.md](backlog.md#4-clean-up-qc-and-seams)).
