// The "My soundings" settings panel: a keepAlive iframe the host opens from the
// toolbar button or the layer's "Layer settings" row. It edits the
// extension's state, which the host persists and rebroadcasts (`state.changed`),
// so the runtime picks changes up without a direct connection between the two
// contexts.
//
// Depth-valued settings are shown in the user's preferred depth unit
// (`units.get`) and stored in metres.
//
// Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.

import { connectExtension } from "signalk-plotterext-bus/extension";
import {
  DEFAULT_SETTINGS,
  SETTINGS_BOUNDS,
  mergeSettings,
  type LayerSettings,
} from "./shared/settings.js";

/** Metres in a foot. */
const METRES_PER_FOOT = 0.3048;

const client = await connectExtension();
let settings: LayerSettings = { ...DEFAULT_SETTINGS };
let depthUnit: "m" | "foot" = "m";

const root = document.getElementById("root")!;

interface Field {
  key: keyof LayerSettings;
  label: string;
  hint?: string;
  /** A unit shown after the input. */
  suffix?: string;
  /** Shown in the user's depth unit, stored in metres. */
  depth?: boolean;
}

const FIELDS: Field[] = [
  {
    key: "shadeLimitMetres",
    label: "Shade limit",
    hint: "Depth the shading runs to; deeper is left to the chart.",
    depth: true,
  },
  {
    key: "contourIntervalMetres",
    label: "Isobath interval",
    hint: "Depth between isobaths.",
    depth: true,
  },
  {
    key: "cellPx",
    label: "Grid cell",
    hint: "Circle diameter, in screen pixels.",
    suffix: "px",
  },
  {
    key: "mergeTolerance",
    label: "Merge band",
    hint: "Adjacent positions within this depth fraction merge into one circle.",
  },
  {
    key: "maxDepthMetres",
    label: "Max depth",
    hint: "Samples deeper than this are not drawn.",
    depth: true,
  },
  {
    key: "safetyDepthMetres",
    label: "Safety depth",
    hint: "Samples at or below this depth are marked individually.",
    depth: true,
  },
];

const unitSymbol = () => (depthUnit === "foot" ? "ft" : "m");
const toDisplay = (metres: number) =>
  depthUnit === "foot" ? metres / METRES_PER_FOOT : metres;
const fromDisplay = (value: number) =>
  depthUnit === "foot" ? value * METRES_PER_FOOT : value;
const round = (v: number) => Math.round(v * 100) / 100;

/** The bounds a field is shown and clamped with, in the unit it is shown in.
 * A depth setting is stored in metres but read in the user's unit; converting
 * the metre bounds outright gives awkward values in feet (0.5 m = 1.64 ft), so
 * a typed whole foot would be snapped away. In feet the bounds are whole
 * numbers and the step is one; in metres they are used as-is. */
function displayBounds(field: Field): {
  min: number;
  max: number;
  step: number;
} {
  const b = SETTINGS_BOUNDS[field.key]!;
  if (!field.depth || depthUnit !== "foot") {
    return b;
  }
  return {
    min: Math.floor(toDisplay(b.min)),
    max: Math.round(toDisplay(b.max)),
    step: 1,
  };
}

function numberField(field: Field): HTMLElement {
  const { min: lo, max: hi, step } = displayBounds(field);

  const wrap = document.createElement("label");
  wrap.className = "field";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = field.label;
  wrap.appendChild(name);

  const control = document.createElement("span");
  control.className = "control";
  const input = document.createElement("input");
  input.type = "number";
  input.min = `${lo}`;
  input.max = `${hi}`;
  input.step = `${step}`;
  const stored = settings[field.key] as number;
  input.value = `${round(field.depth ? toDisplay(stored) : stored)}`;
  input.addEventListener("change", () => {
    const clamped = Math.min(hi, Math.max(lo, Number(input.value)));
    input.value = `${round(clamped)}`;
    (settings[field.key] as number) = field.depth
      ? fromDisplay(clamped)
      : clamped;
    void save();
  });
  control.appendChild(input);
  const suffix = document.createElement("span");
  suffix.className = "suffix";
  suffix.textContent = field.depth ? unitSymbol() : (field.suffix ?? "");
  control.appendChild(suffix);
  wrap.appendChild(control);

  if (field.hint) {
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = field.hint;
    wrap.appendChild(hint);
  }

  return wrap;
}

function build(): void {
  root.replaceChildren();

  const heading = document.createElement("h2");
  heading.textContent = "My soundings";
  root.appendChild(heading);

  const notice = document.createElement("p");
  notice.className = "hint";
  notice.textContent =
    "Raw depths from this boat's sounder, as Crowd Depth records them. " +
    "Not corrected for tide or checked against surveys. Not for navigation.";
  root.appendChild(notice);

  const enabled = document.createElement("label");
  enabled.className = "field row";
  const enabledName = document.createElement("span");
  enabledName.className = "name";
  enabledName.textContent = "Show the layer";
  const enabledInput = document.createElement("input");
  enabledInput.type = "checkbox";
  enabledInput.checked = settings.enabled;
  enabledInput.addEventListener("change", () => {
    settings.enabled = enabledInput.checked;
    void save();
  });
  enabled.append(enabledName, enabledInput);
  root.appendChild(enabled);

  for (const field of FIELDS) {
    root.appendChild(numberField(field));
  }
}

async function save(): Promise<void> {
  await client.state.set(settings as unknown as Record<string, unknown>);
}

async function load(): Promise<void> {
  try {
    settings = mergeSettings(
      (await client.state.get()) as Record<string, unknown>,
    );
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  try {
    const res = (await client.call("units.get")) as {
      units?: { depth?: string };
    };
    depthUnit = res?.units?.depth === "foot" ? "foot" : "m";
  } catch {
    depthUnit = "m";
  }
  build();
}

await load();
