import "./Configurations.js";
import ffmpegStatic from "ffmpeg-static";
process.env.FFMPEG_PATH = (ffmpegStatic as unknown as string) || "";

import fs from "fs";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import figlet from "figlet";
import chalk from "chalk";
import got from "got";
import pino from "pino";
import mongoose from "mongoose";
import qrcodeTerminal from "qrcode-terminal";
import { Boom } from "@hapi/boom";
import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

import MongoAuth from "./System/MongoAuth/MongoAuth.js";
import { serialize } from "./System/whatsapp.js";
import welcomeLeft from "./System/Welcome.js";
import { readcommands, commands } from "./System/ReadCommands.js";
import core from "./Core.js";
import { getPluginURLs } from "./System/MongoDB/MongoDb_Core.js";
import { getSleepConfig, checkIfSleepTime } from "./utils/helper.js";

import { initLoggerNoiseFilter } from "./core/logger.js";
import { store } from "./core/store.js";
import { handleAntiDelete } from "./core/antidelete.js";
import { attachSocketHelpers } from "./core/socketHelpers.js";
import {
  startServer,
  setServerStatus,
  setServerQR,
  setServerSocket,
} from "./core/server.js";
import { initSleepScheduler, initGCScheduler } from "./core/scheduler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Write PID file
fs.writeFileSync(path.join(__dirname, "atlas.pid"), process.pid.toString());

// Initialize Baileys/libsignal noise filter
initLoggerNoiseFilter();

(commands as any).prefix = (global as any).prefa;
(global as any).isSleeping = false;
(global as any).justWokeUp = false;

let mongoAuth: any = null;

/**
 * Downloads and installs any remote plugin URLs saved in MongoDB.
 */
