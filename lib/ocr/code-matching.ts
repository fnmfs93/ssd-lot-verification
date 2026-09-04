// Pure text-matching logic for pulling label codes out of OCR output. No
// Node or browser APIs here — this runs both server-side (if ever needed
// again) and client-side, where OCR itself now happens.

// Real codes always follow J + MMYYDD (6 digits) + a 4-character
// alphanumeric suffix — e.g. J16262914IP. Locking to this exact shape
// rejects OCR noise from body text far more reliably than a generic
// "11 alphanumeric characters" check.
const CODE_PATTERN = /^J\d{8}[A-Z0-9]{2}$/;

export function looksLikeCode(value: string) {
  return CODE_PATTERN.test(value);
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

export function extractCandidateCodes(texts: string[]) {
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
