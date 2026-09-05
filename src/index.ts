export {
  AtlasBot,
  createBot,
  type AtlasBotOptions,
} from "../core/AtlasBot.js";

export {
  definePlugin,
  type Plugin,
  type PluginContext,
} from "../core/plugin.js";

export {
  config,
  type BotConfig,
  stripEnv,
  parseKeys,
  pickKey,
} from "../core/configurations.js";

export {
  sanitizeJid,
  toUpper,
} from "../core/core.js";

import { AtlasBot } from "../core/AtlasBot.js";
export default AtlasBot;
