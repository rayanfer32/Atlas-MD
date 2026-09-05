import "./core/configurations.js";

import ffmpegStatic from "ffmpeg-static";
process.env.FFMPEG_PATH = (ffmpegStatic as unknown as string) || "";

import fs from "fs";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import { commands } from "./System/ReadCommands.js";
import { initLoggerNoiseFilter } from "./core/logger.js";
import { startServer } from "./core/server.js";
import { initSleepScheduler, initGCScheduler } from "./core/scheduler.js";
import { initPluginWatcher } from "./core/pluginManager.js";
import {
  startAtlas,
  runPeriodicSync,
  initWatchdog,
  initMessageCachePruner,
  shutdownAtlas,
  onShutdown,
} from "./core/connection.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Write PID file
fs.writeFileSync(path.join(__dirname, "atlas.pid"), process.pid.toString());

// Initialize Baileys/libsignal noise filter
initLoggerNoiseFilter();

(commands as any).prefix = (global as any).prefa;
(global as any).isSleeping = false;
(global as any).justWokeUp = false;

// Start Express HTTP server & Schedulers
startServer((global as any).port);
initSleepScheduler(startAtlas);
const maintenanceTimer = initGCScheduler(runPeriodicSync);
const pluginWatcher = initPluginWatcher();
const watchdogTimer = initWatchdog();
const messageCacheTimer = initMessageCachePruner();

// Register background resources for graceful shutdown
onShutdown(() => {
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  if (pluginWatcher) pluginWatcher.close();
  if (watchdogTimer) clearInterval(watchdogTimer);
  if (messageCacheTimer) clearInterval(messageCacheTimer);
});

// Graceful process shutdown
process.once("SIGINT", () => void shutdownAtlas("SIGINT"));
process.once("SIGTERM", () => void shutdownAtlas("SIGTERM"));

// Launch bot
void startAtlas("initial");

export { startAtlas };
