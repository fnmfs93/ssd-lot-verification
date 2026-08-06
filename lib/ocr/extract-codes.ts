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

    // Only trust normalization on lines that are already close to code-length
    // (a code with a stray space/hyphen OCR'd into the middle of it). Sliding
    // an 11-char window across long header/timestamp lines produces dozens of
    // overlapping, meaningless substrings — e.g. a compacted 40-character
    // sentence yields ~30 spurious "candidates" shifted by one character each.
    if (compact.length < 11 || compact.length > 15) {
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

// Real codes always follow J + MMYYDD (6 digits) + a 4-character
// alphanumeric suffix — e.g. J16262914IP. Locking to this exact shape
// rejects OCR noise from body text far more reliably than a generic
// "11 alphanumeric characters" check.
const CODE_PATTERN = /^J\d{8}[A-Z0-9]{2}$/;

function looksLikeCode(value: string) {
  return CODE_PATTERN.test(value);
}

function extractCandidateCodes(texts: string[]) {
  const directCounts = new Map<string, number>();
  const normalizedCounts = new Map<string, number>();

  for (const text of texts) {
    for (const candidate of collectDirectMatches(text)) {
      if (looksLikeCode(candidate)) {
        directCounts.set(candidate, (directCounts.get(candidate) ?? 0) + 1);
      }
    }

    for (const candidate of collectLineNormalizedMatches(text)) {
      if (looksLikeCode(candidate)) {
        normalizedCounts.set(candidate, (normalizedCounts.get(candidate) ?? 0) + 1);
      }
    }
  }

  const counts = new Map<string, number>(directCounts);

  for (const [value, count] of normalizedCounts) {
    // A direct bounded-token read is trustworthy on its own. A
    // sliding-window normalized match is easy to produce by chance from
    // unrelated text, so only accept it once it's corroborated — either a
    // direct match also saw it, or it showed up in at least two passes.
    if (count >= 2 || counts.has(value)) {
      counts.set(value, (counts.get(value) ?? 0) + count);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => {
      const countDelta = right[1] - left[1];

      if (countDelta !== 0) {
        return countDelta;
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
    const codeColumnWidth = Math.max(1, Math.round(width * 0.28));
    const upperLeftWidth = Math.max(1, Math.round(width * 0.42));
    const upperLeftHeight = Math.max(1, Math.round(height * 0.42));
    const rowSectionTop = Math.max(0, Math.round(height * 0.14));
    const rowSectionHeight = Math.max(1, Math.round(height * 0.22));

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
      pipeline.clone().extract({
        left: 0,
        top: rowSectionTop,
        width: codeColumnWidth,
        height: rowSectionHeight,
      }),
    );
  }

  return regionPipelines;
}

async function buildLeftColumnPipelines(pipeline: ReturnType<typeof sharp>) {
  const metadata = await pipeline.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  if (!width || !height) {
    return [];
  }

  const leftWidth = Math.max(1, Math.round(width * 0.28));
  const upperHeight = Math.max(1, Math.round(height * 0.42));
  const rowSectionTop = Math.max(0, Math.round(height * 0.14));
  const rowSectionHeight = Math.max(1, Math.round(height * 0.22));

  return [
    pipeline.clone().extract({
      left: 0,
      top: 0,
      width: leftWidth,
      height: upperHeight,
    }),
    pipeline.clone().extract({
      left: 0,
      top: rowSectionTop,
      width: leftWidth,
      height: rowSectionHeight,
    }),
  ];
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

  // Tier 0: start with just the upper-left code section, which is where the
  // three target values always live.
  const leftColumnPipelines = await buildLeftColumnPipelines(basePipelines[0]);
  const leftColumnBuffers = (
    await Promise.all(
      leftColumnPipelines.map((pipeline) => Promise.all(fastVariantBuffers(pipeline))),
    )
  ).flat();
  texts.push(...(await recognizeAll(leftColumnBuffers)));

  let codes = extractCandidateCodes(texts);

  if (!codes.length) {
    // Fast pass: only the most likely orientations to keep cycle time down.
    const fastPipelines = [basePipelines[0], basePipelines[2], basePipelines[3]];
    const fastBuffers = (
      await Promise.all(fastPipelines.map((pipeline) => Promise.all(fastVariantBuffers(pipeline))))
    ).flat();

    texts.push(...(await recognizeAll(fastBuffers)));
    codes = extractCandidateCodes(texts);
  }

  if (!codes.length) {
    // Hard-image fallback: focused table regions plus one heavier denoise
    // variant, but still limited to the most likely orientations.
    const fallbackBases = [basePipelines[0], basePipelines[2], basePipelines[3]];
    const regionPipelines = await buildRegionPipelines(fallbackBases);
    const allPipelines = [...fallbackBases, ...regionPipelines];

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
