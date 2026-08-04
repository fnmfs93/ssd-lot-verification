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

function buildBasePipelines(buffer: Buffer) {
  const base = sharp(buffer).rotate();
  const trimmed = base.clone().trim({ threshold: 12 }).rotate();

  return [
    base.clone(),
    base.clone().rotate(90),
    base.clone().rotate(270),
    trimmed.clone(),
    trimmed.clone().rotate(90),
    trimmed.clone().rotate(270),
  ];
}

async function buildRegionPipelines(pipelines: Array<ReturnType<typeof sharp>>) {
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

  return regionPipelines;
}

async function buildLeftColumnPipeline(pipeline: ReturnType<typeof sharp>) {
  const metadata = await pipeline.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  if (!width || !height) {
    return null;
  }

  return pipeline.clone().extract({
    left: 0,
    top: 0,
    width: Math.max(1, Math.round(width * 0.4)),
    height,
  });
}

function fastVariantBuffers(pipeline: ReturnType<typeof sharp>) {
  return [
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
  ];
}

function extraVariantBuffer(pipeline: ReturnType<typeof sharp>) {
  return pipeline
    .clone()
    .grayscale()
    .normalize()
    .resize({ width: 2800, withoutEnlargement: false })
    .median(1)
    .sharpen({ sigma: 1.2 })
    .png()
    .toBuffer();
}

async function recognizeAll(buffers: Buffer[]) {
  const worker = await getWorker();
  const texts: string[] = [];

  for (const buffer of buffers) {
    const result = await worker.recognize(buffer);
    texts.push(result.data.text ?? "");
  }

  return texts;
}

export async function extractCodesFromLabelBuffer(
  buffer: Buffer,
): Promise<ExtractionResult> {
  const basePipelines = buildBasePipelines(buffer);
  const texts: string[] = [];

  // Tier 0: these labels always print the 11-character code in the left
  // ~40% of the frame, so try a straight crop to just that strip first — 2
  // OCR passes on the upright orientation, no rotation search needed.
  const leftColumnPipeline = await buildLeftColumnPipeline(basePipelines[0]);

  if (leftColumnPipeline) {
    const leftColumnBuffers = await Promise.all(fastVariantBuffers(leftColumnPipeline));
    texts.push(...(await recognizeAll(leftColumnBuffers)));
  }

  let codes = extractCandidateCodes(texts);

  if (!codes.length) {
    // Fast pass: the 6 whole-image orientations, 2 processing variants each
    // (12 OCR passes). This covers a clear, well-cropped photo that wasn't
    // caught by the left-column crop above (e.g. rotated capture) without
    // paying for the full region-crop combinatorial search below, which was
    // slow enough to time out the serverless function on every request.
    const fastBuffers = (
      await Promise.all(basePipelines.map((pipeline) => Promise.all(fastVariantBuffers(pipeline))))
    ).flat();

    texts.push(...(await recognizeAll(fastBuffers)));
    codes = extractCandidateCodes(texts);
  }

  if (!codes.length) {
    // Slow fallback for hard images: add cropped table/column regions and a
    // third denoising variant across every pipeline, same coverage as before.
    const regionPipelines = await buildRegionPipelines(basePipelines);
    const allPipelines = [...basePipelines, ...regionPipelines];

    const remainingBuffers = (
      await Promise.all([
        ...regionPipelines.map((pipeline) => Promise.all(fastVariantBuffers(pipeline))),
        ...allPipelines.map((pipeline) => extraVariantBuffer(pipeline).then((buf) => [buf])),
      ])
    ).flat();

    const moreTexts = await recognizeAll(remainingBuffers);
    texts.push(...moreTexts);
    codes = extractCandidateCodes(texts);
  }

  const rawText = texts.join("\n\n--- OCR PASS ---\n\n");

  return {
    codes,
    rawText,
    textPreview: rawText.replace(/\s+/g, " ").slice(0, 500),
  };
}
