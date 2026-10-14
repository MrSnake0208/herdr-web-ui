import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { encodeUploadImage, isStaticUploadImage, worthOptimizing } from "./imageOptimization.ts";

const threshold = 512 * 1024;
const pngChunk = (name: string, data = new Uint8Array()) => {
  const chunk = new Uint8Array(data.length + 12);
  new DataView(chunk.buffer).setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(name), 4);
  chunk.set(data, 8);
  return chunk;
};
const webpChunk = (name: string, data = new Uint8Array()) => {
  const chunk = new Uint8Array(data.length + 8 + data.length % 2);
  new DataView(chunk.buffer).setUint32(4, data.length, true);
  chunk.set(new TextEncoder().encode(name));
  chunk.set(data, 8);
  return chunk;
};
const png = (animated = false) => new Blob([
  new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", new Uint8Array(13)),
  ...(animated ? [pngChunk("acTL", new Uint8Array(8))] : []), pngChunk("IDAT", new Uint8Array(threshold)),
], { type: "image/png" });
const webp = (chunks: Uint8Array<ArrayBuffer>[]) => {
  const size = 12 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode("RIFF"));
  new DataView(header.buffer).setUint32(4, size - 8, true);
  header.set(new TextEncoder().encode("WEBP"), 8);
  return new Blob([header, ...chunks], { type: "image/webp" });
};

it("answers the async optimization protocol in a real Bun worker without browser image APIs", async () => {
  const worker = new Worker(new URL("./optimizeUploadImage.worker.ts", import.meta.url).href);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = new Promise<unknown>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = reject;
      timer = setTimeout(() => reject(new Error("worker did not answer")), 2000);
    });
    worker.postMessage({ id: 7, request: png() });
    expect(await answer).toEqual({ id: 7, result: null });
  } finally {
    clearTimeout(timer);
    worker.terminate();
  }
});

