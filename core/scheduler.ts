import cron from "node-cron";
import chalk from "chalk";
import { getSleepConfig } from "../utils/helper.js";
import { getServerSocket, getServerStatus, setServerStatus } from "./server.js";

const pad = (num: number) => String(num).padStart(2, "0");

/**
 * Initializes the sleep and wake scheduler cron jobs.
 */
export function initSleepScheduler(startAtlasFn: () => Promise<void>): void {
  const { sleepTime, wakeTime } = getSleepConfig();
  const sleepCronPattern = `${sleepTime.minute} ${sleepTime.hour} * * *`;
  const wakeCronPattern = `${wakeTime.minute} ${wakeTime.hour} * * *`;
  const timezone = process.env.TIMEZONE || "Asia/Kolkata";

  // Schedule bot sleep
  cron.schedule(
    sleepCronPattern,
    async () => {
      const { sleepTime: currentSleep, wakeTime: currentWake } = getSleepConfig();
      const sleepStr = `${pad(currentSleep.hour)}:${pad(currentSleep.minute)}`;
      const wakeStr = `${pad(currentWake.hour)}:${pad(currentWake.minute)}`;

      console.log(chalk.yellow(`[ ATLAS ] Sleep time (${sleepStr}) reached. Disconnecting...`));
      (global as any).isSleeping = true;
      setServerStatus("sleeping");

      const socket = getServerSocket();
      if (socket) {
        const owners = (global as any).owner || [];
        for (const owner of owners) {
          const cleanOwner = String(owner).replace(/[^0-9]/g, "");
          if (cleanOwner) {
            const jid = `${cleanOwner}@s.whatsapp.net`;
            await socket
              .sendMessage(jid, {
                text: `💤 *Atlas Bot is going to sleep (disconnecting from WhatsApp until ${wakeStr})...*`,
              })
              .catch(() => {});
          }
        }

        // Wait 3 seconds for messages to dispatch
        await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
          await socket.end(undefined);
        } catch (e: any) {
          console.error(chalk.red(`[ ATLAS ] Error ending socket: ${e.message}`));
        }
      }
    },
    { timezone }
  );

  // Schedule bot wake up
  cron.schedule(
    wakeCronPattern,
    async () => {
      const { wakeTime: currentWake } = getSleepConfig();
      const wakeStr = `${pad(currentWake.hour)}:${pad(currentWake.minute)}`;

      console.log(chalk.green(`[ ATLAS ] Wake up time (${wakeStr}) reached. Reconnecting...`));
      (global as any).isSleeping = false;
      (global as any).justWokeUp = true;
      setServerStatus("initializing");

      await startAtlasFn();
    },
    { timezone }
  );
}

/**
 * Initializes periodic garbage collection, session sync to MongoDB, and watchdog reconnect.
 */
export function initGCScheduler(
  getMongoAuth: () => any,
  startAtlasFn: () => Promise<void>
): void {
  const GC_INTERVAL_MINUTES = Math.max(
    1,
    parseInt(process.env.GC_INTERVAL_MINUTES || "30", 10)
  );

  const runPeriodicSync = async () => {
    const mongoAuth = getMongoAuth();
    if (mongoAuth) {
      await mongoAuth
        .pushToMongoDB()
        .catch((err: any) =>
          console.error(
            chalk.redBright(`[ ATLAS ] MongoDB session sync error: ${err.message}`)
          )
        );
      console.log(chalk.cyan(`[ ATLAS ] Session synced to MongoDB`));
    }
  };

  const runWatchdog = () => {
    const socket = getServerSocket();
    if (!socket) return;
    // WebSocket readyState: 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED
    const wsReady = socket.ws?.readyState;
    const status = getServerStatus();

    if (wsReady !== undefined && wsReady !== 1 && status === "open") {
      console.log(
        chalk.yellow(
          `[ ATLAS ] Session Watchdog: silent disconnect detected (wsState=${wsReady}) — reconnecting...`
        )
      );
      setServerStatus("reconnecting");
      startAtlasFn();
    }
  };

  if (typeof (global as any).gc === "function") {
    setInterval(async () => {
      (global as any).gc();
      console.log(
        chalk.cyan(
          `[ ATLAS ] Garbage collection triggered (interval: ${GC_INTERVAL_MINUTES}m)`
        )
      );
      await runPeriodicSync();
      runWatchdog();
    }, GC_INTERVAL_MINUTES * 60 * 1000);

    console.log(
      chalk.cyan(
        `[ ATLAS ] GC scheduler active — running every ${GC_INTERVAL_MINUTES} minute(s)`
      )
    );
  } else {
    console.warn(
      "[ ATLAS ] GC not available. Start the bot with 'npm start' to enable garbage collection."
    );
    setInterval(() => {
      runPeriodicSync();
      runWatchdog();
    }, GC_INTERVAL_MINUTES * 60 * 1000);
  }
}
