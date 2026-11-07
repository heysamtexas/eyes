interface Level {
  w: number;
  h: number;
  rgb: Float32Array;
  wt: Float32Array;
}

/**
 * Push-pull (pyramid) fill. Pixels with weight 1 are kept; pixels with weight < 1 are
 * blended toward a smooth interpolation of their known neighbours. Mutates `rgb` in place.
 * Returns false when there are no known pixels to fill from.
 */
export function pushPullFill(rgb: Float32Array, weight: Float32Array, w: number, h: number): boolean {
  const levels: Level[] = [{ w, h, rgb, wt: Float32Array.from(weight) }];

  // Push: average known pixels into ever-coarser levels.
  while (levels.at(-1)!.w > 1 || levels.at(-1)!.h > 1) {
    const fine = levels.at(-1)!;
    const cw = Math.ceil(fine.w / 2);
    const ch = Math.ceil(fine.h / 2);
    const coarse: Level = { w: cw, h: ch, rgb: new Float32Array(cw * ch * 3), wt: new Float32Array(cw * ch) };
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        let r = 0, g = 0, b = 0, s = 0;
        for (let dy = 0; dy < 2; dy++) {
          const fy = 2 * y + dy;
          if (fy >= fine.h) continue;
          for (let dx = 0; dx < 2; dx++) {
            const fx = 2 * x + dx;
            if (fx >= fine.w) continue;
            const i = fy * fine.w + fx;
            const wt = fine.wt[i];
            r += fine.rgb[i * 3] * wt;
            g += fine.rgb[i * 3 + 1] * wt;
            b += fine.rgb[i * 3 + 2] * wt;
            s += wt;
          }
        }
        const o = y * cw + x;
        if (s > 0) {
          coarse.rgb[o * 3] = r / s;
          coarse.rgb[o * 3 + 1] = g / s;
          coarse.rgb[o * 3 + 2] = b / s;
        }
        coarse.wt[o] = Math.min(1, s);
      }
    }
    levels.push(coarse);
  }

  if (levels.at(-1)!.wt[0] === 0) return false;
  levels.at(-1)!.wt[0] = 1;

  // Pull: fill unknown pixels from the (already complete) coarser level, bilinearly.
  for (let l = levels.length - 2; l >= 0; l--) {
    const fine = levels[l];
    const coarse = levels[l + 1];
    for (let y = 0; y < fine.h; y++) {
      const cy = Math.min(Math.max((y + 0.5) / 2 - 0.5, 0), coarse.h - 1);
      const y0 = Math.floor(cy);
      const y1 = Math.min(y0 + 1, coarse.h - 1);
      const ty = cy - y0;
      for (let x = 0; x < fine.w; x++) {
        const i = y * fine.w + x;
        const wt = fine.wt[i];
        if (wt >= 1) continue;
        const cx = Math.min(Math.max((x + 0.5) / 2 - 0.5, 0), coarse.w - 1);
        const x0 = Math.floor(cx);
        const x1 = Math.min(x0 + 1, coarse.w - 1);
        const tx = cx - x0;
        for (let c = 0; c < 3; c++) {
          const top = coarse.rgb[(y0 * coarse.w + x0) * 3 + c] * (1 - tx) + coarse.rgb[(y0 * coarse.w + x1) * 3 + c] * tx;
          const bot = coarse.rgb[(y1 * coarse.w + x0) * 3 + c] * (1 - tx) + coarse.rgb[(y1 * coarse.w + x1) * 3 + c] * tx;
          const v = top * (1 - ty) + bot * ty;
          fine.rgb[i * 3 + c] = fine.rgb[i * 3 + c] * wt + v * (1 - wt);
        }
        fine.wt[i] = 1;
      }
    }
  }
  return true;
}
