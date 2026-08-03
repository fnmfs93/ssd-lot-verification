import sharp from "sharp";
import { createWorker } from "tesseract.js";

type ExtractionResult = {
  codes: string[];
  rawText: string;
  textPreview: string;
};

let workerPromise: Promise<Awaited<ReturnType<typeof createWorker>>> | null = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker("eng");
  }

  return workerPromise;
}

function extractCandidateCodes(text: string) {
  const matches = text.toUpperCase().match(/\b[A-Z0-9]{11}\b/g) ?? [];
  return [...new Set(matches)];
}

export async function extractCodesFromLabelBuffer(
  buffer: Buffer,
): Promise<ExtractionResult> {
  const prepared = await sharp(buffer)
    .rotate()
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();

  const worker = await getWorker();
  const result = await worker.recognize(prepared);
  const rawText = result.data.text ?? "";
  const codes = extractCandidateCodes(rawText);

  return {
    codes,
    rawText,
    textPreview: rawText.replace(/\s+/g, " ").slice(0, 500),
  };
}
