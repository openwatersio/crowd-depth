# Water level beyond the tide

Tide predictions miss two things: a slow part, which is sea level sitting above the datum epoch the predictions were made for plus seasonal and year-to-year swings, and a fast part, which is the weather. In the Chesapeake the slow part is the larger error. Reducing soundings by predicted tide alone leaves per-vessel offsets 0.17 m off, and that bias is nearly constant across vessels. A residual from one open-coast gauge 80 to 350 km away removes most of the bias. The fast part needs a gauge in the same water body, within about 100 km. Past that distance, a distant gauge's hourly residual can do worse than none.

So the layering is predicted tide, plus a slow residual from the nearest usable gauge within a few hundred km, plus a fast residual only from a gauge close by. A model's surge comes in only where it has been checked against gauges. Of the global sources, UHSLC's fast-delivery gauges fit a daily pipeline and an openly licensed grid. Copernicus Marine's hourly sea level fits a daily pipeline too, but its commercial terms are still to be confirmed, so it counts as provisional for the published grid. IOC's monitoring facility doesn't, because it bars commercial use. GTSM's reanalysis is openly licensed but ends in 2024.

Measured in October 2026 on the Chesapeake set. The comparison's code isn't checked in. GTSM and Copernicus Marine were not compared against gauges, because both need an account.

## Sources

