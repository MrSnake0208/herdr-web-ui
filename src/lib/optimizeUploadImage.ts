import { worthOptimizing } from "./imageOptimization.ts";
import { createOffThreadQueue, type WorkerLike } from "./offThread.ts";

const optimize = createOffThreadQueue<Blob, Blob>(
  () => new Worker(new URL("./optimizeUploadImage.worker.ts", import.meta.url), { type: "module" }) as WorkerLike,
  15_000,
);

/** Runs before base64/network work; unsupported, failed or unhelpful optimization keeps the input. */
export async function optimizeUploadImage(image: Blob): Promise<Blob> {
  if (!worthOptimizing(image)) return image;
  try {
    const result = await optimize(image).promise;
    if (!result || result.type !== "image/webp" || result.size === 0 || result.size > image.size * 0.85) return image;
    return image instanceof File
      ? new File([result], `${image.name.replace(/\.[^.]*$/, "") || "image"}.webp`, { type: result.type, lastModified: image.lastModified })
      : result;
  } catch {
    return image;
  }
}
