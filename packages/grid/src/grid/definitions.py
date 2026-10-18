"""The definitions the grid shares with the plugin's live layer, read from definitions.json.

The plugin's live layer is to import the same file, so a QC threshold, the cell resolution
or the overlay's portrayal changes for both at once. Changing a QC threshold changes flags:
bump `qc.version` with it. Changing the cells, surface or portrayal changes the grid: bump
`cells.GRID_VERSION`.
"""

import json
from pathlib import Path

DEFINITIONS = json.loads(Path(__file__).with_suffix(".json").read_text())
QC = DEFINITIONS["qc"]
CELLS = DEFINITIONS["cells"]
SURFACE = DEFINITIONS["surface"]
PORTRAYAL = DEFINITIONS["portrayal"]
