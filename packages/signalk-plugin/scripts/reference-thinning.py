# /// script
# dependencies = ["shapely==2.2.0"]
# ///
"""Generate the horizontal-only thinning oracle; independent of plugin code.

Run: uv run scripts/reference-thinning.py > test/observations/fixtures/geos-thinning.json
Reference API: https://shapely.readthedocs.io/en/stable/reference/shapely.simplify.html
Inputs are planar metres. Production tests convert these small equatorial tracks
to lon/lat; depth is constant and no maximum-gap anchors are needed in this case.
"""
import json
import math
import shapely
from shapely import LineString

count = 600
points = [(i / 10, 2 * math.sin(i * 0.073) + 0.4 * math.cos(i * 0.157)) for i in range(count)]
index = {point: i for i, point in enumerate(points)}
fixtures = []
for tolerance in (0.25, 0.75, 1.25):
    simplified = shapely.simplify(LineString(points), tolerance, preserve_topology=False)
    fixtures.append({"toleranceM": tolerance, "kept": [index[tuple(p)] for p in simplified.coords]})
print(json.dumps({"shapely": shapely.__version__, "geos": shapely.geos_version_string,
                  "count": count, "fixtures": fixtures}, indent=2))
