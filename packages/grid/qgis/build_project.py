"""Write depth-chart.qgs, the QGIS project that draws a published depth.tif as a survey chart.

Run with QGIS's own Python, which has PyQGIS; see README.md here. It writes the project, reads
it back, and draws each bookmark to a PNG in RENDER_DIR, to check the project opens as QGIS
would open it.

    python build_project.py OUT.qgs RENDER_DIR [DEPTH_URL]
"""

import itertools
import re
import sys
from pathlib import Path

from qgis.core import (
    QgsApplication,
    QgsBookmark,
    QgsColorRampShader,
    QgsCoordinateReferenceSystem,
    QgsCoordinateTransform,
    QgsLineSymbol,
    QgsMapRendererParallelJob,
    QgsMapSettings,
    QgsProject,
    QgsRasterContourRenderer,
    QgsRasterDataProvider,
    QgsRasterLayer,
    QgsRasterShader,
    QgsRectangle,
    QgsReferencedRectangle,
    QgsSingleBandPseudoColorRenderer,
)
from qgis.PyQt.QtCore import QSize
from qgis.PyQt.QtGui import QColor

DEPTH_URL = "https://tiles.openwaters.io/crowd-depth/preview/planet/depth.tif"
OSM = "type=xyz&url=https://tile.openstreetmap.org/{z}/{x}/{y}.png&zmax=19&zmin=0"
# Survey charts' reversed jet: dark red at 0 m to dark blue at SHALLOW_M, then toward
# ABYSS at DEEP_M, where crowd sounders stop being worth drawing.
SHALLOW_M, DEEP_M = 30, 200
# Drying heights, depths above the datum, are dark red as 0 m is, down to this.
DRYING_M = 10
ABYSS = QColor(8, 8, 31)
# matplotlib's jet, as (position, value) stops per channel.
JET = (
    ((0, 0), (0.35, 0), (0.66, 1), (0.89, 1), (1, 0.5)),
    ((0, 0), (0.125, 0), (0.375, 1), (0.64, 1), (0.91, 0), (1, 0)),
    ((0, 0.5), (0.11, 1), (0.34, 1), (0.65, 0), (1, 0)),
)
# Contour lines are computed at 1/DOWNSCALE of the screen's resolution: 4, QGIS's default,
# leaves ragged ticks along the edges of the data.
DOWNSCALE = 2
# Places with enough coverage to show, west, south, east, north.
BOOKMARKS = {
    "Hampton Roads": (-76.45, 36.85, -75.95, 37.15),
    "Chesapeake Bay": (-77.2, 36.8, -75.6, 39.6),
    "New York Harbor and Long Island Sound": (-74.3, 40.4, -72.0, 41.4),
    "Florida Keys": (-82.2, 24.4, -80.0, 25.9),
    "Tampa Bay": (-83.0, 27.4, -82.3, 28.1),
    "Galveston Bay": (-95.2, 29.2, -94.6, 29.8),
    "Puget Sound": (-123.2, 47.0, -122.2, 48.4),
    "Southeast Alaska": (-136.5, 55.5, -131.5, 59.0),
    "Oslofjord": (10.2, 58.9, 11.0, 59.95),
}
START = "Hampton Roads"


def jet(t):
    rgb = []
    for stops in JET:
        for (t0, v0), (t1, v1) in itertools.pairwise(stops):
            if t0 <= t <= t1:
                rgb.append(round(255 * (v0 + (v1 - v0) * (t - t0) / (t1 - t0))))
                break
    return QColor(*rgb)


def colour(layer):
    stops = [
        QgsColorRampShader.ColorRampItem(SHALLOW_M * (1 - i / 20), jet(i / 20))
        for i in range(20, -1, -1)
    ]
    stops.insert(0, QgsColorRampShader.ColorRampItem(-DRYING_M, jet(1)))
    stops.append(QgsColorRampShader.ColorRampItem(DEEP_M, ABYSS))
    ramp = QgsColorRampShader(-DRYING_M, DEEP_M)
    ramp.setColorRampType(QgsColorRampShader.Type.Interpolated)
    # Clipped: nothing past DEEP_M is drawn.
    ramp.setClip(True)
    ramp.setColorRampItemList(stops)
    shader = QgsRasterShader()
    shader.setRasterShaderFunction(ramp)
    layer.setRenderer(QgsSingleBandPseudoColorRenderer(layer.dataProvider(), 1, shader))


