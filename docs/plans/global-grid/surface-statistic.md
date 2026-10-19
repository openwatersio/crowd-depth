# Surface statistic

With tide reduced and each vessel's offset corrected, draw `median − 1.75σ`, where σ combines each sounding's correction uncertainty with the spread of vessels around a local plane. In Thimble Shoal Channel it draws 0.1% of pixels more than 1 m deeper than the shoalest BlueTopo cell under them, and 0.3% of channel pixels, with a channel bias of −1.2 m. The current statistic, a 10th percentile with a guard on the shoalest sounding, draws none too deep but puts the channel 1.9 m too shallow and 45% of channel pixels more than 2 m too shallow.

Drop the guard on the shoalest sounding: it doubles false shoals in the channel and helps little anywhere else. In sparse water the statistic matters less than QC. In Tangier Sound, one sounder stuck at 2.6 m in 9 to 22 m of water and two vessels without an offset drew false shoals over a fifth of the area under every statistic, and no QC rule caught the stuck sounder.

Measured in October 2026 on the Chesapeake NOAA CSB set. The comparison's code isn't checked in. The speckle in the same channel is in [channel-speckle.md](channel-speckle.md).

## Literature and prior art

- **No source uses a sample percentile as the gridded depth.** Hydrographic practice separates two things:
  - **Chart soundings** are shoal-biased by selection. S-4 keeps the least depth, checked with the triangle test.
  - **Surfaces** are estimates with an uncertainty attached. In the Navigation Surface (Smith, Alexander and Armstrong 2002), a CUBE grid carries uncertainty per node and is optimised so least depths over significant features survive. CUBE workflows produce a shoal-biased surface by subtracting the 95% confidence layer from the depths.
