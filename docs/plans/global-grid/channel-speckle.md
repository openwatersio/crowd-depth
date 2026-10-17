# Speckle in busy channels

Busy water draws noisier than quiet water. Thimble Shoal Channel, at the mouth of the Chesapeake, is dredged to about 15 m and carries more traffic than anywhere else in the set: a 1 km box across it holds 41,561 soundings from 44 vessels and 295 files. In the per-tile build its depth areas are salt-and-pepper, while the quieter water around it is smooth.

## Causes

With the cells stage's flags applied, the deep pixels (median over 12 m) in that box break down as:

- **Holes: 489 of 964.** Each holds an unconfirmed shoal, a sounding shallower than its cell's median by more than max(1 m, 3 × MAD), and the surface leaves any pixel holding one empty. Between vessels, 1–3 m of disagreement in 13 m of water is ordinary, so a busy pixel almost always has one. A lone track sets its own cell's median, so in quiet water nothing stands out.
- **Capped below 9 m: 62 of 964.** The surface caps each pixel at the shallowest accepted sounding in it or next to it. Nearly all of these soundings come from one vessel, a Carnival ship, which reads 8.2–8.8 m on every pass on several days, where other vessels read 12–14 m. That is a constant per-vessel offset, most likely depth below the keel or a wrong transducer offset.
- **Tracks noisy throughout.** NOAA Ship Pisces reads anywhere from 6 m to 13 m second to second. The spike check rejects only readings deeper than the track's running median and keeps shallower ones as unconfirmed. On a track whose median is pulled shallow by noise, it rejects the true 13 m bottom (82 rejects in one file) and keeps the shallow noise.

One-ping drops are already handled: a 6.4 m reading between 10–12 m readings is flagged unconfirmed by the spike check.

## Changes

1. **Widen the cell's tolerance** for a candidate shoal from max(1 m, 3 × MAD) to the consensus check's max(2 m + 5%, 3 × MAD). Approximating cells with 3″ blocks across all 212 tiles:

   | Tiles                              | Unconfirmed soundings | Still unconfirmed |      Hole pixels |
   | ---------------------------------- | --------------------: | ----------------: | ---------------: |
   | Sparse, under 100k soundings (172) |                10,563 |       1,253 (12%) |      8,402 → 968 |
   | 100k–1M (30)                       |                27,740 |        2,445 (9%) |   21,048 → 1,876 |
   | Dense, 1M or more (10)             |               621,595 |     142,942 (23%) | 358,241 → 80,752 |

   The soundings that stop being unconfirmed are drawn, shallow-biased, instead of leaving holes, so the change shows more and errs shoal, and nothing is dropped, in sparse areas or anywhere else. What is lost is the hole that marks a bump of 1–2.3 m above its cell as uncertain.

2. **Score each track's noise.** Where a track's local spread is large, keep its soundings for consensus votes but don't let them set depths, cap pixels or punch holes. This makes the spike check's one-sided rejection safe on noisy tracks. It changes QC, so it bumps `QC_VERSION`.
3. **Calibrate vessels.** Estimate each vessel's vertical offset where its tracks cross other vessels', as in [Vessel calibration](README.md#vessel-calibration), and apply it before gridding. This removes offsets like the Carnival ship's at the source and sharpens the whole map, not just channels.

The cap on the shoalest sounding is measured on its own in [surface-statistic.md](surface-statistic.md), against BlueTopo over a wider area of the channel and its flanks. There it draws a third of pixels under 9 m, and the recommendation is to drop it and carry hazards through confirmed shoals instead. Requiring only a second vessel would change sparse areas, where a shoal read by one track would no longer cap the surface.
