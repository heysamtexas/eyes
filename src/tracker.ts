import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { createLandmarker } from "./vision";

/** A person in front of the camera, in raw (unmirrored) camera-frame coordinates. */
export interface Viewer {
  /** Midpoint between their eyes, 0..1 across the frame. */
  x: number;
  y: number;
  /** Distance between their eyes as a fraction of the frame width; bigger means closer. */
  size: number;
  /** Blink amount (0..1) of the viewer's eye on the screen-left / screen-right side, as seen facing them. */
  blink: [number, number];
}

export class ViewerTracker {
  private landmarker?: FaceLandmarker;
  private stream?: MediaStream;
  private lastTime = -1;

  constructor(readonly video: HTMLVideoElement) {}

  get running(): boolean {
    return !!this.stream;
  }

  async start(): Promise<void> {
    this.landmarker ??= await createLandmarker({ runningMode: "VIDEO", numFaces: 4, outputFaceBlendshapes: true });
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.video.srcObject = null;
    this.lastTime = -1;
  }

  /**
   * Runs detection when a new camera frame is available. Returns `undefined` when there is
   * no new frame, `null` when nobody is in view, otherwise the closest (largest) face.
   */
  poll(nowMs: number): Viewer | null | undefined {
    const { video, landmarker } = this;
    if (!this.stream || !landmarker || video.readyState < 2 || video.currentTime === this.lastTime) return undefined;
    this.lastTime = video.currentTime;

    const result = landmarker.detectForVideo(video, nowMs);
    let best: Viewer | null = null;
    let bestSpan = 0;
    result.faceLandmarks.forEach((lm, i) => {
      const a = lm[468];
      const b = lm[473];
      const span = Math.abs(a.x - b.x);
      if (span <= bestSpan) return;
      bestSpan = span;
      const shapes = result.faceBlendshapes[i]?.categories ?? [];
      const score = (name: string) => shapes.find((c) => c.categoryName === name)?.score ?? 0;
      // Blendshapes are named from the viewer's own perspective; their left eye is on screen-left facing them.
      best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, size: span, blink: [score("eyeBlinkLeft"), score("eyeBlinkRight")] };
    });
    return best;
  }
}
