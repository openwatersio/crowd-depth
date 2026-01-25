import { Temporal } from "@js-temporal/polyfill";
import { ServerAPI } from "@signalk/server-api";

export type Status = ReturnType<typeof createStatus>;

export function createStatus(app: ServerAPI) {
  const state = {
    usingHistory: false,
    collecting: false,
    lastReport: undefined as Temporal.Instant | undefined,
    nextReport: undefined as Temporal.Instant | undefined,
  };

  function getStatusMessage() {
    return (
      [
        state.collecting && "Collecting bathymetry",
        state.usingHistory && "Using history",
        state.lastReport && `Reported at ${state.lastReport.toLocaleString()}`,
        state.nextReport &&
          `Next report at ${state.nextReport.toLocaleString()}`,
      ]
        .filter(Boolean)
        .join(", ") || "Idle"
    );
  }

  function updateStatus() {
    app.setPluginStatus(getStatusMessage());
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

    error(err: Error) {
      // @ts-expect-error: it does accept an Error
      app.error(err);
      app.setPluginError(err.message);
      return err;
    },
  };
}
