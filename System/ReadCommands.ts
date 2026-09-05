import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

export interface CommandCollection extends Map<string, any> {
  prefix?: any;
}

const commands: CommandCollection = new Map();
commands.prefix = (global as any).prefa;

async function readcommands(): Promise<void> {
  commands.clear();
  const cmdfile = fs
    .readdirSync("./Plugins")
    .filter((file) => file.endsWith(".js") || file.endsWith(".ts"));
  for (const file of cmdfile) {
    try {
      const filePath = path.resolve("./Plugins", file);
      const fileUrl = pathToFileURL(filePath).href;
      const module = await import(`${fileUrl}?update=${Date.now()}`);
      const cmdfiles = module.default;
      if (!cmdfiles || !cmdfiles.name) {
        console.warn(`[ ATLAS ] Skipping ${file}: missing default export or name`);
        continue;
      }
      commands.set(cmdfiles.name, cmdfiles);
    } catch (err: any) {
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

export { readcommands, commands };
export default readcommands;
