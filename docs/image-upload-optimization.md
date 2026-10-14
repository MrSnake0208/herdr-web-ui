# Image upload optimization

## Implementation plan and boundaries

1. Keep `uploadPaneImage(paneId, blob, machineId)` and `/api/pane/image` unchanged. Both Composer's
   paste/drop/file picker and PaneTerminal's paste/drop already reach this shared API.
2. Optimize before base64 encoding in a same-origin Worker, reusing `createOffThreadQueue`.
   No main-thread canvas, added dependencies, external service, clipboard changes or server rewrite.
3. Cover policy, native API calls/fallbacks, upload bytes/metadata, queues and server persistence with
   non-browser tests. Build the actual Worker asset. Record reproducible codec measurements separately
   from browser visual acceptance.
4. Document Windows acceptance, local Mac deployment and upstream synchronization. Do not commit,
   push, deploy, restart Herdr or touch an installed plugin as part of implementation.

## Policy

The existing 8 MiB input limit is checked **before** optimization and again before upload. A larger
input remains rejected, even if it might compress well. Files with an absent/generic MIME type use
the existing extension normalization for both chat and terminal uploads.

Only PNG/JPEG/WebP of at least 512 KiB are candidates. Container checks preserve GIF, APNG and
animated WebP; SVG/PDF/other files bypass encoding. A single WebP attempt uses quality 0.90 and
keeps the original unless the output saves at least 15%. Unsupported codecs (including a browser
returning PNG instead of WebP), empty output and exceptions keep the original.

`createImageBitmap(blob, { imageOrientation: "from-image" })` applies EXIF orientation before drawing.
The canvas retains alpha. Ordinary images, including 3840×2160 screenshots, retain their dimensions.
Only images exceeding 8192 pixels on an edge or 32 megapixels are proportionally reduced; decoded
images above 64 megapixels are left untouched to avoid another large canvas allocation. Worker
execution has a 15-second deadline per image, after which the original proceeds. Bitmap/canvas
resources are released after each attempt; one image is processed at a time.

The worker returns a Blob, never base64 text. File outputs receive `.webp` and `image/webp`; Blob
outputs carry `image/webp`. The existing upload produces only a server path. Composer keeps its
attachment IDs, previews of the originals, uploading/ready/error states, deletion rules and ordered
`@path` insertion. Terminal batches still wait for every upload before pasting ordered quoted paths.

