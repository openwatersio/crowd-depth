// Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.
/// <reference lib="webworker" />
//
// The render Worker: turns the soundings into one overlay frame.
//
// It is kept off the runtime iframe's main thread — on several engines an
// extension iframe shares the host page's main thread, so a heavy render here
// would stall the whole chart. The runtime sends it the soundings and settings;
// on each `render` request it builds (once per data change) the depth field,
// runs a WebGL2 pass that shades the surface and draws isobaths, composites
// that onto a 2D canvas that adds the shoal/cluster dots and their depth
// labels, and hands the result back as an ImageBitmap.
//
// Geometry: the host asks for a north-up, axis-aligned EPSG:3857 box whose
// pixels are evenly spaced in Mercator metres. The field is built in the same
// space, so a frame is a re-raster of the cached field — panning or zooming
// never changes the surface (and the absolute-depth isobars stay put).

import { buildDepthField, type DepthField } from "./shared/bathymetry.js";
import { DEPTH_FRAG_SRC, DEPTH_VERT_SRC } from "./shared/shaders.js";
import {
  SHADE_CONTOUR_LEVELS,
  depthClusters,
  depthCss,
  mercX,
  mercY,
  selectShoals,
  shadeColor,
  type DepthSample,
} from "./shared/live-depth.js";
import type { LayerSettings } from "./shared/settings.js";
import type {
  RenderRequest,
  RenderWorkerIn,
  RenderWorkerOut,
} from "./shared/protocol.js";

/** Hard cap on a field dimension; if the cell would exceed it the cells are
 * grown to fit, so the grid always covers the whole data extent. */
const MAX_FIELD_CELLS = 1024;
/** Label size (CSS px): scaled with zoom between a readable floor and a cap. */
const LABEL_FONT_MIN = 12;
const LABEL_FONT_MAX = 20;
/** Smallest on-screen radius (CSS px) at which a group is labelled. */
const LABEL_MIN_RADIUS_PX = 8;

const ORIGIN_SHIFT = Math.PI * 6378137;
const WORLD_WIDTH = 2 * ORIGIN_SHIFT;

let samples: DepthSample[] = [];
let settings: LayerSettings | null = null;
/** Ground size of a cell in the tiles the samples came from, in metres. */
let tileCellMetres = 0;
let field: DepthField | null = null;
let fieldDirty = true;
/** The user's preferred depth unit (`"m"` or `"foot"`), for the labels. */
let depthUnit = "m";

/** A depth in the user's unit: whole feet, or a tenth of a metre. */
function formatDepth(metres: number): string {
  return depthUnit === "foot"
    ? (metres / 0.3048).toFixed(0)
    : metres.toFixed(1);
}

// ******** WebGL ********

let glCanvas: OffscreenCanvas | null = null;
let gl: WebGL2RenderingContext | null = null;
let program: WebGLProgram | null = null;
let quad: WebGLBuffer | null = null;
let depthTexture: WebGLTexture | null = null;
let lutTexture: WebGLTexture | null = null;
let aPos = 0;
let uDepth: WebGLUniformLocation | null = null;
let uLut: WebGLUniformLocation | null = null;
let uTexel: WebGLUniformLocation | null = null;
let uView: WebGLUniformLocation | null = null;
let uField: WebGLUniformLocation | null = null;
let uShadeLimit: WebGLUniformLocation | null = null;
let uLevels: WebGLUniformLocation | null = null;
let uInterval: WebGLUniformLocation | null = null;
let uLineWidth: WebGLUniformLocation | null = null;

