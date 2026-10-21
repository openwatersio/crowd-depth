"""Sounding labels and cell column widths, shared with the plugin's live layer.

portrayal_vectors.json is read by this test and by the plugin's vitest, so the live
layer labels soundings and lays out cells as the grid does. To change a case or add
one, edit `cases()` and write the file again:

    uv run python tests/test_portrayal_vectors.py
"""

import json
from pathlib import Path

from grid.cells import k_for
from grid.overlay import depths

VECTORS = Path(__file__).with_name("portrayal_vectors.json")


def cases():
    return {
        "depths": [
            [d, depths(d)]
            for d in [0, 0.05, 0.3, 1.29, 2.999, 9.99, 20.95, 21.0, 24.7, 30.99, 31.0, 57.4, 199.9]
        ],
        "column_steps": [
            [lat0, k_for(lat0)] for lat0 in [-90, -61, -45, 0, 30, 44, 48, 60, 70, 80, 84, 89]
        ],
    }


def test_vectors_match_the_grid():
    assert json.loads(VECTORS.read_text()) == cases()


if __name__ == "__main__":
    VECTORS.write_text(json.dumps(cases(), indent=1) + "\n")
