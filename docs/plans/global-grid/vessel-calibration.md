# Vessel calibration

Each vessel's vertical offset can be calibrated, both against BlueTopo and from crossings with other vessels, and the two methods agree. Across the Chesapeake, 234 of 303 vessels calibrate against BlueTopo, with offsets from −3.4 m to 0.0 m (10th to 90th percentile). A crossover solve anchored to the other vessels recovers a held-out vessel's BlueTopo offset to within 0.09 m (median) and 0.31 m (90th percentile).

Offsets are not constant for a quarter of the vessels. 36 of the 146 vessels with enough calibrated transits show a step, a median of 0.74 m and up to 5.2 m, which looks like a sounder being moved, replaced or reconfigured. Calibrating per vessel and step segment, rather than per vessel, is what makes the corrected surface right. In Thimble Shoal Channel, with offsets learned everywhere except the scored area, `median − 1.645σ` is never drawn more than 1 m deeper than the shoalest BlueTopo cell under it, against 2.1% of pixels with one constant offset per vessel.

Planet-scale cost is small. The crossover work runs per 1° tile, and the densest Chesapeake tile takes 4.7 s and 1.3 GB. The global solve is a sparse system with one unknown per vessel segment, which takes under a second at 100,000 segments.

Measured in October 2026 on the Chesapeake set. The comparison's code isn't checked in.

## Method

- **Soundings:** the pipeline's accepted soundings from the [per-tile build](per-tile-pipeline.md): files active after dedupe, no track-QC reject or unconfirmed, and no cells-stage reject or unconfirmed unless later confirmed. In the box −78 to −75, 36 to 40, that is 79.3M soundings from 303 vessels and 18,356 files.
- **Unit of comparison:** each vessel's median depth per file (transit) per 2/3″ pixel (about 20 m), 16.7M rows over 5.9M pixels. Medians per transit and pixel keep a vessel logging at 1 Hz from outweighing one logging every few seconds.
- **Reference:** BlueTopo, the 603 tiles that contain a CSB pixel, 4 m and 8 m, delivered in 2026. At each pixel centre: the mean of BlueTopo cells within about 10 m, the range of cells within ±20 m as flatness, and BlueTopo's own uncertainty band. Heights are taken from NAVD88 to MSL with Sewells Point's +0.123 m everywhere, which is off by up to about 0.1 m up the bay.
- **Calibration sample:** flat, well-surveyed, shallow-to-moderate seabed: BlueTopo depth 2–20 m, its uncertainty under 2 m, range under 0.5 m within ±20 m, and a difference under 12 m. That leaves 7.1M rows from 283 vessels. A vessel is calibrated with at least 50 rows from at least 2 transits.
- **Offset:** the median of the vessel's CSB depth minus BlueTopo. Negative means the vessel reads shallow. Its standard error comes from the spread of per-transit offsets.
- **Crossings:** a pixel where two or more vessels (or vessel segments) have a median. This is GMT x2sys's crossover idea on a grid, without interpolating along tracks, so it runs as two group-bys. Outside the scored area, 1.6M pixels are shared, giving 5.3M vessel-pixel rows.
- **Crossover solve:** least squares on `depth = pixel depth + vessel offset`, with pixel depths eliminated, anchored vessels fixed at their BlueTopo offsets, and Huber weights by iteratively reweighted least squares. That leaves one equation per vessel, and the solve converges in 9–10 iterations. Held-out vessels are tested in 5 folds: each fold's vessels are solved from crossings alone while the other 80% are anchored.
- **Steps:** each vessel's per-transit offsets in time order, split by binary segmentation where the medians either side differ by more than 0.3 m and more than four standard errors, with at least 5 transits each side.
- **Scoring:** Thimble Shoal Channel's east half (−76.175 to −76.14, 36.975 to 37.0), with [surface-statistic.md](surface-statistic.md)'s surface, σ and scores. Every offset in the scoring is learned with the east half left out.

## 1. Calibration against BlueTopo

