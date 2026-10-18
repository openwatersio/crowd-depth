# Track QC as pure functions

Verdict: yes. A numpy implementation of QC v2 produces identical flags to the SQL that ran in ingest, which split each file by UTC day, and to the one-pass reference SQL on 1,000 real Chesapeake files (13,419,616 soundings, 50,740 flags): 0 files and 0 soundings differ. Every check fired on the sample (flatline 33,485, sentinel 11,046, very_shallow 4,949, unconfirmed spike 811, reject spike 321, jump 108, time 20).

The spike's code is a numpy version (203 lines), a plain-loop version shaped for a TypeScript port (106 lines), and 38 test cases that each assert numpy = plain loops = SQL. The numpy version is the grid's QC in [qc.py](../../../packages/grid/src/grid/qc.py), and the plain loops are the plugin's port in [qc.ts](../../../packages/signalk-plugin/src/qc.ts), both checked against shared test vectors.

Performance (Apple M5, shared machine, QC only, inputs loaded):

| Version                  | Soundings/s per core | Largest file (379,912) |
| ------------------------ | -------------------- | ---------------------- |
| Production SQL, 1 thread | 415k                 | 0.81 s                 |
| Reference SQL, 1 thread  | 276k                 | 0.86 s                 |
| Numpy                    | 7.3M (about 17x)     | 0.051 s                |
| Plain loops              | 384k                 | 0.99 s                 |

Memory: about 125 bytes per sounding above inputs for numpy (45 MB for a 365k-sounding file) against 210–800 MB for the SQL versions. Files are independent, so it parallelizes per file. Loading and validating the CSVs (about 180k soundings/s) dominates; numpy QC adds about 2% to ingest, SQL QC about 40%.

One intentional difference: the day-split SQL measures stuck runs one UTC day at a time (a memory workaround), so a stuck run split by midnight can escape; the pure version, like the reference SQL, flags it. This is why the numpy QC is QC v4.

Reuse: the plain-loop version needs only fmod/cos/radians/sqrt, a stable sort and an 11-value median, so it ports to TypeScript directly. Share thresholds as JSON and test vectors as JSON read by both pytest and vitest. Server QC must still run regardless of any client flags.

Unmeasured: only 2017–2020 files had downloaded at the time (6,476 of 24,418); no Open Waters GeoJSON; reading from the DuckLake/R2 store; files with millions of soundings; the TypeScript port.
