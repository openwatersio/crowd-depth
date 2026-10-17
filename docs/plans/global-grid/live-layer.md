# Live layer

The crowd-depth plugin draws the boat's own soundings on the chart as they're recorded, on top of the global grid overlay. The live layer is the grid pipeline run on one vessel's soundings, incrementally: the same QC, corrections, statistic, interpolation and portrayal, from the same definitions. A depth the boat just measured looks the way the grid will publish it from the same soundings, only sooner, so where the two layers meet they agree.

Every number below comes from the grid's design and changes with it. This note covers only what's different about running that design live, on one boat.

## Shared definitions

The grid is Python and the plugin is TypeScript, so both read one set of definitions instead of porting by hand:

- **Constants as JSON:** QC thresholds, cell resolution, the statistic's k, the interpolation radius, band levels, contour tiers and sounding rounding, in one file under `packages/grid` that the plugin imports at build time.
- **Test vectors as JSON:** inputs and expected outputs for QC, the statistic, interpolation and rounding, run by both pytest and vitest. A change on either side fails the other's tests until both agree.
- **QC as pure functions:** the grid's track QC as plain loops, ported once to TypeScript and checked against the shared vectors ([qc-functions.md](qc-functions.md)).

When the grid changes a definition, the plugin picks it up on its next release, and its tiles are rebuilt from the plugin's sounding log, as they are for an offset change.

## Pipeline

### QC

[Track QC](README.md#2-quality-control) runs on the plugin's stream. Checks that look ahead along the track, such as the spike check's window, make the newest soundings provisional until the window fills. Provisional soundings draw as soundings with a provisional flag; only judged ones go into cells.

Cell QC runs across the boat's own passes, as the grid's does across vessels. Consensus QC needs other vessels, so on its own the plugin can't run it. Where the grid overlay covers the water, its published depth and σ stand in for the other vessels' vote.

Unconfirmed shoals are handled as in the grid: they publish as soundings with a low-reliability flag, and the surface is never drawn over them.

### Corrections

The plugin applies the grid's [corrections](README.md#3-corrections) in the same order:

- **Offsets:** the plugin's depth reference and transducer offsets.
- **Vessel calibration:** the vessel's own offset, scale and uncertainty, fetched from the grid's calibration ([Vessel calibration](README.md#vessel-calibration)). It needs the plugin's `SIGNALK-<uuid>` to match the vessel's `UNIQUE_ID` in the grid. A vessel without a calibration is marked uncalibrated, as the grid marks it.
- **Tide:** the water level at each sounding's own time and place, from the same Slackwater engine the grid uses, which the plugin reaches through signalk-tides. The correction is applied when cells are built, so the log keeps raw depths and a better prediction or observed level can be applied later.
- **Datum:** the grid's low-water chart datum, from the same separation source.

Each cell records which corrections it has, as in the grid. A cell without tide and datum isn't on the overlay's reference, and the layer says so.

### Cells and surface

Cells use the grid's [resolution](README.md#resolution) and [statistic](README.md#cell-statistics), with each transit standing in for a vessel: depth is the median of per-transit medians minus kσ, and σ is published. The surface follows the grid's [interpolation](README.md#interpolation): bounded, marked, with σ widening with distance from the nearest track.

The statistic needs the soundings, not a running minimum. Accepted soundings are kept indexed by grid cell in the plugin's SQLite database, and a cell's statistic is recomputed from its own soundings when a new one lands in it. Interpolated cells within the radius of a changed cell are recomputed with it. A cell holds few soundings, so this stays cheap on a Raspberry Pi. A month of one boat's soundings, about 2.6M, is roughly 50–100 MB.

### Portrayal

The live layer has the overlay's schema: S-57 `DEPARE`, `DEPCNT`, `SOUNDG` and `M_QUAL` vector tiles with `type=S-57`, built with the grid's band levels, contour tiers and rounding toward shoal. The plugin serves them through a Signal K chart resource, so the plotter applies its own S-52 styling, including the user's safety contour and depth units, to both layers the same way. The portrayal code shared with Seascape ([#146](https://github.com/openwatersio/crowd-depth/issues/146)) covers the live layer too.

The plotter extension draws only what tiles can't keep up with: the provisional soundings of the last few seconds under the bow, as sounding labels in the same style, until their tiles refresh.

## Phases

- [ ] Shared constants and test vectors, read by both the grid and the plugin.
- [ ] Track QC in the plugin, ported from the plain-loop functions and checked against the shared vectors.
- [ ] Accepted soundings stored by cell, with the grid's resolution, statistic and interpolation.
- [ ] Tide and datum through signalk-tides, applied per sounding time.
- [ ] S-57 vector tiles served as a chart resource, with the plotter extension drawing provisional soundings.
- [ ] Vessel calibration fetched from the grid, once the grid calibrates vessels.
- [ ] Cell QC against the overlay's depth and σ where the overlay covers the water.

## Open questions

- Whether Freeboard refreshes a vector chart resource's tiles often enough for a layer that changes every few seconds, or whether the plotter extension has to draw more than provisional soundings.
- What the layer shows where there's no tide station or datum separation: raw depths, flagged, or nothing on top of the overlay.
