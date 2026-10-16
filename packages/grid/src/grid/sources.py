"""Load and validate one submitted file from each source, in DuckDB.

A file is read from disk through the temp view `file_points`, so it is never held in
Python memory, nor copied into DuckDB's: each query reads it again from disk.
"""

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime

import duckdb

NOAA_PREFIX = "csb/csv/"
# RFC 4180, every field read as text and checked after. A row with an extra field
# still reads (the field is ignored); a short row reads with NULLs, which fail checks.
CSV = (
    "header = true, delim = ',', quote = '\"', all_varchar = true, "
    "strict_mode = false, null_padding = true"
)
NOAA_COLUMNS = {
    "UNIQUE_ID",
    "FILE_UUID",
    "LON",
    "LAT",
    "DEPTH",
    "TIME",
    "PLATFORM_NAME",
    "PROVIDER",
}

# <YYYY/MM/DD>/<HH:MM:SS.mmmZ>-<vessel uuid>.geojson, built by packages/api/src/r2.ts
OPENWATERS_KEY = re.compile(
    r"^(\d{4})/(\d\d)/(\d\d)/(\d\d:\d\d:\d\d\.\d{3})Z-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.geojson$"
)
# csb/csv/YYYY/MM/DD/<YYYYMMDDhhmmss><micros>_<uuid>_pointData.csv
NOAA_KEY = re.compile(r"^csb/csv/\d{4}/\d\d/\d\d/(\d{14})(\d{6})_[^/]+_pointData\.csv$")

# The plugin's provider name at NOAA, so both sources' points read alike.
OPENWATERS_PROVIDER = "Signal K"
# DuckDB reads a GeoJSON body as one value. The API refuses uploads over 25 MB
# (packages/api/src/api.ts), and the largest object in the bucket is 22 MB.
MAX_JSON_BYTES = 64 * 2**20

# Errors that come from the file's contents. Others, such as running out of memory or
# disk, say nothing about the file and fail the run, so the file is read again.
# Binder and parser errors would come from this module's own SQL, so they fail the run.
FILE_ERRORS = (duckdb.InvalidInputException, duckdb.ConversionException)


class Invalid(Exception):
    """The file can't be parsed or holds impossible values."""


@dataclass
class Parsed:
    source: str
    vessel: str
    file_uuid: str | None
    count: int
    time_min: datetime
    time_max: datetime
    content_hash: str
    meta: dict | None = None


def is_submission(source: str, key: str) -> bool:
    try:
        arrival(source, key)
        return True
    except (AttributeError, TypeError, ValueError):
        return False


# Soundings before this, or more than a day after their file arrived, are rejected by QC.
EARLIEST = "2000-01-01"


def arrival(source: str, key: str) -> datetime:
    """When the file arrived at its source, read from the key both sources build at arrival."""
    if source == "noaa":
        m = NOAA_KEY.match(key)
        return datetime.strptime(m[1] + m[2], "%Y%m%d%H%M%S%f")
    y, mo, d, t, _ = OPENWATERS_KEY.match(key).groups()
    return datetime.fromisoformat(f"{y}-{mo}-{d}T{t}")


def vessel_from_key(key: str) -> str:
    return "SIGNALK-" + OPENWATERS_KEY.match(key)[5]


def soundings(time_raw: str, lon: str, lat: str, depth: str) -> str:
    """Typed columns from text ones; NULL where a value doesn't parse, for validate() to find."""
    return f"""{time_raw} AS time_raw,
      timezone('UTC', TRY_CAST({time_raw} AS TIMESTAMPTZ)) AS time,
      -- A time without a time of day and a zone is ambiguous, so it doesn't parse.
      regexp_matches({time_raw}, '\\d\\d:\\d\\d(:\\d\\d(\\.\\d+)?)?(Z|[+-]\\d\\d(:?\\d\\d)?)$')
        AS zoned,
      TRY_CAST({lon} AS DOUBLE) AS lon, TRY_CAST({lat} AS DOUBLE) AS lat,
      TRY_CAST({depth} AS FLOAT) AS depth"""