describe("image optimization policy and native API boundary (no DOM)", () => {
  const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  const canvasDescriptor = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
  let bitmap: { width: number; height: number; close: ReturnType<typeof mock> };
  let decode: ReturnType<typeof mock>;
  let encode: ReturnType<typeof mock>;
  let draw: ReturnType<typeof mock>;
  let contextOptions: unknown;
  let dimensions: number[];
  let hasContext: boolean;
  let failCanvas: boolean;

  beforeEach(() => {
    bitmap = { width: 3840, height: 2160, close: mock(() => {}) };
    decode = mock(async () => bitmap);
    encode = mock(async () => new Blob([new Uint8Array(100_000)], { type: "image/webp" }));
    draw = mock(() => {});
    hasContext = true;
    failCanvas = false;
    contextOptions = undefined;
    dimensions = [];
    class Canvas {
      constructor(public width: number, public height: number) {
        if (failCanvas) throw new Error("canvas allocation failed");
        dimensions = [width, height];
      }
      getContext(_type: string, options: unknown) {
        contextOptions = options;
        return hasContext ? { drawImage: draw } : null;
      }
      convertToBlob = encode;
    }
    Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: decode });
    Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: Canvas });
  });
  afterEach(() => {
    for (const [key, descriptor] of [["createImageBitmap", bitmapDescriptor], ["OffscreenCanvas", canvasDescriptor]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  for (const type of ["image/png", "image/jpeg", "image/webp"]) {
    it(`encodes a static ${type} to WebP at 0.90 without shrinking 4K`, async () => {
      const image = type === "image/png" ? png() : type === "image/jpeg"
        ? new Blob([new Uint8Array([255, 216, 255]), new Uint8Array(threshold)], { type })
        : webp([webpChunk("VP8L", new Uint8Array(threshold))]);
      const result = await encodeUploadImage(image);
      expect(result?.type).toBe("image/webp");
      expect(result?.size).toBe(100_000);
      expect(dimensions).toEqual([3840, 2160]);
      expect(encode).toHaveBeenCalledWith({ type: "image/webp", quality: 0.90 });
      expect(bitmap.close).toHaveBeenCalledTimes(1);
    });
  }

  it("skips small images and every non-candidate type without decoding", async () => {
    for (const type of ["image/gif", "image/svg+xml", "application/pdf", "text/plain", "", "image/avif"]) {
      const file = new Blob([new Uint8Array(threshold)], { type });
      expect(worthOptimizing(file)).toBe(false);
      expect(await encodeUploadImage(file)).toBeNull();
    }
    expect(await encodeUploadImage(new Blob([new Uint8Array(threshold - 1)], { type: "image/png" }))).toBeNull();
    expect(worthOptimizing(new Blob([new Uint8Array(threshold)], { type: "image/png" }))).toBe(true);
    expect(decode).not.toHaveBeenCalled();
  });

  it("preserves APNG, animated WebP and files with misleading MIME types", async () => {
    for (const image of [png(true), webp([webpChunk("VP8X", new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 0])), webpChunk("VP8L", new Uint8Array(threshold))]),
      webp([webpChunk("ANIM"), webpChunk("VP8L", new Uint8Array(threshold))]),
      webp([webpChunk("ANMF", new Uint8Array(threshold))]),
      new Blob(["<svg/>", new Uint8Array(threshold)], { type: "image/png" })]) {
      expect(await encodeUploadImage(image)).toBeNull();
    }
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects truncated containers and ignores chunk names inside compressed pixels", async () => {
    const image = png();
    const bytes = new Uint8Array(await image.arrayBuffer());
    expect(isStaticUploadImage(bytes.subarray(0, 7), "image/png")).toBe(false);
    expect(isStaticUploadImage(bytes.subarray(0, bytes.length - 1), "image/png")).toBe(false);
    expect(isStaticUploadImage(new Uint8Array([255, 216]), "image/jpeg")).toBe(false);
    expect(isStaticUploadImage(new Uint8Array(), "image/webp")).toBe(false);
    const still = webp([webpChunk("VP8L", new TextEncoder().encode("ANIM"))]);
    expect(isStaticUploadImage(new Uint8Array(await still.arrayBuffer()), still.type)).toBe(true);
    const truncated = new Uint8Array(await still.arrayBuffer());
    new DataView(truncated.buffer).setUint32(16, 100, true);
    expect(isStaticUploadImage(truncated, still.type)).toBe(false);
  });

  it("keeps originals when savings are below 15%, output grows, is empty or falls back to PNG", async () => {
    const image = png();
    for (const output of [new Blob([new Uint8Array(image.size)], { type: "image/webp" }),
      new Blob([new Uint8Array(image.size + 1)], { type: "image/webp" }),
      new Blob([new Uint8Array(Math.ceil(image.size * 0.85))], { type: "image/webp" }),
      new Blob([], { type: "image/webp" }), new Blob(["small"], { type: "image/png" })]) {
      encode.mockResolvedValue(output);
      expect(await encodeUploadImage(image)).toBeNull();
    }
    encode.mockResolvedValue(new Blob([new Uint8Array(Math.floor(image.size * 0.85))], { type: "image/webp" }));
    expect(await encodeUploadImage(image)).not.toBeNull();
  });

  it("applies EXIF orientation once and keeps an alpha-enabled canvas without a background fill", async () => {
    bitmap.width = 2160;
    bitmap.height = 3840;
    const image = png();
    const before = await image.arrayBuffer();
    await encodeUploadImage(image);
    expect(decode).toHaveBeenCalledWith(image, { imageOrientation: "from-image" });
    expect(contextOptions).toEqual({ alpha: true });
    expect(draw).toHaveBeenCalledWith(bitmap, 0, 0, 2160, 3840);
    expect(await image.arrayBuffer()).toEqual(before);
  });

  it("scales only exceptional dimensions proportionally and never enlarges", async () => {
    for (const [width, height] of [[10_000, 1000], [8192, 8192], [1, 10_000], [400, 300]]) {
      bitmap.width = width!;
      bitmap.height = height!;
      await encodeUploadImage(png());
      expect(dimensions[0]).toBeLessThanOrEqual(width!);
      expect(dimensions[1]).toBeLessThanOrEqual(height!);
      expect(Math.max(...dimensions)).toBeLessThanOrEqual(8192);
      expect(dimensions[0]! * dimensions[1]!).toBeLessThanOrEqual(32 * 1024 * 1024);
    }
  });

  it("falls back on decode, canvas and encoding errors, releasing decoded bitmaps", async () => {
    decode.mockRejectedValueOnce(new Error("bad image"));
    expect(await encodeUploadImage(png())).toBeNull();
    expect(bitmap.close).not.toHaveBeenCalled();
    failCanvas = true;
    expect(await encodeUploadImage(png())).toBeNull();
    failCanvas = false;
    hasContext = false;
    expect(await encodeUploadImage(png())).toBeNull();
    hasContext = true;
    encode.mockRejectedValueOnce(new Error("unsupported encoding"));
    expect(await encodeUploadImage(png())).toBeNull();
    bitmap.width = 100_000;
    bitmap.height = 100_000;
    expect(await encodeUploadImage(png())).toBeNull();
    expect(bitmap.close).toHaveBeenCalledTimes(4);
  });

  it("falls back without browser image APIs or when reading the source fails", async () => {
    const image = png();
    Object.defineProperty(image, "arrayBuffer", { value: async () => { throw new Error("read failed"); } });
    expect(await encodeUploadImage(image)).toBeNull();
    Reflect.deleteProperty(globalThis, "createImageBitmap");
    expect(await encodeUploadImage(png())).toBeNull();
    Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: decode });
    Reflect.deleteProperty(globalThis, "OffscreenCanvas");
    expect(await encodeUploadImage(png())).toBeNull();
    expect(decode).not.toHaveBeenCalled();
  });
});