function compile(
  ctx: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader | null {
  const shader = ctx.createShader(type);
  if (!shader) return null;
  ctx.shaderSource(shader, src);
  ctx.compileShader(shader);
  if (!ctx.getShaderParameter(shader, ctx.COMPILE_STATUS)) {
    ctx.deleteShader(shader);
    return null;
  }
  return shader;
}

function initWebgl(): boolean {
  if (gl) return true;
  glCanvas = new OffscreenCanvas(1, 1);
  const ctx = glCanvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
  }) as WebGL2RenderingContext | null;
  if (!ctx) return false;
  const vs = compile(ctx, ctx.VERTEX_SHADER, DEPTH_VERT_SRC);
  const fs = compile(ctx, ctx.FRAGMENT_SHADER, DEPTH_FRAG_SRC);
  const prog = ctx.createProgram();
  if (!vs || !fs || !prog) return false;
  ctx.attachShader(prog, vs);
  ctx.attachShader(prog, fs);
  ctx.linkProgram(prog);
  if (!ctx.getProgramParameter(prog, ctx.LINK_STATUS)) return false;

  gl = ctx;
  program = prog;
  aPos = ctx.getAttribLocation(prog, "aPos");
  uDepth = ctx.getUniformLocation(prog, "uDepth");
  uLut = ctx.getUniformLocation(prog, "uLut");
  uTexel = ctx.getUniformLocation(prog, "uTexel");
  uView = ctx.getUniformLocation(prog, "uView");
  uField = ctx.getUniformLocation(prog, "uField");
  uShadeLimit = ctx.getUniformLocation(prog, "uShadeLimit");
  uLevels = ctx.getUniformLocation(prog, "uLevels");
  uInterval = ctx.getUniformLocation(prog, "uInterval");
  uLineWidth = ctx.getUniformLocation(prog, "uLineWidth");

  quad = ctx.createBuffer();
  ctx.bindBuffer(ctx.ARRAY_BUFFER, quad);
  ctx.bufferData(
    ctx.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    ctx.STATIC_DRAW,
  );

  depthTexture = ctx.createTexture();
  ctx.bindTexture(ctx.TEXTURE_2D, depthTexture);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.NEAREST);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.NEAREST);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);

  lutTexture = ctx.createTexture();
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = shadeColor(i / 255);
    lut[i * 4] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = 255;
  }
  ctx.bindTexture(ctx.TEXTURE_2D, lutTexture);
  ctx.texImage2D(
    ctx.TEXTURE_2D,
    0,
    ctx.RGBA,
    256,
    1,
    0,
    ctx.RGBA,
    ctx.UNSIGNED_BYTE,
    lut,
  );
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.LINEAR);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);

  return true;
}

/** Release the GL context while the overlay is hidden or suspended. */
function releaseGpu(): void {
  if (gl) {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
  gl = null;
  program = null;
  quad = null;
  depthTexture = null;
  lutTexture = null;
  glCanvas = null;
  // The field's texture went with the context; upload it again on the next
  // render, or the empty texture would shade the whole extent as 0 m.
  fieldDirty = true;
}

function uploadField(f: DepthField): void {
  if (!gl || !depthTexture) return;
  // GLSL ES does not require NaN support, so the no-coverage marker the field
  // uses on the CPU (NaN) is uploaded as -1 — a value no real depth can take —
  // and the shader tests `v < 0` for it.
  const gpu = new Float32Array(f.depth.length);
  for (let i = 0; i < f.depth.length; i++) {
    const d = f.depth[i];
    gpu[i] = Number.isNaN(d) ? -1 : d;
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, depthTexture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32F,
    f.width,
    f.height,
    0,
    gl.RED,
    gl.FLOAT,
    gpu,
  );
}

/** Build the depth field from the data alone (fixed ground resolution over the
 * data's extent), so it is independent of the current view. */
function buildField(): void {
  field = null;
  if (samples.length === 0 || !settings) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of samples) {
    const x = mercX(s.lon);
    const y = mercY(s.lat);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const padX = (maxX - minX) * 0.1 + 1;
  const padY = (maxY - minY) * 0.1 + 1;
  const extent: [number, number, number, number] = [
    minX - padX,
    minY - padY,
    maxX + padX,
    maxY + padY,
  ];
  const extMax = Math.max(extent[2] - extent[0], extent[3] - extent[1]);
  // Tile samples sit at tile cell centres, so a sounding reaches just past the
  // next tile cell and no further: a track draws as a continuous ribbon, never
  // wider than the cells it was sounded in.
  const cell = Math.max(extMax / MAX_FIELD_CELLS, tileCellMetres / 2, 0.01);
  const built = buildDepthField(samples, extent, {
    cellMetres: cell,
    coverageMetres: Math.max(tileCellMetres, cell) * 1.5,
    coverageMinMetres: 0,
  });
  if (!built) return;
  field = built;
  uploadField(built);
}

function renderGpu(
  box: readonly [number, number, number, number],
  canvasW: number,
  canvasH: number,
  ratio: number,
): void {
  const f = field;
  if (!gl || !f || !glCanvas) return;
  if (glCanvas.width !== canvasW || glCanvas.height !== canvasH) {
    glCanvas.width = canvasW;
    glCanvas.height = canvasH;
  }
  gl.viewport(0, 0, canvasW, canvasH);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, depthTexture);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, lutTexture);

  const ext = f.extent;
  const fieldCentreX = (ext[0] + ext[2]) / 2;
  const viewCentreX = (box[0] + box[2]) / 2;
  const shift =
    Math.round((fieldCentreX - viewCentreX) / WORLD_WIDTH) * WORLD_WIDTH;
  // Pass field-relative metres to the shader: absolute EPSG:3857 values
  // (~8.6e6) lose about a metre of precision in the shader's float32 maths.
  gl.uniform4f(
    uView,
    box[0] + shift - ext[0],
    box[1] - ext[1],
    box[2] - box[0],
    box[3] - box[1],
  );
  gl.uniform4f(uField, 0, 0, ext[2] - ext[0], ext[3] - ext[1]);
  gl.uniform2f(uTexel, 1 / f.width, 1 / f.height);
  gl.uniform1i(uDepth, 0);
  gl.uniform1i(uLut, 1);
  gl.uniform1f(uShadeLimit, Math.max(0.01, settings?.shadeLimitMetres ?? 10));
  gl.uniform1i(uLevels, SHADE_CONTOUR_LEVELS);
  gl.uniform1f(uInterval, Math.max(0.01, settings?.contourIntervalMetres ?? 1));
  gl.uniform1f(uLineWidth, Math.max(1, ratio));

  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

