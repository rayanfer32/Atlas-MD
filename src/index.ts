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
} from "../core/core.js";

export {
  defaultPlugins,
} from "./plugins/index.js";

export {
  startAtlas,
} from "../index.js";

import { AtlasBot } from "../core/AtlasBot.js";
export default AtlasBot;
