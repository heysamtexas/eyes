import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { FaceBehavior, type BehaviorSettings } from "./gaze";
import { analyzePortrait } from "./portrait";
import { PortraitRenderer } from "./renderer";
import { ViewerTracker, type Viewer } from "./tracker";
import { createLandmarker } from "./vision";
import { FaceWarp } from "./warp";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("portrait");
const stage = $("stage");
const empty = $("empty");
const status = $("status");
const cameraBtn = $<HTMLButtonElement>("camera");
const settingsPanel = $("settings");
const settingsToggle = $<HTMLButtonElement>("settings-toggle");
const video = $<HTMLVideoElement>("cam");

const SETTINGS_KEY = "eyes.settings";
const SETTING_IDS = ["sensitivity", "cameraOffset", "smoothing", "headTurn", "reactions", "autoBlink", "mirrorBlink", "debug"] as const;
const settingInputs = SETTING_IDS.map((id) => $<HTMLInputElement>(id));
const setting = (id: (typeof SETTING_IDS)[number]) => settingInputs[SETTING_IDS.indexOf(id)];

const tracker = new ViewerTracker(video);
const warp = FaceWarp.create(canvas);
let behaviors: FaceBehavior[] = [];
let renderer: PortraitRenderer | undefined;
let imageLandmarker: Promise<FaceLandmarker> | undefined;
let lastViewer: Viewer | null = null;
/** Lets automated tests stand in for the camera. */
let forcedViewer: Viewer | null | undefined;
let statusTimer: number | undefined;

function setStatus(text: string, clearAfterMs = 0): void {
  status.textContent = text;
  clearTimeout(statusTimer);
  if (clearAfterMs) statusTimer = window.setTimeout(() => (status.textContent = ""), clearAfterMs);
}

function readSettings(): BehaviorSettings & { debug: boolean } {
  return {
    sensitivity: setting("sensitivity").valueAsNumber,
    cameraOffsetDeg: setting("cameraOffset").valueAsNumber,
    smoothing: setting("smoothing").valueAsNumber,
    headTurn: warp ? setting("headTurn").valueAsNumber : 0,
    reactions: setting("reactions").checked,
    autoBlink: setting("autoBlink").checked,
    mirrorBlink: setting("mirrorBlink").checked,
    debug: setting("debug").checked,
  };
}

function restoreSettings(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Record<string, string | boolean>;
    for (const input of settingInputs) {
      const v = saved[input.id];
      if (typeof v === "boolean") input.checked = v;
      else if (typeof v === "string") input.value = v;
    }
  } catch {
    // Storage unavailable (private window, blocked site data): keep defaults.
  }
}

function saveSettings(): void {
  const values = Object.fromEntries(settingInputs.map((i) => [i.id, i.type === "checkbox" ? i.checked : i.value]));
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(values));
  } catch {
    // Not persisted; settings still apply for this session.
  }
}

async function loadPortrait(blob: Blob): Promise<void> {
  setStatus("Finding faces…");
  try {
    imageLandmarker ??= createLandmarker({ runningMode: "IMAGE", numFaces: 10 });
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const portrait = analyzePortrait(bitmap, await imageLandmarker);
    bitmap.close();
    renderer = new PortraitRenderer(canvas, portrait, warp);
    behaviors = portrait.faces.map(() => new FaceBehavior());
    canvas.hidden = false;
    empty.hidden = true;
    const found = portrait.faces.length > 1 ? `Found ${portrait.faces.length} faces. ` : "";
    if (portrait.warnings.length) setStatus(found + portrait.warnings.join(" "), 8000);
    else if (found) setStatus(found, 5000);
    else setStatus("");
    if (!tracker.running && !cameraBtn.disabled) await toggleCamera();
  } catch (err) {
    console.error(err);
    setStatus(err instanceof Error ? err.message : "Couldn't read that image.", 8000);
  }
}

async function toggleCamera(): Promise<void> {
  if (tracker.running) {
    tracker.stop();
    cameraBtn.textContent = "Start camera";
    return;
  }
  cameraBtn.disabled = true;
  if (!status.textContent) setStatus("Starting camera…");
  try {
    await tracker.start();
    cameraBtn.textContent = "Stop camera";
    if (status.textContent === "Starting camera…") setStatus("");
  } catch (err) {
    console.error(err);
    tracker.stop();
    setStatus("Couldn't open the camera. Check the browser's camera permission.", 8000);
  } finally {
    cameraBtn.disabled = false;
  }
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
  last = now;
  const s = readSettings();

  const viewer = forcedViewer !== undefined ? forcedViewer : tracker.poll(now);
  if (viewer !== undefined) lastViewer = viewer;

  video.hidden = !(s.debug && tracker.running);
  video.classList.toggle("debug", s.debug);

  if (renderer) {
    renderer.draw(
      behaviors.map((b) => b.update(dt, now, viewer, lastViewer, s)),
      s.debug,
    );
  }
  requestAnimationFrame(frame);
}

function wireUi(): void {
  for (const id of ["file", "file2"]) {
    $<HTMLInputElement>(id).addEventListener("change", (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) void loadPortrait(file);
    });
  }
  $("sample").addEventListener("click", async () => {
    const res = await fetch(`${import.meta.env.BASE_URL}sample.jpg`);
    await loadPortrait(await res.blob());
  });
  cameraBtn.addEventListener("click", () => void toggleCamera());
  settingsToggle.addEventListener("click", () => {
    settingsPanel.hidden = !settingsPanel.hidden;
    settingsToggle.setAttribute("aria-expanded", String(!settingsPanel.hidden));
  });
  $("fullscreen").addEventListener("click", () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  });
  settingInputs.forEach((i) => i.addEventListener("input", saveSettings));

  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "d" || e.target instanceof HTMLInputElement) return;
    const debug = setting("debug");
    debug.checked = !debug.checked;
    saveSettings();
  });

  stage.addEventListener("dragover", (e) => {
    e.preventDefault();
    stage.classList.add("drag");
  });
  stage.addEventListener("dragleave", () => stage.classList.remove("drag"));
  stage.addEventListener("drop", (e) => {
    e.preventDefault();
    stage.classList.remove("drag");
    const file = e.dataTransfer?.files[0];
    if (file?.type.startsWith("image/")) void loadPortrait(file);
  });

  // Hide the controls when the mouse rests, so the portrait can stand alone.
  let idleTimer: number | undefined;
  const wake = () => {
    document.body.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      if (renderer && settingsPanel.hidden) document.body.classList.add("idle");
    }, 3000);
  };
  window.addEventListener("pointermove", wake);
  window.addEventListener("keydown", wake);
}

declare global {
  interface Window {
    eyesTest: { setViewer(v: Viewer | null | undefined): void; layers(): string[] };
  }
}
window.eyesTest = {
  setViewer: (v) => (forcedViewer = v),
  layers: () => {
    const p = renderer?.portrait;
    return p ? [p.clean, ...p.faces.flatMap((f) => f.eyes.map((e) => e.discs.at(-1)!))].map((c) => c.toDataURL("image/png")) : [];
  },
};

restoreSettings();
wireUi();
requestAnimationFrame(frame);