| Measure                                               |                 Value |
| ----------------------------------------------------- | --------------------: |
| Calibrated vessels                                    |            234 of 303 |
| Offset, 10th / 50th / 90th percentile                 | −3.36 / −0.58 / +0.04 |
| Offset range                                          |         −8.95 to +1.1 |
| Vessels reading over 1 m shallow / over 3 m shallow   |               80 / 26 |
| Spread within a vessel, robust σ, 10th / 50th / 90th  |    0.17 / 0.31 / 0.61 |
| Standard error of an offset, median / 90th percentile |           0.07 / 0.19 |

**Flat seabed matters.** Where BlueTopo varies by less than 0.2 m within ±20 m, raw differences, offsets included, spread 0.92 m (1.4826 × their median absolute value). Between 0.2 and 0.5 m they spread 2.67 m. Everything steeper is left out.

**Depth scale is not worth fitting yet.** Fitting `depth = a + b × BlueTopo` on the 219 vessels whose calibration spans at least 5 m of depth gives b from 0.943 to 1.022 (median 0.984), and 39% of vessels differ from 1 by more than 3%. But it only narrows the within-vessel spread from 0.318 to 0.293 m, and it does nothing for the channel residuals below. At 2–20 m, sound speed error is smaller than the tide.

### Stability

A vessel's offset from one group of its soundings, against its offset from all its other soundings:

| Split                          | Vessels | Groups | Median difference | 90th percentile | Over 0.3 m |
| ------------------------------ | ------: | -----: | ----------------: | --------------: | ---------: |
| Upper, middle, lower bay       |     145 |    394 |              0.16 |            0.47 |        24% |
| 0.25° cells                    |     199 |  2,267 |              0.18 |            0.59 |        28% |
| Calendar year                  |      73 |    186 |              0.18 |            0.94 |        27% |
| Depth under 5, 5–10, over 10 m |     204 |    556 |              0.14 |            0.45 |        23% |

Across space and depth the offset holds to about 0.15 m, and the tail is the steps below plus tide. Across years the tail is much longer (0.94 m at the 90th percentile), and that is where steps show up.

**Steps.** Of 146 vessels with at least 10 calibrated transits, 36 have at least one step, 62 steps in all, with sizes 0.74 m (median), 2.58 m (90th percentile) and 5.17 m (largest). Splitting at them shrinks a vessel's spread of per-transit offsets, from 1.96 to 0.44 m for the worst one. Vessels without steps have a per-transit spread of 0.26 m (median) and 0.50 m (90th percentile). The CSB CSVs carry no sounder metadata, so a step can't be confirmed as a sounder change. Some vessels step several times in a few days, which looks more like a configuration being changed than new hardware.

**Tide is most of what's left.** Nothing here is tide-reduced. Subtracting the hourly water level at the nearest of Sewells Point or Annapolis, with no zone offsets, cuts the spread of per-transit offsets from 0.31 to 0.23 m (median over 132 vessels) and from 0.67 to 0.47 m (90th percentile), and the within-vessel σ from 0.33 to 0.27 m. Tide reduction belongs before calibration, not after it.

## 2. Calibration from crossings

| Anchors                                      | Held-out error, median | 90th percentile |
| -------------------------------------------- | ---------------------: | --------------: |
| 80% of calibrated vessels, constant offsets  |                   0.09 |            0.31 |
| 80% of calibrated segments, offsets per step |                   0.09 |            0.32 |
| 30 vessels                                   |                   0.13 |            0.41 |
| 10 vessels                                   |                   0.14 |            0.44 |
| 3 vessels                                    |                   0.13 |            0.45 |
| 1 vessel                                     |                   0.27 |            1.02 |

Error is the crossover offset minus the vessel's own BlueTopo offset, which carries its own 0.07 m standard error. Bias is −0.02 m. 296 of the 303 vessels share a pixel with another vessel outside the scored area, and every one of those links to a calibrated vessel through crossings, so the 62 of them that BlueTopo can't calibrate all get a crossover offset.

The network matters more than the anchors. A handful of anchors does nearly as well as 187, because the crossings tie everything together: 226 of 234 held-out vessels cross 30 or more others. One anchor is too few, because every other offset then inherits its error.

