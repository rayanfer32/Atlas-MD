import type { WAMessage } from "../types/index.js";

export interface PluginContext {
  name: string;
  metadata: any;
  pushName: string;
  participants: any[];
  body: string;
  inputCMD: string;
  args: string[];
  botNumber: string;
  botLid: string;
  isCmd: boolean;
  isMedia: boolean;
  ar: string[];
  isAdmin: boolean;
  groupAdmin: string[];
  text: string;
  itsMe: boolean;
  doReact: (emoji: string) => Promise<void>;
  modcheck: boolean;
  isCreator: boolean;
  quoted: any;
  isintegrated: () => boolean;
  groupName: string;
  mentionByTag: string[];
  mime: string;
  isBotAdmin: boolean;
  prefix: string;
  command: string;
  commands: Map<string, any>;
  toUpper: (str: string) => string;
}

export interface Plugin {
  name: string;
  alias?: string[];
  uniquecommands?: string[];
  description?: string;
  category?: string;
  start: (Atlas: any, m: WAMessage | any, context: PluginContext) => Promise<any> | any;
}

/**
 * Type-safe helper function for defining Atlas-MD plugins with IDE autocomplete.
 *
 * @example
 * ```ts
 * export default definePlugin({
 *   name: "ping",
 *   alias: ["p"],
 *   description: "Check bot latency",
 *   start: async (Atlas, m, { doReact }) => {
 *     await doReact("🏓");
 *     return m.reply("Pong!");
 *   }
 * });
 * ```
 */
export const definePlugin = (plugin: Plugin): Plugin => plugin;
