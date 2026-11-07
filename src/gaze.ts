import { clamp } from "./geometry";
import type { Gaze } from "./renderer";
import type { Viewer } from "./tracker";

/** Typical laptop webcam field of view, in radians. */
const H_FOV = (62 * Math.PI) / 180;
const V_FOV = (48 * Math.PI) / 180;
/** How long nobody must be in view before the eyes start wandering. */
const IDLE_AFTER_MS = 1500;
/** Eye movement time constant; real saccades settle in roughly 50ms. */
const EYE_TAU = 0.045;
/** The head follows far more lazily than the eyes. */
const HEAD_TAU = 0.4;
/** Pupils respond over about half a second. */
const PUPIL_TAU = 0.5;

export interface GazeSettings {
  /** Multiplier on how far the eyes turn. */
  sensitivity: number;
  /** Degrees the camera sits above the portrait; tilts the gaze up to meet the viewer's eyes. */
  cameraOffsetDeg: number;
  /** 0 = twitchy, 1 = very smooth. */
  smoothing: number;
}

export interface BehaviorSettings extends GazeSettings {
  /** 0..1: how much of the gaze the head follows. */
  headTurn: number;
  /** Pupils react to distance and surprise; staring makes the face glance away. */
  reactions: boolean;
  autoBlink: boolean;
  mirrorBlink: boolean;
}

/** Everything the renderer needs to draw one face for one frame. */
export interface FaceState {
  gaze: Gaze;
  /** Per eye (image-left, image-right): 0 open, 1 shut. */
  closure: [number, number];
  /** Pupil size relative to the photo's. */
  dilation: number;
  head: Gaze;
}

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const approach = (from: number, to: number, dt: number, tau: number) => from + (to - from) * (1 - Math.exp(-dt / tau));

/** One Euro filter: smooths jitter at rest while staying responsive to fast moves. */
class OneEuro {
  private x?: number;
  private dx = 0;

  filter(value: number, dt: number, minCutoff: number, beta: number): number {
    if (this.x === undefined) return (this.x = value);
    const alpha = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    this.dx += alpha(1) * ((value - this.x) / dt - this.dx);
    this.x += alpha(minCutoff + beta * Math.abs(this.dx)) * (value - this.x);
    return this.x;
  }

  reset(): void {
    this.x = undefined;
    this.dx = 0;
  }
}

class GazeController {
  private readonly fy = new OneEuro();
  private readonly fp = new OneEuro();
  private target: Gaze = { yaw: 0, pitch: 0 };
  private eye: Gaze = { yaw: 0, pitch: 0 };
  private aim: Gaze = { yaw: 0, pitch: 0 };
  private jitter: Gaze = { yaw: 0, pitch: 0 };
  private nextJitter = 0;
  private nextWander = 0;
  lastSeen = -Infinity;

  /**
   * `target` is where the face wants to look (the viewer, or a wander point); `override`
   * sends the eyes somewhere else without forgetting it. `jumped` flags a large eye jump.
   */
  update(dt: number, nowMs: number, viewer: Viewer | null | undefined, s: GazeSettings, override: Gaze | null) {
    if (viewer) {
      this.lastSeen = nowMs;
      const yaw = (0.5 - viewer.x) * H_FOV * s.sensitivity;
      const pitch = ((viewer.y - 0.5) * V_FOV - (s.cameraOffsetDeg * Math.PI) / 180) * s.sensitivity;
      const minCutoff = 3 - 2.7 * s.smoothing;
      this.target = { yaw: this.fy.filter(yaw, dt, minCutoff, 0.4), pitch: this.fp.filter(pitch, dt, minCutoff, 0.4) };
    } else if (nowMs - this.lastSeen > IDLE_AFTER_MS && nowMs > this.nextWander) {
      this.fy.reset();
      this.fp.reset();
      this.target = { yaw: rand(-0.35, 0.35), pitch: rand(-0.12, 0.15) };
      this.nextWander = nowMs + rand(1200, 3500);
    }

    if (nowMs > this.nextJitter) {
      this.jitter = { yaw: rand(-0.015, 0.015), pitch: rand(-0.01, 0.01) };
      this.nextJitter = nowMs + rand(300, 1200);
    }

    const aim = override ?? this.target;
    const jumped = Math.hypot(aim.yaw - this.aim.yaw, aim.pitch - this.aim.pitch) > 0.2;
    this.aim = { ...aim };
    this.eye.yaw = approach(this.eye.yaw, aim.yaw + this.jitter.yaw, dt, EYE_TAU);
    this.eye.pitch = approach(this.eye.pitch, aim.pitch + this.jitter.pitch, dt, EYE_TAU);
    return {
      gaze: { yaw: clamp(this.eye.yaw, -1.2, 1.2), pitch: clamp(this.eye.pitch, -1, 1) },
      target: this.target,
      jumped,
    };
  }
}

