import { Temporal } from "@js-temporal/polyfill";
import { BathymetrySource } from "../types.js";
import { Status } from "../status.js";
import { waitForHistorySource } from "./history.js";

export interface SettleSourceOptions {
  findHistory: () => Promise<BathymetrySource | undefined>;
  sqlite: BathymetrySource;
  /** Starts recording into SQLite until the signal aborts. */
  record: (signal: AbortSignal) => void;
  status: Status;
  wait: Temporal.Duration;
  interval?: Temporal.Duration;
  /** The plugin's lifetime: once it aborts, nothing may keep running. */
  signal: AbortSignal;
}

/**
 * Picks the source to report from. A history provider found at startup wins
 * outright. Otherwise the plugin records to SQLite while it waits for one, and
 * keeps whichever source settles. Reporting should start only after that: a
 * first report read from a nearly empty SQLite would mark everything a late
 * provider holds as already reported.
 *
 * Resolves to undefined when the plugin stops first, with no recording left
 * running.
 */
export async function settleSource({
  findHistory,
  sqlite,
  record,
  status,
  wait,
  interval,
  signal,
}: SettleSourceOptions): Promise<BathymetrySource | undefined> {
  const history = await findHistory();
  if (signal.aborted) return;
  if (history) {
    status.set({ usingHistory: true });
    return history;
  }

  const recording = new AbortController();
  const stopRecording = () => recording.abort(signal.reason);
  signal.addEventListener("abort", stopRecording, { once: true });
  status.set({ collecting: true, waitingForHistory: true });
  record(recording.signal);

  const late = await waitForHistorySource(findHistory, {
    timeout: wait,
    ...(interval ? { interval } : {}),
    signal,
  });
  status.set({ waitingForHistory: false });
  if (signal.aborted) return;
  if (!late) return sqlite;

  // The provider records the same stream itself.
  signal.removeEventListener("abort", stopRecording);
  recording.abort("History provider found");
  status.clearError("collector");
  status.set({ collecting: false, usingHistory: true });
  return late;
}
