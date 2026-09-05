import { defineConfig } from "tsup";
import fs from "fs";

export default defineConfig({
  entry: {
    index: "src/index.ts",
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
  },
});