async function installPlugin(): Promise<void> {
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
      const { body, statusCode } = await got(pluginUrl);
      if (statusCode === 200) {
        const folderName = "Plugins";
        const fileName = path.basename(pluginUrl);
        const filePath = path.join(folderName, fileName);
        let pluginBody = body;

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
          chalk.yellow(`[ ATLAS ] ✗ ${path.basename(pluginUrl)} (HTTP ${statusCode})`)
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
 * Main function to start the Atlas WhatsApp bot instance.
 */
export const startAtlas = async (): Promise<void> => {
  const pad = (num: number) => String(num).padStart(2, "0");

  if (checkIfSleepTime()) {
    (global as any).isSleeping = true;
    setServerStatus("sleeping");
    const { sleepTime, wakeTime } = getSleepConfig();
    const sleepStr = `${pad(sleepTime.hour)}:${pad(sleepTime.minute)}`;
    const wakeStr = `${pad(wakeTime.hour)}:${pad(wakeTime.minute)}`;

    console.log(
      chalk.yellow(
        `[ ATLAS ] Bot is in sleep hours (${sleepStr} - ${wakeStr}). Suppressing WhatsApp socket connection. Process remains alive.`
      )
    );

    try {
      if (mongoose.connection.readyState === 0) {
        await mongoose.connect((global as any).mongodb);
        console.log(chalk.green(`[ ATLAS ] MongoDB connected (during sleep startup) ✓`));
      }
    } catch (err: any) {
      console.error(
        chalk.redBright(`[ EXCEPTION ] MongoDB error during sleep startup: ${err.message}`)
      );
    }
    return;
  }

  try {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect((global as any).mongodb);
      console.log(chalk.green(`[ ATLAS ] MongoDB connected ✓`));
    }
  } catch (err: any) {
    console.error(chalk.redBright(`[ EXCEPTION ] MongoDB error: ${err.message}`));
  }

  mongoAuth = new MongoAuth((global as any).sessionId);
  const { state, saveCreds, clearState } = await mongoAuth.init();

  console.log(
    figlet.textSync("ATLAS", {
      font: "Standard",
      horizontalLayout: "default",
      width: 70,
      whitespaceBreak: true,
    })
  );

  // Version info + update check
  const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
  (global as any).botVersion = pkg.version;
  (global as any).latestVersion = pkg.version;
  (global as any).updateAvailable = false;

  console.log(
    chalk.cyan(
      `[ ATLAS ] v${pkg.version}  |  Node.js ${process.version}  |  ${process.platform}/${process.arch}`
    )
  );

  try {
    const remote: any = await got(
      "https://raw.githubusercontent.com/FantoX/Atlas-MD/main/package.json"
    ).json();
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

  await installPlugin();
  await readcommands();

  const { version } = await fetchLatestBaileysVersion();

  const Atlas = makeWASocket({
    logger: pino({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    auth: state,
    version,
    keepAliveIntervalMs: 20_000,
    shouldSyncHistoryMessage: () => false,
  });

  setServerSocket(Atlas);
  store.bind(Atlas.ev);
  attachSocketHelpers(Atlas, store);

  (Atlas as any).public = true;

  // Connection lifecycle handler
  Atlas.ev.on("connection.update", async (update: any) => {
    const { lastDisconnect, connection, qr } = update;
    if (connection) {
      const currentStatus = (global as any).isSleeping ? "sleeping" : connection;
      setServerStatus(currentStatus);
      console.info(`[ ATLAS ] Server Status => ${currentStatus}`);
    }

    if (connection === "open") {
      if ((global as any).justWokeUp) {
        (global as any).justWokeUp = false;
        const owners = (global as any).owner || [];
        for (const owner of owners) {
          const cleanOwner = String(owner).replace(/[^0-9]/g, "");
          if (cleanOwner) {
            const jid = `${cleanOwner}@s.whatsapp.net`;
            console.log(chalk.green(`[ ATLAS ] Notifying ${owner} ${jid} that bot has woken up...`));
            setTimeout(async () => {
              await Atlas.sendMessage(jid, {
                text: "🌅 *Atlas Bot has woken up and is now online!*",
              }).catch(() => {});
            }, 10_000);
          }
        }
      }
    }

    if (connection === "close") {
      if ((global as any).isSleeping) {
        console.log("[ ATLAS ] WhatsApp connection closed for scheduled sleep. Reconnection suppressed.\n");
        return;
      }
      const reason = new Boom(lastDisconnect?.error)?.output.statusCode;

      if (reason === DisconnectReason.badSession) {
        console.log("[ ATLAS ] Bad session detected — clearing and restarting for fresh QR scan...\n");
        await clearState();
        startAtlas();
      } else if (reason === DisconnectReason.connectionClosed) {
        console.log("[ ATLAS ] Connection closed, reconnecting....\n");
        startAtlas();
      } else if (reason === DisconnectReason.connectionLost) {
        console.log("[ ATLAS ] Connection Lost from Server, reconnecting...\n");
        startAtlas();
      } else if (reason === DisconnectReason.connectionReplaced) {
        console.log("[ ATLAS ] Connection Replaced, Another New Session Opened, Please Close Current Session First!\n");
        process.exit();
      } else if (reason === DisconnectReason.loggedOut) {
        console.log("[ ATLAS ] Device logged out — clearing session and restarting for fresh QR scan...\n");
        await clearState();
        startAtlas();
      } else if (reason === DisconnectReason.restartRequired) {
        console.log("[ ATLAS ] Server Restarting...\n");
        startAtlas();
      } else if (reason === DisconnectReason.timedOut) {
        console.log("[ ATLAS ] Connection Timed Out, Trying to Reconnect...\n");
        startAtlas();
      } else {
        console.log("ReasonCode:", reason);
        console.log(`[ ATLAS ] Server Disconnected: "It's either safe disconnect or WhatsApp Account got banned !\n"`);
      }
    }

    if (qr) {
      setServerQR(qr);
      setServerStatus("qr");
      qrcodeTerminal.generate(qr, { small: true });
    }
  });

  Atlas.ev.on("creds.update", saveCreds);

  Atlas.ev.on("group-participants.update", async (m: any) => {
    welcomeLeft(Atlas, m);
  });

  Atlas.ev.on("messages.upsert", async (chatUpdate: any) => {
    if (chatUpdate.type !== "notify") return;
    const msg = chatUpdate.messages?.[0];
    if (!msg) return;
    const m = serialize(Atlas, msg);

    if (!m?.message) return;
    if (m.key?.remoteJid === "status@broadcast") return;
    if (m.key?.id?.startsWith("BAE5") && m.key.id.length === 16) return;

    core(Atlas, m, commands, chatUpdate);
  });

  Atlas.ev.on("messages.update", async (updates: any) => {
    await handleAntiDelete(Atlas, updates, store);
  });

  Atlas.ev.on("contacts.update", (updates: any[]) => {
    for (const contact of updates) {
      const id = (Atlas as any).decodeJid(contact.id);
      if (store && store.contacts) {
        store.contacts[id] = {
          id,
          name: contact.notify,
        };
      }
    }
  });
};

// Plugin directory hot-reloading watcher
let reloadTimeout: NodeJS.Timeout | null = null;
fs.watch("./Plugins", (_eventType, filename) => {
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

// Start Express HTTP server & Schedulers
startServer((global as any).port);
initSleepScheduler(startAtlas);
initGCScheduler(() => mongoAuth, startAtlas);

// Launch bot
startAtlas();
