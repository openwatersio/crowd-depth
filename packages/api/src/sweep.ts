import { Readable } from "stream";
import { submitFormData, SubmissionError } from "crowd-depth";
import { NOAA_CSB_URL, NOAA_CSB_TOKEN } from "./api.js";
import type { R2Storage } from "./r2.js";
import { getLogger } from "./logger.js";

const logger = getLogger("sweep");

export type SweepOptions = {
  storage: R2Storage;
  url?: string;
  token?: string;
  /** How many days back to scan for undelivered submissions */
  days?: number;
};

export type SweepSummary = {
  /** Submissions NOAA accepted this run */
  submitted: number;
  /** Submissions NOAA rejected permanently (4xx) this run */
  rejected: number;
  /** Submissions that failed retryably and stay queued */
  deferred: number;
};

/**
 * Resubmit stored data that never reached NOAA: objects with a retryable
 * `.failed.json` marker and no terminal `.done.json`. Anything else is the
 * vessel's to retry — it never received a queued 200 for that upload.
 */
export async function sweep({
  storage,
  url = NOAA_CSB_URL,
  token = NOAA_CSB_TOKEN,
  days = 14,
}: SweepOptions): Promise<SweepSummary> {
  const summary: SweepSummary = { submitted: 0, rejected: 0, deferred: 0 };

  for (const prefix of dayPrefixes(days)) {
    for (const key of await findPending(storage, prefix)) {
      await resubmit(storage, url, token, key, summary);
    }
  }

  logger.info(summary, "Sweep complete");
  return summary;
}

/** Day prefixes (`YYYY/MM/DD/`) for today and the previous `days` days. */
function dayPrefixes(days: number): string[] {
  return Array.from({ length: days + 1 }, (_, i) => {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10).replaceAll("-", "/") + "/";
  });
}

async function findPending(
  storage: R2Storage,
  prefix: string,
): Promise<string[]> {
  const failed = new Set<string>();
  const done = new Set<string>();

  for (const object of await storage.list(prefix)) {
    if (object.key.endsWith(".failed.json")) {
      failed.add(object.key.slice(0, -".failed.json".length));
    } else if (object.key.endsWith(".done.json")) {
      done.add(object.key.slice(0, -".done.json".length));
    }
  }

  return [...failed].filter((key) => !done.has(key));
}

async function resubmit(
  storage: R2Storage,
  url: string,
  token: string,
  key: string,
  summary: SweepSummary,
) {
  const data = await storage.getData(key);
  if (!data) return;

  // Keys end with the vessel uuid: YYYY/MM/DD/<time>-<uuid>
  const uuid = key.slice(-36);
  const uniqueID = `SIGNALK-${uuid}`;
  const previous = await storage.getJSON(`${key}.failed.json`);
  const attempts = (Number(previous?.attempts) || 1) + 1;
  const bytes = data.byteLength;

  logger.info({ key, attempts, bytes }, "Resubmitting to NOAA");
  const started = Date.now();

  try {
    const submission = await submitFormData(
      new URL("geojson", url),
      uuid,
      { uniqueID },
      Readable.from([data]),
      { "x-auth-token": token },
    );

    await storage.storeDone(key, {
      success: true,
      uuid,
      uniqueID,
      bytes,
      durationMs: Date.now() - started,
      attempts,
      submission,
    });
    summary.submitted++;
  } catch (err) {
    const upstream = err instanceof SubmissionError;
    const permanent = upstream && err.status >= 400 && err.status < 500;
    const failure = {
      success: false,
      uuid,
      uniqueID,
      bytes,
      durationMs: Date.now() - started,
      noaaStatus: upstream ? err.status : undefined,
      noaaBody: upstream ? err.body : undefined,
      message: err instanceof Error ? err.message : String(err),
      attempts,
      lastAttempt: new Date().toISOString(),
    };

    logger.error({ err, key, attempts }, "Resubmission failed");
    if (permanent) {
      await storage.storeDone(key, failure);
      summary.rejected++;
    } else {
      await storage.storeFailed(key, failure);
      summary.deferred++;
    }
  }
}
