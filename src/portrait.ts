import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { clamp, traceCurve, type Pt } from "./geometry";
import { pushPullFill } from "./inpaint";
import { CHEEKS, EYE_A, EYE_B, IRISES, NOSE_TIP } from "./vision";

/** Longest side of the working image; larger uploads are downscaled. */
const MAX_SIDE = 2048;
/** Radius (in iris radii) of the area repainted as sclera, and where that repaint fades out. */
const HOLE_R = 1.15;
const HOLE_FADE_R = 1.35;
/** Radius (in iris radii) of the movable iris disc; slightly larger than the iris to carry the limbal ring. */
const DISC_R = 1.08;
const FALLBACK_SCLERA = [222, 214, 206];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Eye {
  /** Upper and lower lid curves in image pixels, ordered left to right. */
  upper: Pt[];
  lower: Pt[];
  iris: Pt;
  irisR: number;
  minX: number;
  maxX: number;
  /** Largest vertical gap between the lids. */
  opening: number;
  crop: Rect;
  /** Crop-sized canvas whose alpha is the eye opening. */
  mask: HTMLCanvasElement;
  /** Iris discs, one per `DILATIONS` level, with transparent surround; `discCenter` is the iris centre within each. */
  discs: HTMLCanvasElement[];
  discCenter: Pt;
}

export interface Face {
  /** Sorted by image x: [image-left eye, image-right eye]. */
  eyes: [Eye, Eye];
  /** Middle of the face (between the eyes and the nose tip), and cheek-to-cheek width. */
  center: Pt;
  width: number;
}

export interface Portrait {
  width: number;
  height: number;
  original: HTMLCanvasElement;
  /** The photo with every iris painted out. */
  clean: HTMLCanvasElement;
  /** Sorted by image x. */
  faces: Face[];
  warnings: string[];
}

/** Pupil sizes the discs are pre-rendered at, relative to the photo's pupil. */
export const DILATIONS = [1, 1.12, 1.24, 1.36, 1.48, 1.6, 1.72, 1.84, 1.96];
/** Faces whose irises are smaller than this (in pixels) are too small to animate. */
const MIN_IRIS_R = 2.5;
const MAX_FACES = 12;

export function analyzePortrait(source: ImageBitmap, landmarker: FaceLandmarker): Portrait {
  const scale = Math.min(1, MAX_SIDE / Math.max(source.width, source.height));
  const width = Math.round(source.width * scale);
  const height = Math.round(source.height * scale);
  const original = makeCanvas(width, height);
  const octx = original.getContext("2d", { willReadFrequently: true })!;
  octx.drawImage(source, 0, 0, width, height);

  const clean = makeCanvas(width, height);
  const cctx = clean.getContext("2d", { willReadFrequently: true })!;
  cctx.drawImage(original, 0, 0);

  const found = detectFaces(original, landmarker);
  if (found.length === 0) throw new Error("No face found in that photo. Try a clear, front-facing headshot.");

  const faces: Face[] = [];
  let skipped = 0;
  for (const pts of found.slice(0, MAX_FACES)) {
    const face = buildFace(octx, cctx, pts);
    if (face) faces.push(face);
    else skipped++;
  }
  if (faces.length === 0) throw new Error("The faces in that photo are too small to animate. Try a closer shot.");
  faces.sort((a, b) => a.center.x - b.center.x);

  const warnings: string[] = [];
  const eyes = faces.flatMap((f) => f.eyes);
  if (skipped) warnings.push(`${skipped} face${skipped > 1 ? "s were" : " was"} too small to animate.`);
  else if (Math.min(...eyes.map((e) => e.irisR)) < 5) {
    warnings.push("The eyes are small in this photo; a tighter shot will look better.");
  }
  if (Math.min(...eyes.map((e) => e.opening / e.irisR)) < 0.8) {
    warnings.push("Some eyes look nearly closed; there isn't much room for them to move.");
  }
  return { width, height, original, clean, faces, warnings };
}

/**
 * Finds faces in the whole image, then in overlapping 2x2 and 3x3 tiles: the landmarker's
 * face detector works on a small input, so faces in group shots are often only found when
 * zoomed in. Faces cut off by a tile edge are ignored; duplicates keep the first sighting.
 */
