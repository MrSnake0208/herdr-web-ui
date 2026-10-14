import { afterEach, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { MAX_ATTACHMENT_BYTES } from "../../shared/attachments.ts";
import { NOTICE_VERSION } from "../../shared/telemetry.ts";
import { AttachmentTooLargeError, ApiError, changeTelemetry, fetchTelemetry, uploadPaneImage } from "./api.ts";
import { DEFAULT_SETTINGS, telemetrySettingsSnapshot } from "./settings.ts";
import type { OffThreadRequest, WorkerLike } from "./offThread.ts";
import { optimizeUploadImage } from "./optimizeUploadImage.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

it("refuses a file over the attachment limit before any of it is sent, and sends one at the limit", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url: string) => {
    requests.push(url);
    return Response.json({ ok: true, path: "/work/.herdr-web-ui/site.zip" });
  }) as typeof fetch;

  const over = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "site.zip", { type: "application/zip" });
  const refused = await uploadPaneImage("p1", over).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(AttachmentTooLargeError);
  expect(refused).toMatchObject({ fileName: "site.zip", size: MAX_ATTACHMENT_BYTES + 1 });
  expect(requests).toEqual([]);

  const atLimit = new File([new Uint8Array(MAX_ATTACHMENT_BYTES)], "site.zip", { type: "application/zip" });
  expect(await uploadPaneImage("p1", atLimit)).toBe("/work/.herdr-web-ui/site.zip");
  expect(requests).toEqual(["/api/pane/image"]);
});

it("waits for optimization, uploads its bytes and metadata in queue order, and falls back on worker failure", async () => {
  const realWorker = globalThis.Worker;
  const workers: FakeWorker[] = [];
  class FakeWorker implements WorkerLike {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    sent: OffThreadRequest<Blob>[] = [];
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(message: unknown) { this.sent.push(message as OffThreadRequest<Blob>); }
    terminate() { this.terminated = true; }
    answer(index: number, result: Blob | null) {
      this.onmessage?.({ data: { id: this.sent[index]!.id, result } } as MessageEvent);
    }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const requests: { url: string; body: Record<string, string>; headers: unknown }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init?.body)), headers: init?.headers });
    return Response.json({ path: `/work/.herdr-web-ui/${requests.length}.webp` });
  }) as typeof fetch;
  try {
    const images = ["first.PNG", "second.jpg", "third.webp"].map((name, index) => new File(
      [new Uint8Array(600_000)], name, { type: ["image/png", "image/jpeg", "image/webp"][index], lastModified: 123 },
    ));
    // Reading the original for base64 would fail: only the worker result may be encoded here.
    for (const image of images) Object.defineProperty(image, "arrayBuffer", { value: async () => { throw new Error("original encoded"); } });
    const pending = images.map((image) => uploadPaneImage("pane-1", image, "mac"));
    expect(requests).toHaveLength(0);
    expect(workers).toHaveLength(1);
    const worker = workers[0]!;
    expect(worker.sent.map(({ request }) => (request as File).name)).toEqual(["first.PNG"]);
    const optimized = new Blob([readFileSync(new URL("../../site/assets/strip-dark.webp", import.meta.url))], { type: "image/webp" });
    for (let index = 0; index < images.length; index++) {
      worker.answer(index, optimized);
      expect(await pending[index]).toBe(`/work/.herdr-web-ui/${index + 1}.webp`);
    }
    expect(requests.map(({ body }) => body.name)).toEqual(["first.webp", "second.webp", "third.webp"]);
    expect(worker.sent.map(({ request }) => request)).toEqual(images);
    for (const request of requests) {
      expect(request.url).toBe("/api/machines/mac/pane/image");
      expect(request.body.pane_id).toBe("pane-1");
      expect(request.body.content_type).toBe("image/webp");
      expect(Buffer.from(request.body.data_base64!, "base64")).toEqual(Buffer.from(await optimized.arrayBuffer()));
      expect(request.headers).toEqual({ "content-type": "application/json", "x-herdr-machine": "1" });
    }
    const metadata = optimizeUploadImage(images[0]!);
    worker.answer(worker.sent.length - 1, optimized);
    expect(await metadata).toMatchObject({ name: "first.webp", type: "image/webp", lastModified: 123 });

    const blobUpload = uploadPaneImage("pane-1", new Blob([new Uint8Array(600_000)], { type: "image/png" }));
    worker.answer(worker.sent.length - 1, optimized);
    await blobUpload;
    expect(requests.at(-1)!.body.content_type).toBe("image/webp");
    expect(requests.at(-1)!.body).not.toHaveProperty("name");

    const fallback = new File([new Uint8Array(600_000)], "original.png", { type: "image/png" });
    const unchanged = uploadPaneImage("pane-1", fallback);
    worker.answer(worker.sent.length - 1, new Blob([new Uint8Array(600_001)], { type: "image/webp" }));
    await unchanged;
    expect(requests.at(-1)!.body.name).toBe("original.png");
    expect(requests.at(-1)!.body.content_type).toBe("image/png");
    expect(Buffer.from(requests.at(-1)!.body.data_base64!, "base64").length).toBe(fallback.size);

    for (const result of [null, new Blob(["png fallback"], { type: "image/png" })]) {
      const unoptimized = uploadPaneImage("pane-1", fallback);
      worker.answer(worker.sent.length - 1, result);
      await unoptimized;
      expect(requests.at(-1)!.body.content_type).toBe("image/png");
    }

    const failed = uploadPaneImage("pane-1", fallback);
    worker.onerror?.(new Event("error"));
    await failed;
    expect(worker.terminated).toBe(true);
    expect(requests.at(-1)!.body.name).toBe("original.png");

    globalThis.Worker = class { constructor() { throw new Error("workers unavailable"); } } as unknown as typeof Worker;
    await uploadPaneImage("pane-1", fallback);
    expect(requests.at(-1)!.body.content_type).toBe("image/png");
    const before = requests.length;
    await expect(uploadPaneImage("pane-1", new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "huge.png", { type: "image/png" }))).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(requests).toHaveLength(before);
  } finally {
    globalThis.Worker = realWorker;
  }
});

