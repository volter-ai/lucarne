// PER-POST IMAGES, WITHOUT THE CDN. Ported from cadence's `capturedMedia`/`mediaInfo`
// maps + `cropMedia` (`recall.ts:107-157`): the image is already IN the screenshot the screen
// sensor just took (the screen, in-session) — so we crop each on-screen post's image OUT of that
// PNG (via the shared assembler's `cropImageFromScreenshot`, `video/assembler.ts`) rather than
// fetching the media host's own CDN copy of the image (the out-of-session, bot-flagging request
// the recorder forbids — safety law 3). Deduped by post id (`sid`); a later, fuller pass UPGRADES
// a partial crop to a full one.
import { cropImageFromScreenshot } from "../video/assembler.js";
import type { MediaBox } from "./dom-probes.js";

export interface MediaCropInfo {
  image: string;
  alt: string;
}

/** Injectable crop backend — defaults to the real ffmpeg-backed `cropImageFromScreenshot`, so
 *  the dedup/upgrade LOGIC in this class can be tested with a fake, deterministic backend while a
 *  SEPARATE test exercises the real ffmpeg path end-to-end (test/recall-media-crop.mjs covers both). */
export type CropBackend = (shotPath: string, outPath: string, box: { x: number; y: number; w: number; h: number }) => { ok: boolean };

/**
 * PERSISTENT across captures (one instance per `startRecall` run): `capturedMedia` (sid → was this
 * crop FULLY visible?) drives the dedup/upgrade decision; `mediaInfo` (sid → {image, alt}) is what
 * every later capture of that post attaches its crop from, regardless of which capture actually
 * made it — this is the fix for orphaned crops cadence's own comment (`recall.ts:186-188`)
 * describes: an image cropped on capture N must still attach on capture N+5 that re-records the
 * same post.
 */
export class MediaCropTracker {
  readonly #captured = new Map<string, boolean>(); // sid → wasFullyVisible
  readonly #info = new Map<string, MediaCropInfo>(); // sid → {image, alt}
  readonly #cropDir: string;
  readonly #cropBackend: CropBackend;

  constructor(cropDir: string, cropBackend: CropBackend = cropImageFromScreenshot) {
    this.#cropDir = cropDir;
    this.#cropBackend = cropBackend;
  }

  /** Info for a post's crop, if one has ever been made (or reconciled) — the persistent read side. */
  infoFor(sid: string): MediaCropInfo | undefined {
    return this.#info.get(sid);
  }

  /** Seed the tracker from an on-disk crop found by `reconcileMedia` — does not overwrite an existing entry. */
  seed(sid: string, info: MediaCropInfo): void {
    if (!this.#info.has(sid)) this.#info.set(sid, info);
  }

  /**
   * Crop any newly-visible (or newly-FULL) images out of `shotPath` for the given boxes. Returns
   * the crops made THIS call (cadence's return value is unused by its own caller — attach reads
   * `mediaInfo`/`infoFor` instead, which is what makes cropping-then-attaching order-independent).
   */
  crop(shotPath: string, boxes: readonly MediaBox[]): Record<string, MediaCropInfo> {
    const out: Record<string, MediaCropInfo> = {};
    for (const box of boxes) {
      const had = this.#captured.get(box.sid);
      if (had === true) continue; // already have a FULL crop → done
      if (had === false && !box.full) continue; // have a partial, this one's also partial → skip
      const cropPath = `${this.#cropDir}/media-${box.sid}.png`;
      const x = Math.round(box.x * box.dpr);
      const y = Math.round(box.y * box.dpr);
      const w = Math.round(box.w * box.dpr);
      const h = Math.round(box.h * box.dpr);
      const result = this.#cropBackend(shotPath, cropPath, { x, y, w, h });
      if (result.ok) {
        this.#captured.set(box.sid, !!box.full);
        const info = { image: cropPath, alt: box.alt };
        this.#info.set(box.sid, info);
        out[box.sid] = info;
      }
    }
    return out;
  }
}
