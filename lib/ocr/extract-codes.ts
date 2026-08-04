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

function collectDirectMatches(text: string) {
  return text.toUpperCase().match(/\b[A-Z0-9]{11}\b/g) ?? [];
}

function collectLineNormalizedMatches(text: string) {
  const matches: string[] = [];

  for (const rawLine of text.toUpperCase().split(/\r?\n/)) {
    const compact = rawLine.replace(/[^A-Z0-9]/g, "");

    if (compact.length < 11) {
      continue;
    }

    for (let index = 0; index <= compact.length - 11; index += 1) {
      const candidate = compact.slice(index, index + 11);

      if (/^[A-Z0-9]{11}$/.test(candidate)) {
        matches.push(candidate);
      }
    }
  }

  return matches;
}

function scoreCandidate(value: string) {
  let score = 0;

  if (/^[A-Z]/.test(value)) {
    score += 3;
  }

  if (/\d/.test(value)) {
    score += 2;
  }

  if (/^[A-Z]\d{5,}/.test(value)) {
    score += 3;
  }

  if (/^[A-Z0-9]{11}$/.test(value)) {
    score += 1;
  }

  return score;
}

function extractCandidateCodes(texts: string[]) {
  const counts = new Map<string, number>();

  for (const text of texts) {
    const candidates = [
      ...collectDirectMatches(text),
      ...collectLineNormalizedMatches(text),
    ];

    for (const candidate of candidates) {
      counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => {
      const countDelta = right[1] - left[1];

      if (countDelta !== 0) {
        return countDelta;
      }

      const scoreDelta = scoreCandidate(right[0]) - scoreCandidate(left[0]);

      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return left[0].localeCompare(right[0]);
    })
    .map(([value]) => value);
}

async function prepareVariants(buffer: Buffer) {
  const base = sharp(buffer).rotate();
  const trimmed = base
    .clone()
    .trim({ threshold: 12 })
    .rotate();

  const pipelines = [
    base.clone(),
    base.clone().rotate(90),
    base.clone().rotate(270),
    trimmed.clone(),
    trimmed.clone().rotate(90),
    trimmed.clone().rotate(270),
  ];

  const regionPipelines: Array<ReturnType<typeof sharp>> = [];

  for (const pipeline of pipelines) {
    const metadata = await pipeline.metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;

    if (!width || !height) {
      continue;
    }

    const fullTableHeight = Math.max(1, Math.round(height * 0.42));
    const codeColumnWidth = Math.max(1, Math.round(width * 0.34));
    const upperLeftWidth = Math.max(1, Math.round(width * 0.52));
    const upperLeftHeight = Math.max(1, Math.round(height * 0.45));

    regionPipelines.push(
      pipeline.clone().extract({
        left: 0,
        top: 0,
        width,
        height: fullTableHeight,
      }),
      pipeline.clone().extract({
        left: 0,
        top: 0,
        width: codeColumnWidth,
        height: fullTableHeight,
      }),
      pipeline.clone().extract({
        left: 0,
        top: 0,
        width: upperLeftWidth,
        height: upperLeftHeight,
      }),
    );
  }

  const allPipelines = [...pipelines, ...regionPipelines];

  return Promise.all(
    allPipelines.flatMap((pipeline) => [
      pipeline.clone().grayscale().normalize().sharpen().png().toBuffer(),
      pipeline
        .clone()
        .grayscale()
        .normalize()
        .resize({ width: 2400, withoutEnlargement: false })
        .sharpen({ sigma: 1.4 })
        .threshold(165)
        .png()
        .toBuffer(),
      pipeline
        .clone()
        .grayscale()
        .normalize()
        .resize({ width: 2800, withoutEnlargement: false })
        .median(1)
        .sharpen({ sigma: 1.2 })
        .png()
        .toBuffer(),
    ]),
  );
}

export async function extractCodesFromLabelBuffer(
  buffer: Buffer,
): Promise<ExtractionResult> {
  const preparedVariants = await prepareVariants(buffer);
  const worker = await getWorker();
  const texts: string[] = [];

  for (const prepared of preparedVariants) {
    const result = await worker.recognize(prepared);
    texts.push(result.data.text ?? "");
  }

  const rawText = texts.join("\n\n--- OCR PASS ---\n\n");
  const codes = extractCandidateCodes(texts);

  return {
    codes,
    rawText,
    textPreview: rawText.replace(/\s+/g, " ").slice(0, 500),
  };
}
