import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream } from "fs";
import createDebug from "debug";

const debug = createDebug("crowd-depth:s3");

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
   * @param uuid - The uuid of the vessel
   * @param tempFilePath - Path to the temporary geojson file
   */
  async store(uuid: string, tempFilePath: string): Promise<void> {
    const key = generateKey(uuid);

    debug("Storing to S3 with key %s", key);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${key}.geojson`,
        Body: createReadStream(tempFilePath),
        ContentType: "application/geo+json",
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
    debug("S3 storage not configured, missing environment variables");
    return null;
  }

  debug(
    "Using S3 storage with endpoint %s and bucket %s",
    config.S3_ENDPOINT,
    config.S3_BUCKET,
  );
  return new S3Storage(config);
}

function generateKey(uuid: string) {
  const now = new Date();
  const [date, time] = now.toISOString().split("T");
  const [y, m, d] = date.split("-");

  return `${y}/${m}/${d}/${time}-${uuid}`;
}
