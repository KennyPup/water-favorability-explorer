/**
 * Build script – bundles server (ESM→CJS) then builds Vite client.
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const root = process.cwd();

console.log("[build] Bundling server…");
execSync(
  `esbuild server/index.ts \
    --bundle \
    --platform=node \
    --format=cjs \
    --outfile=dist/index.cjs \
    --external:vite \
    --external:lightningcss \
    --external:esbuild \
    --external:tsx \
    --external:better-sqlite3`,
  { stdio: "inherit", cwd: root }
);

console.log("[build] Building Vite client…");
execSync("vite build", { stdio: "inherit", cwd: root });

// Copy Python scripts into dist so they are co-located with server bundle
const pyFiles = ["run_hf.py"];
for (const f of pyFiles) {
  const src = path.join(root, "python", f);
  const dst = path.join(root, "dist", f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    console.log(`[build] Copied ${f}`);
  }
}

console.log("[build] Done.");
