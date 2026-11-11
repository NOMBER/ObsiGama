// Converts any browser-decodable image (PNG, JPEG, GIF, WebP, AVIF, BMP, SVG) to a small WebP.
// Used for avatars (256 px square, < 50 KB) and reusable for game icons / badges.

import { checkInput, encodeToBudget, planDraw, shrink } from "./math";

export interface WebpOptions {
  maxW: number;
  maxH: number;
  mode: "cover" | "contain";
  maxBytes: number;
  qMax?: number;
  qMin?: number;
}

export const AVATAR_WEBP: WebpOptions = { maxW: 256, maxH: 256, mode: "cover", maxBytes: 50 * 1024, qMax: 0.8, qMin: 0.35 };
export const ICON_WEBP: WebpOptions = { maxW: 256, maxH: 256, mode: "contain", maxBytes: 40 * 1024, qMax: 0.85, qMin: 0.4 };
export const BADGE_WEBP: WebpOptions = { maxW: 128, maxH: 128, mode: "contain", maxBytes: 16 * 1024, qMax: 0.85, qMin: 0.4 };

export class ImageConvertError extends Error {}

export interface WebpResult {
  blob: Blob;
  width: number;
  height: number;
  quality: number;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

async function decode(file: Blob): Promise<{ img: CanvasImageSource; w: number; h: number; close(): void }> {
  if (typeof createImageBitmap === "function" && file.type !== "image/svg+xml") {
    try {
      const bmp = await createImageBitmap(file);
      return { img: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
    } catch {
      /* fall back to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 512, h = img.naturalHeight || 512;
    return { img, w, h, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new ImageConvertError("This file could not be read as an image.");
  }
}

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

function encode(canvas: AnyCanvas, quality: number): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/webp", quality });
  return new Promise((res, rej) =>
    (canvas as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new ImageConvertError("Encoding failed."))), "image/webp", quality),
  );
}

export async function toWebp(file: Blob, o: WebpOptions): Promise<WebpResult> {
  const bad = checkInput(file.type, file.size);
  if (bad) throw new ImageConvertError(bad);
  const src = await decode(file);
  try {
    const plan = planDraw(src.w, src.h, o.maxW, o.maxH, o.mode);
    let w = plan.dw, h = plan.dh;
    for (;;) {
      const canvas = makeCanvas(w, h);
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!ctx) throw new ImageConvertError("Canvas is not available.");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src.img, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, w, h);
      const r = await encodeToBudget((q) => encode(canvas, q), { maxBytes: o.maxBytes, qMax: o.qMax, qMin: o.qMin });
      if (r.result.type !== "image/webp") {
        // e.g. Safari / iOS WebView can't encode WebP from a canvas and silently returns PNG
        throw new ImageConvertError("This device cannot encode WebP images yet. Try on desktop.");
      }
      if (r.fits) return { blob: r.result, width: w, height: h, quality: r.quality };
      const next = shrink(w, h);
      if (!next) return { blob: r.result, width: w, height: h, quality: r.quality }; // best effort; bucket still caps size
      w = next.w; h = next.h;
    }
  } finally {
    src.close();
  }
}
