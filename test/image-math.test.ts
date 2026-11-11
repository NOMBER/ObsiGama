import { describe, expect, it } from "vitest";
import { checkInput, encodeToBudget, planDraw, shrink } from "../src/image/math";

describe("planDraw", () => {
  it("center-crops a landscape photo to a 256 square", () => {
    expect(planDraw(4000, 3000, 256, 256, "cover")).toEqual({ sx: 500, sy: 0, sw: 3000, sh: 3000, dw: 256, dh: 256 });
  });
  it("center-crops a portrait photo", () => {
    expect(planDraw(1000, 2000, 256, 256, "cover")).toMatchObject({ sx: 0, sy: 500, sw: 1000, sh: 1000, dw: 256, dh: 256 });
  });
  it("never upscales", () => {
    expect(planDraw(100, 80, 256, 256, "cover")).toMatchObject({ sw: 80, sh: 80, dw: 80, dh: 80 });
    expect(planDraw(100, 50, 256, 256, "contain")).toMatchObject({ dw: 100, dh: 50 });
  });
  it("contain keeps the aspect ratio", () => {
    expect(planDraw(1024, 512, 256, 256, "contain")).toMatchObject({ sx: 0, sy: 0, sw: 1024, sh: 512, dw: 256, dh: 128 });
  });
  it("rejects zero sizes", () => expect(() => planDraw(0, 10, 256, 256, "cover")).toThrow());
});

// fake encoder: size falls linearly with quality
const fake = (bytesAtQ1: number) => async (q: number) => ({ size: Math.round(bytesAtQ1 * q), q });

describe("encodeToBudget", () => {
  it("returns the first try when it already fits", async () => {
    const r = await encodeToBudget(fake(10_000), { maxBytes: 50_000 });
    expect(r).toMatchObject({ quality: 0.82, fits: true, tries: 1 });
  });
  it("finds the highest quality under the budget", async () => {
    const r = await encodeToBudget(fake(100_000), { maxBytes: 50_000, qMax: 0.9, qMin: 0.3, steps: 8 });
    expect(r.fits).toBe(true);
    expect(r.result.size).toBeLessThanOrEqual(50_000);
    expect(r.quality).toBeGreaterThan(0.45);
    expect(r.quality).toBeLessThanOrEqual(0.5);
  });
  it("reports when even the lowest quality is too big", async () => {
    const r = await encodeToBudget(fake(1_000_000), { maxBytes: 50_000, qMin: 0.3 });
    expect(r).toMatchObject({ quality: 0.3, fits: false, tries: 2 });
  });
});

describe("shrink / checkInput", () => {
  it("shrinks by 20 % until the minimum side", () => {
    expect(shrink(256, 256)).toEqual({ w: 205, h: 205 });
    expect(shrink(50, 50)).toBeNull();
  });
  it("rejects non-images and huge files", () => {
    expect(checkInput("application/pdf", 10)).toMatch(/Not an image/);
    expect(checkInput("image/png", 30 * 1024 * 1024)).toMatch(/20 MB/);
    expect(checkInput("image/png", 0)).toMatch(/empty/);
    expect(checkInput("image/jpeg", 1000)).toBeNull();
  });
});
