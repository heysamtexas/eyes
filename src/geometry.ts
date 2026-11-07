export interface Pt {
  x: number;
  y: number;
}

/**
 * Continues the current path with a smooth curve that passes through the first and last
 * points of `pts` and uses the interior points as quadratic control points.
 */
export function traceCurve(ctx: CanvasRenderingContext2D | Path2D, pts: Pt[]): void {
  ctx.lineTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const end = i === pts.length - 2 ? pts[i + 1] : { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, end.x, end.y);
  }
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const shift = (pts: Pt[], dx: number, dy: number): Pt[] => pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
