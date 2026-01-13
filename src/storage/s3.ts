import type { Metadata } from "../reporters/noaa.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream } from "fs";

export type S3Config = {
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_BUCKET: string;
};

export class S3Storage {
  private client: S3Client;
  private bucket: string;

  constructor(config: S3Config) {
    this.bucket = config.S3_BUCKET;
    this.client = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  /**
   * Store metadata and data files in the S3-compatible storage
   * @param key - The base key/path for the files (e.g., "uuid-timestamp")
   * @param metadata - The metadata object to store as JSON
   * @param tempFilePath - Path to the temporary CSV data file
   */
  async store(
    key: string,
    metadata: Metadata,
    tempFilePath: string,
  ): Promise<void> {
    const jsonBody = Buffer.from(JSON.stringify(metadata, null, 2), "utf8");
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${key}.json`,
        Body: jsonBody,
        ContentType: "application/json",
        ContentLength: jsonBody.byteLength,
      }),
    );

    const csvStream = createReadStream(tempFilePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${key}.csv`,
        Body: csvStream,
        ContentType: "text/csv",
      }),
    );
  }
}

/**
 * Create generic S3 storage from environment variables.
 * Required: S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET
 */
export function createS3Storage(
  config: S3Config = process.env as S3Config,
): S3Storage | null {
  if (
    !config.S3_ENDPOINT ||
    !config.S3_REGION ||
    !config.S3_ACCESS_KEY_ID ||
    !config.S3_SECRET_ACCESS_KEY ||
    !config.S3_BUCKET
  ) {
    return null;
  }
  return new S3Storage(config);
}
