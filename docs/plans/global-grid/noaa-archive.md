# The NOAA CSB archive

Crowdsourced bathymetry submitted to the IHO Data Centre for Digital Bathymetry (DCDB) is hosted by NOAA NCEI in a public S3 bucket. This note describes how the archive is laid out and the quirks the [global grid](README.md) pipeline has to handle. Facts marked "checked" were confirmed against the live archive on 2026-10-15.

## Layout

| Resource         | Location                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Point data (CSV) | `s3://noaa-dcdb-bathymetry-pds/csb/csv/YYYY/MM/DD/<name>_pointData.csv`, public, no credentials            |
| Bucket readme    | <https://noaa-dcdb-bathymetry-pds.s3.amazonaws.com/docs/readme.html>                                       |
| Track index      | <https://gis.ngdc.noaa.gov/arcgis/rest/services/csb/MapServer/1>: one simplified track line per submission |
| Data viewer      | <https://www.ncei.noaa.gov/maps/iho_dcdb/>                                                                 |

The bucket holds only CSV under `csb/csv/`. There is no Parquet or other columnar copy.

A submission's name in the track index maps to its CSV: the first eight digits of the name are the date folder, and the rest of the name before `.tar.gz` is the file stem. For example, index entry `20240615000711185286_0d1b6ce0-….tar.gz` is `csb/csv/2024/06/15/20240615000711185286_0d1b6ce0-…_pointData.csv`.

## Size

Checked through the track index's statistics query:

- 784,429 submissions from 2017-04-25 on, totaling 80 GB as submitted (compressed). The CSVs are roughly three times larger.
- 275,726 submissions and 25 GB arrived in the last year.
- One day's folder (2026-10-14) held 1,631 CSVs and 751 MB.

A build of Fiji read 28.4 million soundings from 1.15 GB of submissions, which puts the whole archive at roughly 2 billion soundings.

## CSV format

```
UNIQUE_ID,FILE_UUID,LON,LAT,DEPTH,TIME,PLATFORM_NAME,PROVIDER
```

- `UNIQUE_ID` identifies the vessel, and stays the same when the vessel's name is withheld. Checked: anonymous files carry ids such as `AQM-13564`, `AQM-Talonewo` and `ROSEP-672e2884-…`, and the same id repeats across a boat's files.
- `PLATFORM_NAME` is often `Anonymous` or `UNKNOWN`, so it can't identify a vessel.
- `PROVIDER` is the trusted node or logger maker, such as `Rosepoint`, `AquaMap`, `FarSounder` or `PGS`.
- `TIME` is ISO 8601 UTC. Most providers write whole seconds; FarSounder writes milliseconds. Checked: Signal K files keep the plugin's milliseconds, identical to the R2 copy.
- `DEPTH` is positive down in metres, written as a float32 value printed as float64 (for example `4.800000190734863`), so storing it as float32 loses nothing.
- Fields can be quoted, so the file must be parsed as RFC 4180 CSV, not split on commas.

## Quirks

The simplification, in-place changes, resubmissions and metadata API come from the DCDB's own description of the archive (Campbell and Cain, in [references](references.md#csb-data-sources)). The rest were found in the data.

- **Timestamps are not unique within a vessel.** Loggers faster than 1 Hz write several soundings in the same second. Checked: one Rosepoint file from 2024-06-15 has 148 colliding `(UNIQUE_ID, TIME)` pairs, and PGS and Aqua Map files have them too. The colliding rows are different soundings.
- **Missing-depth sentinels.** Some providers write `-1e9` for a missing depth, and PGS writes `0`.
- **Soundings are simplified.** The archive thins each track with Douglas-Peucker before publishing, so a NOAA file holds fewer points than were submitted.
- **Files change in place.** The DCDB replaces or removes CSVs when it reprocesses the archive (for example, with a new simplification tolerance) and when a coastal state changes its participation. A replacement can keep the same key, so ingest compares ETags as well as looking for new keys.
- **Identical resubmissions.** The same soundings can arrive twice under different file ids, seconds apart.
- **Date folders are processing dates.** A folder's date is when the file was processed, not when the soundings were collected. Files in one month's folder can hold soundings from earlier months or, rarely, years.
- **Index entries without a CSV.** Some track-index entries have no CSV in the bucket, mostly small fragments. Checked: 75 of 14,300 Fiji entries (0.5%); PR #127 reports about 7% in its regions.
- **Only IHO member waters.** NOAA does not publish soundings from the waters of states that are not IHO members. Open Waters holds plugin submissions from those waters in its own R2 bucket.
- **Metadata is elsewhere.** The CSV drops the CSB metadata (depth reference, sensor offsets, sounder). NOAA serves it through the CSB API, looked up by `FILE_UUID` plus `.tar.gz`.

