// Pure sizing / quality math for WebP conversion (unit-tested, no DOM).

export interface DrawPlan {
  /** source rectangle */
  sx: number; sy: number; sw: number; sh: number;
  /** output canvas size */
  dw: number; dh: number;
}

/**
 * cover: center-crop to the target aspect and scale down to (maxW x maxH). Used for avatars.
 * contain: keep the whole image, fit inside (maxW x maxH). Used for icons / screenshots.
 * Never upscales.
 */
export function planDraw(srcW: number, srcH: number, maxW: number, maxH: number, mode: "cover" | "contain"): DrawPlan {
  if (!(srcW > 0 && srcH > 0 && maxW > 0 && maxH > 0)) throw new Error("invalid image size");
  if (mode === "cover") {
    const target = maxW / maxH;
    let sw = srcW, sh = srcH;
    if (srcW / srcH > target) sw = srcH * target; // too wide: crop the sides
    else sh = srcW / target; // too tall: crop top/bottom
    sw = Math.round(sw); sh = Math.round(sh);
    const scale = Math.min(1, maxW / sw);
    return {
      sx: Math.floor((srcW - sw) / 2), sy: Math.floor((srcH - sh) / 2), sw, sh,
      dw: Math.max(1, Math.round(sw * scale)), dh: Math.max(1, Math.round(sh * scale)),
    };
  }
  const scale = Math.min(1, maxW / srcW, maxH / srcH);
  return { sx: 0, sy: 0, sw: srcW, sh: srcH, dw: Math.max(1, Math.round(srcW * scale)), dh: Math.max(1, Math.round(srcH * scale)) };
}

export interface QualitySearch {
  maxBytes: number;
  qMax?: number;
  qMin?: number;
  /** binary-search iterations after the first try */
  steps?: number;
}

/**
 * Finds the highest quality whose encoded size fits in maxBytes.
 * Tries qMax first (often already small enough), then binary-searches down to qMin.
 * Returns the best fitting result, or the qMin result with fits=false.
 */
export async function encodeToBudget<T extends { size: number }>(
  encode: (quality: number) => Promise<T>,
  o: QualitySearch,
): Promise<{ result: T; quality: number; fits: boolean; tries: number }> {
  const qMax = o.qMax ?? 0.82, qMin = o.qMin ?? 0.3, steps = o.steps ?? 5;
  let tries = 1;
  const first = await encode(qMax);
  if (first.size <= o.maxBytes) return { result: first, quality: qMax, fits: true, tries };
  tries++;
  const floor = await encode(qMin);
  if (floor.size > o.maxBytes) return { result: floor, quality: qMin, fits: false, tries };
  let lo = qMin, hi = qMax, best = floor, bestQ = qMin;
  for (let i = 0; i < steps; i++) {
    const mid = Math.round(((lo + hi) / 2) * 100) / 100;
    if (mid <= lo || mid >= hi) break;
    tries++;
    const r = await encode(mid);
    if (r.size <= o.maxBytes) { best = r; bestQ = mid; lo = mid; } else hi = mid;
  }
  return { result: best, quality: bestQ, fits: true, tries };
}

/** Next smaller size when even the lowest quality does not fit. null = give up. */
export function shrink(w: number, h: number, factor = 0.8, minSide = 48): { w: number; h: number } | null {
  const nw = Math.round(w * factor), nh = Math.round(h * factor);
  if (Math.min(nw, nh) < minSide) return null;
  return { w: nw, h: nh };
}

export const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/** Cheap pre-check before decoding. Returns an error message or null. */
export function checkInput(type: string, size: number): string | null {
  if (!type || !type.startsWith("image/")) return "Not an image file.";
  if (size > MAX_INPUT_BYTES) return "Image is larger than 20 MB.";
  if (size === 0) return "File is empty.";
  return null;
}
