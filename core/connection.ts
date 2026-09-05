import fs from "fs";
import path from "path";
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

import MongoAuth from "../System/MongoAuth/MongoAuth.js";
import { readcommands } from "../System/ReadCommands.js";
import { getSleepConfig, checkIfSleepTime } from "../utils/helper.js";
import { store, MESSAGE_CACHE_TTL_MS } from "./store.js";
import { attachSocketHelpers } from "./socketHelpers.js";
import {
  setServerStatus,
  getServerStatus,
  setServerQR,
  setServerSocket,
  setConnectionDiagnostics,
} from "./server.js";
import { displayBannerAndCheckUpdates } from "./banner.js";
import { installRemotePlugins } from "./pluginManager.js";
import { bindSocketEvents } from "./events.js";

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
const cleanupCallbacks: Array<() => void | Promise<void>> = [];

/**
 * Checks whether the specified socket matches the currently active socket generation.
 */
export const isCurrentSocket = (socket: any, generation: number): boolean =>
  AtlasSocket === socket && activeSocketGeneration === generation;

/**
 * Updates diagnostic status in the server module.
 */
export const updateDiagnostics = (): void => {
  setConnectionDiagnostics({
    websocketOpen: Boolean(AtlasSocket?.ws?.isOpen),
    reconnectAttempt,
    healthProbeFailures,
    lastConnectionUpdate: new Date(lastConnectionUpdateAt).toISOString(),
  });
};

const clearStableConnectionTimer = (): void => {
  if (stableConnectionTimer) {
    clearTimeout(stableConnectionTimer);
    stableConnectionTimer = null;
  }
};

const markConnectionStableLater = (socket: any, generation: number): void => {
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

/**
 * Closes the active WhatsApp socket cleanly or terminates if stalled.
 */
export const closeActiveSocket = async (reason: string): Promise<void> => {
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

const getReconnectDelay = (immediate: boolean): number => {
  if (immediate && reconnectAttempt === 1) return 250;
  const exponentialDelay = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, reconnectAttempt - 1)
  );
  const jitter = Math.floor(exponentialDelay * 0.2 * Math.random());
  return exponentialDelay + jitter;
};

/**
 * Schedules a socket reconnection attempt with exponential backoff.
 */
export const scheduleReconnect = (
  reason: string,
  { clearAuth = false, immediate = false } = {}
): void => {
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
 * Silently wipes Cache directory contents on boot / restart (preserves .gitkeep).
 */
const clearSystemCache = (): void => {
  try {
    const cacheDir = path.resolve(process.cwd(), "System", "Cache");
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
};

/**
 * Establishes the WhatsApp socket connection and initializes dependencies.
 */
const connectAtlas = async (trigger: string): Promise<any> => {
  console.log(chalk.cyan(`[ ATLAS ] Starting connection (${trigger})...`));

  clearSystemCache();

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

  await displayBannerAndCheckUpdates();

  await installRemotePlugins();
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

  // Connection lifecycle events
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
              }).catch(() => { });
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

  // Bind message, contact, and participant events
  bindSocketEvents({
    Atlas,
    generation,
    isCurrentSocket,
    saveCreds,
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

/**
 * Periodic MongoDB session sync with mutex lock.
 */
export const runPeriodicSync = async (): Promise<void> => {
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

/**
 * Active connection watchdog with WhatsApp IQ health ping probe.
 */
export const runWatchdog = async (): Promise<void> => {
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

/**
 * Initializes the connection watchdog timer.
 */
export function initWatchdog(): NodeJS.Timeout {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    void runWatchdog();
  }, WATCHDOG_INTERVAL_MS);

  console.log(
    chalk.cyan(
      `[ ATLAS ] Connection watchdog active - probing every ` +
      `${WATCHDOG_INTERVAL_MS / 1000}s`
    )
  );
  return watchdogTimer;
}

/**
 * Initializes the message cache pruning timer.
 */
export function initMessageCachePruner(): NodeJS.Timeout {
  if (messageCacheTimer) clearInterval(messageCacheTimer);
  messageCacheTimer = setInterval(
    () => store.pruneMessages(),
    Math.min(
      10 * 60 * 1000,
      Math.max(60_000, Math.floor(MESSAGE_CACHE_TTL_MS / 2))
    )
  );
  return messageCacheTimer;
}

/**
 * Registers a callback to be run during graceful shutdown.
 */
export function onShutdown(cb: () => void | Promise<void>): void {
  cleanupCallbacks.push(cb);
}

/**
 * Performs graceful shutdown of the bot process.
 */
export async function shutdownAtlas(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  setServerStatus("stopping");
  console.log(chalk.yellow(`[ ATLAS ] ${signal} received - shutting down`));

  if (restartTimer) clearTimeout(restartTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  if (messageCacheTimer) clearInterval(messageCacheTimer);
  clearStableConnectionTimer();

  for (const cb of cleanupCallbacks) {
    try {
      await cb();
    } catch (_) { }
  }

  await Promise.race([
    runPeriodicSync(),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  await closeActiveSocket(`Process shutdown: ${signal}`);
  await mongoose.disconnect().catch(() => { });
  process.exit(0);
}