**Crossings needed.** With every other vessel anchored, a vessel's offset is estimated from k randomly chosen transits that cross calibrated vessels. A crossing transit shares a median of 341 pixels with others.

| Crossing transits | Error, median | 90th percentile | Within 0.3 m |
| ----------------: | ------------: | --------------: | -----------: |
|                 1 |          0.21 |            0.75 |          65% |
|                 2 |          0.17 |            0.60 |          73% |
|                 3 |          0.13 |            0.50 |          79% |
|                 5 |          0.12 |            0.43 |          82% |
|                10 |          0.09 |            0.33 |          88% |
|                20 |          0.08 |            0.26 |          92% |
|                50 |          0.08 |            0.23 |          95% |

The count that matters is transits, not pixels. Pixels along one transit share that transit's tide and squat, so a thousand pixels from one pass are worth about one pass. Five crossing transits give an offset good to about ±0.4 m, and ten to about ±0.3 m. In the Chesapeake, the median vessel has 21 crossing transits and the 10th percentile has 3.

## 3. Effect on the grid

Thimble Shoal Channel's east half, scored as in [surface-statistic.md](surface-statistic.md). Bias is the estimate minus BlueTopo; negative means shoaler.

| Offsets, learned outside the east half | Statistic                |  Bias | Channel bias | Median abs. error | 90th pct. abs. error | Deeper than shoalest cell by > 1 m | Channel false shoals > 2 m |
| -------------------------------------- | ------------------------ | ----: | -----------: | ----------------: | -------------------: | ---------------------------------: | -------------------------: |
| None                                   | Current                  | −3.61 |        −9.29 |              3.61 |                 7.35 |                                 0% |                       100% |
| None                                   | Median − 1.645σ          | −5.12 |        −6.74 |              5.12 |                 8.35 |                                 0% |                       100% |
| BlueTopo, constant per vessel          | Median of vessel medians | −0.16 |        −0.42 |              0.31 |                 1.20 |                               7.9% |                         6% |
| BlueTopo, constant per vessel          | Median − 1.645σ          | −1.09 |        −1.86 |              1.12 |                 2.60 |                               2.1% |                        45% |
| **BlueTopo, per step segment**         | Median of vessel medians | −0.09 |        −0.40 |              0.24 |                 0.66 |                               2.3% |                         8% |
| **BlueTopo, per step segment**         | **Median − 1.645σ**      | −0.89 |        −1.65 |              0.89 |                 2.12 |                             **0%** |                        40% |
| Crossings only, constant per vessel    | Median − 1.645σ          | −1.33 |        −2.31 |              1.40 |                 3.30 |                               3.6% |                        66% |
| **Crossings only, per step segment**   | **Median − 1.645σ**      | −1.03 |        −2.37 |              1.03 |                 2.73 |                           **0.1%** |                        65% |
| BlueTopo, per step segment             | Current                  | −0.35 |        −5.03 |              0.42 |                 4.64 |                               1.0% |                        87% |

"Crossings only" gives each vessel the offset it got while held out of the anchors, so no vessel's own BlueTopo calibration is used for it.

- **Steps carry the result.** With one offset per vessel learned across the bay, residual vessel offsets in the east half run −0.64 to +0.23 m (10th to 90th percentile), and 2.1% of pixels are too deep. With an offset per step segment they run −0.50 to +0.19 m, and none are. [surface-statistic.md](surface-statistic.md)'s 0.6% came from offsets learned in the same channel, which absorb local effects as well as each vessel's.
- **Crossings alone are close behind.** The safe surface is too deep by more than 1 m in 0.1% of pixels, but the channel is drawn 0.7 m shoaler than with BlueTopo segments, because errors in held-out offsets spread into σ.
- **One vessel can't be calibrated away.** An articulated tug-barge reads within 0.3 m of BlueTopo at every depth across the bay, and in the channel in 2021, but 4.5–5.2 m shallow in the channel on four passes in 2023–2024. Its step segment doesn't change there. Either the channel was shallower then (it has been deepened in recent years, and BlueTopo shows it after), or its position is off on the channel's side slopes. Calibration can't tell these apart, and that vessel alone sets the channel bias of the median statistic.