def load_noaa(con, path: str) -> tuple[str, str | None]:
    columns = {
        name
        for (name,) in con.execute(
            f"SELECT column_name FROM (DESCRIBE SELECT * FROM read_csv(?, {CSV}))",
            [path],
        ).fetchall()
    }
    if not NOAA_COLUMNS <= columns:
        raise Invalid(f"missing columns: {sorted(NOAA_COLUMNS - columns)}")
    con.execute(
        f"""CREATE OR REPLACE TEMP VIEW file_points AS
        SELECT row_number() OVER () - 1 AS "row", UNIQUE_ID AS unique_id, FILE_UUID AS file_uuid,
          nullif(PLATFORM_NAME, '') AS platform, nullif(PROVIDER, '') AS provider,
          {soundings("TIME", "LON", "LAT", "DEPTH")}
        FROM read_csv({literal(path)}, {CSV})"""
    )
    ids, blank, vessel, file_uuid = con.execute(
        "SELECT count(DISTINCT unique_id), count(*) FILTER (WHERE coalesce(unique_id, '') = ''), "
        "any_value(unique_id), any_value(file_uuid) FROM file_points"
    ).fetchone()
    # A sounding with no vessel can't be counted as one vessel or told from another.
    if blank:
        raise Invalid(f"{blank} soundings without a UNIQUE_ID")
    # ponytail: one vessel per file, as every submission so far; drop the rule if NOAA ever merges them
    if ids > 1:
        raise Invalid(f"{ids} UNIQUE_IDs in one file")
    return vessel, file_uuid


def literal(value: str) -> str:
    """A SQL string literal, for views, which can't take parameters."""
    return "'" + value.replace("'", "''") + "'"


def text(path: str) -> str:
    """A JSON value as text when it is a string, otherwise NULL."""
    return f"CASE WHEN json_type(json, '{path}') = 'VARCHAR' THEN json ->> '{path}' END"


def load_openwaters(con, key: str, path: str) -> dict:
    vessel = vessel_from_key(key)
    con.execute(
        "CREATE OR REPLACE TEMP VIEW doc AS SELECT json FROM read_json_objects("
        f"{literal(path)}, maximum_object_size = {MAX_JSON_BYTES})"
    )
    [(objects, kind)] = con.execute(
        "SELECT count(*), any_value(json_type(json)) FROM doc"
    ).fetchall()
    if objects != 1 or kind != "OBJECT":
        raise Invalid("not one GeoJSON object")
    # The API checks the token, not the body, so the key is the vessel's identity.
    for body_path in ("$.properties.trustedNode.uniqueVesselID", "$.properties.platform.uniqueID"):
        [(body_id,)] = con.execute(
            f"SELECT CASE WHEN json_type(json, '{body_path}') NOT IN ('NULL') "
            f"THEN json ->> '{body_path}' END FROM doc"
        ).fetchall()
        if body_id is not None and body_id != vessel:
            raise Invalid(f"body vessel {body_id} differs from key vessel {vessel}")
    if con.execute("SELECT json_type(json, '$.features') FROM doc").fetchone()[0] != "ARRAY":
        raise Invalid("no features array")
    con.execute(
        f"""CREATE OR REPLACE TEMP VIEW file_points AS
        SELECT row_number() OVER () - 1 AS "row", {
            literal(vessel)
        } AS unique_id, NULL::VARCHAR AS file_uuid,
          (SELECT {text("$.properties.platform.name")} FROM doc) AS platform,
          '{OPENWATERS_PROVIDER}' AS provider,
          {
            soundings(
                "f ->> '$.properties.time'",
                "f ->> '$.geometry.coordinates[0]'",
                "f ->> '$.geometry.coordinates[1]'",
                "f ->> '$.properties.depth'",
            )
        }
        FROM (SELECT unnest(json_extract(json, '$.features[*]')) AS f FROM doc)"""
    )
    return submission_meta(con)


def submission_meta(con) -> dict:
    """Metadata is a hint: a field of the wrong type is stored as missing, not trusted or fatal."""
    sensor = """list_filter(
      CASE WHEN json_type(json, '$.properties.platform.sensors') = 'ARRAY'
        THEN json_extract(json, '$.properties.platform.sensors[*]') END,
      s -> (s ->> '$.type') = '{kind}')[1]"""
    row = con.execute(
        f"""SELECT {text("$.properties.trustedNode.verticalReferenceOfDepth")},
          {text("$.properties.trustedNode.vesselPositionReferencePoint")},
          {text("$.properties.trustedNode.providerLoggerVersion")},
          json -> '$.properties', s, g
        FROM (SELECT json, {sensor.format(kind="Sounder")} AS s, {sensor.format(kind="GNSS")} AS g
              FROM doc)"""
    ).fetchone()
    depth_reference, position_reference, logger_version, props, sounder, gnss = row

    def sensor_text(s, field):
        return (
            con.execute(
                f"SELECT CASE WHEN json_type(?::JSON, '$.{field}') = 'VARCHAR' "
                f"THEN ?::JSON ->> '$.{field}' END",
                [s, s],
            ).fetchone()[0]
            if s
            else None
        )

    def numbers(s, field):
        # A list counts only if every element is a JSON number.
        query = f"""SELECT CASE WHEN len(e) > 0 AND list_bool_and(list_transform(e,
            x -> json_type(x) IN ('UBIGINT', 'BIGINT', 'DOUBLE')
              AND coalesce(isfinite(TRY_CAST(x AS DOUBLE)), false)))
            THEN e::DOUBLE[] END
          FROM (SELECT CASE WHEN json_type(j) = 'ARRAY' THEN json_extract(j, '$[*]') END AS e
                FROM (SELECT ?::JSON -> '$.{field}' AS j))"""
        return con.execute(query, [s]).fetchone()[0] if s else None

    def number(s, field):
        query = f"""SELECT CASE WHEN json_type(j) IN ('UBIGINT', 'BIGINT', 'DOUBLE')
            AND isfinite(TRY_CAST(j AS DOUBLE)) THEN TRY_CAST(j AS DOUBLE) END
          FROM (SELECT ?::JSON -> '$.{field}' AS j)"""
        return con.execute(query, [s]).fetchone()[0] if s else None

    make_model = " ".join(
        filter(None, (sensor_text(sounder, "make"), sensor_text(sounder, "model")))
    )
    return {
        "depth_reference": depth_reference,
        "position_reference": position_reference,
        "sounder": make_model or None,
        "sounder_position": numbers(sounder, "position") or None,
        "gnss_position": numbers(gnss, "position") or None,
        "draft": number(sounder, "draft"),
        "logger_version": logger_version,
        "csb": str(props) if props is not None else None,
    }