- **The shallowest measured depth is a poor estimator.** Mohammadloo et al. (TU Delft, ASCE Journal of Surveying Engineering) find it is dominated by measurement noise in flat areas and propose combinations of mean and standard deviation instead.
- **Robust central estimates are the norm for gridding noisy track data.** MB-System recommends median gridding for unedited bathymetry, and GMT pairs `blockmedian` with `surface`.
- **Crowdsourced data's dominant error is an uncontrolled vertical offset per vessel.** Calder and colleagues' Trusted Community Bathymetry work addresses this by self-calibrating offsets with post-processed GNSS. Ibekwute (UNB 2025) estimates offsets with a Kalman filter, with corrections of −1.3 to +1.2 m on Gulf of St. Lawrence data. For track data in general, crossover analysis solves a constant offset per track by least squares (Wessel's x2sys). That solution is only relative, so an absolute reference has to anchor it.

## Why the 10th percentile is weak

- **It changes meaning with density.** Over half of all sounded pixels in Thimble Shoal Channel hold 10 or fewer soundings. On those, `quantile_disc(d, 0.1)` returns the minimum; elsewhere it returns a true percentile.
- **It counts soundings, not vessels.** A vessel logging at 1 Hz sets the pixel. The median pixel has two vessels in it.
- **Its shoal margin follows the noise, unstated.** For Gaussian noise, the 10th percentile sits about 1.28σ below the mean, and its sampling error is about 1.4 times the median's. The margin grows where the data is worst and is never recorded.

## Method

- **Data:** 18,434 NOAA CSB files (98.5M soundings) over the Chesapeake, through the pipeline as it runs: track QC at version 5 with the Seascape deep-side check, tide reduced with the Slackwater engine and CO-OPS residuals, offsets from `grid calibrate` against S-102 and BlueTopo, and cells built for the scored tiles so their consensus rejects and confirmed shoals are in.
- **No offset scored on its own data:** calibration ran with every scored area left out. A rerun keeps a published offset that moved by less than its standard error, so an offset can still sit within one standard error of a fit that saw the area.
- **Grid:** the pipeline's 2/3″ grid (about 20 m), `gdal_grid` settings and blur.
- **Reference:** BlueTopo at 4 m, resampled to each pixel's median and shoalest 4 m cell, and taken from NAVD88 to MLLW with the nearest CO-OPS gauge's separation, as calibration does.
- **Leave one vessel out:** each vessel with 100 or more pixels in the area is dropped, the surface is built from the rest, and it's scored against the dropped vessel's own pixel medians. This scores the statistic against soundings it never saw, independent of BlueTopo's vintage.
- **Relief:** a pixel is a slope where BlueTopo's median is more than 0.5 m deeper than its shoalest 4 m cell.

### Areas

| Area                                            | Soundings | Vessels | Scored pixels | Slope pixels | Deeper than 12 m |
| ----------------------------------------------- | --------: | ------: | ------------: | -----------: | ---------------: |
| Thimble Shoal Channel, east half                |      210k |      54 |        21,400 |        1,200 |            3,800 |
| Tangier Sound (−76.05 to −75.85, 37.85 to 38.2) |      238k |      16 |        87,800 |        8,400 |           66,800 |
| Pocomoke Sound (−75.9 to −75.65, 37.85 to 38.0) |       72k |      12 |         2,000 |           81 |                0 |

Tangier is scored with calibrated vessels only and without one vessel's 2003 files, for the reasons under [Sparse water](#sparse-water).

### σ

- **σ_a, spread:** the robust spread (1.4826 × MAD) of every vessel's median within 2 pixels, about 40 m, around the median surface, with a 0.3 m floor.
- **σ_b, corrections and plane:** each sounding's correction uncertainty (tide and calibration combined, the median across vessels within 2 pixels) combined with the robust spread of vessel medians around a plane fitted to them. The plane takes out the slope, so σ_b measures disagreement, not relief.
- **σ_c, standard error:** σ_b as the standard error of a median of n vessels, 1.2533 σ_b / √n.

In Thimble Shoal Channel, σ_a has a median of 0.36 m, σ_b 0.23 m and σ_c 0.20 m.

## Results

Bias is the estimate minus BlueTopo's median, so negative means shoaler. "Too deep" is the share of pixels more than 1 m deeper than the shoalest BlueTopo cell under them. "False shoals" is the share more than 2 m shoaler than BlueTopo. The last two columns leave one vessel out, against that vessel's own soundings.

### Thimble Shoal Channel

| Statistic                          |  Bias | Channel bias | Too deep | On slopes | In channel | False shoals | In channel | Left out: too deep | Left out: false shoals |
| ---------------------------------- | ----: | -----------: | -------: | --------: | ---------: | -----------: | ---------: | -----------------: | ---------------------: |
| Current: 10th pct., shoalest guard | −0.25 |        −1.87 |     0.0% |      0.1% |       0.0% |         6.7% |        45% |               0.2% |                  10.0% |
| 10th percentile, no guard          | −0.18 |        −0.92 |     0.4% |      7.0% |       2.2% |         2.9% |        14% |                    |                        |
| Median of vessel medians           | −0.07 |        −0.41 |     1.3% |       23% |       7.0% |         1.3% |       5.6% |               2.3% |                   0.8% |
| Median − 1.0σ_a                    | −0.45 |        −1.02 |     0.0% |      0.1% |       0.0% |         5.5% |        27% |               0.4% |                   5.9% |
| Median − 1.5σ_a                    | −0.63 |        −1.30 |     0.0% |      0.0% |       0.0% |         7.5% |        34% |               0.2% |                   9.1% |
| Median − 1.0σ_b                    | −0.32 |        −0.86 |     0.4% |      7.1% |       2.2% |         3.7% |        17% |               0.8% |                   2.5% |
| Median − 1.5σ_b                    | −0.42 |        −1.09 |     0.1% |      2.3% |       0.7% |         5.3% |        24% |               0.4% |                   4.1% |
| **Median − 1.75σ_b**               | −0.47 |        −1.20 |     0.1% |      1.1% |       0.3% |         6.4% |        28% |                    |                        |
| Median − 2.0σ_b                    | −0.53 |        −1.31 |     0.0% |      0.5% |       0.2% |         9.4% |        31% |               0.3% |                   6.8% |
| Median − 1.5σ_c                    | −0.41 |        −0.78 |     0.3% |      4.9% |       1.6% |         5.3% |        20% |               0.8% |                   3.5% |
| Median − 1.5σ_b, shoalest guard    | −0.47 |        −1.86 |     0.0% |      0.0% |       0.0% |         9.0% |        45% |                    |                        |

A guard on confirmed shoals changed no row by more than 0.3 points: these areas have few.

### Tangier Sound

| Statistic                          |  Bias | Too deep | On slopes | Deeper than 12 m | False shoals | Left out: too deep | Left out: false shoals |
| ---------------------------------- | ----: | -------: | --------: | ---------------: | -----------: | -----------------: | ---------------------: |
| Current: 10th pct., shoalest guard | −0.18 |     4.0% |       18% |             4.2% |         1.9% |               2.1% |                   1.5% |
| Median of vessel medians           | −0.05 |     6.1% |       31% |             6.5% |         0.9% |               2.9% |                   0.8% |
| Median − 1.0σ_a                    | −0.44 |     2.5% |       11% |             2.5% |         2.9% |               0.8% |                   2.7% |
| Median − 1.5σ_a                    | −0.63 |     1.8% |      7.0% |             1.8% |         5.0% |               0.5% |                   5.1% |
| Median − 1.5σ_b                    | −0.32 |     3.1% |       15% |             3.1% |         2.5% |               0.9% |                   2.1% |
| **Median − 1.75σ_b**               | −0.37 |     2.8% |       13% |             2.8% |         2.8% |                    |                        |
| Median − 2.0σ_b                    | −0.41 |     2.5% |       12% |             2.5% |         3.1% |               0.7% |                   2.6% |
| Median − 1.5σ_b, shoalest guard    | −0.34 |     2.7% |       13% |             2.7% |         3.0% |                    |                        |

Left out, every σ statistic draws under 1% of a vessel's own pixels more than 1 m deeper than it read them. Against BlueTopo, 2 to 3% of pixels stay too deep at any k. The vessels agree with each other there and not with the survey, which points at the survey's vintage on a moving bottom or its 4 m shoalest cell, not at the statistic.

### Pocomoke Sound

The result here is inconclusive. Only 2,000 pixels can be scored, and 4 to 9% of them are too deep under every statistic and every k. Those pixels all sit where BlueTopo reads a uniform 2.4 m and 2025 soundings from 68 of 73 files read 3.3 to 4.1 m. BlueTopo's source there, not the statistic, sets the score.

## Findings

- **σ_b beats σ_a.** At the same safety, σ_a over-shoals: its spread counts relief as noise, so on Thimble's slopes it draws 86% of pixels as false shoals at k = 1.5, against 61% for σ_b. σ_a is the only σ that keeps every slope pixel safe, though. σ_c shrinks with the number of vessels and lets 1.6% of channel pixels through at k = 1.5, so it's not a safety margin.
- **k = 1.75 with σ_b** is the smallest k that keeps Thimble's channel under 0.5% too deep (0.3%), and in Tangier it draws fewer pixels too deep than the current statistic, overall and on slopes, at the cost of 0.2 m more shoal bias. k = 2 buys 0.1 point of channel safety for 3 points more false shoals.
- **The guard on the shoalest sounding can go.** On Thimble it takes slopes from 2.3% to 0% too deep and doubles channel false shoals (24% to 45%). In Tangier it changes too-deep pixels by 0.4 points. Confirmed shoals, which publish as soundings anyway, are the hazard path.
- **Slopes are the remaining risk.** σ_b at k = 1.75 leaves 1.1% of Thimble's slope pixels and 13% of Tangier's more than 1 m too deep, against 0.1% and 18% for the current statistic. The 200 m interpolation radius blends the deep side of a slope over its shoal side. A pixel's own shoalest sounding as a floor only where σ_a is much larger than σ_b, that is on slopes, is the next thing to measure.
- **Corrections close most of the gap.** Uncorrected, every statistic put the channel 3 to 5 m too shallow. With tide and calibration, the median of vessels is within 0.1 m of BlueTopo outside the channel in both dense and sparse water.

## Sparse water

In Tangier Sound, before cleaning, every statistic drew 19 to 30% of pixels as false shoals more than 2 m too shallow, and leaving one vessel out drew 8 to 10% too deep. The statistic wasn't the cause:

- **A stuck sounder.** One calibrated vessel logged 19,000 soundings in 2003 at a raw 2.5 to 2.8 m in 9 to 22 m of water, a sounder that lost bottom and read a near-constant shallow value. Track QC's flatline check needs a constant reading and this one wandered by 0.3 m, the Seascape check only looks for soundings too deep, and consensus needs three other vessels to disprove a shoal, which Tangier rarely has. Leaving that vessel's 2003 files out took the median's false shoals from 9.6% to 0.9%.
- **Uncalibrated vessels.** Two vessels without an offset read 2 m and 17 m shallow; one logged a raw median of 0.4 m in 17 m of water. Leaving uncalibrated vessels out of the statistic where calibrated ones sounded took the median's false shoals from 19.6% to 9.6%. Readings under 0.5 m, which version 5 QC keeps for review, account for 0.7 points of that.
- **Datum seams.** The nearest-gauge separation jumps 0.42 m across Pocomoke Sound, from −0.37 m at its northwest corner to Onancock's −0.79 m. Calibration anchors on the same rule, so a vessel anchored on either side of the seam carries it.

## Recommendation

1. **Draw `median − 1.75σ_b`** of per-vessel medians, and publish σ_b. It feeds M_QUAL and CATZOC.
2. **Drop the guard on the shoalest sounding.** Keep confirmed shoals as the hazard path.
3. **Catch shallow lost-bottom readings in QC.** A shoal-side reference check, a near-constant reading far shoaler than Seascape over a whole file, would have caught Tangier's stuck sounder. Measure its false-alarm rate on real shoals first.
4. **Leave uncalibrated vessels out of the median** where calibrated vessels sounded the pixel, and keep them where they're the only data, marked uncalibrated.
5. **Measure a slope floor next:** the shoalest accepted sounding as a floor only on pixels where σ_a is well above σ_b.

## Not measured

- **Crossover-only offsets:** most offsets here are anchored to BlueTopo or S-102; crossover offsets were 10 of 343 segments.
- **Rocky bottom and areas without BlueTopo.** Leaving one vessel out is the only score that works there.
- **Survey vintage:** BlueTopo's surveys and the CSB soundings span different years, and Tangier's bottom moves. Some of what scores as too deep against BlueTopo is likely change, not error.
