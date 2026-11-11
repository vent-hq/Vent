import { build } from "esbuild";
import { cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packages = path.resolve(__dirname, "../../../packages");

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outdir: "dist",
  packages: "external",
  alias: {
    "@vent/shared": path.resolve(packages, "shared/src/index.ts"),
    "@vent/db": path.resolve(packages, "db/src/index.ts"),
    "@vent/voice": path.resolve(packages, "voice/src/index.ts"),
    "@vent/platform-connections": path.resolve(packages, "platform-connections/src/index.ts"),
    "@vent/artifacts": path.resolve(packages, "artifacts/src/index.ts"),
  },
  plugins: [
    {
      name: "externalize-ten-vad",
      setup(build) {
        build.onResolve({ filter: /ten_vad\.mjs$/ }, () => ({
          path: "./ten-vad/ten_vad.mjs",
          external: true,
        }));
      },
    },
  ],
});

// Copy ten-vad WASM assets for voice package runtime resolution
cpSync(
  path.resolve(packages, "voice/src/ten-vad"),
  path.resolve(__dirname, "../dist/ten-vad"),
  { recursive: true }
);

console.log("Bundled → dist/");
