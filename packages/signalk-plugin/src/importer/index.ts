import { createHash } from "crypto";
import { readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";
import { Readable } from "stream";
import { text } from "stream/consumers";
import { Temporal } from "@js-temporal/polyfill";
import { BATHY_URL } from "../constants.js";
import type { Config } from "../config.js";
import type { VesselInfo } from "../metadata.js";
import { createGeoJSON, submitGeoJSON } from "../reporters/noaa.js";
import {
  convertGpx,
  DepthReferences,
  parseInterval,
  type ConversionOptions,
  type DepthReference,
} from "./convert.js";
import { parseRaymarineGpx } from "./gpx.js";

export type ImportOptions = ConversionOptions & {
  file: string;
  apiBaseUrl: string;
  identityFile: string;
  ledgerFile: string;
  upload: boolean;
  out?: string;
};

export type ImportSummary = {
  file: string;
  trackpoints: number;
  pointsWithDepth: number;
  pointsWithoutDepth: number;
  importedPoints: number;
  deduplicatedPoints: number;
  from: string;
  to: string;
  minDepth: number;
  maxDepth: number;
  timestampSource: "gpx" | "cli" | "mixed";
  depthReference: "belowWaterline";
};

export async function runImport(options: ImportOptions) {
  const xml = await readFile(options.file, "utf8");
  const parsed = parseRaymarineGpx(xml);
  const converted = convertGpx(parsed, options);
  const summary = summarize(
    options.file,
    parsed.trackpoints,
    parsed.pointsWithoutDepth,
    converted,
  );
  const vessel = options.upload
    ? await readIdentity(options.identityFile)
    : previewVessel;
  const config = importerConfig(options);

  if (options.out) {
    const geojson = await text(
      createGeoJSON(config, vessel, Readable.from(converted.data)),
    );
    await writeFile(options.out, geojson, "utf8");
  }

  let submission: Awaited<ReturnType<typeof submitGeoJSON>> | undefined;
  if (options.upload) {
    const ledgerKey = createLedgerKey(xml, options);
    const ledger = await readLedger(options.ledgerFile);
    if (ledger[ledgerKey])
      throw new Error(
        `This file and option set was already uploaded at ${ledger[ledgerKey]}; ledger: ${options.ledgerFile}`,
      );
    submission = await submitGeoJSON(
      options.apiBaseUrl,
      config,
      vessel,
      Readable.from(converted.data),
    );
    if (!submission.success)
      throw new Error(`Upload was rejected: ${submission.message}`);
    ledger[ledgerKey] = new Date().toISOString();
    await writeFile(
      options.ledgerFile,
      JSON.stringify(ledger, null, 2) + "\n",
      "utf8",
    );
  }

  return { summary, submission };
}

export function summarize(
  file: string,
  trackpoints: number,
  pointsWithoutDepth: number,
  converted: ReturnType<typeof convertGpx>,
): ImportSummary {
  if (converted.data.length === 0)
    throw new Error("No points remain after filtering");
  const depths = converted.data.map(({ depth }) => depth);
  const times = converted.data
    .map(({ timestamp }) => timestamp)
    .sort(Temporal.Instant.compare);
  return {
    file: resolve(file),
    trackpoints,
    pointsWithDepth: trackpoints - pointsWithoutDepth,
    pointsWithoutDepth,
    importedPoints: converted.data.length,
    deduplicatedPoints: converted.deduplicatedPoints,
    from: times[0].toString(),
    to: times.at(-1)!.toString(),
    minDepth: Math.min(...depths),
    maxDepth: Math.max(...depths),
    timestampSource: converted.timestampSource,
    depthReference: "belowWaterline",
  };
}

export function formatSummary(summary: ImportSummary) {
  return [
    `File: ${summary.file}`,
    `Trackpoints: ${summary.trackpoints}`,
    `Points with depth: ${summary.pointsWithDepth}`,
    `Points without depth: ${summary.pointsWithoutDepth}`,
    `Imported points: ${summary.importedPoints}`,
    `Deduplicated points: ${summary.deduplicatedPoints}`,
    `Time range: ${summary.from} – ${summary.to}`,
    `Depth range: ${summary.minDepth}–${summary.maxDepth} m (below waterline)`,
    `Timestamp source: ${summary.timestampSource}`,
  ].join("\n");
}

export function parseArgs(argv: string[]): ImportOptions {
  const [file, ...args] = argv;
  if (!file || file.startsWith("--"))
    throw new Error(
      "Usage: crowd-depth-import <track.gpx> --depth-reference <reference> [options]",
    );
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set([
    "--depth-reference",
    "--started-at",
    "--interval",
    "--transducer-depth",
    "--draft",
    "--dedupe-distance-meters",
    "--max-points",
    "--api-base-url",
    "--identity-file",
    "--ledger-file",
    "--out",
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    if (["--upload", "--dry-run"].includes(arg)) flags.add(arg);
    else {
      if (!valueOptions.has(arg)) throw new Error(`Unknown option: ${arg}`);
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} requires a value`);
      values.set(arg, value);
    }
  }
  if (flags.has("--upload") && flags.has("--dry-run"))
    throw new Error("Use either --upload or --dry-run, not both");
  const depthReference = values.get("--depth-reference") as
    | DepthReference
    | undefined;
  if (!depthReference || !DepthReferences.includes(depthReference))
    throw new Error(
      `--depth-reference is required (${DepthReferences.join(", ")})`,
    );
  const number = (name: string) => {
    const value = values.get(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
      throw new Error(`${name} must be a finite number`);
    return parsed;
  };
  const startedAtValue = values.get("--started-at");
  let startedAt: Temporal.Instant | undefined;
  if (startedAtValue) {
    try {
      startedAt = Temporal.Instant.from(startedAtValue);
    } catch (cause) {
      throw new Error(`Invalid --started-at: ${startedAtValue}`, { cause });
    }
  }
  return {
    file: resolve(file),
    depthReference,
    startedAt,
    interval: values.has("--interval")
      ? parseInterval(values.get("--interval")!)
      : undefined,
    transducerDepth: number("--transducer-depth"),
    draft: number("--draft"),
    dedupeDistanceMeters: number("--dedupe-distance-meters"),
    maxPoints: number("--max-points"),
    apiBaseUrl: values.get("--api-base-url") ?? BATHY_URL,
    identityFile: resolve(
      values.get("--identity-file") ??
        join(
          homedir(),
          ".signalk",
          "plugin-data",
          "crowd-depth",
          "identity.json",
        ),
    ),
    ledgerFile: resolve(
      values.get("--ledger-file") ?? ".crowd-depth-import-ledger.json",
    ),
    out: values.get("--out") ? resolve(values.get("--out")!) : undefined,
    upload: flags.has("--upload"),
  };
}

async function readIdentity(path: string): Promise<VesselInfo> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new Error(`Cannot read identity file ${path}`, { cause });
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("uuid" in value) ||
    !("token" in value)
  )
    throw new Error(`Identity file ${path} must contain uuid and token`);
  return value as VesselInfo;
}

function importerConfig(options: ImportOptions): Config {
  return {
    path: "belowSurface",
    sounder: {
      x: 0,
      y: 0,
      z: options.transducerDepth ?? 0,
      draft: options.draft,
    },
    gnss: { x: 0, y: 0, z: 0 },
    sharing: { anonymous: false },
  };
}

const previewVessel: VesselInfo = { uuid: "preview", token: "preview" };

function createLedgerKey(xml: string, options: ImportOptions) {
  return createHash("sha256")
    .update(xml)
    .update(
      JSON.stringify({
        depthReference: options.depthReference,
        startedAt: options.startedAt?.toString(),
        interval: options.interval?.toString(),
        transducerDepth: options.transducerDepth,
        draft: options.draft,
        dedupeDistanceMeters: options.dedupeDistanceMeters,
        maxPoints: options.maxPoints,
        apiBaseUrl: options.apiBaseUrl,
      }),
    )
    .digest("hex");
}

async function readLedger(path: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read import ledger ${path}`, { cause: error });
  }
}
