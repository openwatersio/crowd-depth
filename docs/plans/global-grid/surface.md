# Depth surface

The overlay draws depth areas and contours from a continuous depth surface interpolated between nearby tracks, the way Navionics SonarChart Live renders its users' soundings, instead of from the grid cells one by one. The surface is a raster, the same artifact Seascape's remove-restore merge will take in, so building it is the first step toward merging crowd soundings into the existing depth surface.

Soundings come from the cells, at the positions of accepted soundings, and are never deeper than the vessels' median there. Only areas, contours and coverage come from the surface.

## What the prototype showed

The Lynn Canal tile (58–59°N, 135–136°W) from the sample store, gridded at 20 m in UTM with GDAL:

| Method                                                                  | Filled | Result                                                         |
| ----------------------------------------------------------------------- | -----: | -------------------------------------------------------------- |
| `invdistnn`, power 2, 200 m radius, 3–12 points (the earlier prototype) |    33% | Continuous between close tracks; rings around single soundings |
| The same, with a point required in every quadrant                       |    26% | Fills between tracks only, never past their ends               |
| `minimum` within 50 m                                                   |    22% | Shoalest per pixel; picks up every false shallow echo          |
| `linear` (Delaunay), 200 m beyond its triangles                         |    45% | Smoothest, but spans gaps no sounding supports                 |

Gridding takes seconds per tile; it isn't the cost. The data is:

- Neighboring cells within about 60 m disagree by 7% at the median, 4.6 times at the 90th percentile and 45 times at the 99th. In water deeper than about 200 m, many recreational sounders lose bottom and report echoes from the water column, half depths, or a fixed value.
- One track reads 400–1,000 m through water the other tracks put at 290 m; 93 cells read 900 m or more; a track elsewhere repeats 169 m. QC runs along each track, and a track that's wrong the whole way is consistent with itself, so nothing flags it.
- Single-vessel 3″ cells sit about 90 m apart along a track, and interpolating between them draws beads.

Any interpolator draws that noise faithfully, so the surface needs soundings checked against other tracks first.

## Pipeline

