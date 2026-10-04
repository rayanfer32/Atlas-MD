import axios from "axios";
import { GoogleGenAI } from "@google/genai";
import { getGeminiConfig, GEMINI_MODEL, ATLAS_SYSTEM_PROMPT, CUSTOM_SYSTEM_PROMPT } from "../System/systemPrompt.js";
import { getAiConfig } from "../System/MongoDB/MongoDb_Core.js";
import { stripEnv } from "./configurations.js";

const DEFAULT_APINEX_MODEL = "free/gpt-6-luna";
const DEFAULT_APINEX_URL = "https://api.apinex.bond/v1/chat/completions";
const FALLBACK_AI_URL = "https://api-faa.my.id/faa/gemini-ai";

/**
 * Call APInex Chat Completion API
 */
export async function callApinexAi(
  promptText: string,
  modelOverride?: string,
  urlOverride?: string,
): Promise<string | null> {
  const apiKey =
    global.apinexApiKey ||
    stripEnv(process.env.APINEX_API_KEY, "");

  if (!apiKey) {
    console.warn("[ ATLAS AI ] APINEX_API_KEY is missing or empty in environment.");
    return null;
  }

  const endpoint = urlOverride || DEFAULT_APINEX_URL;
  const model = modelOverride || DEFAULT_APINEX_MODEL;

  try {
    const response = await axios.post(
      endpoint,
      {
        model,
        messages: [
          { role: "system", content: CUSTOM_SYSTEM_PROMPT },
          { role: "user", content: promptText },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      },
    );

    const reply = response.data?.choices?.[0]?.message?.content;
    if (typeof reply === "string" && reply.trim()) {
      return reply.trim();
    }
  } catch (err: any) {
    console.error(
      "[ ATLAS AI ] APInex API request error:",
      err.response?.data || err.message,
    );
  }

  return null;
}

/**
 * Fallback free AI endpoint when primary APIs fail
 */
export async function fetchFallbackAi(promptText: string): Promise<string | null> {
  try {
    const url = `${FALLBACK_AI_URL}?text=${encodeURIComponent(promptText)}`;
    const response = await axios.get(url, { timeout: 15000 });
    if (response.data && response.data.status) {
      return response.data.result;
    }
  } catch (e: any) {
    console.error("[ ATLAS AI ] Fallback AI API request failed:", e?.message);
  }
  return null;
}

/**
 * Call Google Gemini AI
 */
export async function callGeminiAi(promptText: string): Promise<string | null> {
  const geminiKey = global.pickKey ? global.pickKey(global.geminiAPIKeys) : null;
  if (!geminiKey) return null;

  try {
    const ai = new GoogleGenAI({ apiKey: geminiKey });
    const result = await ai.models.generateContent({
      model: GEMINI_MODEL,
      config: getGeminiConfig() as any,
      contents: [{ role: "user", parts: [{ text: promptText }] }],
    });
    return result.text?.trim() || null;
  } catch (err: any) {
    console.error("[ ATLAS AI ] Gemini API error:", err?.message || err);
    return null;
  }
}

/**
 * Generate AI response based on the active handler and model in MongoDB
 */
export async function generateAiResponse(promptText: string): Promise<string> {
  let aiConfig: {
    activeHandler: string;
    model: string;
    apiUrl: string;
    isEnabled: boolean;
  };

  try {
    aiConfig = await getAiConfig();
  } catch {
    aiConfig = {
      activeHandler: "apinex",
      model: DEFAULT_APINEX_MODEL,
      apiUrl: DEFAULT_APINEX_URL,
      isEnabled: true,
    };
  }

  if (!aiConfig.isEnabled) {
    return "AI handler is currently disabled.";
  }

  const handler = (aiConfig.activeHandler || "apinex").toLowerCase().trim();

  if (handler === "apinex") {
    // 1. Primary: APInex
    const apinexReply = await callApinexAi(promptText, aiConfig.model, aiConfig.apiUrl);
    if (apinexReply) return apinexReply;

    // 2. Fallback: Gemini
    console.log("[ ATLAS AI ] APInex failed, trying Gemini fallback...");
    const geminiReply = await callGeminiAi(promptText);
    if (geminiReply) return geminiReply;

    // 3. Fallback: Free backup endpoint
    console.log("[ ATLAS AI ] Gemini failed, trying secondary fallback AI...");
    const fallbackReply = await fetchFallbackAi(promptText);
    if (fallbackReply) return fallbackReply;
  } else if (handler === "gemini") {
    // 1. Primary: Gemini
    const geminiReply = await callGeminiAi(promptText);
    if (geminiReply) return geminiReply;

    // 2. Fallback: APInex
    console.log("[ ATLAS AI ] Gemini failed, trying APInex fallback...");
    const apinexReply = await callApinexAi(promptText, aiConfig.model, aiConfig.apiUrl);
    if (apinexReply) return apinexReply;

    // 3. Fallback: Free backup endpoint
    console.log("[ ATLAS AI ] APInex failed, trying secondary fallback AI...");
    const fallbackReply = await fetchFallbackAi(promptText);
    if (fallbackReply) return fallbackReply;
  } else {
    // Custom/other handler: APInex first, then Gemini
    const apinexReply = await callApinexAi(promptText, aiConfig.model, aiConfig.apiUrl);
    if (apinexReply) return apinexReply;
    const geminiReply = await callGeminiAi(promptText);
    if (geminiReply) return geminiReply;
  }

  return "Service unavailable at the moment. Please try again later.";
}

export default {
  callApinexAi,
  callGeminiAi,
  fetchFallbackAi,
  generateAiResponse,
};
