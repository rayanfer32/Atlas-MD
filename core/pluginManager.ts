import fs from "fs";
import path from "path";
import chalk from "chalk";
import { getPluginURLs } from "../System/MongoDB/MongoDb_Core.js";
import { readcommands } from "../System/ReadCommands.js";

/**
 * Downloads and installs any remote plugin URLs saved in MongoDB.
 */
export async function installRemotePlugins(): Promise<void> {
  console.log(chalk.cyan(`[ ATLAS ] Checking plugins...`));
  let plugins: string[] = [];
  try {
    const fetched = await getPluginURLs();
    plugins = (fetched || []).filter((p: any): p is string => typeof p === "string");
  } catch (err: any) {
    console.error(
      chalk.redBright(`[ EXCEPTION ] Plugin DB error: ${err.message}`)
    );
  }

  if (!plugins.length) {
    console.log(chalk.gray(`[ ATLAS ] No extra plugins installed`));
    return;
  }

  console.log(chalk.cyan(`[ ATLAS ] Installing ${plugins.length} plugin(s)...`));
  for (let i = 0; i < plugins.length; i++) {
    const pluginUrl = plugins[i];
    try {
      const res = await fetch(pluginUrl);
      if (res.status === 200) {
        const folderName = "Plugins";
        const fileName = path.basename(pluginUrl);
        const filePath = path.join(folderName, fileName);
        let pluginBody = await res.text();

        if (
          pluginBody.includes("alias:") &&
          !pluginBody.includes("uniquecommands:")
        ) {
          pluginBody = pluginBody.replace(
            /alias:\s*(\[[\s\S]*?\]),/,
            (match, aliasPart) => `${match}\n  uniquecommands: ${aliasPart},`
          );
        }

        fs.writeFileSync(filePath, pluginBody);
        console.log(chalk.green(`[ ATLAS ] ✓ ${fileName}`));
      } else {
        console.log(
          chalk.yellow(`[ ATLAS ] ✗ ${path.basename(pluginUrl)} (HTTP ${res.status})`)
        );
      }
    } catch (error: any) {
      console.error(
        chalk.redBright(`[ EXCEPTION ] ✗ ${path.basename(pluginUrl)}: ${error.message}`)
      );
    }
  }
  console.log(chalk.green(`[ ATLAS ] Plugins ready`));
}

/**
 * Watches the Plugins directory for changes and hot-reloads commands.
 */
export function initPluginWatcher(): fs.FSWatcher {
  let reloadTimeout: NodeJS.Timeout | null = null;
  const watcher = fs.watch("./Plugins", (_eventType, filename) => {
    if (filename && (filename.endsWith(".js") || filename.endsWith(".ts"))) {
      if (reloadTimeout) clearTimeout(reloadTimeout);
      reloadTimeout = setTimeout(async () => {
        try {
          await readcommands();
          console.log(chalk.green(`[ ATLAS ] Hot-reloaded modified plugin: ${filename}`));
        } catch (err: any) {
          console.error(chalk.redBright(`[ ATLAS ] Failed to hot-reload: ${err.message}`));
        }
      }, 500);
    }
  });

  return watcher;
}