| Source                                                                                                                                      | What it gives                                                                                                  | Interval             | Coverage                                    | Latency                        | Licence                                                                                    | Daily pipeline                |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------- |
| [NOAA CO-OPS](https://tidesandcurrents.noaa.gov/disclaimers.html)                                                                           | Observed and predicted water level                                                                             | 6 min                | About 300 US gauges                         | Minutes                        | Public domain, attribution asked                                                           | Yes, used today               |
| [UHSLC fast delivery](https://uhslc.soest.hawaii.edu/erddap/info/global_hourly_fast/index.html)                                             | Observed sea level, research-quality history with fast delivery appended                                       | Hourly, daily        | 326 gauges                                  | 4 to 6 weeks                   | "May be used and redistributed for free"; South African Navy stations need permission      | Yes, with the lag             |
| [IOC SLSMF](https://www.ioc-sealevelmonitoring.org/disclaimer.php)                                                                          | Raw real-time sea level                                                                                        | Mostly 1 min         | 1,339 stations listed                       | Minutes                        | "May not be used for any commercial purposes"; not quality-controlled                      | No: licence                   |
| [GESLA-4](https://gesla787883612.wordpress.com/license/)                                                                                    | Archive of high-frequency gauge records                                                                        | Sub-hourly to hourly | 6,474 records (4.0)                         | Yearly releases                | Per contributor, some non-commercial                                                       | No: archive, mixed licences   |
| [PSMSL](https://psmsl.org/data/obtaining/)                                                                                                  | Mean sea level                                                                                                 | Monthly, annual      | Global                                      | About a year                   | Citation asked                                                                             | Slow part only, late          |
| [GTSM reanalysis](https://cds.climate.copernicus.eu/datasets/sis-water-level-change-timeseries-cmip6)                                       | Modelled tide, surge and total water level, forced by ERA5                                                     | 10 min, hourly       | Coastal points every 0.1°, coarser offshore | Ends 2024, no updates expected | CC BY 4.0                                                                                  | No: backfill before 2025 only |
| [Copernicus Marine global analysis and forecast](https://data.marine.copernicus.eu/product/GLOBAL_ANALYSISFORECAST_PHY_001_024/description) | `merged-sl`: total sea level as ocean tide, inverse barometer and sea surface height, each a separate variable | Hourly               | 1/12° global                                | Daily, with a 10-day forecast  | Free; derived products credit "Generated using E.U. Copernicus Marine Service Information" | Yes, not yet validated        |

- **CO-OPS and UHSLC** serve over plain HTTP with no account: CO-OPS through its data API, UHSLC through ERDDAP. Neither states a rate limit.
- **GTSM** comes only from the Climate Data Store, which needs a free account and `cdsapi`. Its Zenodo record holds statistics, not time series. Deltares runs GTSM operationally as GLOSSIS; access and licence for that are not verified.
- **Copernicus Marine**'s standard `zos` leaves the tide out. Inverse barometer plus sea surface height from `merged-sl` is a modelled non-tidal residual, so no second tide model is needed. Access is through the `copernicusmarine` toolbox with a free account. The product keeps a sliding two-year window, so older soundings need the multi-year reanalysis, which has daily means only. The licence text wasn't reachable on its primary page, and its commercial terms are unverified.
- **IOC** has the densest real-time network, but its disclaimer rules it out for a grid published CC BY 4.0 that others may use commercially. Many IOC stations are national gauges whose operators publish them under their own terms. Baltimore and Cambridge are CO-OPS gauges, for example. Those can be taken from the operator instead.
- **Near the Chesapeake**, UHSLC has two gauges: Duck Pier, outside the bay mouth, and Atlantic City.

## Method

- **Gauges:** the 6-minute observed-minus-predicted residuals `grid tide` keeps from CO-OPS, averaged to the hour, at 19 gauges in and around the bay, 2016 to 2026.
- **Soundings:** each vessel's median tide-reduced depth per transit and 2/3″ pixel at BlueTopo anchor pixels, as `grid calibrate` takes them (see [vessel-calibration.md](vessel-calibration.md)), in −77.5 to −75.5, 36.6 to 39.7. Only rows whose station has a CO-OPS gauge and whose half hour has a residual are kept, so every variant is scored on the same 7.1M rows: 9,750 transits in 295 vessel segments.
- **Variants:** the stored level is Slackwater's prediction plus the CO-OPS gauge's residual. Each variant adds that residual back and subtracts another one in its place:
  - predicted tide only;
  - the local CO-OPS gauge's residual, as built;
  - Duck Pier's hourly residual for the whole bay, which stands in for a sparse global network;
  - Duck's monthly mean residual;
  - Duck's mean residual over its whole record;
  - the local gauge's monthly mean, which is its slow part without the weather.
- **Scores:** each transit's offset is its median difference from BlueTopo, grouped by the step segments the store's calibration found. Spread is 1.4826 × the median absolute deviation of a segment's per-transit offsets, over the 203 segments with at least 5 transits. Bias is each segment's median offset minus its median with the local gauge.

## Residuals between gauges

At a single gauge the residual's standard deviation is 0.15 to 0.20 m. Using another gauge's residual in its place leaves this error, by distance between the two:

| Distance   | Pairs |  RMS | Mean bias |
| ---------- | ----: | ---: | --------: |
| 0–25 km    |     3 | 0.04 |      0.01 |
| 25–50 km   |    16 | 0.05 |      0.03 |
| 50–100 km  |    40 | 0.08 |      0.02 |
| 100–150 km |    43 | 0.11 |      0.02 |
| 150–250 km |    57 | 0.15 |      0.03 |
| 250–400 km |    12 | 0.20 |      0.02 |

Error grows by about 0.06 m per 100 km. Past about 200 km a borrowed residual is no better than none, though its mean is still right.

Direction matters as much as distance. Duck Pier, on the open coast, matches the lower bay's gauges to 0.06–0.08 m out to 130 km: Sewells Point, Money Point, Kiptopeke, the Bay Bridge-Tunnel and Yorktown. It misses the upper bay's by 0.19–0.22 m: Annapolis, Tolchester Beach, Baltimore and Washington. That is more than those gauges' own residual of 0.17–0.19 m. Wind sets water up and down the bay's axis, which a gauge outside the bay doesn't see.

## Effect on calibration

| Water level                            | Per-transit spread, median | 90th percentile |  Pooled σ | Offset bias, median | Absolute bias, 90th percentile |
| -------------------------------------- | -------------------------: | --------------: | --------: | ------------------: | -----------------------------: |
| Predicted tide only                    |                      0.205 |           0.436 |     0.241 |              +0.172 |                          0.303 |
| Predicted + Duck's record mean         |                      0.205 |           0.436 |     0.241 |              +0.020 |                          0.169 |
| Predicted + Duck's monthly mean        |                      0.189 |           0.437 |     0.233 |              +0.011 |                          0.147 |
| Predicted + local gauge's monthly mean |                      0.198 |           0.443 |     0.232 |              −0.010 |                          0.134 |
| Predicted + Duck's hourly residual     |                      0.197 |           0.437 |     0.215 |              +0.025 |                          0.120 |
| **Predicted + local CO-OPS gauge**     |                  **0.161** |       **0.379** | **0.189** |                   0 |                              0 |

Pooled σ is the robust spread of every transit's offset around its segment's median.

- **The bias is sea level, not weather.** At the gauges the soundings used, the mean residual was under 0.1 m in 2002–2004, 0.14–0.17 m in 2016–2019, 0.06–0.12 m in 2020–2022 and 0.20–0.21 m in 2023–2024. That fits relative sea level rise since the 1983–2001 tidal datum epoch, with year-to-year swings on top. Predictions don't carry it, so with predicted tide alone it goes into every vessel's offset. A single constant from Duck, 80–350 km away, removes nearly nine-tenths of it.
- **The weather is most of the spread.** The local gauge narrows the per-transit spread from 0.205 to 0.161 m, a fifth of it. Its monthly mean alone barely narrows it (0.198), so the gain is in hours to days. Duck's hourly residual gets half of the local gauge's gain in pooled σ, but almost none of it for the median segment. The gain is mostly in the lower bay.
- **What's left is the vessel.** 0.16 m of per-transit spread remains with the local gauge, which is squat, loading, sounder noise and the tide prediction's own error. More water level data won't remove it.

Every row here is in reach of a CO-OPS gauge, with the station a median of 11 km from it (90th percentile 27 km). Only 0.2% of rows are more than 50 km away, so the local gauge's score is a near-gauge score.

## Recommendation

Reduce each sounding by three layers, each with its own uncertainty, and record which applied.

1. **Predicted tide**, from Slackwater as now. On its own it should carry σ of 0.20 m for weather in an estuary, and it shouldn't be trusted for the mean: where no residual applies at all, the 0.1–0.2 m of sea level since the datum epoch reads every depth that much too deep.
2. **Slow residual:** the 30-day mean of observed minus predicted, from the nearest gauge within 300 km, CO-OPS or UHSLC fast delivery. CO-OPS publishes both halves on one datum. UHSLC publishes observed sea level only, on its own station zero, so its residual is the observation minus Slackwater's prediction at the same gauge, less the mean of that difference over the years the station's constants were fitted from. That ties the residual to the prediction's own mean sea level and keeps the sea level since then. It needs a Slackwater station at or next to each UHSLC gauge, and until it is checked against a CO-OPS gauge that UHSLC also carries, UHSLC residuals aren't interchangeable with CO-OPS ones. This is the largest correction outside the US and the cheapest. One gauge covers a region, UHSLC's 4–6 week lag doesn't matter for a monthly mean, and until a month arrives the previous year's same month plus the trend will do. Where no gauge reaches, Copernicus Marine's sea surface height carries the slow part too, once it is checked against gauges. Carry the slow residual's own error at about 0.03 m.
3. **Fast residual:** the hourly residual minus its 30-day mean, from a gauge within 100 km that reads the same water as the sounding. A straight line through the gauge-pair table gives its σ as 0.03 + 0.0006 × distance in km: about 0.05 m at 25 km, 0.09 m at 100 km. Two gauges either side of a sounding can be blended by distance, as TCARI does. A gauge in another water body, such as an open-coast gauge for the upper Chesapeake, is skipped: judge this by the RMS between its residual and the nearest gauges' where they overlap, and use it only where that is under 0.10 m.
4. **Modelled surge** where no gauge reaches, from Copernicus Marine's inverse barometer plus sea surface height, only after it beats the slow-residual-only layer against held-out gauges. GTSM's reanalysis can backfill soundings before 2025 if it passes the same test. Until a model is tested, those soundings keep the slow residual and σ of 0.20 m for weather.

`grid tide` gives a level with a gauge's residual σ of √(0.10² + (0.002 × gauge distance in km)²), and a predicted level 0.25 m. A sounding's tide σ then adds 0.005 m per km of its distance from the station, in quadrature. Next to a gauge that is 0.10 m where the gauge pairs measure 0.04 m, and without a gauge it treats the 0.17 m bias as noise rather than removing it. Splitting the residual into slow and fast parts lets the bias be removed where any gauge reaches, and keeps the weather's error honest where none does.

Leave IOC SLSMF and GESLA out of the published grid, because of their licences. IOC's real-time feed can still help in QC, flagging storm days, since nothing derived from it would be published.

## Not measured

- **GTSM and Copernicus Marine against gauges.** Both need an account. The next spike is to fetch GTSM's 10-minute surge for 2016–2024 and `merged-sl` for 2024–2026 at points near the bay's gauges, and score them as the gauge pairs are scored above, by distance from the model's nearest output point.
- **Far from any gauge.** Every scored row has a CO-OPS gauge within 50 km. Anchor rows far from a gauge, where a model would matter most, aren't in the Chesapeake.
- **The slow residual outside the US.** TICON-4's constants come from GESLA records with their own epochs, so the bias there could be larger or smaller than the Chesapeake's 0.17 m, and its sign depends on whether the land is rising or sinking.
- **UHSLC residuals.** The datum tie in layer 2 wasn't built or tested. Duck Pier's residual here is CO-OPS', not UHSLC's.
- **Prediction error.** CO-OPS residuals are measured against CO-OPS' own predictions, and they are added to Slackwater's. Where the two predictors differ, the difference stays in the level.
- **Crossover calibration.** Only anchor offsets against BlueTopo were scored. Crossings share each transit's water level error the same way, so they should tighten the same way.
