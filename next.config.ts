import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["tesseract.js", "sharp"],
  outputFileTracingIncludes: {
    "/api/label-session": [
      "./node_modules/tesseract.js/**",
      "./node_modules/tesseract.js-core/**",
      "./node_modules/bmp-js/**",
      "./node_modules/idb-keyval/**",
      "./node_modules/is-url/**",
      "./node_modules/node-fetch/**",
      "./node_modules/opencollective-postinstall/**",
      "./node_modules/regenerator-runtime/**",
      "./node_modules/wasm-feature-detect/**",
      "./node_modules/zlibjs/**",
      "./node_modules/whatwg-url/**",
      "./node_modules/tr46/**",
      "./node_modules/webidl-conversions/**",
      // sharp's native binding + libvips shared library live under the
      // scoped @img/* packages, not node_modules/sharp itself.
      "./node_modules/sharp/**",
      "./node_modules/@img/**",
    ],
  },
};

export default nextConfig;
