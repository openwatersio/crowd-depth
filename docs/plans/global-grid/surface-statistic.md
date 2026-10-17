# Surface statistic

Compared against NOAA BlueTopo in Thimble Shoal Channel, the 10th percentile is not the right statistic, but it is also not the main problem. Each vessel's vertical offset is. In Thimble Shoal Channel, vessels read a median of 3.8 m shallower than BlueTopo, from −0.6 m to −5.4 m by vessel. That is consistent with depths logged below the transducer of deep-draft vessels. No per-pixel statistic recovers from that.

Once each vessel's offset is removed, a robust median with an explicit uncertainty margin, `median − 1.645σ`, beats the current surface on safety and accuracy at once. It is drawn more than 1 m deeper than the shoalest BlueTopo cell under it in 0.6% of pixels, against 2.7% for the current surface. Its channel bias is −1.4 m, against −4.5 m.

Measured in October 2026 on the Chesapeake set. The comparison's code isn't checked in. The speckle this causes in the same channel is in [channel-speckle.md](channel-speckle.md).

## Literature and prior art

- **No source uses a sample percentile as the gridded depth.** Hydrographic practice separates two things:
  - **Chart soundings** are shoal-biased by selection. S-4 keeps the least depth, checked with the triangle test.
  - **Surfaces** are estimates with an uncertainty attached. In the Navigation Surface (Smith, Alexander and Armstrong 2002), a CUBE grid carries uncertainty per node and is optimised so least depths over significant features survive. CUBE workflows produce a shoal-biased surface by subtracting the 95% confidence layer from the depths.
