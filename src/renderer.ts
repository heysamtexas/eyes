import type { FaceState } from "./gaze";
import { clamp, shift, traceCurve, type Pt } from "./geometry";
import { DILATIONS, makeCanvas, type Eye, type Portrait } from "./portrait";
import type { FaceWarp } from "./warp";

/** Eyeball radius relative to iris radius (human: ~12mm vs ~6mm). */
const EYEBALL_RATIO = 2.0;
/** How far a face's middle shifts per radian of head turn, as a fraction of face width. */
const HEAD_SHIFT_X = 0.1;
const HEAD_SHIFT_Y = 0.07;
/** Size of the region a head turn moves, as a fraction of face width. */
const HEAD_SIGMA_X = 0.3;
const HEAD_SIGMA_Y = 0.42;

/** Gaze in radians. +yaw looks toward image right, +pitch looks down. */
export interface Gaze {
  yaw: number;
  pitch: number;
}

export class PortraitRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  /** Per face, per eye: scratch canvas for compositing that eye. */
  private readonly layers: CanvasRenderingContext2D[][];

  /** With a `warp`, frames are composited offscreen and shown through it; otherwise drawn straight to `output`. */
  constructor(
    output: HTMLCanvasElement,
    readonly portrait: Portrait,
    private readonly warp: FaceWarp | null,
  ) {
    const target = warp ? makeCanvas(portrait.width, portrait.height) : output;
    target.width = portrait.width;
    target.height = portrait.height;
    this.ctx = target.getContext("2d")!;
    this.layers = portrait.faces.map((f) => f.eyes.map((e) => makeCanvas(e.crop.w, e.crop.h).getContext("2d")!));
  }

  /** `states` holds one entry per face, in `portrait.faces` order. */
  draw(states: FaceState[], debug: boolean): void {
    const { ctx, portrait } = this;
    ctx.drawImage(portrait.clean, 0, 0);
    portrait.faces.forEach((face, f) => {
      const s = states[f];
      face.eyes.forEach((eye, i) => {
        const target = this.irisTarget(eye, s.gaze);
        this.drawEye(eye, this.layers[f][i], target, s, s.closure[i]);
        if (debug) this.drawDebug(eye, target);
      });
    });

    this.warp?.render(
      ctx.canvas,
      portrait.faces.map((face, f) => ({
        x: face.center.x,
        y: face.center.y,
        sx: face.width * HEAD_SIGMA_X,
        sy: face.width * HEAD_SIGMA_Y,
        dx: Math.sin(states[f].head.yaw) * HEAD_SHIFT_X * face.width,
        dy: Math.sin(states[f].head.pitch) * HEAD_SHIFT_Y * face.width,
      })),
    );
  }

  private irisTarget(eye: Eye, gaze: Gaze): Pt {
    const R = eye.irisR * EYEBALL_RATIO;
    const reachY = Math.min(eye.opening * 0.4, eye.irisR * 0.7);
    return {
      x: clamp(eye.iris.x + Math.sin(gaze.yaw) * R, eye.minX + eye.irisR * 0.5, eye.maxX - eye.irisR * 0.5),
      y: clamp(eye.iris.y + Math.sin(gaze.pitch) * R, eye.iris.y - reachY, eye.iris.y + reachY),
    };
  }

  private drawEye(eye: Eye, l: CanvasRenderingContext2D, target: Pt, s: FaceState, closure: number): void {
    const { crop } = eye;
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.globalCompositeOperation = "source-over";
    l.clearRect(0, 0, crop.w, crop.h);

    // Iris, foreshortened as it rotates away from the viewer. Pupil size blends between
    // the two nearest pre-rendered dilation levels.
    l.translate(target.x - crop.x, target.y - crop.y);
    l.scale(Math.cos(s.gaze.yaw), Math.cos(s.gaze.pitch));
    const step = DILATIONS[1] - DILATIONS[0];
    const level = clamp((s.dilation - DILATIONS[0]) / step, 0, DILATIONS.length - 1);
    const lo = Math.floor(level);
    l.drawImage(eye.discs[lo], -eye.discCenter.x, -eye.discCenter.y);
    if (level > lo) {
      l.globalAlpha = level - lo;
      l.drawImage(eye.discs[lo + 1], -eye.discCenter.x, -eye.discCenter.y);
      l.globalAlpha = 1;
    }
    l.setTransform(1, 0, 0, 1, -crop.x, -crop.y);

    // Shadow the upper lid casts onto the iris.
    const lidY = Math.min(...eye.upper.map((p) => p.y));
    const shadow = l.createLinearGradient(0, lidY, 0, lidY + eye.opening * 0.6);
    shadow.addColorStop(0, "rgba(25, 12, 6, 0.4)");
    shadow.addColorStop(1, "rgba(25, 12, 6, 0)");
    l.globalCompositeOperation = "source-atop";
    l.fillStyle = shadow;
    l.fillRect(crop.x, crop.y, crop.w, crop.h);
    l.globalCompositeOperation = "source-over";

    // Blink: slide the skin above the upper lid down over the opening.
    if (closure > 0.01) {
      const d = closure * eye.opening * 1.1;
      l.save();
      l.beginPath();
      traceCurve(l, shift(eye.upper, 0, d));
      l.lineTo(eye.upper.at(-1)!.x, crop.y - 1);
      l.lineTo(eye.upper[0].x, crop.y - 1);
      l.closePath();
      l.clip();
      l.drawImage(this.portrait.original, crop.x, crop.y - d, crop.w, crop.h, crop.x, crop.y, crop.w, crop.h);
      l.restore();
    }

    l.setTransform(1, 0, 0, 1, 0, 0);
    l.globalCompositeOperation = "destination-in";
    l.drawImage(eye.mask, 0, 0);
    this.ctx.drawImage(l.canvas, crop.x, crop.y);
  }

  private drawDebug(eye: Eye, target: Pt): void {
    const { ctx } = this;
    ctx.save();
    ctx.lineWidth = Math.max(1, eye.irisR / 10);
    ctx.strokeStyle = "#3ee07a";
    ctx.beginPath();
    traceCurve(ctx, eye.upper);
    traceCurve(ctx, [...eye.lower].reverse());
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = "#ffcc33";
    ctx.beginPath();
    ctx.arc(eye.iris.x, eye.iris.y, eye.irisR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#ff4d6d";
    ctx.beginPath();
    ctx.arc(target.x, target.y, ctx.lineWidth * 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