## 4. Cost at planet scale

The work splits into a per-tile part, which carries all the soundings, and a global part with one unknown per vessel segment.

- **Per 1° tile:** read accepted soundings, reduce them to vessel-pixel medians, keep shared pixels, and add the tile's terms to the vessel equations. On the densest Chesapeake tile (26.0M soundings, 182 vessels, 0.93M shared vessel-pixel rows) this takes 4.7 s with a peak of 1.27 GB under a 1.5 GB DuckDB limit; most of it is reading and reducing. A tile of 7.8M soundings takes 3.0 s at 1.05 GB.
- **Whole bay:** reducing 79M accepted soundings to 16.7M vessel-transit-pixel rows takes 5.6 s, and finding crossings 2.6–4.9 s. In one process, each iteration of the crossover solve takes about 1.5 s, but all 5.3M rows in memory peak at 2.2–3.2 GB. At planet scale the rows stay in their tiles.
- **Global solve:** the vessel equations are sparse. A synthetic system of 100,000 vessel segments, each crossing 100 others, with 10% anchored, solves by conjugate gradients in 0.53 s at 1.35 GB; 20,000 segments take 0.07 s. Each reweighting iteration is one pass over the tiles and one global solve, and the Chesapeake needs about 10 of them.
- **BlueTopo:** sampling 603 tiles (3.6 GB) at 5.9M pixels takes 3 min 16 s on one core. Only tiles that hold soundings are needed, and the samples can be kept per pixel and refreshed when BlueTopo is.

At the 2B soundings assumed in [rebuild-cost.md](rebuild-cost.md), crossover detection and terms are about 25 times the bay, a few minutes per pass, and ten passes stay well under an hour of worker time. That is small next to the grid rebuild. A calibration change dirties every tile a segment touched, so a daily run should re-solve and republish only offsets that moved by more than their standard error.

## Recommendation

1. **Key offsets by vessel and step segment.** Run step detection on per-transit offsets against BlueTopo or crossings, and give each segment its own offset and standard error. One constant per vessel leaves 2.1% of channel pixels drawn more than 1 m too deep; per segment leaves none.
2. **Solve BlueTopo and crossings together.** Use BlueTopo, S-102 and Seascape's surveyed sources as anchors where a segment has at least 50 flat-seabed pixels across 2 transits, and solve every segment's offset at shared pixels. Weight anchors by their standard error rather than fixing them, so one bad anchor can't pull its neighbors.
3. **Require five crossing transits** before treating a crossover offset as calibrated, about ±0.4 m. Below that, publish the offset with its uncertainty and weight the segment low, as the plan does for uncalibrated vessels.
4. **Reduce tide before calibrating.** It is most of the remaining per-transit spread, and it would tighten both the offsets and the step detection.
5. **Offset only, no scale factor,** until deeper water is in the set. Scale fits barely help at 2–20 m.
6. **Feed calibration residuals into σ.** Each segment's standard error and spread are the per-vessel uncertainty the backlog's "Better σ" item needs.

## Not measured

- **Sparse areas and rocky bottom.** The Chesapeake is soft and dense. With few crossings or one vessel per area the network is thin, and on rock, position error matters more than here.
- **Outside BlueTopo.** Every held-out vessel here sailed in BlueTopo waters, where the anchors were dense. A crossover network with anchors only at its edges, as in most of the world, was not tested beyond the few-anchors runs above.
- **Tide-reduced calibration.** Only the effect on spread was measured, with a crude nearest-gauge correction.
- **Track-intersection crossovers.** Crossings are shared 2/3″ pixels, not x2sys's interpolated intersections, so position error on slopes is noise the robust weights absorb. Coarser or finer pixels were not compared.
- **Squat and loading.** Large vessels' draft changes with speed and cargo. Per-transit offsets carry this as noise, and nothing here separates it.
- **Open Waters soundings.** The set is NOAA CSB CSVs only.
- **Cost on R2 and cheap x86 cores.** All timings are on a shared M-series laptop reading local Parquet. The global solve's timing is synthetic.