- **The shallowest measured depth is a poor estimator.** Mohammadloo et al. (TU Delft, ASCE Journal of Surveying Engineering) find it is dominated by measurement noise in flat areas and propose combinations of mean and standard deviation instead.
- **Robust central estimates are the norm for gridding noisy track data.** MB-System recommends median gridding for unedited bathymetry, and GMT pairs `blockmedian` with `surface`.
- **Crowdsourced data's dominant error is an uncontrolled vertical offset per vessel.** Calder and colleagues' Trusted Community Bathymetry work addresses this by self-calibrating offsets with post-processed GNSS. Ibekwute (UNB 2025) estimates offsets with a Kalman filter, with corrections of −1.3 to +1.2 m on Gulf of St. Lawrence data. For track data in general, crossover analysis solves a constant offset per track by least squares (Wessel's x2sys). That solution is only relative, so an absolute reference has to anchor it.

## Why the 10th percentile is weak

- **It changes meaning with density.** Over half of all sounded pixels in the area hold 10 or fewer soundings. On those, `quantile_disc(d, 0.1)` returns the minimum; elsewhere it returns a true percentile.
- **It counts soundings, not vessels.** A vessel logging at 1 Hz, or one with a large offset, sets the pixel. The median pixel has two vessels in it.
- **Its shoal margin follows the noise, unstated.** For Gaussian noise, the 10th percentile sits about 1.28σ below the mean, and its sampling error is about 1.4 times the median's. The margin grows where the data is worst and is never recorded.
- **The guard on the shoalest sounding does more damage than the percentile.** In the channel, the guard alone draws a third of pixels under 9 m, against 6% for the 10th percentile.

## Method

- **Area:** Thimble Shoal Channel and its flanks (−76.21 to −76.14, 36.975 to 37.0).
- **Grid and data:** the pipeline's own grid (2/3″, about 20 m), the [per-tile build](per-tile-pipeline.md)'s accepted soundings and flags, and the pipeline's `gdal_grid` settings and blur.
- **Replication check:** a rebuild of the current surface matches the per-tile build's to a median of 0.04 m.
- **Reference:** BlueTopo, at 4 m and delivered in 2026. It's resampled to each pixel's median and shoalest 4 m cell, and taken from NAVD88 to present mean sea level with Sewells Point's 2023–2026 mean, +0.123 m.
- **Uncertainty:** σ is the robust spread (1.4826 × MAD) of every vessel's median within 2 pixels, about 40 m, combined with a floor of 0.3 m.
- **Offsets:** each vessel's offset is learned against BlueTopo west of −76.175, and the statistics are scored only east of it, so no offset is scored on the data it came from. Offsets learned in the west leave residual vessel offsets of −0.14 to +0.12 m in the east (10th to 90th percentile), so each vessel's offset is a constant.

## Results: east half, offsets corrected

Bias is the estimate minus BlueTopo; negative means shoaler.

| Statistic                                  |  Bias | Channel bias | Median abs. error | 90th pct. abs. error | Deeper than shoalest cell by > 1 m | Channel false shoals > 2 m | Channel roughness, 90th pct. |
| ------------------------------------------ | ----: | -----------: | ----------------: | -------------------: | ---------------------------------: | -------------------------: | ---------------------------: |
| Current: 10th pct., shoalest guard, holes  | −0.29 |        −4.49 |              0.38 |                 4.14 |                               2.7% |                        86% |                         1.96 |
| 10th percentile, no guard                  | −0.23 |        −2.44 |              0.35 |                 2.56 |                               2.6% |                        61% |                         2.33 |
| Median of vessel medians                   | −0.02 |        −0.14 |              0.20 |                 1.00 |                               4.8% |                         5% |                         1.35 |
| **Median − 1.645σ**                        | −0.80 |        −1.40 |              0.82 |                 2.47 |                           **0.6%** |                        38% |                         2.37 |
| Median − 1.645σ, guard on confirmed shoals | −0.80 |        −1.42 |              0.82 |                 2.50 |                               0.6% |                        39% |                         2.50 |

For reference, BlueTopo's own median is more than 0.5 m deeper than its shoalest 4 m cell in 4.7% of pixels; those are slopes. On sloped pixels, the plain median is unsafe, more than 0.5 m too deep in 55% of them. The σ margin brings that to 0%, because σ widens on slopes.

**Uncorrected, as the pipeline runs today:** every statistic is 3–5 m too shallow. BlueTopo puts the channel at a median 17.9 m below MSL. The current surface puts it 9.3 m shallower, and the median of vessels 4.6 m shallower. Nothing is drawn too deep, but the channel is drawn wrong.

## Recommendation

1. **Correct each vessel's offset before gridding.** It is the largest error by far, and offsets hold steady across space. Where an authoritative survey exists (BlueTopo covers US waters), calibrate each vessel against it, as IHO B-12 describes for reference surfaces. Elsewhere, solve relative offsets at crossovers, anchored to vessels that have a calibration. Record each offset and its uncertainty per vessel.
2. **Replace the 10th percentile with a robust estimate and an uncertainty.** Take the median of per-vessel (or per-transit) medians, give each pixel a σ, and draw `median − kσ`. Publish σ. It feeds M_QUAL and CATZOC, and k becomes a stated, documented safety margin.
3. **Drop the guard on the shoalest sounding.** Keep hazards through confirmed shoals, which act as the Navigation Surface's designated soundings and are drawn as soundings in any case. The guard on confirmed shoals made no difference here; this area has few.
4. **Build a better σ.** The window σ here mixes slope with noise, which is safe but over-shoals channel edges. A per-vessel uncertainty from calibration residuals, combined with spread around a local plane, would be tighter. CUBE/CHRT does this formally and suits dense areas like this channel; the plan's note that sparse cells never form hypotheses still holds for the long tail.

## Not measured

- **Production offsets:** offsets here come from BlueTopo itself, as a reference-surface calibration would. Crossover-only offsets, without a reference, are untested.
- **Tide:** not reduced. The range here is 0.89 m, so tide is part of the noise.
- **Survey vintage:** the channel was deepened in recent years, and the CSB soundings span 2017–2026. Older soundings from before the deepening read shallow, which adds to the channel bias of every statistic.
- **Scope:** one channel; no sparse areas and no rocky bottom. Repeat the comparison where BlueTopo has a sparse CSB area.
