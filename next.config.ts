import type { NextConfig } from "next";

// OCR now runs entirely client-side (lib/ocr/browser-ocr.ts) instead of via
// sharp + tesseract.js on the server, so none of the server-bundling
// workarounds this file used to need (serverExternalPackages,
// outputFileTracingIncludes for tesseract.js's worker script and sharp's
// native libvips binary) are required any more.
const nextConfig: NextConfig = {};

export default nextConfig;
