import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  sourcemap: true,
  dts: true,
  clean: true,
  outDir: "dist",
  splitting: false,
  treeshake: true,
  minify: false,
  external: ["@opencode-ai/plugin", "@opencode-ai/sdk", "ws", "@larksuiteoapi/node-sdk", "zod", "https-proxy-agent"],
  // Keep runtime deps external so bundled third-party JSDoc type imports
  // (e.g. import('./list.d.ts')) are not resolved against our dist/ folder.
});
