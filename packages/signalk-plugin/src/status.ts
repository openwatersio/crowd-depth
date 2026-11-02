import { Temporal } from "@js-temporal/polyfill";
import { ServerAPI } from "@signalk/server-api";

export type Status = ReturnType<typeof createStatus>;

export function createStatus(app: ServerAPI) {
  const state = {
    usingHistory: false,
    waitingForHistory: false,
    collecting: false,
    lastReport: undefined as Temporal.Instant | undefined,
    nextReport: undefined as Temporal.Instant | undefined,
  };
  const errors = new Map<string, Error>();

  function getStatusMessage() {
    return (
      [
        state.collecting && "Collecting bathymetry",
        state.usingHistory && "Using history",
        state.waitingForHistory && "Waiting for a history provider",
        state.lastReport && `Checked through ${state.lastReport.toString()}`,
        state.nextReport && `Next report at ${state.nextReport.toString()}`,
      ]
        .filter(Boolean)
        .join(", ") || "Idle"
    );
  }

  function updateStatus() {
    const message = getStatusMessage();
    if (errors.size)
      app.setPluginError(
        `${[...errors.values()].map((err) => err.message).join("; ")}; ${message}`,
      );
    else app.setPluginStatus(message);
  }

  return {
    get state() {
      return { ...state };
    },

    set(newState: Partial<typeof state>) {
      Object.assign(state, newState);
      updateStatus();
      return state;
    },

    clearError(source: string) {
      errors.delete(source);
      updateStatus();
    },

    error(value: unknown, source = "plugin") {
      const err = value instanceof Error ? value : new Error(String(value));
      // @ts-expect-error: it does accept an Error
      app.error(err);
      errors.set(source, err);
      updateStatus();
      return err;
    },
  };
}
