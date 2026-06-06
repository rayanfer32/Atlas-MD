import fs from "fs";
import Collections from "./Collections.js";
const commands = new Collections();
commands.prefix = global.prefa;

async function readcommands() {
  commands.clear();
  const cmdfile = fs
    .readdirSync("./Plugins")
    .filter((file) => file.endsWith(".js") || file.endsWith(".ts"));
  for (const file of cmdfile) {
    try {
      const module = await import(`../Plugins/${file}`);
      const cmdfiles = module.default;
      if (!cmdfiles || !cmdfiles.name) {
        console.warn(`[ ATLAS ] Skipping ${file}: missing default export or name`);
        continue;
      }
      commands.set(cmdfiles.name, cmdfiles);
    } catch (err) {
      if (file.endsWith(".ts")) {
        console.warn(
          `[ ATLAS ] Skipping TypeScript plugin ${file}: ${err.message}. (Run with 'npm run start:ts' or Bun to support TypeScript plugins)`
        );
      } else {
        console.error(`[ EXCEPTION ] Failed to load plugin ${file}: ${err.message}`);
      }
    }
  }
}

  export {readcommands, commands};