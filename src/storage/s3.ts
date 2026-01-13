import type { S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "stream";
import type { Metadata } from "../reporters/noaa.js";

export type S3Config = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

export class S3Storage {
  private clientPromise: Promise<S3Client>;
  private bucket: string;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.clientPromise = (async () => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      return new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: true,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
    })();
  }

  /**
   * Store metadata and data files in the S3-compatible storage
   * @param key - The base key/path for the files (e.g., "uuid-timestamp")
   * @param metadata - The metadata object to store as JSON
   * @param data - The CSV data stream
   */
  async store(key: string, metadata: Metadata, data: Readable): Promise<void> {
    const client = await this.clientPromise;
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");

    const jsonBody = Buffer.from(JSON.stringify(metadata, null, 2), "utf8");
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${key}.json`,
        Body: jsonBody,
        ContentType: "application/json",
        ContentLength: jsonBody.byteLength,
      }),
    );

    const csvBody = await this.toBuffer(data);
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${key}.csv`,
        Body: csvBody,
        ContentType: "text/csv",
        ContentLength: csvBody.byteLength,
      }),
    );
  }

  private async toBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}

/**
 * Create generic S3 storage from environment variables.
 * Required: S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET
 */
export function createS3Storage(): S3Storage | null {
  const {
    S3_ENDPOINT,
    S3_REGION,
    S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY,
    S3_BUCKET,
  } = process.env;

  if (
    !S3_ENDPOINT ||
    !S3_REGION ||
    !S3_ACCESS_KEY_ID ||
    !S3_SECRET_ACCESS_KEY ||
    !S3_BUCKET
  ) {
    return null;
  }

  return new S3Storage({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    bucket: S3_BUCKET,
  });
}

/**
 * Backwards/compat convenience: Create Cloudflare R2 storage from environment variables.
 * R2-specific vars: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */
// Removed createR2Storage in favor of generic createS3Storage
