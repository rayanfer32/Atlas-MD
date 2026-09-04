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
 * Initializes periodic garbage collection and session sync to MongoDB.
 */
export function initGCScheduler(
  runPeriodicSyncFn: () => Promise<any>
): NodeJS.Timeout {
  const GC_INTERVAL_MINUTES = Math.max(
    1,
    parseInt(process.env.GC_INTERVAL_MINUTES || "30", 10)
  );

  let timer: NodeJS.Timeout;
  if (typeof (global as any).gc === "function") {
    timer = setInterval(async () => {
      (global as any).gc();
      console.log(
        chalk.cyan(
          `[ ATLAS ] Garbage collection triggered (interval: ${GC_INTERVAL_MINUTES}m)`
        )
      );
      await runPeriodicSyncFn();
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
    timer = setInterval(() => {
      void runPeriodicSyncFn();
    }, GC_INTERVAL_MINUTES * 60 * 1000);
  }

  return timer;
}
