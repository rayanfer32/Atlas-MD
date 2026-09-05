import dotenv from "dotenv";
dotenv.config({ override: true });

// Strip inline # comments that some env injectors (e.g. vestauth) leave in the value,
// then trim surrounding whitespace.
// Example: "mykey     #old-key  # note" → "mykey"
const stripEnv = (val?: string, fallback = ""): string => {
  if (!val) return fallback;
  return val.split("#")[0].trim() || fallback;
};

// Parse a comma-separated env value into a cleaned array, dropping known placeholders
const parseKeys = (envVal?: string, ...placeholders: string[]): string[] => {
  if (!envVal) return [];
  return envVal
    .split(",")
    .map((k: string) => k.trim())
    .filter((k: string) => k && !placeholders.includes(k));
};

// Pick a random key from a pool; returns null when pool is empty
(global as any).pickKey = (keys?: string[]): string | null => {
  if (!keys || keys.length === 0) return null;
  return keys[Math.floor(Math.random() * keys.length)];
};

let gg = process.env.MODS;
if (!gg) {
  throw new Error("Please provide MODS in the environment variables");
}

(global as any).owner = gg.split(",");
(global as any).mongodb = process.env.MONGODB || "mongodb://localhost:27017/atlas";
(global as any).sessionId = stripEnv(process.env.SESSION_ID, "ok");
(global as any).prefa = stripEnv(process.env.PREFIX, "-");
(global as any).packname = stripEnv(process.env.PACKNAME, `Atlas Bot`);
(global as any).author = stripEnv(process.env.AUTHOR, "by: Team Atlas");
(global as any).port = stripEnv(process.env.PORT, "10000");

// Multi-key pools — comma-separate as many keys as you want in .env
(global as any).geminiAPIKeys = parseKeys(
  process.env.GEMINI_API,
  "Put your gemini API key here",
  "your-gemini-api-key-here",
);
(global as any).openAiAPIKeys = parseKeys(
  process.env.OPENAI_API,
  "Put your openai API key here",
  "sk-...put your OpenAI API key",
);
(global as any).claudeAPIKeys = parseKeys(
  process.env.CLAUDE_API,
  "Put your claude API key here",
  "your-anthropic-api-key-here",
);
(global as any).tenorAPIKeys = parseKeys(
  process.env.TENOR_API_KEY || "AIzaSyCyouca1_KKy4W_MG1xsPzuku5oa8W358c",
);

// Dynamic getter — every access to `tenorApiKey` (used in Plugins) returns a random key from the pool
Object.defineProperty(global, "tenorApiKey", {
  get() {
    return (global as any).pickKey((global as any).tenorAPIKeys) || "AIzaSyCyouca1_KKy4W_MG1xsPzuku5oa8W358c";
  },
  configurable: true,
});

export default {
  mongodb: (global as any).mongodb as string,
};

