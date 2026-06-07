import axios from "axios";
import type { WAMessage, AtlasClient, QuotedMessage } from "../types/index.js";
import { ATLAS_SYSTEM_PROMPT, CUSTOM_SYSTEM_PROMPT } from "../System/__system_prompt.js";
import { getChar } from "../System/MongoDB/MongoDb_Core.js";

interface ChatMessage {
    role: "user" | "assistant";
    content: string;
}

const chatHistories = new Map<string, ChatMessage[]>();

const botNames = [
    "Atlas MD",
    "Power",
    "Makima",
    "Denji",
    "Zero Two",
    "Chika",
    "Miku",
    "Marin",
    "Ayanokoji",
    "Ruka",
    "Mizuhara",
    "Rem",
    "Sumi",
    "Kaguya",
    "Yumeko",
    "Kurumi",
    "Mai",
    "Yor",
    "Shinbou",
    "Eiko",
];

export default {
    name: "jimmy",
    alias: ["jim", "ai"],
    uniquecommands: ["jim", "ai"],
    description: "Chat with ChatJimmy Llama 3.1 8B AI with active character and conversation history",
    start: async (
        Atlas: AtlasClient,
        m: WAMessage,
        {
            inputCMD,
            text,
            prefix,
            doReact,
        }: {
            inputCMD: string;
            text: string;
            args: string[];
            prefix: string;
            doReact: (emoji: string) => Promise<void>;
            quoted: QuotedMessage | null;
        }
    ) => {
        const cleanText = text.trim();

        // Check if the user wants to clear conversation history
        if (cleanText.toLowerCase() === "clear") {
            chatHistories.delete(m.from);
            await doReact("🧹");
            return m.reply("🧹 Chat history for this conversation has been cleared!");
        }

        // Build prompt, prepending quoted text if present
        let prompt = cleanText;
        if (m.quoted?.text) {
            if (prompt) {
                prompt = `[Replying to: "${m.quoted.text}"]\n${prompt}`;
            } else {
                prompt = m.quoted.text;
            }
        }

        // Check if prompt is empty
        if (!prompt) {
            await doReact("❔");
            return m.reply(
                `Please provide a prompt!\n\nExample: *${prefix}${inputCMD} hello*\nOr clear history: *${prefix}${inputCMD} clear*`
            );
        }

        // Determine the active character name
        let charName = "Atlas MD";
        try {
            const charIdStr = await getChar();
            const charId = parseInt(charIdStr) || 0;
            charName = botNames[charId] || "Atlas MD";
        } catch (err) {
            console.error("[JIMMY] Error getting character ID:", err);
        }

        // Adapt the system prompt to match the active character
        let customSystemPrompt = CUSTOM_SYSTEM_PROMPT;
        if (charName !== "Atlas MD") {
            customSystemPrompt =
                `You are currently adopting the character role: **${charName}**.
Adopt their personality, speech patterns, tone, and traits in all replies, while remaining a helpful WhatsApp bot assistant named ${charName}.

` + CUSTOM_SYSTEM_PROMPT;
        }

        // Retrieve and update conversation history for the current chat
        let history = chatHistories.get(m.from) || [];
        history.push({ role: "user", content: prompt });

        // Restrict history size to the last 10 messages (user + assistant turns)
        if (history.length > 10) {
            history = history.slice(history.length - 10);
        }
        chatHistories.set(m.from, history);

        await doReact("⏳");
        await Atlas.sendPresenceUpdate("composing", m.from);

        try {
            const response = await axios.post(
                "https://chatjimmy.ai/api/chat",
                {
                    messages: history,
                    chatOptions: {
                        selectedModel: "llama3.1-8B",
                        systemPrompt: customSystemPrompt,
                        topK: 8,
                    },
                    attachment: null,
                },
                {
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "*/*",
                        Origin: "https://chatjimmy.ai",
                        Referer: "https://chatjimmy.ai/",
                        "User-Agent":
                            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
                    },
                    timeout: 60000,
                }
            );

            const rawResponse = response.data;
            const rawText =
                typeof rawResponse === "string" ? rawResponse : JSON.stringify(rawResponse);
            const reply = rawText
                .replace(/<\|stats\|>[\s\S]*?<\|\/stats\|>/g, "")
                .trim();

            if (!reply) {
                throw new Error("Empty response received from ChatJimmy API");
            }

            // Add assistant response to history
            history.push({ role: "assistant", content: reply });
            if (history.length > 10) {
                history = history.slice(history.length - 10);
            }
            chatHistories.set(m.from, history);

            await doReact("✅");
            await m.reply(reply);
        } catch (error: any) {
            console.error("[JIMMY] Error during ChatJimmy API call:", error);

            // Remove failed user prompt from history so retry is clean
            history.pop();
            chatHistories.set(m.from, history);

            await doReact("❌");
            await m.reply(
                `❌ Failed to get response from AI. Error: ${error.message || error}`
            );
        } finally {
            await Atlas.sendPresenceUpdate("paused", m.from);
        }
    },
};
