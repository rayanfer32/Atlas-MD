import { generateAiResponse } from "../core/aiService.js";
import {
  getAiConfig,
  setActiveAiHandler,
  setAiModel,
} from "../System/MongoDB/MongoDb_Core.js";

const mergedCommands = ["ai", "ask", "chat", "setai", "aimodel", "aistatus"];

export default {
  name: "ai",
  alias: [...mergedCommands],
  uniquecommands: ["ai", "setai", "aimodel", "aistatus"],
  description: "AI chat assistant powered by APInex & multi-provider handlers",

  start: async (
    Atlas: any,
    m: any,
    { inputCMD, text, quoted, doReact, prefix, isCreator, modcheck }: any,
  ) => {
    switch (inputCMD) {
      case "ai":
      case "ask":
      case "chat": {
        const cleanText = text?.trim() || "";
        const quotedText = (
          quoted?.text ||
          (typeof quoted?.msg === "string" ? quoted.msg : "") ||
          quoted?.conversation ||
          quoted?.msg?.text ||
          quoted?.msg?.caption ||
          ""
        ).trim();

        const query =
          quotedText && cleanText
            ? `${quotedText}\n\nUser Question: ${cleanText}`
            : cleanText || quotedText;

        if (!query) {
          if (doReact) await doReact("❔");
          return m.reply(
            `*『 🤖 Atlas AI Assistant 』*\n\n` +
            `Please provide a prompt or reply to a message with your question!\n\n` +
            `*Usage:*\n` +
            `• *${prefix}${inputCMD} <your question>*\n` +
            `• Reply to any message with *${prefix}${inputCMD}*\n\n` +
            `*Example:*\n` +
            `*${prefix}${inputCMD} Explain the event loop in Node.js*`,
          );
        }

        if (doReact) await doReact("🤖");
        await Atlas.sendPresenceUpdate("composing", m.from);

        try {
          const reply = await generateAiResponse(query);
          await m.reply(reply);
        } catch (err: any) {
          console.error("[ ATLAS AI ] Error generating AI response:", err?.message || err);
          if (doReact) await doReact("❌");
          await m.reply("Sorry, an error occurred while processing your AI request.");
        } finally {
          await Atlas.sendPresenceUpdate("paused", m.from);
        }
        break;
      }

      case "setai": {
        if (!isCreator && !modcheck) {
          if (doReact) await doReact("🔒");
          return m.reply("❌ Only the bot owner and moderators can change the active AI handler.");
        }

        const config = await getAiConfig();
        const newHandler = text?.trim().toLowerCase();

        if (!newHandler) {
          if (doReact) await doReact("❔");
          return m.reply(
            `*『 ⚙️ AI Handler Settings 』*\n\n` +
            `*Active Handler:* \`${config.activeHandler}\`\n\n` +
            `*Usage:*\n` +
            `• *${prefix}setai apinex*\n` +
            `• *${prefix}setai gemini*\n\n` +
            `*Available Handlers:* \`apinex\`, \`gemini\``,
          );
        }

        if (newHandler !== "apinex" && newHandler !== "gemini") {
          if (doReact) await doReact("⚠️");
          return m.reply(
            `⚠️ Unknown AI handler \`${newHandler}\`. Supported options are *apinex* or *gemini*.`,
          );
        }

        await setActiveAiHandler(newHandler);
        if (doReact) await doReact("✅");
        return m.reply(`✅ Active AI handler updated to *${newHandler}*.`);
      }

      case "aimodel": {
        if (!isCreator && !modcheck) {
          if (doReact) await doReact("🔒");
          return m.reply("❌ Only the bot owner and moderators can change the active AI model.");
        }

        const config = await getAiConfig();
        const newModel = text?.trim();

        if (!newModel) {
          if (doReact) await doReact("❔");
          return m.reply(
            `*『 ⚙️ AI Model Settings 』*\n\n` +
            `*Current Model:* \`${config.model}\`\n` +
            `*Active Handler:* \`${config.activeHandler}\`\n\n` +
            `*Usage:*\n` +
            `• *${prefix}aimodel free/gpt-6-luna*\n` +
            `• *${prefix}aimodel <model_name>*`,
          );
        }

        await setAiModel(newModel);
        if (doReact) await doReact("✅");
        return m.reply(`✅ Active AI model updated to *${newModel}*.`);
      }

      case "aistatus": {
        const config = await getAiConfig();
        const hasApinexKey = Boolean(
          global.apinexApiKey || process.env.APINEX_API_KEY,
        );
        const hasGeminiKey = Boolean(
          global.geminiAPIKeys && global.geminiAPIKeys.length > 0,
        );

        if (doReact) await doReact("ℹ️");
        return m.reply(
          `*『 🤖 Atlas AI Configuration 』*\n\n` +
          `• *Active Handler:* \`${config.activeHandler}\`\n` +
          `• *Active Model:* \`${config.model}\`\n` +
          `• *API Endpoint:* \`${config.apiUrl}\`\n` +
          `• *Handler Status:* \`${config.isEnabled ? "Active 🟢" : "Disabled 🔴"}\`\n` +
          `• *APInex Key Configured:* \`${hasApinexKey ? "Yes ✅" : "No ❌"}\`\n` +
          `• *Gemini Key Configured:* \`${hasGeminiKey ? "Yes ✅" : "No ❌"}\``,
        );
      }

      default:
        break;
    }
  },
};
