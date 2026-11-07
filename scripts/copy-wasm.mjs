// Copies MediaPipe's WebAssembly runtime into public/ so the app runs without a CDN.
import { cpSync } from "node:fs";

cpSync("node_modules/@mediapipe/tasks-vision/wasm", "public/wasm", { recursive: true });
