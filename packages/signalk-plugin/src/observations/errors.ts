/** This window cannot succeed by retrying the same data; leave it incomplete. */
export class ObservationDataError extends Error {
  override name = "ObservationDataError";
}

export function isObservationDataError(
  error: unknown,
): error is ObservationDataError {
  return error instanceof Error && error.name === "ObservationDataError";
}

/** Internal worker backpressure; queued opens resume when a reader is released. */
export class ObservationReadBusy extends Error {
  override name = "ObservationReadBusy";
  constructor() {
    super("Owned merged read queue full");
  }
}