Reference: [bitmap orientation](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/createImageBitmap),
[native encoding](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas/convertToBlob),
[WebP animation chunks](https://developers.google.com/speed/webp/docs/riff_container),
[PNG animation control](https://www.w3.org/TR/png-3/).

## Reproducible size baseline

Run `bun scripts/measure-image-optimization.ts` from the repository root. It requires the optional
developer tool `cwebp` (not an app dependency, and never needed on the Windows client). Pass file
paths to measure other samples. It uses real repository images, checks static containers, encodes
eligible samples at quality 90, applies the 15% rule and deletes its temporary output. This CLI
baseline does not execute browser canvas, emulate EXIF handling or measure visual clarity. Custom
samples should already be within the dimension limits; the CLI baseline does not apply resizing.

Measured on 2026-10-14 with cwebp/libwebp 1.6.0, original dimensions, no browser launched:

| Sample | Original bytes | Selected bytes | Saved | Policy |
| --- | ---: | ---: | ---: | --- |
| `docs/screenshots/desktop-chat.png` | 665,464 | 246,098 | 63.02% | WebP |
| `docs/screenshots/desktop-prompt.png` | 533,522 | 169,244 | 68.28% | WebP |
| `docs/screenshots/mobile-chat.png` | 343,500 | 343,500 | 0% | Small file skipped |
| `site/assets/chat-worked-open.jpg` | 248,681 | 248,681 | 0% | Small file skipped |
| `site/assets/chat-worked-open.webp` | 106,806 | 106,806 | 0% | Small file skipped |

## Verification and its limits

The non-DOM tests in `src/lib/imageOptimization.test.ts` stub bitmap/canvas to check PNG/JPEG/WebP
policy, animation detection, dimensions, EXIF options, alpha options, errors and cleanup. A real Bun
Worker also checks the async message protocol and unsupported-runtime fallback. `src/lib/api.test.ts`
holds worker responses to verify no request starts before preprocessing, optimized payload bytes,
File/Blob metadata, multiple-image queue order, remote machine ownership and original-byte fallback.
The existing `offThread.test.ts` covers timeout, failure and queue recovery. These are behavioral
unit tests at the image API boundary, not pixel-level browser tests.

The isolated `POST /api/pane/image` contract tests write genuine WebP bytes beside an owned test
pane, compare saved bytes, check `.webp` and 0600 permissions, and retain all existing rejection
cases. They do not invoke Codex. No server implementation, HTTP shape, Composer or PaneTerminal
interaction was changed. Their existing browser regressions cover ordered mentions, attachment
states/deletion and terminal file input, but were deliberately **not run** for this task.

```bash
HERDR_TEST_MODE=unit bun test ./src/lib/imageOptimization.test.ts ./src/lib/api.test.ts ./src/lib/offThread.test.ts ./src/lib/composerImageMime.test.ts ./server/paste.test.ts
bun run check run bun test --timeout 15000 ./server/api.contract.test.ts -t 'POST /api/pane/image'
bun run typecheck
bun run build
bun run test:unit
```

The production build emits a separate `optimizeUploadImage.worker-*.js` under `dist/assets/`.
`uploadPaneImage` awaits its Blob result before reading bytes for base64 and calling fetch. The
worker uses only browser APIs and never makes network requests; encoding therefore runs in the
client browser, independently of the Mac server's operating system. Actual Windows execution,
decoded pixels, visual clarity and Codex reading still require the manual acceptance below.

## Deploy this checkout on the Mac later

These steps change the running plugin and were **not executed**. Save drafts and authorize the
switch before doing them. Keep this checkout at its current permanent path; linking references it
directly. The manifest retains `devswha.herdr-web-ui`, so config and state remain attached to that ID.
Use the same Herdr session as the existing WebUI for every command (`herdr --session NAME …` if it
is not the default session).

1. Record the old registration and configuration location for recovery:
   `herdr plugin list --plugin devswha.herdr-web-ui --json` and
   `herdr plugin config-dir devswha.herdr-web-ui`. Keep the existing config/state and old checkout.
2. Prepare the clone:
   `cd /Users/snake/Desktop/herdr-web-ui`, `bun install --frozen-lockfile`, `bun run typecheck`,
   then `bun run build`. Do not use `bun run start` for preparation: it starts the updater/server.
3. Stop the **WebUI bridge** with `herdr plugin action invoke devswha.herdr-web-ui.stop`, then run
   `herdr plugin unlink devswha.herdr-web-ui`. Unlink removes the registration and leaves files,
   config and state; it does not uninstall the managed checkout.
4. Run `herdr plugin link /Users/snake/Desktop/herdr-web-ui`, then
   `herdr plugin action invoke devswha.herdr-web-ui.start` and
   `herdr plugin action invoke devswha.herdr-web-ui.status`. Linking does not build or run startup
   hooks, which is why build and explicit start are separate. The Herdr daemon/agent panes need
   no restart. If start fails, stop the bridge if needed, unlink this checkout, link the previous
   recorded checkout path and invoke its start action.
5. Reload Windows WebUI after saving drafts, then run the manual acceptance. A feature branch/local
   changes intentionally block the managed updater; installing an official update would omit this
   feature until it is included upstream. Keep deploying from this branch while maintaining it.

Commands and unlink/state behavior were checked against local Herdr 0.9.3 help and its
[versioned plugin documentation](https://github.com/herdrdev/herdr/blob/master/docs/versions/0.9.3/website/src/content/docs/plugins.mdx).

## Synchronize upstream later

`origin` currently points to `MrSnake0208/herdr-web-ui`; preserve it. Once the user has authorized
committing this feature and the working tree is clean, add upstream once and merge its changes into
the feature branch (do not run this against uncommitted work):

```bash
git remote add upstream https://github.com/devswha/herdr-web-ui.git
git fetch upstream
git switch feat/client-image-optimization
git merge upstream/main
bun run check fast
```

If `upstream` already exists, inspect `git remote -v` and omit `remote add`. Resolve upload/API
conflicts against current upstream callers, then rerun the targeted upload contract test and the
Windows acceptance before deploying again. A merge preserves existing commits; no force push is
needed. Commit, push, PR and deployment each remain subject to the user's authorization rules.

## Windows manual acceptance (after an explicitly authorized deployment)

1. In current Edge/Chrome on Windows, open the Mac WebUI and paste a screenshot larger than 512 KiB
   into Chat using Ctrl+V. Observe the existing Uploading state, then an attachment and `@…webp`
   path when savings qualify. Send a normal instruction asking Codex to read that image.
2. Repeat in Terminal, then drag and file-pick three distinctly numbered images in Chat. Confirm
   paths/attachments remain in pick order; delete an uploading attachment and confirm it never
   reappears. Terminal paste/drop must insert paths without sending Enter.
3. Try a small PNG, GIF/APNG/animated WebP, SVG/PDF and an image over 8 MiB. Confirm originals are
   preserved where applicable, animations stay intact, and oversized files retain the size error.
4. Try transparent UI, tiny code text, thin table lines, a 4K screenshot and an EXIF-rotated JPEG.
   Inspect the **saved file**, not just the original attachment preview: check readable text, alpha,
   orientation and dimensions. Lossy quality 0.90 is a starting policy, not a visual guarantee.
5. In browser Network, filter `pane/image`: check `content_type: image/webp`, `.webp` name and decoded
   payload size. On the Mac, inspect the returned file with `file` and `stat -f %z`, and confirm Codex
   can read it. Block the optimization worker temporarily and repeat: upload must still use the
   original. Restore the worker afterward.
