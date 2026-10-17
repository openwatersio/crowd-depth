# The grid's tools: GDAL (gdal_grid and gdal_contour, for the depth surface) from the
# official image, tippecanoe from Open Waters' image, and uv, which installs Python and
# the locked dependencies. The package is mounted at /app, not copied in.
FROM ghcr.io/openwatersio/tippecanoe:2.79 AS tippecanoe
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.11.4
COPY --from=tippecanoe /usr/local/bin/tippecanoe /usr/local/bin/tippecanoe-decode /usr/local/bin/tile-join /usr/local/bin/
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /uvx /bin/
ENV UV_PROJECT_ENVIRONMENT=/venv UV_LINK_MODE=copy UV_CACHE_DIR=/cache/uv \
    UV_PYTHON_INSTALL_DIR=/cache/python
WORKDIR /app