function detectFaces(image: HTMLCanvasElement, landmarker: FaceLandmarker): Pt[][] {
  const W = image.width;
  const H = image.height;
  const found: Pt[][] = [];
  const add = (tile: Rect, source: HTMLCanvasElement) => {
    for (const lm of landmarker.detect(source).faceLandmarks) {
      const xs = lm.map((p) => p.x);
      const ys = lm.map((p) => p.y);
      const edge = 0.01;
      if ((Math.min(...xs) < edge && tile.x > 0) || (Math.max(...xs) > 1 - edge && tile.x + tile.w < W)) continue;
      if ((Math.min(...ys) < edge && tile.y > 0) || (Math.max(...ys) > 1 - edge && tile.y + tile.h < H)) continue;
      const pts = lm.map((p) => ({ x: tile.x + p.x * tile.w, y: tile.y + p.y * tile.h }));
      const c = mean([pts[468], pts[473]]);
      const span = dist(pts[468], pts[473]);
      if (found.some((f) => dist(mean([f[468], f[473]]), c) < span * 0.8)) continue;
      found.push(pts);
    }
  };

  add({ x: 0, y: 0, w: W, h: H }, image);
  for (const n of [2, 3]) {
    const tw = Math.round(Math.min(W, (W / n) * 1.5));
    const th = Math.round(Math.min(H, (H / n) * 1.5));
    const tile = makeCanvas(tw, th);
    const tctx = tile.getContext("2d")!;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = Math.round((i * (W - tw)) / (n - 1));
        const y = Math.round((j * (H - th)) / (n - 1));
        tctx.drawImage(image, x, y, tw, th, 0, 0, tw, th);
        add({ x, y, w: tw, h: th }, tile);
      }
    }
  }
  return found;
}

function buildFace(octx: CanvasRenderingContext2D, cctx: CanvasRenderingContext2D, pts: Pt[]): Face | null {
  const irises = IRISES.map(({ center, ring }) => {
    const c = pts[center];
    const r = ring.reduce((sum, i) => sum + dist(pts[i], c), 0) / ring.length;
    return { c, r };
  });
  if (Math.min(...irises.map((i) => i.r)) < MIN_IRIS_R) return null;

  const eyes = [EYE_A, EYE_B].map((def) => {
    const upper = leftToRight(def.upper.map((i) => pts[i]));
    const lower = leftToRight(def.lower.map((i) => pts[i]));
    const centroid = mean([...upper, ...lower]);
    const iris = irises.reduce((a, b) => (dist(b.c, centroid) < dist(a.c, centroid) ? b : a));
    return buildEye(octx, cctx, upper, lower, iris.c, iris.r);
  });
  eyes.sort((a, b) => a.iris.x - b.iris.x);

  const eyeMid = mean([eyes[0].iris, eyes[1].iris]);
  return {
    eyes: eyes as [Eye, Eye],
    center: mean([eyeMid, pts[NOSE_TIP]]),
    width: dist(pts[CHEEKS[0]], pts[CHEEKS[1]]),
  };
}

