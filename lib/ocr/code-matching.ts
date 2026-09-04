// Pure text-matching logic for pulling label codes out of OCR output. No
// Node or browser APIs here — this runs both server-side (if ever needed
// again) and client-side, where OCR itself now happens.

// Real codes always follow J + MMYYDD (6 digits) + a 4-character
// alphanumeric suffix — e.g. J16262914IP. Locking to this exact shape
// rejects OCR noise from body text far more reliably than a generic
// "11 alphanumeric characters" check.
const CODE_PATTERN = /^J\d{8}[A-Z0-9]{2}$/;

// Characters OCR commonly mistakes for a digit. The MMYYDD segment
// (positions 2-7) is always pure digits by definition, so any letter
// appearing there is necessarily a misread — safe to correct outright
// rather than just reject.
const DIGIT_LOOKALIKES: Record<string, string> = {
  B: "8",
  O: "0",
  D: "0",
  Q: "0",
  I: "1",
  L: "1",
  S: "5",
  Z: "2",
  G: "6",
};

function correctDigitZone(value: string) {
  if (value.length !== 11) {
    return value;
  }

  const chars = value.split("");

  for (let index = 1; index <= 6; index += 1) {
    const replacement = DIGIT_LOOKALIKES[chars[index]];

    if (replacement) {
      chars[index] = replacement;
    }
  }

  return chars.join("");
}

export function looksLikeCode(value: string) {
  return CODE_PATTERN.test(value);
}

/** Returns the canonical code form if `value` matches as-is or after
 * correcting known digit look-alikes in the MMYYDD zone, else null. */
export function normalizeCodeCandidate(value: string) {
  if (looksLikeCode(value)) {
    return value;
  }

  const corrected = correctDigitZone(value);
  return looksLikeCode(corrected) ? corrected : null;
}

export function collectDirectMatches(text: string) {
  return text.toUpperCase().match(/\b[A-Z0-9]{11}\b/g) ?? [];
}

export function collectLineNormalizedMatches(text: string) {
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

/**
 * `minTotalCount` raises the bar for how many times a code must be seen
 * (across both direct and normalized matches combined) before it's
 * trusted. Live camera scanning passes 2+ here — with plenty of repeated
 * reads available, requiring corroboration for every candidate (including
 * otherwise-trusted direct matches) filters out one-off misreads from a
 * moment of camera drift. A single-pass read (e.g. one file upload
 * rotation) can't reasonably clear that bar, so it keeps the default of 1.
 */
export function extractCandidateCodes(texts: string[], options?: { minTotalCount?: number }) {
  const minTotalCount = options?.minTotalCount ?? 1;
  const directCounts = new Map<string, number>();
  const normalizedCounts = new Map<string, number>();

  for (const text of texts) {
    for (const candidate of collectDirectMatches(text)) {
      const normalized = normalizeCodeCandidate(candidate);

      if (normalized) {
        directCounts.set(normalized, (directCounts.get(normalized) ?? 0) + 1);
      }
    }

    for (const candidate of collectLineNormalizedMatches(text)) {
      const normalized = normalizeCodeCandidate(candidate);

      if (normalized) {
        normalizedCounts.set(normalized, (normalizedCounts.get(normalized) ?? 0) + 1);
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
    .filter(([, count]) => count >= minTotalCount)
    .sort((left, right) => {
      const countDelta = right[1] - left[1];

      if (countDelta !== 0) {
        return countDelta;
      }

      return left[0].localeCompare(right[0]);
    })
    .map(([value]) => value);
}
