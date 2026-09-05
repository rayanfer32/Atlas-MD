import { EventEmitter } from "events";
import fs from "fs";
import path, { dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import chalk from "chalk";
import mongoose from "mongoose";
import config, { type BotConfig } from "./configurations.js";
import { commands as globalCommands, type CommandCollection } from "../System/ReadCommands.js";
import type { Plugin } from "./plugin.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface AtlasBotOptions {
  /** MongoDB connection string */
  mongodb?: string;
  /** Alias for mongodb */
  mongoUri?: string;
  /** Array of owner/admin phone numbers */
  owner?: string[];
  /** Alias for owner */
  mods?: string[];
  /** Session identifier */
  sessionId?: string;
  /** Command prefix (default: "-") */
  prefix?: string;
  /** Sticker pack name */
  packname?: string;
  /** Sticker author name */
  author?: string;
  /** HTTP server port */
  port?: string | number;
  /** Gemini API keys for AI chatbot */
  geminiAPIKeys?: string[];
  /** OpenAI API keys */
  openAiAPIKeys?: string[];
  /** Claude / Anthropic API keys */
  claudeAPIKeys?: string[];
  /** Tenor GIF API keys */
  tenorAPIKeys?: string[];
  /** Enable built-in HTTP server (default: true) */
  enableHttpServer?: boolean;
}

/**
 * Main Atlas-MD Bot Class
 */
export class AtlasBot extends EventEmitter {
  public config: BotConfig;
  public commands: CommandCollection = globalCommands;
  public isStarted = false;
  private socketInstance: any = null;

  constructor(options: AtlasBotOptions = {}) {
    super();

    const mongoConnection = options.mongoUri || options.mongodb || config.mongodb;
    const owners = options.mods || options.owner || config.owner;

    this.config = {
      mongodb: mongoConnection,
      owner: owners,
      sessionId: options.sessionId || config.sessionId || "ok",
      prefix: options.prefix || config.prefix || "-",
      packname: options.packname || config.packname || "Atlas Bot",
      author: options.author || config.author || "by: Team Atlas",
      port: String(options.port || config.port || "10000"),
      geminiAPIKeys: options.geminiAPIKeys || config.geminiAPIKeys || [],
      openAiAPIKeys: options.openAiAPIKeys || config.openAiAPIKeys || [],
      claudeAPIKeys: options.claudeAPIKeys || config.claudeAPIKeys || [],
      tenorAPIKeys: options.tenorAPIKeys || config.tenorAPIKeys || [],
    };

    // Synchronize to global namespace for backwards compatibility with legacy plugins
    global.mongodb = this.config.mongodb;
    global.owner = this.config.owner;
    global.sessionId = this.config.sessionId;
    global.prefa = this.config.prefix;
    global.packname = this.config.packname;
    global.author = this.config.author;
    global.port = this.config.port;
    if (this.config.geminiAPIKeys.length > 0) global.geminiAPIKeys = this.config.geminiAPIKeys;
    if (this.config.openAiAPIKeys.length > 0) global.openAiAPIKeys = this.config.openAiAPIKeys;
    if (this.config.claudeAPIKeys.length > 0) global.claudeAPIKeys = this.config.claudeAPIKeys;
    if (this.config.tenorAPIKeys.length > 0) global.tenorAPIKeys = this.config.tenorAPIKeys;

    this.commands.prefix = this.config.prefix;
  }

  /**
   * Register a single plugin command
   */
  public register(plugin: Plugin): this {
    if (!plugin || !plugin.name) {
      throw new Error("Plugin must provide a valid 'name' property");
    }
    this.commands.set(plugin.name.toLowerCase(), plugin);
    if (Array.isArray(plugin.alias)) {
      for (const alias of plugin.alias) {
        this.commands.set(alias.toLowerCase(), plugin);
      }
    }
    return this;
  }

  /**
   * Register multiple plugin commands (chainable)
   */
  public use(...plugins: (Plugin | Plugin[])[]): this {
    for (const item of plugins) {
      if (Array.isArray(item)) {
        item.forEach((p) => this.register(p));
      } else if (item) {
        this.register(item);
      }
    }
    return this;
  }

  /**
   * Load plugins dynamically from a directory
   */
  public async loadPluginsFromDir(dirPath: string): Promise<number> {
    const resolvedPath = path.isAbsolute(dirPath) ? dirPath : path.resolve(process.cwd(), dirPath);
    if (!fs.existsSync(resolvedPath)) {
      console.warn(chalk.yellow(`[ ATLAS ] Plugin directory not found: ${resolvedPath}`));
      return 0;
    }

    const files = fs
      .readdirSync(resolvedPath)
      .filter((file) => file.endsWith(".js") || file.endsWith(".ts"));

    let loadedCount = 0;
    for (const file of files) {
      try {
        const filePath = path.join(resolvedPath, file);
        const fileUrl = pathToFileURL(filePath).href;
        const module = await import(`${fileUrl}?update=${Date.now()}`);
        const plugin = module.default;
        if (plugin && plugin.name) {
          this.register(plugin);
          loadedCount++;
        }
      } catch (err: any) {
        console.error(chalk.red(`[ ATLAS ] Failed to load plugin ${file}: ${err.message}`));
      }
    }
    return loadedCount;
  }

  /**
   * Load standard built-in plugins bundled with Atlas-MD
   */
  public async useDefaultPlugins(): Promise<this> {
    // Locate default Plugins relative to package directory
    const defaultPluginsPath = path.resolve(__dirname, "../../Plugins");
    const fallbackPath = path.resolve(__dirname, "../Plugins");

    const targetDir = fs.existsSync(defaultPluginsPath)
      ? defaultPluginsPath
      : fs.existsSync(fallbackPath)
        ? fallbackPath
        : path.resolve(process.cwd(), "Plugins");

    if (fs.existsSync(targetDir)) {
      const count = await this.loadPluginsFromDir(targetDir);
      console.log(chalk.green(`[ ATLAS ] Loaded ${count} built-in default plugins from ${targetDir}`));
    } else {
      console.warn(chalk.yellow(`[ ATLAS ] Default plugins directory not found.`));
    }
    return this;
  }

  /**
   * Start MongoDB and initialize the bot
   */
  public async start(): Promise<any> {
    if (this.isStarted) {
      console.warn(chalk.yellow(`[ ATLAS ] Bot is already running.`));
      return;
    }

    this.isStarted = true;
    this.emit("starting");

    // Connect to MongoDB if not already connected
    try {
      if (mongoose.connection.readyState === 0 && this.config.mongodb) {
        await mongoose.connect(this.config.mongodb);
        console.log(chalk.green(`[ ATLAS ] MongoDB connected successfully ✓`));
      }
    } catch (err: any) {
      console.error(chalk.redBright(`[ ATLAS ] MongoDB connection failed: ${err.message}`));
      this.emit("error", err);
    }

    // Launch core socket runner
    const { startAtlas } = await import("../index.js");
    this.socketInstance = await startAtlas();
    this.emit("started", this.socketInstance);
    return this.socketInstance;
  }

  /**
   * Stop bot and clean up connections
   */
  public async stop(): Promise<void> {
    if (!this.isStarted) return;
    this.isStarted = false;
    this.emit("stopping");

    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
    } catch {
      // Ignore disconnect errors
    }

    this.emit("stopped");
  }

  /**
   * Get active socket instance
   */
  public getSocket(): any {
    return this.socketInstance;
  }
}

/**
 * Factory helper function to instantiate AtlasBot
 */
export const createBot = (options: AtlasBotOptions = {}): AtlasBot => new AtlasBot(options);

export default AtlasBot;