def validate(con, arrived: datetime) -> tuple[int, datetime, datetime]:
    """Raise Invalid for an empty file or any impossible value in `file_points`.

    Returns the count and the span of the file's plausible times, those QC doesn't
    reject: a GPS that logs 1970 before its first fix must not stretch the span that
    dedupe compares, or the span overflow at the edges of DuckDB's timestamp range.
    """
    n, pos, depth, time, tmin, tmax = con.execute(
        f"""SELECT count(*),
          count(*) FILTER (WHERE lon IS NULL OR lat IS NULL
            OR NOT (lon BETWEEN -180 AND 180) OR NOT (lat BETWEEN -90 AND 90)),
          -- Sentinels such as -1e9 and 0 are fine here; QC flags them.
          count(*) FILTER (WHERE NOT coalesce(isfinite(depth), false)),
          count(*) FILTER (WHERE time IS NULL OR NOT coalesce(zoned, false)
            OR NOT (year(time) BETWEEN 1 AND 9999)),
          min(time) FILTER (WHERE plausible), max(time) FILTER (WHERE plausible)
        FROM (SELECT *, time >= TIMESTAMP '{EARLIEST}'
            AND time <= $arrived + INTERVAL 1 DAY AS plausible FROM file_points)""",
        {"arrived": arrived},
    ).fetchone()
    if n == 0:
        raise Invalid("no soundings")
    for count, what in ((pos, "positions"), (depth, "depths"), (time, "times")):
        if count:
            raise Invalid(f"{count} impossible {what}")
    return n, tmin, tmax


def content_hash(con, source: str) -> str:
    """Hash of the source and its soundings (vessel, time, position, depth), whatever their order.

    Each sounding is hashed alone and the hashes are summed, so the file's hash is a
    streaming aggregate with fixed memory, not a sort. Values are formatted explicitly,
    not by DuckDB's casts, so a DuckDB upgrade can't change the hash; the golden test
    in test_ingest.py fails if anything does. A sum of hashes is easier to collide on
    purpose than one hash over sorted lines, but each line holds its vessel's id from
    its key, so a submitter could only aim at their own files. It leaves out FILE_UUID, platform
    and provider, so identical resubmissions hash alike. The source is in it because
    NOAA's CSV of a Signal K submission can hold exactly the soundings of the R2 copy:
    rule 1 skips copies within a source, and rule 5 decides between sources. It also
    keeps point ids distinct across sources.
    """
    n, upper, lower = con.execute(
        """SELECT count(*), sum(md5_number_upper(line)::HUGEINT), sum(md5_number_lower(line)::HUGEINT)
        FROM (SELECT concat_ws(chr(9), unique_id, strftime(time, '%Y-%m-%dT%H:%M:%S.%f'),
                printf('%.9f', lon), printf('%.9f', lat), printf('%.6f', depth)) AS line
              FROM file_points)"""
    ).fetchone()
    return hashlib.sha256(f"{source}\n{n}\n{upper}\n{lower}".encode()).hexdigest()


def load(con, source: str, key: str, path: str) -> Parsed:
    """Load the file at `path` into `file_points` and describe it, or raise Invalid."""
    try:
        if source == "noaa":
            vessel, file_uuid = load_noaa(con, path)
            meta = None
        else:
            vessel, file_uuid = vessel_from_key(key), None
            meta = load_openwaters(con, key, path)
        n, tmin, tmax = validate(con, arrival(source, key))
        return Parsed(source, vessel, file_uuid, n, tmin, tmax, content_hash(con, source), meta)
    except FILE_ERRORS as e:
        raise Invalid(f"{type(e).__name__}: {str(e)[:300]}") from e
