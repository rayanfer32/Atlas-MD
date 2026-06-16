import cron from "node-cron";
import axios from "axios";
import type { WAMessage, AtlasClient } from "../types/index.js";

// Set your target WhatsApp group JID here after finding it with the winsjid command.
const TARGET_GROUP_JID = "120363414170382065@g.us"; // Replace with your actual group JID after running the command

interface DashboardData {
    generatedAt: string;
    date: string;
    today: {
        workers: number;
        contractors: number;
        labourSuppliers: number;
    };
    total: {
        workers: number;
        contractors: number;
        labourSuppliers: number;
    };
}

const DAILY_WORKER_TARGET = 30;

async function fetchAndFormatReport(): Promise<string> {
    const response = await axios.get("https://kamavo-app-backend-prod.onrender.com/api/internal/dashboard", {
        headers: {
            "X-API-Key": "SuperSecretInternalApiKeyForBots123!",
            "Accept": "application/json"
        },
        timeout: 10000
    });

    const data: DashboardData = response.data;

    // Format the date nicely
    const dateStr = data.date || new Date().toISOString().split('T')[0];

    const todayWorkers = data.today?.workers ?? 0;
    const totalWorkers = data.total?.workers ?? 0;

    // Daily worker milestone messages
    let dailyStatus = "";
    if (todayWorkers < DAILY_WORKER_TARGET) {
        dailyStatus = `⚠️ *We missed target by ${DAILY_WORKER_TARGET - todayWorkers} users, lets kill it tommrow*`;
    } else if (todayWorkers >= 200) {
        dailyStatus = `🏆 *HISTORIC DAY! ${todayWorkers} workers onboarded! This is mind-blowing! Ops Team, take a bow! 👑🏆*`;
    } else if (todayWorkers >= 100) {
        dailyStatus = `🚀 *Absolute legendary performance! ${todayWorkers} workers today! We are unstoppable! 🚀🚀*`;
    } else if (todayWorkers >= 50) {
        dailyStatus = `🔥 *Incredible day! ${todayWorkers} workers onboarded today. The Ops Team is on fire! 🔥💪*`;
    } else {
        dailyStatus = `🎉 *Daily target Reached today! Awesome work Ops Team. 🎉*`;
    }

    // Overall total milestones
    let totalStatus = "";
    if (totalWorkers >= 500) {
        totalStatus = `🌟 *Milestone: We have crossed 500 total workers! An absolutely colossal achievement!*`;
    } else if (totalWorkers >= 200) {
        totalStatus = `🌟 *Milestone: We have crossed 200 total workers! Unbelievable momentum!*`;
    } else if (totalWorkers >= 100) {
        totalStatus = `🌟 *Milestone: We have crossed 100 total workers! Outstanding work, team!*`;
    } else if (totalWorkers >= 50) {
        totalStatus = `🌟 *Milestone: We have crossed 50 total workers! Solid growth, keep pushing!*`;
    } else {
        totalStatus = `📈 *On our way to the 50 total workers milestone! Every worker counts!*`;
    }

    // Build a beautiful, clean markdown message for WhatsApp
    const message = [
        `📊 *Daily Wins Report - ${dateStr}*`,
        `━━━━━━━━━━━━━━━━━━━`,
        dailyStatus,
        totalStatus,
        `━━━━━━━━━━━━━━━━━━━`,
        ``,
        `*Today's Activity:*`,
        `👤 *Workers:* ${todayWorkers}`,
        `👔 *Contractors:* ${data.today?.contractors ?? 0}`,
        `🏗️ *Labour Suppliers:* ${data.today?.labourSuppliers ?? 0}`,
        ``,
        `*Overall Totals:*`,
        `👥 *Workers:* ${totalWorkers}`,
        `💼 *Contractors:* ${data.total?.contractors ?? 0}`,
        `🏢 *Labour Suppliers:* ${data.total?.labourSuppliers ?? 0}`,
        ``,
        `━━━━━━━━━━━━━━━━━━━`,
        `_Generated at: ${new Date(data.generatedAt || Date.now()).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} (IST)_`
    ].join("\n");

    return message;
}

// Schedule the daily report at 11:30 PM (23:30) IST (Asia/Kolkata)
cron.schedule("30 23 * * *", async () => {
    console.log("[CRON] Running scheduled Daily Wins report check...");

    // Get the globally exposed Atlas socket
    const Atlas = (global as any).AtlasSocket;
    if (!Atlas) {
        console.error("[CRON] Atlas socket is not available yet.");
        return;
    }

    if (!TARGET_GROUP_JID) {
        console.warn("[CRON] JID has not been configured in kamavo-daily-wins.ts yet. Skipping sending report.");
        return;
    }

    try {
        const reportText = await fetchAndFormatReport();
        await Atlas.sendMessage(TARGET_GROUP_JID, { text: reportText });
        console.log("[CRON] Daily Wins report sent successfully to JID:", TARGET_GROUP_JID);
    } catch (error: any) {
        console.error("[CRON] Failed to send scheduled daily wins report:", error.message || error);
    }
}, {
    timezone: "Asia/Kolkata"
});

export default {
    name: "kamavodailywins",
    alias: ["winsreport", "dailywins"],
    uniquecommands: ["winsreport", "dailywins"],
    description: "Daily wins API report scheduler & manual trigger",
    start: async (
        Atlas: AtlasClient,
        m: WAMessage,
        {
            inputCMD,
            doReact
        }: {
            inputCMD: string;
            prefix: string;
            doReact: (emoji: string) => Promise<void>;
        }
    ) => {
        if (inputCMD === "winsreport" || inputCMD === "dailywins") {
            await doReact("⏳");
            try {
                const reportText = await fetchAndFormatReport();
                await doReact("✅");
                return m.reply(reportText);
            } catch (error: any) {
                console.error("[DAILY WINS] Manual trigger error:", error);
                await doReact("❌");
                return m.reply(`❌ *Failed to fetch report from API.*\n\n*Error:* ${error.message || error}`);
            }
        }
    }
};