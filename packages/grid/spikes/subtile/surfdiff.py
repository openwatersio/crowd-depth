"""Prototype: a windowed surface against the full one, inside the window.

surfdiff.py FULL.tif WINDOWED.tif S N W E
"""

import sys

import numpy as np
import rasterio

full, win = sys.argv[1:3]
s, n, w, e = map(float, sys.argv[3:7])
with rasterio.open(full) as a, rasterio.open(win) as c:
    r0, c0 = a.index(w, n)
    r1, c1 = a.index(e, s)
    A = a.read(window=((r0, r1), (c0, c1)))
    C = c.read(window=((r0, r1), (c0, c1)))
v = (A[0] != -9999) & (C[0] != -9999)
d = np.abs(A[0] - C[0])[v]
print(
    {
        "pixels": int(v.sum()),
        "bands_differ": [int((A[b] != C[b]).sum()) for b in range(len(A))],
        "depth_over_0.1m": int((d > 0.1).sum()),
        "depth_over_1m": int((d > 1).sum()),
        "max_depth_m": round(float(d.max()), 3) if len(d) else 0,
        "data_mismatch": int(((A[0] == -9999) != (C[0] == -9999)).sum()),
    }
)
