"""The definitions the grid shares with the plugin's live layer, read from definitions.json.

The plugin's live layer imports the same file, so a track QC threshold, the cell
resolution or the overlay's portrayal changes for both at once. Changing a QC threshold
changes flags: bump `qc.version` with it. Changing the cells, statistic, surface or tide changes the grid:
bump `cells.GRID_VERSION`. A tide change that alters stations or their predicted σ also needs the
tide levels made again, since `grid tide` keeps each station day's levels and σ once made. Portrayal changes only the overlay, which `grid overlay` rebuilds
from the cells.
"""

import json
from pathlib import Path

DEFINITIONS = json.loads(Path(__file__).with_suffix(".json").read_text())
QC = DEFINITIONS["qc"]
CELLS = DEFINITIONS["cells"]
SURFACE = DEFINITIONS["surface"]
STATISTIC = DEFINITIONS["statistic"]
TIDE = DEFINITIONS["tide"]
PORTRAYAL = DEFINITIONS["portrayal"]
