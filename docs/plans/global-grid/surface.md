# Depth surface

The overlay draws depth areas and contours from a continuous depth surface interpolated between nearby tracks, the way Navionics SonarChart Live renders its users' soundings, instead of from the grid cells one by one. The surface is a raster, the same artifact Seascape's remove-restore merge will take in, so building it is the first step toward merging crowd soundings into the existing depth surface.

Soundings stay what they are: measured depths at measured positions. Only areas, contours and coverage come from the surface.

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

1. **Consensus QC.** In the cells build, each sounding is judged against the other vessels within about 270 m, each voting once with its median depth. A sounding far deeper than their consensus is rejected. One far shoaler is rejected when three or more of them agree, unless another vessel read the same depth, within 2 m + 5%, in the same block of about 90 m; otherwise it goes on to the cell's own shoal confirmation. Track QC rejects flatlines, a depth held unchanged over a kilometre. Where fewer than two other vessels sounded there's no consensus, and those cells keep their single-vessel marking. CUBE, which CHRT is built on, solves the same problem with competing depth hypotheses per node; it's the stronger option if this isn't enough, and the validation step decides.
2. **The surface's grid.** The same latitude and longitude grid as the cells, one 1° tile at a time: rows 2/3″ of latitude (about 20 m), columns widened by latitude band as the cells' are, so pixels stay roughly square and line up with the cells. Each tile is gridded in an equirectangular projection centred on it, a linear rescaling of latitude and longitude, so the search radius is in true metres (within about 3% across a tile) while the pixels stay on the latitude and longitude grid. It has no seams between zones and nothing cut off near the poles, as GEBCO, ETOPO and NOAA's CUDEM publish. Web Mercator comes only at the tiling step, and Seascape reprojects the surface into its mosaic like any other source.
3. **Surface input.** Per surface pixel, from the soundings QC accepted: the 10th percentile, as cells take it, at the pixel's centre, to interpolate from; and the shoalest, which the pixel may never be deeper than. Accepted soundings include confirmed shoals, so a shoal confirmed among many deeper soundings still sets its pixel.
4. **Interpolation.** `gdal_grid invdistnn` with a 200 m radius, 3–12 points, at least one point per quadrant, so it interpolates between tracks and never extrapolates past their ends. The radius, power and quadrant rule are tuned by validation, starting from these.
5. **Smoothing and guards.** A light gaussian blur of a pixel's width, clamped so no pixel reads deeper than it was interpolated, then the shoal guard: no pixel deeper than the shoalest accepted sounding in it or a pixel next to it, so a shoal one pixel wide still covers its whole pixel in the areas. A pixel holding an unconfirmed shoal is left empty rather than drawing deeper water over it, as hole filling leaves that cell unfilled; only the 20 m pixel is empty, not the whole cell, and the shoal publishes as an unconfirmed sounding.
6. **Quality bands.** Per pixel, the distance to the nearest sounded pixel and the soundings in the pixel. A pixel more than a pixel from any sounding is interpolated. The bands are in the surface's GeoTIFF; the overlay doesn't yet mark interpolated areas. Coverage (`M_QUAL`) is where the surface has a depth or a sounding, grown by a pixel, so a lone track whose soundings the surface can't interpolate between still has coverage.
7. **Areas and contours.** `gdal_contour -p` on the surface, on Seascape's isobath ladder down to 200 m, as Seascape cuts its depth areas. Crowd soundings past 200 m are mostly sounders that have lost bottom, so deeper water shows soundings only, with no areas or contours, until consensus QC shows the deep data holds up.
8. **Output.** A cloud-optimized GeoTIFF per tile with depth and the quality bands, then the overlay layers from it and the soundings from the cells. The whole tile is interpolated, but only the 512-pixel blocks with a sounding within the search radius are blurred, guarded, measured and written. The rest are left out of the file and read as no data in every band, the soundings count included. The overlay still reads and polygonizes the whole tile.

## Charting standards

S-4 B-418 charts water with only passage soundings as unsurveyed, not interpolated, and the guidance on depth areas prefers classifying cells into bands over contours traced between them, which can miss a shoal ([standards](standards.md)). The surface departs from both. It interpolates only between tracks that surround a pixel, never past them; no pixel is deeper than the shoalest accepted sounding inside it, so the areas keep every shoal the soundings caught; a pixel holding an unconfirmed shoal is left empty; and everything stays CATZOC D with the crowdsourced note.

## Validation

Leave one vessel out: grid without it, then measure the surface against its soundings. That gives the error by distance from the nearest other track, which sets the radius. Where NOAA has surveyed (it has in Lynn Canal), compare the surface to the survey too, as the plan's validation phase describes.

## Tooling and budgets

The grid image is the official GDAL image, pinned to a release tag, with tippecanoe and uv added, so tests and builds have `gdal_grid` and `gdal_contour`. A 1° tile is 5,400 rows by at most 5,400 columns, fewer at higher latitude: at most 117 MB per float band. A tile is the unit of work, and its soundings are aggregated to one row per pixel in DuckDB before anything is held in Python or handed to `gdal_grid`, so its memory is bounded by its pixels whatever the data looks like: about 2 GB of rasters, outside DuckDB's limit, for a fully covered tile at the equator. Of a neighboring tile, only the strip within the search radius is aggregated and kept, though the tiles east and west are still read whole. Consensus runs in the cells build, in its bounded units.
