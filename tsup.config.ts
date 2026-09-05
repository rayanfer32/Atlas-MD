import { defineConfig } from "tsup";
import fs from "fs";
import path from "path";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "plugins/index": "src/plugins/index.ts",
  },
  format: ["esm"],
  dts: false,
  clean: false,
  sourcemap: true,
  target: "es2022",
  outDir: "dist",
  shims: true,
  splitting: false,
  async onSuccess() {
    // Ensure dist/index.d.ts re-exports dist/src/index.js
    const dtsContent = `export * from "./src/index.js";\nexport { default } from "./src/index.js";\n`;
    fs.writeFileSync("dist/index.d.ts", dtsContent, "utf8");

    // Ensure dist/plugins/index.d.ts exists
    const pluginsDtsDir = path.resolve("dist/plugins");
    if (!fs.existsSync(pluginsDtsDir)) fs.mkdirSync(pluginsDtsDir, { recursive: true });
    const pluginsDts = `export * from "../src/plugins/index.js";\nexport { default } from "../src/plugins/index.js";\n`;
    fs.writeFileSync(path.join(pluginsDtsDir, "index.d.ts"), pluginsDts, "utf8");
  },
});
