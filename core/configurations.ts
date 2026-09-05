import dotenv from "dotenv";
dotenv.config({ override: true });

/**
 * Strip inline comments (#...) and quotes from an environment variable, then trim whitespace.
 * Example: '  "mykey"     # old-key  ' → "mykey"
 */
export const stripEnv = (val?: string, fallback = ""): string => {
  if (!val) return fallback;
  const stripped = val.split("#")[0].trim();
  if (!stripped) return fallback;

  // Remove surrounding single or double quotes if present
  if (
    (stripped.startsWith('"') && stripped.endsWith('"')) ||
    (stripped.startsWith("'") && stripped.endsWith("'"))
  ) {
    return stripped.slice(1, -1).trim() || fallback;
  }

  return stripped;
};

/**
 * Parse a comma-separated env value into a cleaned string array, dropping known placeholders.
 */
export const parseKeys = (envVal?: string, ...placeholders: string[]): string[] => {
  if (!envVal) return [];
  const placeholderSet = new Set(placeholders.map((p) => p.toLowerCase().trim()));

  return envVal
    .split(",")
    .map((k) => stripEnv(k))
    .filter((k) => k && !placeholderSet.has(k.toLowerCase()));
};

/**
 * Pick a random key from a pool; returns null when pool is empty.
 */
export const pickKey = (keys?: string[]): string | null => {
  if (!keys || keys.length === 0) return null;
  return keys[Math.floor(Math.random() * keys.length)];
};

// Validate and parse bot owners / moderators
const rawMods = process.env.MODS;
if (!rawMods || !rawMods.trim()) {
  throw new Error("Please provide MODS in the environment variables (e.g. MODS=1234567890)");
}

const owner = parseKeys(rawMods);
if (owner.length === 0) {
  throw new Error("MODS environment variable is defined but contains no valid owner numbers");
}

const DEFAULT_TENOR_KEY = "AIzaSyCyouca1_KKy4W_MG1xsPzuku5oa8W358c";

const mongodb = stripEnv(process.env.MONGODB, "mongodb://localhost:27017/atlas");
const sessionId = stripEnv(process.env.SESSION_ID, "ok");
const prefix = stripEnv(process.env.PREFIX, "-");
const packname = stripEnv(process.env.PACKNAME, "Atlas Bot");
const author = stripEnv(process.env.AUTHOR, "by: Team Atlas");
const port = stripEnv(process.env.PORT, "10000");

// Multi-key pools — comma-separate keys in .env
const geminiAPIKeys = parseKeys(
  process.env.GEMINI_API,
  "Put your gemini API key here",
  "your-gemini-api-key-here",
);
const openAiAPIKeys = parseKeys(
  process.env.OPENAI_API,
  "Put your openai API key here",
  "sk-...put your OpenAI API key",
);
const claudeAPIKeys = parseKeys(
  process.env.CLAUDE_API,
  "Put your claude API key here",
  "your-anthropic-api-key-here",
);
const tenorAPIKeys = parseKeys(process.env.TENOR_API_KEY || DEFAULT_TENOR_KEY);

// Ambient TypeScript typings for globals attached throughout the app lifecycle that are not in ambient.d.ts
declare global {
  var mongodb: string;
  var sessionId: string;
  var port: string;
  var geminiAPIKeys: string[];
  var openAiAPIKeys: string[];
  var claudeAPIKeys: string[];
  var tenorAPIKeys: string[];
  var pickKey: (keys?: string[]) => string | null;
  var isSleeping: boolean;
  var justWokeUp: boolean;
}

// Populate global namespace for legacy plugins and runtime consumers
global.pickKey = pickKey;
global.owner = owner;
global.mongodb = mongodb;
global.sessionId = sessionId;
global.prefa = prefix;
global.packname = packname;
global.author = author;
global.port = port;
global.geminiAPIKeys = geminiAPIKeys;
global.openAiAPIKeys = openAiAPIKeys;
global.claudeAPIKeys = claudeAPIKeys;
global.tenorAPIKeys = tenorAPIKeys;

// Dynamic getter — every access to `tenorApiKey` returns a random key from the pool
Object.defineProperty(global, "tenorApiKey", {
  get() {
    return pickKey(global.tenorAPIKeys) || DEFAULT_TENOR_KEY;
  },
  configurable: true,
});

export interface BotConfig {
  mongodb: string;
  owner: string[];
  sessionId: string;
  prefix: string;
  packname: string;
  author: string;
  port: string;
  geminiAPIKeys: string[];
  openAiAPIKeys: string[];
  claudeAPIKeys: string[];
  tenorAPIKeys: string[];
}

export const config: BotConfig = Object.freeze({
  mongodb,
  owner,
  sessionId,
  prefix,
  packname,
  author,
  port,
  geminiAPIKeys,
  openAiAPIKeys,
  claudeAPIKeys,
  tenorAPIKeys,
});

export default config;