function buildEye(
  octx: CanvasRenderingContext2D,
  cctx: CanvasRenderingContext2D,
  upper: Pt[],
  lower: Pt[],
  iris: Pt,
  irisR: number,
): Eye {
  const W = octx.canvas.width;
  const H = octx.canvas.height;
  const all = [...upper, ...lower];
  const minX = Math.min(...all.map((p) => p.x));
  const maxX = Math.max(...all.map((p) => p.x));
  const minY = Math.min(...all.map((p) => p.y));
  const maxY = Math.max(...all.map((p) => p.y));
  const pad = Math.ceil(irisR * 1.6) + 2;
  const x0 = clamp(Math.floor(minX - pad), 0, W);
  const y0 = clamp(Math.floor(minY - pad), 0, H);
  const crop: Rect = { x: x0, y: y0, w: clamp(Math.ceil(maxX + pad), 0, W) - x0, h: clamp(Math.ceil(maxY + pad), 0, H) - y0 };
  const { w, h } = crop;

  const mask = makeCanvas(w, h);
  const mctx = mask.getContext("2d", { willReadFrequently: true })!;
  mctx.translate(-x0, -y0);
  mctx.beginPath();
  traceCurve(mctx, upper);
  traceCurve(mctx, [...lower].reverse());
  mctx.closePath();
  mctx.fillStyle = "#fff";
  mctx.fill();
  const alpha = mctx.getImageData(0, 0, w, h).data;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && alpha[(y * w + x) * 4 + 3] === 255;
  // Fully inside the opening and not touching its edge: reliable eyeball pixels.
  const solid = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      solid[y * w + x] = +(inside(x, y) && inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1));
    }
  }

  const img = octx.getImageData(x0, y0, w, h);
  const pix = img.data;
  const irisDist = (x: number, y: number) => Math.hypot(x0 + x + 0.5 - iris.x, y0 + y + 0.5 - iris.y);

  // Paint the iris out: fill the hole from the surrounding sclera.
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = pix[i * 4];
    rgb[i * 3 + 1] = pix[i * 4 + 1];
    rgb[i * 3 + 2] = pix[i * 4 + 2];
  }
  const around: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (solid[i] && irisDist(i % w, Math.floor(i / w)) >= irisR * HOLE_R) around.push(i);
  }
  const weight = new Float32Array(w * h);
  for (const i of scleraLike(pix, around)) weight[i] = 1;
  const hole = weight.map((v) => 1 - v);
  fillRows(rgb, weight, w, h);
  if (!pushPullFill(rgb, weight, w, h)) {
    for (let i = 0; i < w * h; i++) rgb.set(FALLBACK_SCLERA, i * 3);
  }
  smoothColumns(rgb, hole, w, h);
  shadeUnderLid(rgb, alpha, w, h);
  const cleaned = cctx.getImageData(x0, y0, w, h);
  for (let i = 0; i < w * h; i++) {
    const d = irisDist(i % w, Math.floor(i / w));
    const t = (alpha[i * 4 + 3] / 255) * clamp((irisR * HOLE_FADE_R - d) / (irisR * (HOLE_FADE_R - HOLE_R)), 0, 1);
    if (t === 0) continue;
    for (let c = 0; c < 3; c++) cleaned.data[i * 4 + c] = pix[i * 4 + c] * (1 - t) + rgb[i * 3 + c] * t;
  }
  cctx.putImageData(cleaned, x0, y0);

  const disc = buildDisc(pix, solid, crop, iris, irisR);

  let opening = 0;
  for (const p of upper) {
    const below = lower.reduce((a, b) => (Math.abs(b.x - p.x) < Math.abs(a.x - p.x) ? b : a));
    opening = Math.max(opening, below.y - p.y);
  }

  return { upper, lower, iris, irisR, minX, maxX, opening, crop, mask, ...disc };
}

/**
 * Picks the pixels that look like the white of the eye: bright and not skin-warm. The eye
 * outline is a little loose, so the eyeball area also holds lid, lash and corner pixels that
 * would otherwise tint the fill. Falls back to everything when too little qualifies.
 */
function scleraLike(pix: Uint8ClampedArray, candidates: number[]): number[] {
  const lum = (i: number) => 0.3 * pix[i * 4] + 0.59 * pix[i * 4 + 1] + 0.11 * pix[i * 4 + 2];
  const warmth = (i: number) => pix[i * 4] - pix[i * 4 + 2];
  const brightest = [...candidates].sort((a, b) => lum(b) - lum(a)).slice(0, Math.max(1, Math.ceil(candidates.length * 0.3)));
  const refLum = lum(brightest[Math.floor(brightest.length / 2)]);
  const refWarmth = brightest.map(warmth).sort((a, b) => a - b)[Math.floor(brightest.length / 2)];
  const picked = candidates.filter((i) => lum(i) >= refLum * 0.7 && warmth(i) <= refWarmth + 25);
  return picked.length >= 8 ? picked : candidates;
}

