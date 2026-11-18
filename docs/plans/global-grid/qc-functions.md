# Track QC as pure functions

Track QC runs as numpy functions over one file's soundings at a time ([qc.py](../../../packages/grid/src/grid/qc.py)), and the plugin runs a plain-loop port of the same rules ([qc.ts](../../../packages/signalk-plugin/src/qc.ts)). Thresholds live in [definitions.json](../../../packages/grid/src/grid/definitions.json) and both pass the shared test vectors in [qc_vectors.json](../../../packages/grid/tests/qc_vectors.json). New QC rules are written against these functions.

## The spike

Measured in October 2026 on the Chesapeake set, on the QC v2 rules. The spike's numpy implementation produced identical flags to the SQL that then ran in ingest, which split each file by UTC day, and to a one-pass reference SQL on 1,000 real Chesapeake files (13,419,616 soundings, 50,740 flags): 0 files and 0 soundings differ. Every check fired on the sample (flatline 33,485, sentinel 11,046, very_shallow 4,949, unconfirmed spike 811, reject spike 321, jump 108, time 20). Only 2017–2020 files had downloaded at the time (6,476 of 24,418).

Its code was a numpy version (203 lines), a plain-loop version shaped for a TypeScript port (106 lines), and 38 test cases that each assert numpy = plain loops = SQL.

Speed (Apple M5, shared machine, QC only, inputs loaded):

| Version                  | Soundings/s per core | Largest file (379,912) |
| ------------------------ | -------------------- | ---------------------- |
| Production SQL, 1 thread | 415k                 | 0.81 s                 |
| Reference SQL, 1 thread  | 276k                 | 0.86 s                 |
| Numpy                    | 7.3M (about 17x)     | 0.051 s                |
| Plain loops              | 384k                 | 0.99 s                 |

Files are independent, so QC parallelizes per file. Loading and validating the CSVs (about 180k soundings/s) dominates; numpy QC added about 2% to ingest, SQL QC about 40%.

The one intentional difference: the day-split SQL measured stuck runs one UTC day at a time (a memory workaround), so a stuck run split by midnight could escape; the pure version, like the reference SQL, flags it.

## In the pipeline

On the full Chesapeake store (24,413 files, 98.5M soundings, 2.31M track flags) the numpy QC's flags match the SQL's except for 84 soundings, all unconfirmed: three stuck runs that cross UTC midnight are flagged whole, and five shoal spikes sit beside one of them. QC of the whole store takes 53 s at a 2.0 GB peak, against 204 s at 2.35 GB for the SQL.

The rules today go past the spike's v2, with the steep check on the deep side and noisy tracks among them. On a synthetic 2M-sounding track in the grid image, `qc.track_qc` holds about 170 bytes a sounding of working arrays for the file it judges. `qc.run_batch` also holds the batch's columns, 52 bytes a sounding, so QC's memory is about 52 bytes for each of the batch's soundings plus 170 for each of the file being judged, and follows the largest file ([backlog.md](backlog.md#3-make-the-daily-rebuild-fit), "Bound QC memory per file").

Not measured: Open Waters GeoJSON input, and QC's speed on files of millions of soundings under today's rules.
