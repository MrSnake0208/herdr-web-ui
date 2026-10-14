import { encodeUploadImage } from "./imageOptimization.ts";
import type { OffThreadAnswer, OffThreadRequest } from "./offThread.ts";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<OffThreadRequest<Blob>>) => void;
  postMessage: (answer: OffThreadAnswer<Blob>) => void;
};
scope.onmessage = async ({ data: { id, request } }) => {
  scope.postMessage({ id, result: await encodeUploadImage(request) });
};
