import "./Configurations.js";
import ffmpegStatic from "ffmpeg-static";
process.env.FFMPEG_PATH = (ffmpegStatic as unknown as string) || "";

import fs from "fs";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import figlet from "figlet";
import chalk from "chalk";
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
import { store, MESSAGE_CACHE_TTL_MS } from "./core/store.js";
import { handleAntiDelete } from "./core/antidelete.js";
import { attachSocketHelpers } from "./core/socketHelpers.js";
import {
  startServer,
  setServerStatus,
  getServerStatus,
  setServerQR,
  setServerSocket,
  setConnectionDiagnostics,
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

// Connection & Watchdog Configuration Constants
const KEEP_ALIVE_INTERVAL_MS = 25_000;
const WATCHDOG_INTERVAL_MS =
  Math.max(
    30,
    Math.min(
      600,
      parseInt(process.env.WATCHDOG_INTERVAL_SECONDS || "60", 10) || 60
    )
  ) * 1000;
const HEALTH_QUERY_TIMEOUT_MS = 15_000;
const HEALTH_FAILURE_THRESHOLD = 2;
const CONNECT_STALL_TIMEOUT_MS = 180_000;
const SOCKET_CLOSE_TIMEOUT_MS = 5_000;
const RECONNECT_BASE_DELAY_MS = 3_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const STABLE_CONNECTION_MS = 300_000;

// Reconnection & Watchdog State
let AtlasSocket: any = null;
let mongoAuth: any = null;
let clearAuthState: (() => Promise<void>) | null = null;
let startPromise: Promise<any> | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let pendingClearAuth = false;
let reconnectAttempt = 0;
let activeSocketGeneration = 0;
let socketGeneration = 0;
let socketStartedAt = 0;
let lastConnectionUpdateAt = Date.now();
let healthProbeFailures = 0;
let healthProbeRunning = false;
let stableConnectionTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;
let periodicSyncPromise: Promise<void> | null = null;
let sessionSyncPaused = false;
let watchdogTimer: NodeJS.Timeout | null = null;
let messageCacheTimer: NodeJS.Timeout | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;

const isCurrentSocket = (socket: any, generation: number) =>
  AtlasSocket === socket && activeSocketGeneration === generation;

const updateDiagnostics = () => {
  setConnectionDiagnostics({
    websocketOpen: Boolean(AtlasSocket?.ws?.isOpen),
    reconnectAttempt,
    healthProbeFailures,
    lastConnectionUpdate: new Date(lastConnectionUpdateAt).toISOString(),
  });
};

const clearStableConnectionTimer = () => {
  if (stableConnectionTimer) {
    clearTimeout(stableConnectionTimer);
    stableConnectionTimer = null;
  }
};

const markConnectionStableLater = (socket: any, generation: number) => {
  clearStableConnectionTimer();
  stableConnectionTimer = setTimeout(() => {
    if (isCurrentSocket(socket, generation) && getServerStatus() === "open") {
      reconnectAttempt = 0;
      updateDiagnostics();
      console.log(chalk.green(`[ ATLAS ] Connection stable - backoff reset`));
    }
  }, STABLE_CONNECTION_MS);
  (stableConnectionTimer as any).unref?.();
};

const closeActiveSocket = async (reason: string) => {
  const socket = AtlasSocket;
  if (!socket) return;

  AtlasSocket = null;
  setServerSocket(null);
  activeSocketGeneration = 0;
  socketStartedAt = 0;
  healthProbeFailures = 0;
  clearStableConnectionTimer();
  updateDiagnostics();

  try {
    const endPromise = socket.end(
      new Boom(reason, {
        statusCode: DisconnectReason.connectionClosed,
      })
    );
    const closedCleanly = await Promise.race([
      endPromise.then(() => true),
      new Promise((resolve) =>
        setTimeout(() => resolve(false), SOCKET_CLOSE_TIMEOUT_MS)
      ),
    ]);

    if (!closedCleanly) {
      console.log(
        chalk.yellow(
          `[ ATLAS ] Socket close timed out - forcing WebSocket termination`
        )
      );
      socket.ws?.socket?.terminate?.();
      await Promise.race([
        endPromise,
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
  } catch (err: any) {
    console.error(
      chalk.redBright(`[ ATLAS ] Socket cleanup error: ${err.message}`)
    );
  }
};

const getReconnectDelay = (immediate: boolean) => {
  if (immediate && reconnectAttempt === 1) return 250;
  const exponentialDelay = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, reconnectAttempt - 1)
  );
  const jitter = Math.floor(exponentialDelay * 0.2 * Math.random());
  return exponentialDelay + jitter;
};

const scheduleReconnect = (
  reason: string,
  { clearAuth = false, immediate = false } = {}
) => {
  if (shuttingDown) return;
  if ((global as any).isSleeping) {
    console.log(chalk.gray(`[ ATLAS ] Reconnect suppressed (bot is scheduled to sleep)`));
    return;
  }

  pendingClearAuth = pendingClearAuth || clearAuth;
  if (restartTimer) {
    console.log(
      chalk.gray(`[ ATLAS ] Reconnect already scheduled - ${reason}`)
    );
    return;
  }

  reconnectAttempt += 1;
  const delay = getReconnectDelay(immediate);
  setServerStatus("reconnecting");
  setServerQR(null);
  updateDiagnostics();

  console.log(
    chalk.yellow(
      `[ ATLAS ] Reconnect scheduled in ${(delay / 1000).toFixed(1)}s ` +
        `(attempt ${reconnectAttempt}) - ${reason}`
    )
  );

  restartTimer = setTimeout(async () => {
    restartTimer = null;
    const shouldClearAuth = pendingClearAuth;
    pendingClearAuth = false;

    try {
      await closeActiveSocket(`Reconnecting: ${reason}`);
      if (shouldClearAuth && clearAuthState) {
        sessionSyncPaused = true;
        await periodicSyncPromise;
        await clearAuthState();
      }

      const inFlightStart = startPromise;
      if (inFlightStart) {
        await inFlightStart;
      }
      await startAtlas(`reconnect: ${reason}`);
    } catch (err: any) {
      console.error(
        chalk.redBright(`[ ATLAS ] Reconnect cycle failed: ${err.message}`)
      );
      scheduleReconnect(`reconnect cycle failed: ${err.message}`, {
        clearAuth: shouldClearAuth,
      });
    } finally {
      sessionSyncPaused = false;
    }
  }, delay);
};

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
 * Internal connection establishment function.
 */
const connectAtlas = async (trigger: string): Promise<any> => {
  console.log(chalk.cyan(`[ ATLAS ] Starting connection (${trigger})...`));

  // Silently wipe Cache folder on every boot / restart (preserve .gitkeep)
  try {
    const cacheDir = path.join(__dirname, "System", "Cache");
    if (fs.existsSync(cacheDir)) {
      for (const entry of fs.readdirSync(cacheDir)) {
        if (entry === ".gitkeep") continue;
        const entryPath = path.join(cacheDir, entry);
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
    }
  } catch (_) {
    // intentionally silent
  }

  try {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect((global as any).mongodb);
      console.log(chalk.green(`[ ATLAS ] MongoDB connected ✓`));
    }
  } catch (err: any) {
    console.error(chalk.redBright(`[ EXCEPTION ] MongoDB error: ${err.message}`));
  }

  const nextMongoAuth = new MongoAuth((global as any).sessionId);
  const { state, saveCreds, clearState } = await nextMongoAuth.init();
  mongoAuth = nextMongoAuth;
  clearAuthState = clearState;

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

  await installPlugin();
  await readcommands();

  const { version } = await fetchLatestBaileysVersion();

  const generation = ++socketGeneration;
  const Atlas = makeWASocket({
    logger: pino({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    auth: state,
    version,
    keepAliveIntervalMs: KEEP_ALIVE_INTERVAL_MS,
    shouldSyncHistoryMessage: () => false,
  });

  AtlasSocket = Atlas;
  activeSocketGeneration = generation;
  socketStartedAt = Date.now();
  lastConnectionUpdateAt = socketStartedAt;
  healthProbeFailures = 0;

  setServerSocket(Atlas);
  store.bind(Atlas.ev);
  attachSocketHelpers(Atlas, store);

  (Atlas as any).public = true;
  updateDiagnostics();

  // Connection lifecycle handler
  Atlas.ev.on("connection.update", async (update: any) => {
    if (!isCurrentSocket(Atlas, generation)) return;

    const { lastDisconnect, connection, qr } = update;
    lastConnectionUpdateAt = Date.now();

    if (connection) {
      const currentStatus = (global as any).isSleeping ? "sleeping" : connection;
      setServerStatus(currentStatus);
      console.info(`[ ATLAS ] Server Status => ${currentStatus}`);
    }

    if (connection === "open") {
      setServerQR(null);
      healthProbeFailures = 0;
      markConnectionStableLater(Atlas, generation);

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
      const reasonName = (DisconnectReason as any)[reason] || `unknown (${reason})`;
      const shouldClearAuth =
        reason === DisconnectReason.badSession ||
        reason === DisconnectReason.loggedOut;

      AtlasSocket = null;
      setServerSocket(null);
      activeSocketGeneration = 0;
      socketStartedAt = 0;
      healthProbeFailures = 0;
      clearStableConnectionTimer();
      updateDiagnostics();

      console.log(
        chalk.yellow(
          `[ ATLAS ] Connection closed - ${reasonName}. Recovery starting.`
        )
      );
      scheduleReconnect(`disconnect: ${reasonName}`, {
        clearAuth: shouldClearAuth,
        immediate: reason === DisconnectReason.restartRequired,
      });
    }

    if (qr) {
      setServerQR(qr);
      setServerStatus("qr");
      qrcodeTerminal.generate(qr, { small: true });
    }

    updateDiagnostics();
  });

  Atlas.ev.on("creds.update", saveCreds);

  Atlas.ev.on("group-participants.update", async (m: any) => {
    if (!isCurrentSocket(Atlas, generation)) return;
    welcomeLeft(Atlas, m);
  });

  Atlas.ev.on("messages.upsert", async (chatUpdate: any) => {
    if (!isCurrentSocket(Atlas, generation)) return;
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
    if (!isCurrentSocket(Atlas, generation)) return;
    await handleAntiDelete(Atlas, updates, store);
  });

  Atlas.ev.on("contacts.update", (updates: any[]) => {
    if (!isCurrentSocket(Atlas, generation)) return;
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

  return Atlas;
};

/**
 * Main entrypoint to start or reconnect the Atlas bot.
 */
export const startAtlas = async (trigger: string = "initial"): Promise<any> => {
  const pad = (num: number) => String(num).padStart(2, "0");

  if (shuttingDown) return null;
  if (startPromise) return startPromise;
  if (AtlasSocket?.ws?.isOpen && getServerStatus() === "open") return AtlasSocket;

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
    return null;
  }

  setServerStatus("connecting");
  lastConnectionUpdateAt = Date.now();
  updateDiagnostics();

  startPromise = connectAtlas(trigger)
    .catch((err: any) => {
      console.error(
        chalk.redBright(`[ ATLAS ] Connection startup failed: ${err.message}`)
      );
      scheduleReconnect(`startup failed: ${err.message}`);
      return null;
    })
    .finally(() => {
      startPromise = null;
    });

  return startPromise;
};

// Periodic MongoDB session sync with mutex lock
const runPeriodicSync = async (): Promise<void> => {
  if (sessionSyncPaused || !mongoAuth) return;
  if (periodicSyncPromise) {
    await periodicSyncPromise;
    return;
  }

  periodicSyncPromise = mongoAuth
    .pushToMongoDB()
    .then(() => console.log(chalk.cyan(`[ ATLAS ] Session synced to MongoDB`)))
    .catch((err: any) =>
      console.error(
        chalk.redBright(`[ ATLAS ] MongoDB session sync error: ${err.message}`)
      )
    )
    .finally(() => {
      periodicSyncPromise = null;
    });

  await periodicSyncPromise;
};

// Active Connection Watchdog with WhatsApp IQ health ping probe
const runWatchdog = async (): Promise<void> => {
  if (shuttingDown || healthProbeRunning || (global as any).isSleeping) return;

  const socket = AtlasSocket;
  const generation = activeSocketGeneration;
  const status = getServerStatus();

  if (!socket) {
    const startingFor = Date.now() - lastConnectionUpdateAt;
    if (startPromise && startingFor > CONNECT_STALL_TIMEOUT_MS) {
      console.error(
        chalk.redBright(
          `[ ATLAS ] Connection startup stalled for ` +
            `${Math.round(startingFor / 1000)}s - exiting for supervisor restart`
        )
      );
      process.exit(1);
    }

    if (!startPromise && !restartTimer && status !== "reconnecting") {
      scheduleReconnect("watchdog found no active socket");
    }
    return;
  }

  if (status === "connecting") {
    const connectingFor = Date.now() - socketStartedAt;
    if (socketStartedAt && connectingFor > CONNECT_STALL_TIMEOUT_MS) {
      scheduleReconnect(
        `connection stalled for ${Math.round(connectingFor / 1000)}s`,
        { immediate: true }
      );
    }
    return;
  }

  if (status !== "open") return;

  if (!socket.ws?.isOpen) {
    scheduleReconnect("watchdog found WebSocket closed", { immediate: true });
    return;
  }

  healthProbeRunning = true;
  try {
    const response = await socket.query(
      {
        tag: "iq",
        attrs: {
          to: "s.whatsapp.net",
          type: "get",
          xmlns: "w:p",
        },
        content: [{ tag: "ping", attrs: {} }],
      },
      HEALTH_QUERY_TIMEOUT_MS
    );

    if (!response) {
      throw new Error("WhatsApp ping timed out");
    }

    if (isCurrentSocket(socket, generation)) {
      healthProbeFailures = 0;
      lastConnectionUpdateAt = Date.now();
      updateDiagnostics();
    }
  } catch (err: any) {
    if (!isCurrentSocket(socket, generation)) return;

    healthProbeFailures += 1;
    updateDiagnostics();
    console.error(
      chalk.yellow(
        `[ ATLAS ] Watchdog probe failed ${healthProbeFailures}/` +
          `${HEALTH_FAILURE_THRESHOLD}: ${err.message}`
      )
    );

    if (healthProbeFailures >= HEALTH_FAILURE_THRESHOLD) {
      scheduleReconnect("WhatsApp health probes failed", { immediate: true });
    }
  } finally {
    healthProbeRunning = false;
  }
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
maintenanceTimer = initGCScheduler(runPeriodicSync);

// Watchdog timer & message cache prune timer
watchdogTimer = setInterval(() => {
  void runWatchdog();
}, WATCHDOG_INTERVAL_MS);

messageCacheTimer = setInterval(
  () => store.pruneMessages(),
  Math.min(
    10 * 60 * 1000,
    Math.max(60_000, Math.floor(MESSAGE_CACHE_TTL_MS / 2))
  )
);

console.log(
  chalk.cyan(
    `[ ATLAS ] Connection watchdog active - probing every ` +
      `${WATCHDOG_INTERVAL_MS / 1000}s`
  )
);

// Graceful process shutdown
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  setServerStatus("stopping");
  console.log(chalk.yellow(`[ ATLAS ] ${signal} received - shutting down`));

  if (restartTimer) clearTimeout(restartTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  if (messageCacheTimer) clearInterval(messageCacheTimer);
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  clearStableConnectionTimer();

  await Promise.race([
    runPeriodicSync(),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  await closeActiveSocket(`Process shutdown: ${signal}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

// Launch bot
void startAtlas("initial");