it("preserves small and non-image attachments and normalizes Windows generic image MIME types", async () => {
  const files = [new File(["png"], "small.png", { type: "image/png" }),
    new File(["gif"], "motion.gif", { type: "image/gif" }),
    new File(["<svg/>"], "icon.svg", { type: "image/svg+xml" }),
    new File(["pdf"], "notes.pdf", { type: "application/pdf" }),
    new File(["text"], "readme.txt", { type: "text/plain" }),
    new File(["png"], "windows.PNG", { type: "application/octet-stream" })];
  const bodies: Record<string, string>[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ path: "/work/attachment" });
  }) as typeof fetch;
  for (const file of files) await uploadPaneImage("pane-1", file);
  for (const [index, file] of files.entries()) {
    expect(bodies[index]!.name).toBe(file.name);
    expect(bodies[index]!.data_base64).toBe(Buffer.from(await file.arrayBuffer()).toString("base64"));
    expect(bodies[index]!.content_type).toBe(index === files.length - 1 ? "image/png" : file.type);
  }
});

it("posts the full safe telemetry snapshot and current notice version", async () => {
  const settings = telemetrySettingsSnapshot({
    ...DEFAULT_SETTINGS,
    terminalFontFamily: "Private Font Name",
    chatFontFamily: "Private Chat Font",
    usageHidden: ["account-identifier"],
  });
  const change = { notice_seen: true as const, notice_version: NOTICE_VERSION, settings };
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requestUrl = url;
    requestInit = init;
    return Response.json({ enabled: true, blocked_by_env: false, notice_seen: true, next: null });
  }) as typeof fetch;

  await changeTelemetry(change);

  expect(requestUrl).toBe("/api/telemetry");
  expect(requestInit?.method).toBe("POST");
  expect(requestInit?.headers).toEqual({ "content-type": "application/json", "x-herdr-update": "1" });
  const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
  expect(body).toEqual(change);
  expect(body).not.toHaveProperty("changed_settings");
  expect(Object.keys(body.settings as object)).toHaveLength(53);
  expect(body.settings).not.toHaveProperty("terminalFontFamily");
  expect(body.settings).not.toHaveProperty("chatFontFamily");
  expect(body.settings).not.toHaveProperty("usageHidden");
  expect((body.settings as Record<string, unknown>).terminalFontCustom).toBe(true);
  expect((body.settings as Record<string, unknown>).usageHiddenCount).toBe(1);
});

it("preserves telemetry API errors", async () => {
  globalThis.fetch = (async (_url: string) => Response.json({ error: { code: "telemetry_failed", message: "Could not save" } }, { status: 500 })) as typeof fetch;

  const error = await changeTelemetry({ enabled: false }).catch((failure: unknown) => failure);

  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 500, code: "telemetry_failed", detail: "Could not save" });
});

it("treats a missing telemetry route as unavailable for reads and an API error for writes", async () => {
  globalThis.fetch = (async (_url: string) => Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 })) as typeof fetch;

  expect(await fetchTelemetry()).toBeNull();
  const error = await changeTelemetry({ enabled: true }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 404, code: "not_found" });
});
