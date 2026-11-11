import { build } from "esbuild";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outdir: "dist",
  splitting: true,
  outExtension: { ".js": ".mjs" },
  entryNames: "[name]",
  chunkNames: "[name]-[hash]",
  loader: { ".md": "text", ".txt": "text" },
  alias: {
    "@vent/shared": path.resolve(__dirname, "../../shared/src/index.ts"),
  },
  external: [
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
  banner: {
    js: "#!/usr/bin/env node",
  },
});

console.log("Bundled → dist/");