// ******** 2D overlay (dots + labels) ********

function drawOverlay(
  ctx: OffscreenCanvasRenderingContext2D,
  box: readonly [number, number, number, number],
  canvasW: number,
  canvasH: number,
  resolution: number,
  ratio: number,
  zoom: number,
): void {
  if (!settings) return;
  const boxW = box[2] - box[0];
  const boxH = box[3] - box[1];
  const centreX = (box[0] + box[2]) / 2;
  const toPixel = (lon: number, lat: number): [number, number] => {
    const mx = mercX(lon);
    const my = mercY(lat);
    const x = mx + Math.round((centreX - mx) / WORLD_WIDTH) * WORLD_WIDTH;
    return [((x - box[0]) / boxW) * canvasW, ((box[3] - my) / boxH) * canvasH];
  };
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const dot = (p: [number, number], depth: number) => {
    ctx.beginPath();
    ctx.arc(
      p[0],
      p[1],
      Math.max(1.5, settings!.cellPx * 0.12) * ratio,
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = depthCss(depth, settings!.shadeLimitMetres, 0.95);
    ctx.fill();
  };
  const label = (text: string, p: [number, number], fontCss: number) => {
    ctx.font = `${Math.round(fontCss * ratio)}px Roboto, Arial, sans-serif`;
    ctx.lineWidth = Math.max(2, 2 * ratio);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.strokeText(text, p[0], p[1]);
    ctx.fillStyle = "rgba(0,0,0,0.95)";
    ctx.fillText(text, p[0], p[1]);
  };

  selectShoals(samples, settings.safetyDepthMetres).forEach((s) =>
    dot(toPixel(s.lon, s.lat), s.depth),
  );

  const cellSize = Math.max(1, settings.cellPx * resolution);
  const clusters = depthClusters(
    samples,
    cellSize,
    settings.mergeTolerance,
    settings.maxDepthMetres,
  );
  for (const c of clusters) {
    const p = toPixel(c.lon, c.lat);
    dot(p, c.depth);
    const radiusPx = (c.radiusMetres / resolution) * ratio;
    if (radiusPx >= LABEL_MIN_RADIUS_PX) {
      const fontCss = Math.max(
        LABEL_FONT_MIN,
        Math.min(LABEL_FONT_MAX, (zoom - 8) * 1.5 + LABEL_FONT_MIN),
      );
      label(formatDepth(c.depth), p, fontCss);
    }
  }
}

// ******** message handling ********

function render(req: RenderRequest): void {
  try {
    if (!initWebgl()) {
      post({ type: "error", message: "WebGL2 unavailable" });
      return;
    }
    if (fieldDirty || !field) {
      buildField();
      fieldDirty = false;
    }
    const { extent, width, height, pixelRatio, resolution, zoom } = req;
    const box: [number, number, number, number] = [
      extent[0],
      extent[1],
      extent[2],
      extent[3],
    ];
    const out = new OffscreenCanvas(width, height);
    const ctx = out.getContext("2d");
    if (!ctx) {
      post({ type: "error", message: "no 2D context" });
      return;
    }
    ctx.clearRect(0, 0, width, height);
    if (field) {
      renderGpu(box, width, height, pixelRatio);
      ctx.drawImage(glCanvas as unknown as CanvasImageSource, 0, 0);
    }
    drawOverlay(ctx, box, width, height, resolution, pixelRatio, zoom);
    const image = out.transferToImageBitmap();
    post({ type: "frame", requestId: req.requestId, image }, [image]);
  } catch (err) {
    post({ type: "error", message: String(err) });
  }
}

function post(message: RenderWorkerOut, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(message, transfer ?? []);
}

self.onmessage = (e: MessageEvent<RenderWorkerIn>) => {
  const msg = e.data;
  switch (msg.type) {
    case "samples":
      samples = msg.samples;
      tileCellMetres = msg.cellMetres;
      fieldDirty = true;
      break;
    case "settings":
      settings = msg.settings;
      fieldDirty = true;
      break;
    case "units":
      depthUnit = msg.depth;
      break;
    case "render":
      render(msg.req);
      break;
    case "release":
      releaseGpu();
      break;
  }
};