1. **Consensus QC.** In the cells build, each sounding is judged against the other vessels within about 270 m, each voting once with its median depth. A sounding far deeper than their consensus is rejected. One far shoaler is rejected when three or more of them agree, unless another vessel read the same depth, within 2 m + 5%, in the same block of about 90 m; otherwise it goes on to the cell's own shoal confirmation. Track QC rejects flatlines, a depth held unchanged over a kilometre. Where fewer than two other vessels sounded there's no consensus but a deep-side check against a lone other vessel, and those cells keep their single-vessel marking. CUBE, which CHRT is built on, solves the same problem with competing depth hypotheses per node; it's the stronger option if this isn't enough, and the validation step decides.
2. **The surface's grid.** The same latitude and longitude grid as the cells, one 1° tile at a time: rows 2/3″ of latitude (about 20 m), columns widened by latitude band as the cells' are, so pixels stay roughly square and line up with the cells. Each tile is gridded in an equirectangular projection centred on it, a linear rescaling of latitude and longitude, so the search radius is in true metres (within about 3% across a tile up to 70° of latitude, 5% at 80°) while the pixels stay on the latitude and longitude grid. It has no seams between zones and nothing cut off near the poles, as GEBCO, ETOPO and NOAA's CUDEM publish. Web Mercator comes only at the tiling step, and Seascape reprojects the surface into its mosaic like any other source.
3. **Surface input.** Per surface pixel, from the soundings QC accepted: each vessel's median depth and median correction σ there, one vote per vessel, smoothed along its own coverage over a pixel each way. The median of the votes, at the pixel's centre, is what's interpolated, and the votes give σ ([Cell statistics](README.md#cell-statistics)). Confirmed shoals come from the cells.
4. **Interpolation.** `gdal_grid invdistnn` with a 200 m radius, 3–12 points, at least one point per quadrant, so it interpolates between tracks and never extrapolates past their ends, and 40 m of smoothing, so a sounded pixel doesn't keep its own value whole. The radius, power and quadrant rule are tuned by validation, starting from these. A pixel it leaves empty within 40 m of a sounded pixel, centre to centre, takes the shoalest pixel median within that reach instead, without the quadrant rule, so a lone track draws a band one or two pixels either side and the surface stops within 40 m past a track's end ([Lone tracks](#lone-tracks)).
5. **Smoothing, margin and guards.** A gaussian blur over 2 pixels, clamped so no pixel reads deeper than it was interpolated, and so the band never makes an interpolated pixel deeper than the interpolation alone draws it; then k × σ off, with σ from the nearest sounded pixel, widened by the distance band; then no pixel deeper than a confirmed shoal in it or a pixel next to it (one the other vessels haven't outvoted), so a confirmed shoal one pixel wide still covers its whole pixel in the areas. Unconfirmed shoals QC judged improbable against their context don't vote, and the surface is drawn over them from the other votes; each publishes as an unconfirmed sounding. An unjudged cell shoal, in a cell with no accepted median, votes. A pixel the surface leaves empty, more than 40 m from every vote, stays empty even where it holds an accepted shoal, which then shows only as a sounding; where it's within a pixel of the surface, the areas grown past the surface reach it at no deeper than its shoal (step 7).
6. **Quality bands.** Per pixel, the distance to the nearest sounded pixel, the soundings in the pixel, and σ. A pixel more than a pixel from any sounding is interpolated. Coverage (`M_QUAL`) is where the surface has a depth or a sounding, grown by a pixel and traced as the areas' edge is (step 7), so a sounding the surface doesn't reach still has coverage. Coverage splits into measured and interpolated parts, and beside a lone track it is all interpolated ([Lone tracks](#lone-tracks)).
7. **Areas and contours.** `gdal_contour -p` on the surface, on Seascape's isobath ladder down to 200 m, as Seascape cuts its depth areas. The surface's edge, where it meets empty water, is traced with [Potrace](https://potrace.sourceforge.net/) (GPL-2.0-or-later, run as its own command) as curves rather than 20 m steps: the surface is grown a pixel all round, holes of up to four pixels and notches up to two pixels wide are filled, every corner is rounded to half a pixel's radius, and each curve keeps points within a tenth of a pixel of it. The surface's depths are carried two pixels past its edge, each empty pixel taking its nearest pixel's depth but never deeper than a published sounding in it or next to it, in this tile or the next, as the surface's own guard does, so `gdal_contour` reaches the traced edge, and the bands are cut to it. The growth is measured beside a sounding and interpolated elsewhere, and interpolated water is drawn a pixel into the measured, so a strip of it a pixel wide is never lost; its uncertainty is the largest over the surface's pixels it's drawn over or beside. Coverage is the same edge, joined by the soundings off the surface, each grown a pixel and traced on its own, so every sounding's pixel is inside it. The edge meets a tile's edge square, and gaps are filled only within a tile, so it can step where it crosses into the next. Crowd soundings past 200 m are mostly sounders that have lost bottom, so deeper water shows soundings only, with no areas or contours, until consensus QC shows the deep data holds up.
8. **Output.** A cloud-optimized GeoTIFF per tile with depth and the quality bands, then the overlay layers from it and the soundings from the cells. Only the extent of the 512-pixel blocks with a sounding within the search radius is interpolated, and only those blocks are blurred, guarded, measured and written. The rest are left out of the file and read as no data in every band, the soundings count included. The overlay cuts depth areas, contours and coverage on the window the tile's depths and soundings reach, 16 pixels past them.

## Charting standards

S-4 B-418 charts water with only passage soundings as unsurveyed, not interpolated, and the guidance on depth areas prefers classifying cells into bands over contours traced between them, which can miss a shoal ([standards](standards.md)). The surface departs from both. It interpolates only between tracks that surround a pixel, and reaches 40 m past them, never deeper than the shoalest pixel median within that reach, though a shoal that publishes without voting can sit in a deeper area there ([Lone tracks](#lone-tracks)); no pixel is deeper than a confirmed shoal inside it, so the areas keep every confirmed shoal wherever the surface reaches, and every pixel is shoal-biased by k × σ; unconfirmed shoals publish as soundings without affecting the surface; and everything stays CATZOC D with the crowdsourced note.

## Lone tracks

The quadrant rule draws nothing under a lone track, whose pixels have soundings only ahead and behind, and nothing between tracks more than about 200 m apart. Off Rock Hall in the upper bay, 26 of the 60 soundings in one z12 tile sat on blank water. So a pixel interpolation leaves empty within 40 m of a sounded pixel, centre to centre, takes the shoalest pixel median within that reach, then the same blur, margin and guards. It never deepens a pixel interpolation drew, and a pixel it fills is never deeper than the shoalest pixel median within 40 m of it.

The reach is measured by drawing each vessel's band alone and scoring it against other vessels' medians in pixels it never sounded, on the Rock Hall (46543) and Annapolis (46183) tiles. Too deep is more than 1 m deeper than the other vessel read, after the margin's distance and correction terms (its spread left out, so this is an upper bound):

| From the track | Rock Hall too deep | Annapolis too deep |
| -------------- | -----------------: | -----------------: |
| Same pixel     |               0.7% |               0.8% |
| Up to 20 m     |               1.0% |               1.3% |
| 20–30 m        |               1.6% |               2.2% |
| 30–40 m        |               2.3% |               2.3% |
| 40–50 m        |               2.9% |               3.2% |
| 50–60 m        |               3.8% |               3.3% |
| 60–80 m        |               5.1% |               3.4% |

Past 40 m the rate passes three times the track's own. At 39°N a pixel is about 21 m by 16 m, so the band reaches a pixel north and south of a track and two east and west, and draws about 120 m wide once the overlay grows the surface's edge.

Rebuilt on the Chesapeake store from the first R2 publish (soundings to 200 m, in the box from 77.5°W 36.8°N to 75.5°W 39.7°N, at z12):

|                                                     |   Before |   After |
| --------------------------------------------------- | -------: | ------: |
| Soundings in no depth area                          |    21.7% |    1.2% |
| Off Rock Hall, z12 tile 12/1179/1562                | 26 of 60 | 0 of 61 |
| Depth areas, km²                                    |    4,215 |   5,161 |
| Of them 0–2 m                                       |       44 |      89 |
| Contours, km                                        |    9,411 |  10,129 |
| Prime soundings                                     |    3,462 |   2,891 |
| Accepted soundings in an area deeper than they read |    1,134 |   1,421 |

- Across all 206 tiles, no surface pixel that had a depth got deeper. On Rock Hall's tile, 18% of them got shoaler where the band's blur reached them, by 0.08 m at the 1st percentile. The surface gained 16.7M pixels, and none of them is farther than 38 m from a vote.
- 2,649 soundings that were on blank water are now in an area no deeper than they read. 268 are in one deeper than they read, by 0.5 m at the median and more than 1 m for 86 of them. 148 of those were in a shallower area before: a hole in the surface, which the overlay's carried depths capped at the sounding, and which the band now fills from the votes around it. Many of these read 0 m, soundings after a sounder lost the bottom, which publish but never vote.
- Coverage beside a lone track is drawn as interpolated, track and all: the band reaches two pixels past the soundings, which is more than a pixel from them, and interpolated water is never drawn as measured, so the track's own strip a pixel wide between two of it isn't kept. In the bay, measured coverage goes from 2,298 to 1,733 km² and interpolated from 2,229 to 3,410 km².
- Prime soundings fall because a shoal joined to the band's edge is no longer closed. Of the bay's primes, 1,080 were lost and 509 gained; the lost ones are 7.1 m deep at the median.
- Offshore, the depth areas grow from 3,800 to 10,300 km², mostly along transits.
- The 0 m band was drawn as drying wherever the margin held pixels at exactly 0 m and nothing read below: `gdal_contour` reads a value on a level as below it. The overlay now reads a depth on a level as in the band it starts, as `band` does. That took the bay's drying areas from 2.9 km² before and 21.5 km² with the band alone to 0.4 km².
- The surface stage took 16% longer over the whole region (5,362 s against 4,619 s on macOS, six jobs at a time), from a second blur and the band's minimum filter per block. Peak resident memory per job didn't grow at any density: 3.2 GB against 3.3 GB on the densest tile, by macOS ru_maxrss.

## Validation

Leave one vessel out: grid without it, then measure the surface against its soundings. That gives the error by distance from the nearest other track, which sets the radius. Where NOAA has surveyed (it has in Lynn Canal), compare the surface to the survey too, as the plan's validation phase describes.

## Tooling and budgets

The grid image is the official GDAL image, pinned to a release tag, with tippecanoe, Potrace and uv added, so tests and builds have `gdal_grid`, `gdal_contour` and `potrace`. A 1° tile is 5,400 rows by at most 5,400 columns, fewer at higher latitude: at most 117 MB per float band. A tile is the unit of work, and its soundings are aggregated to one row per pixel and vessel in DuckDB before anything is held in Python or handed to `gdal_grid`, so what Python holds is bounded by its pixels and the vessels in them: about 2 GB of rasters, outside DuckDB's limit, for a fully covered tile at the equator. σ's windows are worked about 2 million entries at a time, about 300 MB. The densest Chesapeake tile peaked at 3.8 GB. Of a neighboring tile, only the strip within the search radius is aggregated and kept, though the tiles east and west are still read whole. Consensus runs in the cells build, in its bounded units.