def contours(depth, name, formula, interval, index_interval):
    """Contours of `formula` over the depth layer, drawn by QGIS as the map is."""
    params = QgsRasterDataProvider.VirtualRasterParameters()
    params.crs, params.extent = depth.crs(), depth.extent()
    params.width, params.height = depth.width(), depth.height()
    params.formula = formula
    source = QgsRasterDataProvider.VirtualRasterInputLayers()
    source.name, source.uri, source.provider = "depth", depth.source(), "gdal"
    params.rInputLayers = [source]
    uri = QgsRasterDataProvider.encodeVirtualRasterProviderUri(params)
    layer = QgsRasterLayer(uri, name, "virtualraster")
    assert layer.isValid(), layer.error().message()
    r = QgsRasterContourRenderer(layer.dataProvider())
    r.setInputBand(1)
    r.setContourInterval(interval)
    r.setContourIndexInterval(index_interval)
    r.setDownscale(DOWNSCALE)
    r.setContourSymbol(QgsLineSymbol.createSimple({"line_color": "40,40,40", "line_width": "0.15"}))
    r.setContourIndexSymbol(
        QgsLineSymbol.createSimple({"line_color": "40,40,40", "line_width": "0.4"})
    )
    layer.setRenderer(r)
    return layer


def build(p, depth_url):
    merc, wgs = QgsCoordinateReferenceSystem("EPSG:3857"), QgsCoordinateReferenceSystem("EPSG:4326")
    p.setTitle("Crowd Depth chart")
    p.setCrs(merc)
    osm = QgsRasterLayer(OSM, "OpenStreetMap", "wms")
    assert osm.isValid(), osm.error().message()
    osm.hueSaturationFilter().setSaturation(-100)
    depth = QgsRasterLayer(f"/vsicurl/{depth_url}", "Depth (m)", "gdal")
    assert depth.isValid(), depth.error().message()
    colour(depth)
    # The contour renderer takes one interval: clamped at SHALLOW_M, each layer is flat over
    # the other's range, so every metre is drawn in the shallows and every 10 below, to
    # DEEP_M as the colours are.
    shallow = contours(depth, "Contours to 30 m", f'min("depth@1", {SHALLOW_M})', 1, 5)
    deep = contours(
        depth, "Contours past 30 m", f'min(max("depth@1", {SHALLOW_M}), {DEEP_M})', 10, 50
    )
    root = p.layerTreeRoot()
    for layer in (shallow, deep, depth, osm):
        p.addMapLayer(layer, False)
        root.addLayer(layer)
    for name, b in BOOKMARKS.items():
        bm = QgsBookmark()
        bm.setName(name)
        bm.setGroup("Crowd Depth")
        bm.setExtent(QgsReferencedRectangle(QgsRectangle(*b), wgs))
        p.bookmarkManager().addBookmark(bm)
    start = QgsCoordinateTransform(wgs, merc, p).transformBoundingBox(
        QgsRectangle(*BOOKMARKS[START])
    )
    p.viewSettings().setDefaultViewExtent(QgsReferencedRectangle(start, merc))
    # Both licences ask for credit on the map: the depths' in full is in depth.tif's metadata.
    p.writeEntry("CopyrightLabel", "/Enabled", True)
    p.writeEntry(
        "CopyrightLabel",
        "/Label",
        "Depths: Crowd Depth and NOAA DCDB contributors, CC BY 4.0, full credits in depth.tif"
        " · Basemap © OpenStreetMap contributors",
    )


def check(p, render_dir):
    """Draw each bookmark of the project as read back, with the layers it shows."""
    for i, bm in enumerate(p.bookmarkManager().bookmarks()):
        s = QgsMapSettings()
        s.setDestinationCrs(p.crs())
        s.setLayers(p.layerTreeRoot().checkedLayers())
        to = QgsCoordinateTransform(bm.extent().crs(), p.crs(), p)
        s.setExtent(to.transformBoundingBox(bm.extent()))
        s.setOutputSize(QSize(900, 600))
        job = QgsMapRendererParallelJob(s)
        job.start()
        job.waitForFinished()
        assert not job.errors(), [e.message for e in job.errors()]
        assert job.renderedImage().save(f"{render_dir}/{i}.png")
        print("drew", bm.name())


def main(out, render_dir, depth_url=DEPTH_URL):
    app = QgsApplication([], False)
    app.initQgis()
    p = QgsProject.instance()
    build(p, depth_url)
    meta = p.metadata()
    meta.setAuthor("Open Waters")
    p.setMetadata(meta)
    assert p.write(out), p.error()
    # QGIS records who saved a project; this one is published.
    with open(out) as f:
        text = re.sub(r' (saveUser|saveUserFull)="[^"]*"', r' \1=""', f.read())
    with open(out, "w") as f:
        f.write(text)
    # QGIS's backup of the last save, which keeps who saved it, and an empty style database.
    Path(out + "~").unlink(missing_ok=True)
    Path(out).with_name(Path(out).stem + "_attachments.zip").unlink(missing_ok=True)
    p.clear()
    assert p.read(out), p.error()
    assert p.crs().isValid() and all(layer.isValid() for layer in p.mapLayers().values())
    Path(render_dir).mkdir(parents=True, exist_ok=True)
    check(p, render_dir)
    app.exitQgis()


if __name__ == "__main__":
    main(*sys.argv[1:])
