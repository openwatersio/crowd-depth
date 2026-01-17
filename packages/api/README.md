# Crowd Depth API

This is a minimal API for receiving crowd-sourced bathymetry GeoJSON reports, storing them, and forwarding them to.

## Endpoints

- `POST /identify` → `{ uuid, token }` where `token` is a JWT signed with `BATHY_JWT_SECRET`.
- `POST /geojson` (authenticated)
  - Headers: `Authorization: Bearer <token>` from `/identify`.
  - Multipart form fields:
    - `metadataInput`: JSON string containing at least `{ "uniqueID": "SIGNALK-<uuid>" }`.
    - `file`: GeoJSON file (content type `application/geo+json`).
  - Validates `uniqueID` matches the token UUID, forwards to NOAA, mirrors to S3 if configured, and returns the NOAA response.

## Environment

Required in production:

- `BATHY_JWT_SECRET` – HMAC secret for signing/validating tokens.
- `NOAA_CSB_URL` – Base NOAA CSB upload URL (default: NOAA test endpoint).
- `NOAA_CSB_TOKEN` – NOAA token to forward as `x-auth-token`.

Optional S3 mirror (all required if used): `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`.

### Example workflow (local)

1. Get credentials:

```
curl -s http://localhost:3001/identify
```

2. Submit a GeoJSON file (stored at `./sample.geojson`):

```
TOKEN="<token from step 1>"
UUID="<uuid from step 1>"

curl -v \
  -H "Authorization: Bearer $TOKEN" \
  -F "metadataInput={\"uniqueID\":\"SIGNALK-$UUID\"}" \
  -F "file=@./sample.geojson;type=application/geo+json" \
  http://localhost:3001/geojson
```

## Deployment

- Designed for Vercel: `vercel dev -l 3001` locally, `vercel deploy` to ship.
- Ensure required environment variables are set in the Vercel project.
