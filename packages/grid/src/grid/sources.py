"""Parse and validate one submitted file from each source."""

import csv
import hashlib
import io
import json
import math
import re
import struct
from dataclasses import dataclass, field
from datetime import UTC, datetime

NOAA_PREFIX = "csb/csv/"
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


class Invalid(Exception):
    """The file can't be parsed or holds impossible values."""


@dataclass
class Sounding:
    unique_id: str
    platform: str | None
    provider: str | None
    time: datetime
    time_raw: str
    lon: float
    lat: float
    depth: float


@dataclass
class Parsed:
    source: str
    vessel: str
    file_uuid: str | None
    soundings: list[Sounding]
    meta: dict | None = None
    content_hash: str = field(init=False)

    def __post_init__(self):
        if not self.soundings:
            raise Invalid("no soundings")
        self.content_hash = content_hash(self.source, self.soundings)

    @property
    def time_range(self):
        times = [s.time for s in self.soundings]
        return min(times), max(times)


def is_submission(source: str, key: str) -> bool:
    try:
        arrival(source, key)
        return True
    except (AttributeError, TypeError, ValueError):
        return False


def arrival(source: str, key: str) -> datetime:
    """When the file arrived at its source, read from the key both sources build at arrival."""
    if source == "noaa":
        m = NOAA_KEY.match(key)
        return datetime.strptime(m[1] + m[2], "%Y%m%d%H%M%S%f")
    y, mo, d, t, _ = OPENWATERS_KEY.match(key).groups()
    return datetime.fromisoformat(f"{y}-{mo}-{d}T{t}")


def vessel_from_key(key: str) -> str:
    return "SIGNALK-" + OPENWATERS_KEY.match(key)[5]


def content_hash(source: str, soundings: list[Sounding]) -> str:
    """Hash of the source and its soundings (vessel, time, position, depth) in sorted order.

    Leaves out FILE_UUID, platform and provider, so identical resubmissions hash alike.
    The source is in it because NOAA's CSV of a Signal K submission can hold exactly
    the soundings of the R2 copy: rule 1 skips copies within a source, and rule 5
    decides between sources per sounding. It also keeps point ids distinct across sources.
    """
    lines = sorted(
        f"{s.unique_id}\t{s.time.isoformat()}\t{s.lon!r}\t{s.lat!r}\t{s.depth!r}" for s in soundings
    )
    h = hashlib.sha256(source.encode() + b"\n")
    for line in lines:
        h.update(line.encode())
        h.update(b"\n")
    return h.hexdigest()


def float32(x: float) -> float:
    return struct.unpack("f", struct.pack("f", x))[0]


def parse_time(raw: str) -> datetime:
    t = datetime.fromisoformat(raw)
    if t.tzinfo is None:
        raise ValueError(f"time without zone: {raw!r}")
    return t.astimezone(UTC).replace(tzinfo=None)


def position(lon, lat) -> tuple[float, float]:
    lon, lat = float(lon), float(lat)
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        raise ValueError(f"position out of range: {lon}, {lat}")
    return lon, lat


def depth(value) -> float:
    # Sentinels such as -1e9 and 0 are valid here; QC flags them.
    d = float32(float(value))  # overflows to inf on some Python versions, raises on others
    if not math.isfinite(d):
        raise ValueError(f"depth not finite as float32: {value!r}")
    return d


def parse_noaa(body: bytes) -> Parsed:
    reader = csv.DictReader(io.StringIO(body.decode("utf-8-sig")))
    if not NOAA_COLUMNS <= set(reader.fieldnames or []):
        raise Invalid(f"missing columns: {sorted(NOAA_COLUMNS - set(reader.fieldnames or []))}")
    soundings, ids, uuids = [], set(), set()
    for row in reader:
        lon, lat = position(row["LON"], row["LAT"])
        ids.add(row["UNIQUE_ID"])
        uuids.add(row["FILE_UUID"])
        soundings.append(
            Sounding(
                unique_id=row["UNIQUE_ID"],
                platform=row["PLATFORM_NAME"] or None,
                provider=row["PROVIDER"] or None,
                time=parse_time(row["TIME"]),
                time_raw=row["TIME"],
                lon=lon,
                lat=lat,
                depth=depth(row["DEPTH"]),
            )
        )
    # ponytail: one vessel per file, as every submission so far; drop the rule if NOAA ever merges them
    if len(ids) > 1:
        raise Invalid(f"several UNIQUE_IDs: {sorted(ids)[:3]}")
    return Parsed(
        "noaa", vessel=next(iter(ids), ""), file_uuid=next(iter(uuids), None), soundings=soundings
    )


