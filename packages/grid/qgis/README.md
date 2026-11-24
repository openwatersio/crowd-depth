[depth-chart.qgs](depth-chart.qgs) is a QGIS project that draws the published planet depth COG, made by `grid depth --publish`, as a hydrographic survey chart. It shows depth in the reversed jet ramp of survey plots, from dark red at 0 m to dark blue at 30 m and darkening to 200 m, with nothing drawn past 200 m. Contours are drawn every 1 m to 30 m, with a heavier line every 5 m, and every 10 m below that. Drying heights are dark red, as 0 m is. A grayscale OpenStreetMap basemap sits underneath, credited on the map. QGIS draws all of it from the depth values as the map moves, so the Identify tool on the "Depth (m)" layer reads depths in metres. The contour layers need QGIS 3.22 or later. The project opens on Hampton Roads and has bookmarks for other places with good coverage. The whole planet looks empty, since most coverage is narrow ship tracks. The contour layers hold the COG's extent and size as they were when the project was built: rebuild the project when the COG's extent changes.

It's published next to the COG, at https://tiles.openwaters.io/crowd-depth/preview/planet/depth-chart.qgs. To change the styling, edit [build_project.py](build_project.py), rebuild the project with QGIS's Python, and upload it:

```bash
APP=/Applications/QGIS-final-4_2_3.app
QT_QPA_PLATFORM=offscreen PYTHONPATH=$APP/Contents/Resources/python QGIS_PREFIX_PATH=$APP \
  PROJ_DATA=$APP/Contents/Resources/qgis/proj GDAL_DATA=$APP/Contents/Resources/qgis/gdal \
  $APP/Contents/MacOS/python build_project.py depth-chart.qgs /tmp/renders
```

The script reads the project back and draws every bookmark to a PNG in the render directory, so check those before uploading.
