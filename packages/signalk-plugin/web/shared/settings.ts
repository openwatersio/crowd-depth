// Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.
/** The extension's user settings, shared by the config panel (which edits
 * them), the runtime (which applies them) and the render Worker (which draws
 * with them). Persisted in host state under the extension scope. */

export interface LayerSettings {
  enabled: boolean;
  /** Depth (metres) the shading runs to; deeper is left to the chart. */
  shadeLimitMetres: number;
  /** Depth (metres) between isobaths. */
  contourIntervalMetres: number;
  /** Grid cell size in screen pixels; also the base label size. */
  cellPx: number;
  /** Fractional depth difference (0.15 = 15%) within which adjacent cells
   * merge into one group. */
  mergeTolerance: number;
  /** Samples deeper than this (metres) are not drawn. */
  maxDepthMetres: number;
  /** Samples at or below this depth (metres) are marked individually. */
  safetyDepthMetres: number;
}

export const DEFAULT_SETTINGS: LayerSettings = {
  enabled: true,
  shadeLimitMetres: 10,
  contourIntervalMetres: 1,
  cellPx: 24,
  mergeTolerance: 0.15,
  maxDepthMetres: 100,
  safetyDepthMetres: 3,
};

/** The settings keys, with the bounds the config panel clamps to. */
export const SETTINGS_BOUNDS: Partial<
  Record<keyof LayerSettings, { min: number; max: number; step: number }>
> = {
  shadeLimitMetres: { min: 1, max: 200, step: 1 },
  contourIntervalMetres: { min: 0.5, max: 50, step: 0.5 },
  cellPx: { min: 4, max: 128, step: 1 },
  mergeTolerance: { min: 0, max: 1, step: 0.01 },
  maxDepthMetres: { min: 1, max: 500, step: 1 },
  safetyDepthMetres: { min: 0, max: 50, step: 0.5 },
};

/** Merge stored state over the defaults, ignoring unknown/ill-typed keys. */
export function mergeSettings(
  stored: Record<string, unknown> | undefined,
): LayerSettings {
  const out = { ...DEFAULT_SETTINGS };
  if (!stored) {
    return out;
  }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof LayerSettings)[]) {
    const value = stored[key];
    if (typeof value === typeof DEFAULT_SETTINGS[key]) {
      (out[key] as unknown) = value;
    }
  }
  return out;
}
