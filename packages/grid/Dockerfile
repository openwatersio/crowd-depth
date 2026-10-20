# The grid's tools: GDAL (gdal_grid and gdal_contour, for the depth surface) from the
# official image, tippecanoe from Open Waters' image, Node and the Slackwater engine for
# tide levels, and uv, which installs Python and the locked dependencies. The package is
# mounted at /app, not copied in; the Slackwater helper is copied with its locked modules.
FROM ghcr.io/openwatersio/tippecanoe:2.79 AS tippecanoe
FROM node:24.11.1-bookworm-slim AS slackwater
WORKDIR /opt/slackwater
COPY slackwater/package.json slackwater/package-lock.json slackwater/predict.mjs ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.11.4
COPY --from=tippecanoe /usr/local/bin/tippecanoe /usr/local/bin/tippecanoe-decode /usr/local/bin/tile-join /usr/local/bin/
COPY --from=slackwater /usr/local/bin/node /usr/local/bin/
COPY --from=slackwater /opt/slackwater /opt/slackwater
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /uvx /bin/
ENV UV_PROJECT_ENVIRONMENT=/venv UV_LINK_MODE=copy UV_CACHE_DIR=/cache/uv \
    UV_PYTHON_INSTALL_DIR=/cache/python GRID_SLACKWATER=/opt/slackwater/predict.mjs \
    GRID_CACHE_DIR=/cache/grid
WORKDIR /app