/** Darkens the fill toward the lids, strongest under the upper lid, like a real eyeball. */
function shadeUnderLid(rgb: Float32Array, alpha: Uint8ClampedArray, w: number, h: number): void {
  for (let x = 0; x < w; x++) {
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < h; y++) {
      if (alpha[(y * w + x) * 4 + 3] === 0) continue;
      if (top < 0) top = y;
      bottom = y;
    }
    if (top < 0 || bottom === top) continue;
    for (let y = top; y <= bottom; y++) {
      const t = (y - top) / (bottom - top);
      const k = 1 - 0.28 * (1 - t) ** 2 - 0.1 * t ** 2;
      for (let c = 0; c < 3; c++) rgb[(y * w + x) * 3 + c] *= k;
    }
  }
}

/**
 * Fills each row's unknown pixels by interpolating between the nearest known pixels on the
 * left and right. Eye shading is mostly vertical (lid shadow at the top), so working row by
 * row keeps it, where a 2D fill would blend it away. Rows with nothing known are left alone.
 */
function fillRows(rgb: Float32Array, weight: Float32Array, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let prev = -1;
    for (let x = 0; x <= w; x++) {
      if (x < w && weight[row + x] < 1) continue;
      // Gap between known pixels `prev` and `x` (either may be off the row's end).
      if (x - prev > 1 && (prev >= 0 || x < w)) {
        for (let g = prev + 1; g < x; g++) {
          const t = prev < 0 ? 1 : x >= w ? 0 : (g - prev) / (x - prev);
          for (let c = 0; c < 3; c++) {
            const a = prev < 0 ? 0 : rgb[(row + prev) * 3 + c];
            const b = x >= w ? 0 : rgb[(row + x) * 3 + c];
            rgb[(row + g) * 3 + c] = a * (1 - t) + b * t;
          }
          weight[row + g] = 1;
        }
      }
      prev = x;
    }
  }
}

/** Light vertical blur over the filled pixels, to hide row-to-row streaks. */
function smoothColumns(rgb: Float32Array, mask: Float32Array, w: number, h: number): void {
  const src = rgb.slice();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      for (let c = 0; c < 3; c++) {
        rgb[i * 3 + c] = 0.25 * src[(i - w) * 3 + c] + 0.5 * src[i * 3 + c] + 0.25 * src[(i + w) * 3 + c];
      }
    }
  }
}

/**
 * Cuts the iris out as a disc. Parts hidden under the eyelids are rebuilt by rotating the
 * visible iris around its centre (irises are radially patterned), skipping catchlights so
 * highlights aren't smeared into rings.
 */
function buildDisc(pix: Uint8ClampedArray, solid: Uint8Array, crop: Rect, iris: Pt, irisR: number) {
  const discR = irisR * DISC_R;
  const half = Math.ceil(discR) + 2;
  const size = half * 2;
  const ox = Math.round(iris.x) - half;
  const oy = Math.round(iris.y) - half;

  const at = (fx: number, fy: number): number => {
    const x = Math.floor(fx) - crop.x;
    const y = Math.floor(fy) - crop.y;
    if (x < 0 || y < 0 || x >= crop.w || y >= crop.h || !solid[y * crop.w + x]) return -1;
    return (y * crop.w + x) * 4;
  };
  const lum = (o: number) => 0.3 * pix[o] + 0.59 * pix[o + 1] + 0.11 * pix[o + 2];

  // Typical iris colour and brightness, from the visible part of the iris.
  const visible: number[] = [];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const dx = ox + i + 0.5 - iris.x;
      const dy = oy + j + 0.5 - iris.y;
      const o = Math.hypot(dx, dy) < irisR * 0.95 ? at(ox + i + 0.5, oy + j + 0.5) : -1;
      if (o >= 0) visible.push(o);
    }
  }
  visible.sort((a, b) => lum(a) - lum(b));
  const median = visible[Math.floor(visible.length / 2)];
  const base = median === undefined ? [70, 55, 45] : [pix[median], pix[median + 1], pix[median + 2]];
  const brightLimit = median === undefined ? 255 : lum(median) + 45;

  const out = new ImageData(size, size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const dx = ox + i + 0.5 - iris.x;
      const dy = oy + j + 0.5 - iris.y;
      const rho = Math.hypot(dx, dy);
      const o = (j * size + i) * 4;
      out.data[o + 3] = clamp(discR - rho + 0.5, 0, 1) * 255;
      if (rho > discR + 1) continue;

      let src = at(iris.x + dx, iris.y + dy);
      if (src < 0) {
        const theta = Math.atan2(dy, dx);
        for (let step = 1; step <= 36 && src < 0; step++) {
          for (const sign of [1, -1]) {
            const a = theta + (sign * step * Math.PI) / 36;
            const cand = at(iris.x + rho * Math.cos(a), iris.y + rho * Math.sin(a));
            if (cand >= 0 && lum(cand) <= brightLimit) {
              src = cand;
              break;
            }
          }
        }
      }
      out.data.set(src >= 0 ? [pix[src], pix[src + 1], pix[src + 2]] : base, o);
    }
  }

  const discCenter = { x: iris.x - ox, y: iris.y - oy };
  const pupil = measurePupil(out, discCenter, irisR);
  const discs = DILATIONS.map((s) => {
    const disc = makeCanvas(size, size);
    disc.getContext("2d")!.putImageData(s === 1 ? out : dilate(out, discCenter, irisR, pupil, s), 0, 0);
    return disc;
  });
  return { discs, discCenter };
}