def parse_openwaters(key: str, body: bytes) -> Parsed:
    vessel = vessel_from_key(key)
    doc = json.loads(body)
    props = mapping(doc.get("properties"))
    node = mapping(props.get("trustedNode"))
    platform = mapping(props.get("platform"))
    # The API checks the token, not the body, so the key is the vessel's identity.
    for body_id in (node.get("uniqueVesselID"), platform.get("uniqueID")):
        if body_id is not None and body_id != vessel:
            raise Invalid(f"body vessel {body_id} differs from key vessel {vessel}")
    soundings = []
    for f in doc["features"]:
        lon, lat = position(*f["geometry"]["coordinates"][:2])
        raw = f["properties"]["time"]
        soundings.append(
            Sounding(
                unique_id=vessel,
                platform=text(platform.get("name")),
                provider=OPENWATERS_PROVIDER,
                time=parse_time(raw),
                time_raw=raw,
                lon=lon,
                lat=lat,
                depth=depth(f["properties"]["depth"]),
            )
        )
    return Parsed(
        "openwaters",
        vessel=vessel,
        file_uuid=None,
        soundings=soundings,
        meta=submission_meta(props),
    )


def mapping(v) -> dict:
    """Metadata containers of the wrong type read as empty, so they can't invalidate soundings."""
    return v if isinstance(v, dict) else {}


def text(v) -> str | None:
    return v if isinstance(v, str) else None


def number(v) -> float | None:
    ok = isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v)
    return float(v) if ok else None


def numbers(v) -> list[float] | None:
    ok = isinstance(v, list) and v and all(number(x) is not None for x in v)
    return [float(x) for x in v] if ok else None


def submission_meta(props: dict) -> dict:
    """Metadata is a hint: a field of the wrong type is stored as missing, not trusted or fatal."""
    node = mapping(props.get("trustedNode"))
    sensors = mapping(props.get("platform")).get("sensors")
    sensors = [s for s in sensors if isinstance(s, dict)] if isinstance(sensors, list) else []
    sounder = next((s for s in sensors if s.get("type") == "Sounder"), {})
    gnss = next((s for s in sensors if s.get("type") == "GNSS"), {})
    return {
        "depth_reference": text(node.get("verticalReferenceOfDepth")),
        "position_reference": text(node.get("vesselPositionReferencePoint")),
        "sounder": " ".join(filter(None, map(text, [sounder.get("make"), sounder.get("model")])))
        or None,
        "sounder_position": numbers(sounder.get("position")),
        "gnss_position": numbers(gnss.get("position")),
        "draft": number(sounder.get("draft")),
        "logger_version": text(node.get("providerLoggerVersion")),
        "csb": json.dumps(props),
    }


def parse(source: str, key: str, body: bytes) -> Parsed:
    """Parse a file, raising Invalid for anything it can't read: bodies are untrusted input.

    A body nested deeply enough to exhaust the parser's recursion is invalid too. Errors
    that say nothing about the file, such as MemoryError, propagate so the run fails
    and the file is read again, instead of being marked invalid for good.
    """
    try:
        return parse_noaa(body) if source == "noaa" else parse_openwaters(key, body)
    except Invalid:
        raise
    except (
        ValueError,
        TypeError,
        KeyError,
        IndexError,
        AttributeError,
        OverflowError,
        RecursionError,
        csv.Error,
    ) as e:
        raise Invalid(f"{type(e).__name__}: {e}") from e
