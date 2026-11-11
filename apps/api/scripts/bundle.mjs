import { build } from "esbuild";
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
    "@vent/platform-connections": path.resolve(packages, "platform-connections/src/index.ts"),
    "@vent/artifacts": path.resolve(packages, "artifacts/src/index.ts"),
  },
});

console.log("Bundled → dist/");