/**
 * Widens the pupil by remapping the iris radially: the pupil grows by `scale` and the iris
 * texture between pupil and rim is compressed to fit, as a real iris does.
 */
function dilate(src: ImageData, c: Pt, irisR: number, pupil: number, scale: number): ImageData {
  const { width: size, data } = src;
  const out = new ImageData(new Uint8ClampedArray(data), size, size);
  const p1 = Math.min(0.85, pupil * scale);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const dx = i + 0.5 - c.x;
      const dy = j + 0.5 - c.y;
      const u = Math.hypot(dx, dy) / irisR;
      if (u >= 1 || u === 0) continue;
      const us = u < p1 ? (u * pupil) / p1 : pupil + ((u - p1) * (1 - pupil)) / (1 - p1);
      const k = us / u;
      const o = (j * size + i) * 4;
      const rgb = bilinear(data, size, c.x + dx * k - 0.5, c.y + dy * k - 0.5);
      out.data.set(rgb, o);
    }
  }
  return out;
}

/**
 * Pupil radius as a fraction of the iris radius: where brightness climbs most steeply going
 * out from the centre. Dark irises show no clear edge, so a typical value is used instead.
 */
function measurePupil(disc: ImageData, c: Pt, irisR: number): number {
  const BINS = 20;
  const sum = new Float64Array(BINS);
  const count = new Float64Array(BINS);
  const { width: size, data } = disc;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = Math.hypot(i + 0.5 - c.x, j + 0.5 - c.y) / irisR;
      if (u >= 1) continue;
      const b = Math.floor(u * BINS);
      const o = (j * size + i) * 4;
      sum[b] += 0.3 * data[o] + 0.59 * data[o + 1] + 0.11 * data[o + 2];
      count[b]++;
    }
  }
  const mean = (b: number) => (count[b] ? sum[b] / count[b] : NaN);
  let best = 0.3;
  let bestRise = 12;
  for (let b = Math.round(0.15 * BINS); b < Math.round(0.55 * BINS); b++) {
    const rise = mean(b + 1) - mean(b - 1);
    if (rise > bestRise) {
      bestRise = rise;
      best = (b + 0.5) / BINS;
    }
  }
  return best;
}

function bilinear(data: Uint8ClampedArray, size: number, x: number, y: number): number[] {
  const x0 = clamp(Math.floor(x), 0, size - 1);
  const y0 = clamp(Math.floor(y), 0, size - 1);
  const x1 = Math.min(x0 + 1, size - 1);
  const y1 = Math.min(y0 + 1, size - 1);
  const tx = clamp(x - x0, 0, 1);
  const ty = clamp(y - y0, 0, 1);
  return [0, 1, 2].map((ch) => {
    const top = data[(y0 * size + x0) * 4 + ch] * (1 - tx) + data[(y0 * size + x1) * 4 + ch] * tx;
    const bot = data[(y1 * size + x0) * 4 + ch] * (1 - tx) + data[(y1 * size + x1) * 4 + ch] * tx;
    return top * (1 - ty) + bot * ty;
  });
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = (pts: Pt[]): Pt => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
});
const leftToRight = (pts: Pt[]) => (pts[0].x <= pts.at(-1)!.x ? pts : [...pts].reverse());
