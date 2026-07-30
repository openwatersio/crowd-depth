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
  /** Ignore markerless objects younger than this; they may still be in flight */
  minAgeMs?: number;
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
 * `.failed.json` marker, or no marker at all (the request died mid-flight).
 * Terminal outcomes get a `.done.json` and are never touched again.
 */
export async function sweep({
  storage,
  url = NOAA_CSB_URL,
  token = NOAA_CSB_TOKEN,
  days = 14,
  minAgeMs = 10 * 60 * 1000,
}: SweepOptions): Promise<SweepSummary> {
  const summary: SweepSummary = { submitted: 0, rejected: 0, deferred: 0 };
  const cutoff = Date.now() - minAgeMs;

  for (const prefix of dayPrefixes(days)) {
    for (const key of await findPending(storage, prefix, cutoff)) {
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
  cutoff: number,
): Promise<string[]> {
  const entries = new Map<
    string,
    { uploaded?: Date; done?: boolean; failed?: boolean }
  >();

  const entry = (key: string) => {
    let value = entries.get(key);
    if (!value) entries.set(key, (value = {}));
    return value;
  };

  for (const object of await storage.list(prefix)) {
    if (object.key.endsWith(".done.json")) {
      entry(object.key.slice(0, -".done.json".length)).done = true;
    } else if (object.key.endsWith(".failed.json")) {
      entry(object.key.slice(0, -".failed.json".length)).failed = true;
    } else if (object.key.endsWith(".result.json")) {
      // Legacy marker from before the sweep existed. Terminal either way:
      // failures under the old protocol were retried by the vessel itself.
      entry(object.key.slice(0, -".result.json".length)).done = true;
    } else if (object.key.endsWith(".geojson")) {
      entry(object.key.slice(0, -".geojson".length)).uploaded = object.uploaded;
    }
  }

  return [...entries]
    .filter(
      ([, e]) =>
        e.uploaded && !e.done && (e.failed || e.uploaded.getTime() < cutoff),
    )
    .map(([key]) => key);
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