/** Spontaneous blinks, plus optionally copying the viewer's blinks and winks. */
class BlinkController {
  private t = -1;
  private next = performance.now() + rand(1500, 4000);

  trigger(): void {
    if (this.t < 0) this.t = 0;
  }

  update(nowMs: number, dt: number, jumped: boolean, mirror: [number, number] | null, auto: boolean): [number, number] {
    if (auto && this.t < 0 && (nowMs > this.next || (jumped && Math.random() < 0.35))) this.t = 0;

    let c = 0;
    if (this.t >= 0) {
      this.t += dt;
      const CLOSE = 0.07, HOLD = 0.04, OPEN = 0.16;
      if (this.t < CLOSE) c = this.t / CLOSE;
      else if (this.t < CLOSE + HOLD) c = 1;
      else if (this.t < CLOSE + HOLD + OPEN) c = 1 - (this.t - CLOSE - HOLD) / OPEN;
      else {
        this.t = -1;
        this.next = nowMs + rand(2000, 6000);
      }
    }
    const fromViewer = (v: number) => clamp((v - 0.35) / 0.3, 0, 1);
    return mirror ? [Math.max(c, fromViewer(mirror[0])), Math.max(c, fromViewer(mirror[1]))] : [c, c];
  }
}

/** One face's behaviour: where it looks, how its head and pupils follow, when it blinks or looks away. */
export class FaceBehavior {
  private readonly gaze = new GazeController();
  private readonly blink = new BlinkController();
  private head: Gaze = { yaw: 0, pitch: 0 };
  private dilation = 1;
  private surprise = 0;
  private present = false;
  private stare = 0;
  private stareLimit = rand(5, 10);
  private anchor: Gaze = { yaw: 0, pitch: 0 };
  private glanceUntil = 0;
  private glance: Gaze | null = null;

  update(dt: number, nowMs: number, viewer: Viewer | null | undefined, lastViewer: Viewer | null, s: BehaviorSettings): FaceState {
    const absentFor = nowMs - this.gaze.lastSeen;
    if (viewer && !this.present && absentFor > IDLE_AFTER_MS && s.reactions) {
      // Someone new: a little start, and usually a blink.
      this.surprise = 0.35;
      if (Math.random() < 0.6) this.blink.trigger();
    }
    if (nowMs > this.glanceUntil) this.glance = null;

    const g = this.gaze.update(dt, nowMs, viewer, s, this.glance);
    this.present = nowMs - this.gaze.lastSeen < 500;

    if (s.reactions && this.present && !this.glance) this.watchForStaring(dt, nowMs, g.target);
    else if (!this.present) this.stare = 0;

    this.head.yaw = approach(this.head.yaw, g.target.yaw * s.headTurn, dt, HEAD_TAU);
    this.head.pitch = approach(this.head.pitch, g.target.pitch * s.headTurn, dt, HEAD_TAU);

    this.surprise *= Math.exp(-dt / 1.2);
    let wanted = 1;
    if (s.reactions) {
      // Closer viewer (eyes further apart in the camera frame) → wider pupils.
      const closeness = this.present && lastViewer ? clamp((lastViewer.size - 0.06) / 0.12, 0, 1) : 0;
      wanted = 1 + 0.6 * closeness + this.surprise;
    }
    this.dilation = approach(this.dilation, wanted, dt, PUPIL_TAU);

    const mirror = s.mirrorBlink && lastViewer && this.present ? lastViewer.blink : null;
    return {
      gaze: g.gaze,
      closure: this.blink.update(nowMs, dt, g.jumped, mirror, s.autoBlink),
      dilation: this.dilation,
      head: { ...this.head },
    };
  }

  /** Held eye contact for too long: blink and glance away for a moment. */
  private watchForStaring(dt: number, nowMs: number, target: Gaze): void {
    if (Math.hypot(target.yaw - this.anchor.yaw, target.pitch - this.anchor.pitch) > 0.12) {
      this.anchor = { ...target };
      this.stare = 0;
      return;
    }
    this.stare += dt;
    if (this.stare < this.stareLimit) return;
    const side = Math.random() < 0.5 ? -1 : 1;
    this.glance = { yaw: target.yaw + side * rand(0.4, 0.6), pitch: target.pitch + rand(0.08, 0.22) };
    this.glanceUntil = nowMs + rand(800, 1600);
    this.blink.trigger();
    this.stare = 0;
    this.stareLimit = rand(5, 10);
  }
}
