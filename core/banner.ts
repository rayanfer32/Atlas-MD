import fs from "fs";
import path from "path";
import figlet from "figlet";
import chalk from "chalk";

/**
 * Displays the ASCII art banner, system information, and checks GitHub for updates.
 */
export async function displayBannerAndCheckUpdates(): Promise<void> {
  console.log(
    figlet.textSync("ATLAS", {
      font: "Standard",
      horizontalLayout: "default",
      width: 70,
      whitespaceBreak: true,
    })
  );

  // Version info + update check
  const pkgPath = path.resolve(process.cwd(), "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  (global as any).botVersion = pkg.version;
  (global as any).latestVersion = pkg.version;
  (global as any).updateAvailable = false;

  console.log(
    chalk.cyan(
      `[ ATLAS ] v${pkg.version}  |  Node.js ${process.version}  |  ${process.platform}/${process.arch}`
    )
  );

  try {
    const remoteRes = await fetch(
      "https://raw.githubusercontent.com/FantoX/Atlas-MD/main/package.json"
    );
    const remote: any = await remoteRes.json();
    (global as any).latestVersion = remote.version;
    if (remote.version !== pkg.version) {
      (global as any).updateAvailable = true;
      console.log(
        chalk.yellow(
          `[ ATLAS ] Update available: v${pkg.version} → v${remote.version}  |  git pull && npm install`
        )
      );
    } else {
      console.log(chalk.green(`[ ATLAS ] Up to date ✓`));
    }
  } catch {
    console.log(chalk.gray(`[ ATLAS ] Update check skipped (network unavailable)`));
  }
  console.log("");
}
