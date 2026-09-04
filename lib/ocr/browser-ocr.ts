"use client";

import { createWorker, type Worker } from "tesseract.js";

// Runs entirely in the browser (WASM + Web Worker) instead of the server.
// This sidesteps the recurring Vercel deployment failures we hit with
// server-side sharp/tesseract.js native module bundling, and removes the
// serverless function timeout risk for OCR entirely — it just takes as long
// as it takes on the user's own phone, with a live "scanning..." UI instead
// of a single request that can time out.

let workerPromise: Promise<Worker> | null = null;

async function getBrowserOcrWorker() {
  if (!workerPromise) {
    workerPromise = createWorker("eng");
  }

  return workerPromise;
}

export async function terminateBrowserOcrWorker() {
  if (!workerPromise) {
    return;
  }

  const pending = workerPromise;
  workerPromise = null;

  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    // Nothing to clean up if it never finished initializing.
  }
}

/**
 * Grayscale + threshold an image region in place. Cheap, fast, and improves
 * OCR accuracy on printed label text far more than raw RGB input.
 */
export function preprocessForOcr(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");

  if (!context) {
    return canvas;
  }

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;

  for (let index = 0; index < data.length; index += 4) {
    const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    const value = gray > 150 ? 255 : gray < 90 ? 0 : gray;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Crops a region of a video frame, upscaling it to at least `minWidth` so
 * small on-screen text still has enough pixels for OCR to read reliably.
 */
export function captureVideoRegion(
  video: HTMLVideoElement,
  region: { left: number; top: number; width: number; height: number },
  minWidth = 900,
) {
  const canvas = document.createElement("canvas");
  const scale = Math.max(1, minWidth / region.width);
  canvas.width = Math.round(region.width * scale);
  canvas.height = Math.round(region.height * scale);

  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  context.drawImage(
    video,
    region.left,
    region.top,
    region.width,
    region.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  return canvas;
}

export async function recognizeCanvas(canvas: HTMLCanvasElement): Promise<string> {
  const worker = await getBrowserOcrWorker();
  const result = await worker.recognize(canvas);
  return result.data.text ?? "";
}
