const MIN_BYTES = 512 * 1024;
const MAX_PIXELS = 32 * 1024 * 1024;
const MAX_EDGE = 8192;

export function worthOptimizing(image: Blob): boolean {
  return image.size >= MIN_BYTES && ["image/png", "image/jpeg", "image/webp"].includes(image.type);
}

/** Check container chunks, not byte substrings inside compressed pixels, before flattening an image. */
export function isStaticUploadImage(bytes: Uint8Array, type: string): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/png") {
    if (![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const end = offset + 12 + view.getUint32(offset);
      if (end > bytes.length) return false;
      const chunk = tag(offset + 4);
      if (chunk === "acTL") return false;
      if (chunk === "IDAT") return true; // APNG's acTL must precede the first IDAT.
      offset = end;
    }
    return false;
  }
  if (type === "image/webp") {
    if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WEBP" || view.getUint32(4, true) + 8 !== bytes.length) return false;
    let pixels = false;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const length = view.getUint32(offset + 4, true);
      const end = offset + 8 + length + (length % 2);
      if (end > bytes.length) return false;
      const chunk = tag(offset);
      if (chunk === "ANIM" || chunk === "ANMF" || (chunk === "VP8X" && (bytes[offset + 8]! & 2) !== 0)) return false;
      if (chunk === "VP8 " || chunk === "VP8L") pixels = true;
      offset = end;
    }
    return pixels;
  }
  return false;
}

/** Worker-only native encoding. A null result always means keep the original bytes. */
export async function encodeUploadImage(image: Blob): Promise<Blob | null> {
  if (!worthOptimizing(image) || typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") return null;
  let bitmap: ImageBitmap | undefined;
  let canvas: OffscreenCanvas | undefined;
  try {
    if (!isStaticUploadImage(new Uint8Array(await image.arrayBuffer()), image.type)) return null;
    bitmap = await createImageBitmap(image, { imageOrientation: "from-image" });
    const { width, height } = bitmap;
    if (width <= 0 || height <= 0 || width * height > 64 * 1024 * 1024) return null;
    // Keep ordinary screenshots (including 4K) at full resolution; bound only exceptional canvases.
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
    canvas = new OffscreenCanvas(Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale)));
    const context = canvas.getContext("2d", { alpha: true });
    if (context === null) return null;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const optimized = await canvas.convertToBlob({ type: "image/webp", quality: 0.90 });
    return optimized.type === "image/webp" && optimized.size > 0 && optimized.size <= image.size * 0.85 ? optimized : null;
  } catch {
    return null;
  } finally {
    bitmap?.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
