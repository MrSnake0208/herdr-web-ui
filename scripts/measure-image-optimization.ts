/** Optional local codec baseline, not a browser or visual acceptance test. Requires cwebp on PATH. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { isStaticUploadImage, worthOptimizing } from "../src/lib/imageOptimization.ts";

const cwebp = Bun.which("cwebp");
if (!cwebp) throw new Error("Install cwebp on the development machine to run this optional codec baseline.");
const samples = process.argv.slice(2);
if (samples.length === 0) samples.push("docs/screenshots/desktop-chat.png", "docs/screenshots/desktop-prompt.png",
  "docs/screenshots/mobile-chat.png", "site/assets/chat-worked-open.jpg", "site/assets/chat-worked-open.webp");
const directory = mkdtempSync(join(tmpdir(), "herdr-image-measure-"));
console.log("cwebp baseline at quality 90; no browser was launched. Browser output may differ.");
console.log("sample\toriginal bytes\tencoded bytes\tupload bytes\tsaved %\tpolicy");
try {
  for (const [index, sample] of samples.entries()) {
    const bytes = readFileSync(sample);
    const type = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<string, string>)[extname(sample).toLowerCase()] ?? "";
    const image = new Blob([bytes], { type });
    let encoded = image.size;
    let policy = "skip";
    if (worthOptimizing(image) && isStaticUploadImage(bytes, type) && image.size <= 8 * 1024 * 1024) {
      const output = join(directory, `${index}.webp`);
      const child = Bun.spawnSync([cwebp, "-quiet", "-q", "90", sample, "-o", output], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      assert.equal(child.exitCode, 0, child.stderr.toString());
      const result = readFileSync(output);
      assert.equal(result.subarray(0, 4).toString(), "RIFF");
      assert.equal(result.subarray(8, 12).toString(), "WEBP");
      encoded = statSync(output).size;
      policy = encoded > 0 && encoded <= image.size * 0.85 ? "WebP" : "original";
    }
    const upload = policy === "WebP" ? encoded : image.size;
    assert(upload <= image.size);
    console.log(`${sample}\t${image.size}\t${encoded}\t${upload}\t${((1 - upload / image.size) * 100).toFixed(2)}\t${policy}`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