## Open Waters submissions

The plugin submits CSB 3.1 GeoJSON to the trusted node API, which stores each submission in R2 under a date-based key (see [`packages/api/src/r2.ts`](../../../packages/api/src/r2.ts)) before forwarding it to NOAA. Each upload from the plugin is its own object, so a plugin retry, or history uploads whose windows overlap, store the same soundings in separate files. The API's own sweep resends an existing object and doesn't create a new one.

- `<key>.geojson` is the submission. `<key>.done.json` records NOAA's final response, and `<key>.failed.json` marks a retryable failure that the API's sweep resends. The API records any 4xx from NOAA as final, including authentication failures and throttling, so a `.done.json` with `success: false` doesn't mean the data was bad.
- The key is `YYYY/MM/DD/<time>-<uuid>`, where the uuid comes from the vessel's authenticated token. The API checks the vessel id in the submission's form metadata but stores the GeoJSON body unchecked, so the key, not the body, identifies the vessel.
- The code's history has submissions stored as `.json` and `.csv` before 2026-01-14, `.geojson` with no sidecar from then, NOAA's response in `.result.json` on 2026-07-29 and 2026-07-30, and `.done.json` and `.failed.json` after that. The bucket (`crowd-depth-injest`) holds no `.json`/`.csv` submissions, so ingest only reads `.geojson`.
- Checked, by listing the whole bucket on 2026-10-15 (13,725 objects, 10.1 GB):

  | Layout                                     | Stems | Key dates                | Notes                                                            |
  | ------------------------------------------ | ----- | ------------------------ | ---------------------------------------------------------------- |
  | `.geojson` alone                           | 8,628 | 2026-01-20 to 2026-09-24 | All but 15 are before 2026-07-29; NOAA's response isn't recorded |
  | `.geojson` + `.result.json`                | 15    | 2026-07-29 to 2026-07-30 | Every one records a NOAA 500                                     |
  | `.geojson` + `.done.json`                  | 2,392 | 2026-08-01 to 2026-10-15 | 2,391 `success: true`                                            |
  | `.geojson` + `.failed.json` + `.done.json` | 94    | 2026-07-30 to 2026-09-22 | Retried by the sweep, then done; `.failed.json` stays behind     |
  | Other                                      | 1     |                          | `2026/01/.DS_Store`, which matches no key pattern and is skipped |

  The 11,129 `.geojson` files come from 20 vessels, with a median size of 300 KB and a largest of 22 MB. The earliest file (2026-01-20) already carries CSB 3.1 metadata.

- Vessels are identified as `SIGNALK-<uuid>` in `properties.trustedNode.uniqueVesselID` and `properties.platform.uniqueID`.
- Checked: NOAA keeps that id. The track index has 5,547 `Signal K` submissions from 12 vessels, arriving from 2026-01-20 on, and each `EXTERNAL_ID` is `SIGNALK-<uuid>`, matching the uuid in an R2 key. Those files' bodies carry the same id as their keys, so this doesn't show which one NOAA keeps when they differ. The CSV's `UNIQUE_ID` is the same string, and its `FILE_UUID` is NOAA's arrival timestamp joined to the vessel uuid (for example `20261014000005884253_b0a6561e-…`), not the `submissionIds` the API records in `.done.json`. The other 8 vessels in R2 have no NOAA submissions.
- `properties.trustedNode.verticalReferenceOfDepth` states what depths are measured from, but only as well as the vessel is configured. Versions up to 1.2.6 always say `Waterline`. Later versions say `Waterline` when the configured offset was added, `Transducer` or `Unknown` when it wasn't, and `Unknown` can mean below the keel. See the plan's [Open Waters data](README.md#open-waters-data).
- Positions are moved from the GNSS antenna to the transducer by heading, or by course over ground while the boat makes way (about 1 kn or faster), and a sounding that can't be moved is dropped ([#134](https://github.com/openwatersio/crowd-depth/pull/134)). Earlier versions sent the antenna position unchanged when heading was missing, while the metadata still named the transducer as the position reference. The sensor positions in `properties.platform.sensors` are relative to the transducer (`vesselPositionReferencePoint`), so the sounder's is always zero. The sounder's `draft` carries the configured draft when one is set.
- Anonymous vessels leave out their name, type, length and MMSI.

The schema is [CSB-schema-3_1_0-2024-04.json](../../CSB-schema-3_1_0-2024-04.json).
