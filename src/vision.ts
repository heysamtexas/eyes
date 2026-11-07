import { FaceLandmarker, FilesetResolver, type FaceLandmarkerOptions } from "@mediapipe/tasks-vision";

const BASE = import.meta.env.BASE_URL;

let fileset: ReturnType<typeof FilesetResolver.forVisionTasks> | undefined;

/** Creates a Face Landmarker, preferring the GPU delegate and falling back to CPU. */
export async function createLandmarker(
  options: Omit<FaceLandmarkerOptions, "baseOptions">,
): Promise<FaceLandmarker> {
  fileset ??= FilesetResolver.forVisionTasks(`${BASE}wasm`);
  const vision = await fileset;
  const modelAssetPath = `${BASE}models/face_landmarker.task`;
  try {
    return await FaceLandmarker.createFromOptions(vision, {
      ...options,
      baseOptions: { modelAssetPath, delegate: "GPU" },
    });
  } catch (err) {
    console.warn("GPU delegate unavailable, using CPU", err);
    return FaceLandmarker.createFromOptions(vision, {
      ...options,
      baseOptions: { modelAssetPath, delegate: "CPU" },
    });
  }
}

// Face mesh indices. "A" is the subject's right eye, "B" the subject's left;
// the portrait code sorts eyes by image position, so the naming only has to be consistent.
export const EYE_A = {
  upper: [33, 246, 161, 160, 159, 158, 157, 173, 133],
  lower: [33, 7, 163, 144, 145, 153, 154, 155, 133],
};
export const EYE_B = {
  upper: [263, 466, 388, 387, 386, 385, 384, 398, 362],
  lower: [263, 249, 390, 373, 374, 380, 381, 382, 362],
};
export const IRISES = [
  { center: 468, ring: [469, 470, 471, 472] },
  { center: 473, ring: [474, 475, 476, 477] },
];
export const NOSE_TIP = 1;
export const CHEEKS = [234, 454];
