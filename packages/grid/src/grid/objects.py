"""Object storage: S3-compatible buckets (NOAA, R2) and a local directory for runs and tests."""

import hashlib
import logging
import os
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import boto3
from boto3.s3.transfer import TransferConfig
from botocore import UNSIGNED
from botocore.config import Config
from botocore.exceptions import ClientError

log = logging.getLogger(__name__)

# At least the number of parallel fetches in ingest.
POOL = 32


class Conflict(Exception):
    """A conditional write lost: the object changed or already exists."""


@dataclass(frozen=True)
class Obj:
    key: str
    etag: str
    modified: datetime
    size: int


class S3Objects:
    def __init__(self, bucket: str, prefix: str = "", client=None):
        self.bucket = bucket
        self.prefix = prefix.strip("/") + "/" if prefix.strip("/") else ""
        self.client = client or boto3.client("s3")

    @classmethod
    def public(cls, bucket: str, prefix: str = ""):
        return cls(
            bucket,
            prefix,
            boto3.client(
                "s3", config=Config(signature_version=UNSIGNED, max_pool_connections=POOL)
            ),
        )

    @classmethod
    def r2(cls, bucket: str, prefix: str = ""):
        client = boto3.client(
            "s3",
            endpoint_url=os.environ["S3_ENDPOINT"],
            aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
            region_name=os.environ.get("S3_REGION", "auto"),
            config=Config(max_pool_connections=POOL),
        )
        return cls(bucket, prefix, client)

    @property
    def url(self) -> str:
        return f"s3://{self.bucket}/{self.prefix}"

    def get(self, key: str) -> tuple[bytes, str] | None:
        try:
            r = self.client.get_object(Bucket=self.bucket, Key=self.prefix + key)
        except ClientError as e:
            if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
                return None
            raise
        return r["Body"].read(), r["ETag"]

    def download(self, key: str, path) -> bool:
        """Stream an object to a file; False if it doesn't exist."""
        try:
            # One connection per download: ingest already runs downloads in parallel.
            self.client.download_file(
                self.bucket, self.prefix + key, str(path), Config=TransferConfig(use_threads=False)
            )
        except ClientError as e:
            if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
                return False
            raise
        return True

    def put(self, key: str, data: bytes, if_match: str | None = None, if_none_match=False) -> str:
        args = {"Bucket": self.bucket, "Key": self.prefix + key, "Body": data}
        if if_match:
            args["IfMatch"] = if_match
        if if_none_match:
            args["IfNoneMatch"] = "*"
        try:
            return self.client.put_object(**args)["ETag"]
        except ClientError as e:
            if e.response["Error"]["Code"] in (
                "PreconditionFailed",
                "412",
                "ConditionalRequestConflict",
            ):
                raise Conflict(key) from e
            raise

    def delete(self, key: str):
        self.client.delete_object(Bucket=self.bucket, Key=self.prefix + key)

    def list(self, prefix: str = "") -> tuple[list[Obj], bool]:
        """Every object under the prefix, and whether every page was read."""
        objs = []
        try:
            for page in self.client.get_paginator("list_objects_v2").paginate(
                Bucket=self.bucket, Prefix=self.prefix + prefix
            ):
                for o in page.get("Contents", []):
                    key = o["Key"][len(self.prefix) :]
                    objs.append(Obj(key, o["ETag"], o["LastModified"], o["Size"]))
        except Exception:
            log.exception("listing %s%s stopped after %d objects", self.url, prefix, len(objs))
            return objs, False
        return objs, True


class LocalObjects:
    """A directory standing in for a bucket. ETags are content MD5s, as S3 gives for single-part uploads."""

    def __init__(self, root: str | Path):
        self.root = Path(root)

    @property
    def url(self) -> str:
        return str(self.root) + "/"

    def _etag(self, data: bytes) -> str:
        return '"' + hashlib.md5(data).hexdigest() + '"'

    def get(self, key: str) -> tuple[bytes, str] | None:
        path = self.root / key
        if not path.exists():
            return None
        data = path.read_bytes()
        return data, self._etag(data)

    def download(self, key: str, path) -> bool:
        source = self.root / key
        if not source.exists():
            return False
        shutil.copyfile(source, path)
        return True

    def put(self, key: str, data: bytes, if_match: str | None = None, if_none_match=False) -> str:
        # ponytail: check-then-write isn't atomic; fine for one local process, R2 enforces it for real
        path = self.root / key
        current = self.get(key)
        if if_none_match and current is not None:
            raise Conflict(key)
        if if_match and (current is None or current[1] != if_match):
            raise Conflict(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return self._etag(data)

    def delete(self, key: str):
        (self.root / key).unlink(missing_ok=True)

    def list(self, prefix: str = "") -> tuple[list[Obj], bool]:
        objs = []
        for path in sorted(self.root.rglob("*")):
            key = path.relative_to(self.root).as_posix()
            if path.is_file() and key.startswith(prefix):
                stat = path.stat()
                mtime = datetime.fromtimestamp(stat.st_mtime, UTC)
                objs.append(Obj(key, self._etag(path.read_bytes()), mtime, stat.st_size))
        return objs, True


def open_objects(url: str, public=False):
    """`s3://bucket/prefix` (R2 credentials from S3_* env, or unsigned when public) or a local path."""
    if url.startswith("s3://"):
        bucket, _, prefix = url[5:].partition("/")
        return S3Objects.public(bucket, prefix) if public else S3Objects.r2(bucket, prefix)
    return LocalObjects(url)
