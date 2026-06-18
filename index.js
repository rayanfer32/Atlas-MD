import "./Configurations.js";
import ffmpegStatic from "ffmpeg-static";
process.env.FFMPEG_PATH = ffmpegStatic;
import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
  downloadMediaMessage,
  jidDecode,
} from "@whiskeysockets/baileys";
import MongoAuth from "./System/MongoAuth/MongoAuth.js";
import fs from "fs";
import figlet from "figlet";
import { join } from "path";
import got from "got";
import pino from "pino";
import path from "path";
import { fileTypeFromBuffer } from "file-type";
import { Boom } from "@hapi/boom";
import { serialize, WAConnection } from "./System/whatsapp.js";
import { smsg, getBuffer, getSizeMedia } from "./System/Function2.js";
import { fileURLToPath } from "url";
import { dirname } from "path";
import cron from "node-cron";
import { parseTime, getSleepConfig, checkIfSleepTime } from "./utils/helper.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


fs.writeFileSync(path.join(__dirname, "atlas.pid"), process.pid.toString());

// Map of noise prefixes → clean replacement line printed to stdout once per event
const _BAILEYS_NOISE_MAP = {
  "Failed to decrypt message with any known session":
    "[ ATLAS ] Signal: failed to decrypt (session key mismatch — skipped)",
  "Session error:": "[ ATLAS ] Signal: session error (Bad MAC — skipped)",
  "Closing open session in favor of incoming prekey bundle":
    "[ ATLAS ] Signal: rotating session (new prekey bundle received)",
  "Closing session:": null, // suppress entirely — too verbose (raw key dump)
  "Opening session:": null,
};

const _matchNoise = (str) => {
  for (const [prefix, replacement] of Object.entries(_BAILEYS_NOISE_MAP)) {
    if (str.startsWith(prefix)) return { matched: true, replacement };
  }
  return { matched: false };
};

// Patch console.log (stdout)
const _origLog = console.log;
console.log = (...args) => {
  const first = String(args[0] ?? "");
  const { matched, replacement } = _matchNoise(first);
  if (matched) {
    if (replacement) _origLog(replacement);
    return;
  }
  _origLog(...args);
};

// Patch console.error (stderr) — libsignal uses this path
const _origErr = console.error;
console.error = (...args) => {
  const first = String(args[0] ?? "");
  const { matched, replacement } = _matchNoise(first);
  if (matched) {
    if (replacement) _origLog(replacement); // route clean msg to stdout
    return;
  }
  _origErr(...args);
};

// Patch console.info — libsignal uses console.info("Closing session:", session)
const _origInfo = console.info;
console.info = (...args) => {
  const first = String(args[0] ?? "");
  const { matched, replacement } = _matchNoise(first);
  if (matched) {
    if (replacement) _origLog(replacement);
    return;
  }
  _origInfo(...args);
};

// Patch process.stderr.write — final fallback used by some internal Node streams
const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  const str = typeof chunk === "string" ? chunk : chunk.toString();
  const { matched, replacement } = _matchNoise(str.trimStart());
  if (matched) {
    if (replacement) _origLog(replacement);
    return true;
  }
  return _origStderrWrite(chunk, ...rest);
};

import express from "express";
const app = express();
const PORT = global.port;
import welcomeLeft from "./System/Welcome.js";
import { readcommands, commands } from "./System/ReadCommands.js";
import core from "./Core.js";
commands.prefix = global.prefa;
import mongoose from "mongoose";
import qrcode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";
import {
  getPluginURLs,
  checkAntidelete,
  checkMod,
} from "./System/MongoDB/MongoDb_Core.js";
import chalk from "chalk";

app.use(express.json());

global.lidToJidMap = new Map();

const store = {
  contacts: {},
  messages: {},
  bind(ev) {
    let _lidLogTimer = null;
    ev.on("contacts.upsert", (contacts) => {
      for (const contact of contacts) {
        store.contacts[contact.id] = contact;
        const phoneJid = contact.id?.endsWith("@s.whatsapp.net")
          ? contact.id
          : null;
        const lidJid = contact.id?.endsWith("@lid")
          ? contact.id
          : contact.lid?.endsWith("@lid")
            ? contact.lid
            : null;
        if (phoneJid && lidJid) {
          global.lidToJidMap.set(lidJid, phoneJid);
          global.lidToJidMap.set(phoneJid, lidJid);
        }
      }
      // Debounce: print one summary line after the batch settles
      clearTimeout(_lidLogTimer);
      _lidLogTimer = setTimeout(() => {
        if (global.lidToJidMap.size > 0)
          _origLog(
            `[ ATLAS ] LID map ready: ${global.lidToJidMap.size / 2} contact(s) mapped`,
          );
      }, 300);
    });
    ev.on("contacts.update", (updates) => {
      for (const update of updates) {
        if (store.contacts[update.id])
          Object.assign(store.contacts[update.id], update);
        else store.contacts[update.id] = update;
        const phoneJid = update.id?.endsWith("@s.whatsapp.net")
          ? update.id
          : store.contacts[update.id]?.id?.endsWith("@s.whatsapp.net")
            ? store.contacts[update.id].id
            : null;
        const lidJid = update.lid?.endsWith("@lid")
          ? update.lid
          : update.id?.endsWith("@lid")
            ? update.id
            : null;
        if (phoneJid && lidJid) {
          global.lidToJidMap.set(lidJid, phoneJid);
          global.lidToJidMap.set(phoneJid, lidJid);
        }
      }
    });
    ev.on("messages.upsert", ({ messages }) => {
      for (const msg of messages) {
        if (!msg.key?.remoteJid || !msg.key?.id) continue;
        const jid = msg.key.remoteJid;
        if (!store.messages[jid]) store.messages[jid] = {};
        store.messages[jid][msg.key.id] = msg;
      }
    });
  },
  loadMessage: async (jid, id) => store.messages[jid]?.[id],
};

// Atlas Server configuration
let QR_GENERATE = "invalid";
let status = "initializing";
let AtlasSocket = null; // module-level reference for pairing API
let mongoAuth; // module-level so the GC/sync interval can access it

global.isSleeping = false;
global.justWokeUp = false;


const startAtlas = async () => {
  if (checkIfSleepTime()) {
    global.isSleeping = true;
    status = "sleeping";
    const { sleepTime, wakeTime } = getSleepConfig();
    const pad = (num) => String(num).padStart(2, "0");
    const sleepStr = `${pad(sleepTime.hour)}:${pad(sleepTime.minute)}`;
    const wakeStr = `${pad(wakeTime.hour)}:${pad(wakeTime.minute)}`;
    console.log(chalk.yellow(`[ ATLAS ] Bot is in sleep hours (${sleepStr} - ${wakeStr}). Suppressing WhatsApp socket connection. Process remains alive.`));
    try {
      if (mongoose.connection.readyState === 0) {
        await mongoose.connect(mongodb);
        console.log(chalk.green(`[ ATLAS ] MongoDB connected (during sleep startup) ✓`));
      }
    } catch (err) {
      console.error(
        chalk.redBright(`[ EXCEPTION ] MongoDB error during sleep startup: ${err.message}`),
      );
    }
    return;
  }

  try {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(mongodb);
      console.log(chalk.green(`[ ATLAS ] MongoDB connected ✓`));
    }
  } catch (err) {
    console.error(
      chalk.redBright(`[ EXCEPTION ] MongoDB error: ${err.message}`),
    );
  }
  mongoAuth = new MongoAuth(sessionId);
  const { state, saveCreds, clearState } = await mongoAuth.init();
  console.log(
    figlet.textSync("ATLAS", {
      font: "Standard",
      horizontalLayout: "default",
      vertivalLayout: "default",
      width: 70,
      whitespaceBreak: true,
    }),
  );

  // Version info + update check
  const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
  global.botVersion = pkg.version;
  global.latestVersion = pkg.version;
  global.updateAvailable = false;

  console.log(
    chalk.cyan(
      `[ ATLAS ] v${global.botVersion}  |  Node.js ${process.version}  |  ${process.platform}/${process.arch}`,
    ),
  );

  try {
    const remote = await got(
      "https://raw.githubusercontent.com/FantoX/Atlas-MD/main/package.json",
    ).json();
    global.latestVersion = remote.version;
    if (remote.version !== pkg.version) {
      global.updateAvailable = true;
      console.log(
        chalk.yellow(
          `[ ATLAS ] Update available: v${pkg.version} → v${remote.version}  |  git pull && npm install`,
        ),
      );
    } else {
      console.log(chalk.green(`[ ATLAS ] Up to date ✓`));
    }
  } catch {
    console.log(
      chalk.gray(`[ ATLAS ] Update check skipped (network unavailable)`),
    );
  }
  console.log("");

  await installPlugin();

  const { version, isLatest } = await fetchLatestBaileysVersion();

  const Atlas = makeWASocket({
    logger: pino({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    auth: state,
    version,
    // Send a WebSocket ping every 25 s so the server never silently drops
    // an idle connection. If the pong does not come back Baileys fires the
    // normal "connection.update" → "close" event, which restarts the bot.
    keepAliveIntervalMs: 20_000,
    shouldSyncHistoryMessage: () => false
  });

  AtlasSocket = Atlas; // expose for pairing API
  global.AtlasSocket = Atlas;

  store.bind(Atlas.ev);

  Atlas.public = true;

  async function installPlugin() {
    console.log(chalk.cyan(`[ ATLAS ] Checking plugins...`));
    let plugins = [];
    try {
      plugins = await getPluginURLs();
    } catch (err) {
      console.error(
        chalk.redBright(`[ EXCEPTION ] Plugin DB error: ${err.message}`),
      );
    }

    if (!plugins.length) {
      console.log(chalk.gray(`[ ATLAS ] No extra plugins installed`));
    } else {
      console.log(
        chalk.cyan(`[ ATLAS ] Installing ${plugins.length} plugin(s)...`),
      );
      for (let i = 0; i < plugins.length; i++) {
        const pluginUrl = plugins[i];
        try {
          const { body, statusCode } = await got(pluginUrl);
          if (statusCode == 200) {
            const folderName = "Plugins";
            const fileName = path.basename(pluginUrl);
            const filePath = path.join(folderName, fileName);
            let pluginBody = body;

            if (
              pluginBody.includes("alias:") &&
              !pluginBody.includes("uniquecommands:")
            ) {
              pluginBody = pluginBody.replace(
                /alias:\s*(\[[\s\S]*?\]),/,
                (match, aliasPart) =>
                  `${match}\n  uniquecommands: ${aliasPart},`,
              );
            }

            fs.writeFileSync(filePath, pluginBody);
            console.log(chalk.green(`[ ATLAS ] ✓ ${fileName}`));
          } else {
            console.log(
              chalk.yellow(
                `[ ATLAS ] ✗ ${path.basename(pluginUrl)} (HTTP ${statusCode})`,
              ),
            );
          }
        } catch (error) {
          console.error(
            chalk.redBright(
              `[ EXCEPTION ] ✗ ${path.basename(pluginUrl)}: ${error.message}`,
            ),
          );
        }
      }
      console.log(chalk.green(`[ ATLAS ] Plugins ready`));
    }
  }

  await readcommands();

  // Auto hot-reload watcher for Plugins directory
  let reloadTimeout;
  fs.watch("./Plugins", (eventType, filename) => {
    if (filename && (filename.endsWith(".js") || filename.endsWith(".ts"))) {
      clearTimeout(reloadTimeout);
      reloadTimeout = setTimeout(async () => {
        try {
          await readcommands();
          console.log(chalk.green(`[ ATLAS ] Hot-reloaded modified plugin: ${filename}`));
        } catch (err) {
          console.error(chalk.redBright(`[ ATLAS ] Failed to hot-reload: ${err.message}`));
        }
      }, 500);
    }
  });

  Atlas.ev.on("creds.update", saveCreds);
  Atlas.serializeM = (m) => smsg(Atlas, m, store);
  Atlas.ev.on("connection.update", async (update) => {
    const { lastDisconnect, connection, qr } = update;
    if (connection) {
      status = global.isSleeping ? "sleeping" : connection;
      console.info(`[ ATLAS ] Server Status => ${status}`);
    }

    if (connection === "open") {
      if (global.justWokeUp) {
        global.justWokeUp = false;
        const owners = global.owner || [];
        for (const owner of owners) {
          const cleanOwner = owner.replace(/[^0-9]/g, "");
          if (cleanOwner) {
            const jid = `${cleanOwner}@s.whatsapp.net`;
            console.log(chalk.green(`[ ATLAS ] Notifying ${owner} ${jid} that bot has woken up...`));
            setTimeout(async () => {
              await Atlas.sendMessage(jid, { text: "🌅 *Atlas Bot has woken up and is now online!*" }).catch(() => { });
            }, 10_000);
          }
        }
      }
    }

    if (connection === "close") {
      if (global.isSleeping) {
        console.log("[ ATLAS ] WhatsApp connection closed for scheduled sleep. Reconnection suppressed.\n");
        return;
      }
      let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
      if (reason === DisconnectReason.badSession) {
        console.log(
          `[ ATLAS ] Bad session detected — clearing and restarting for fresh QR scan...\n`,
        );
        await clearState();
        startAtlas();
      } else if (reason === DisconnectReason.connectionClosed) {
        console.log("[ ATLAS ] Connection closed, reconnecting....\n");
        startAtlas();
      } else if (reason === DisconnectReason.connectionLost) {
        console.log("[ ATLAS ] Connection Lost from Server, reconnecting...\n");
        startAtlas();
      } else if (reason === DisconnectReason.connectionReplaced) {
        console.log(
          "[ ATLAS ] Connection Replaced, Another New Session Opened, Please Close Current Session First!\n",
        );
        process.exit();
      } else if (reason === DisconnectReason.loggedOut) {
        console.log(
          `[ ATLAS ] Device logged out — clearing session and restarting for fresh QR scan...\n`,
        );
        await clearState();
        startAtlas();
      } else if (reason === DisconnectReason.restartRequired) {
        console.log("[ ATLAS ] Server Restarting...\n");
        startAtlas();
      } else if (reason === DisconnectReason.timedOut) {
        console.log("[ ATLAS ] Connection Timed Out, Trying to Reconnect...\n");
        startAtlas();
      } else {
        console.log("ReasonCode:", reason);
        console.log(
          `[ ATLAS ] Server Disconnected: "It's either safe disconnect or WhatsApp Account got banned !\n"`,
        );
      }
    }
    if (qr) {
      QR_GENERATE = qr;
      status = "qr";
      qrcodeTerminal.generate(qr, { small: true });
    }
  });

  Atlas.ev.on("group-participants.update", async (m) => {
    welcomeLeft(Atlas, m);
  });

  Atlas.ev.on("messages.upsert", async (chatUpdate) => {
    if (chatUpdate.type !== "notify") return;
    const msg = chatUpdate.messages?.[0];
    if (!msg) return;
    const m = serialize(Atlas, msg);

    if (!m?.message) return;
    if (m.key?.remoteJid === "status@broadcast") return;
    if (m.key?.id?.startsWith("BAE5") && m.key.id.length === 16) return;

    core(Atlas, m, commands, chatUpdate);
  });

  // ─── Anti-Delete: catch "delete for everyone" and resend ───────────────────
  Atlas.ev.on("messages.update", async (updates) => {
    for (const { key, update } of updates) {
      try {
        // Only care about group "delete for everyone" events
        if (!key.remoteJid?.endsWith("@g.us")) continue;
        if (!update?.messageStubType) continue;
        // messageStubType 1 = REVOKE (delete for everyone)
        if (update.messageStubType !== 1) continue;

        const groupId = key.remoteJid;
        const isEnabled = await checkAntidelete(groupId);
        if (!isEnabled) continue;

        // Skip if this message was deleted by the bot itself (antilink, -delete cmd, etc.)
        if (global.botDeletedMsgIds?.has(key.id)) {
          global.botDeletedMsgIds.delete(key.id);
          continue;
        }

        // Look up the original message from store cache
        const cached = store.messages[groupId]?.[key.id];
        if (!cached) continue;

        const deleter = key.participant || key.remoteJid;

        const {
          extractMessageContent,
          getContentType,
          downloadContentFromMessage,
          jidNormalizedUser,
        } = await import("@whiskeysockets/baileys");

        // Skip if the original message was sent by the bot itself
        const botJid = Atlas.user?.id ? jidNormalizedUser(Atlas.user.id) : null;
        if (
          cached.key?.fromMe ||
          (botJid &&
            jidNormalizedUser(
              cached.key?.participant || cached.key?.remoteJid,
            ) === botJid)
        )
          continue;

        // Skip if the deleter is a group admin
        try {
          const groupMeta = await Atlas.groupMetadata(groupId);
          const admins = groupMeta.participants
            .filter((p) => p.admin === "admin" || p.admin === "superadmin")
            .map((p) => jidNormalizedUser(p.id));
          if (admins.includes(jidNormalizedUser(deleter))) continue;
        } catch { }

        // Skip if the deleter is a mod
        const isDeleterMod = await checkMod(deleter);
        if (isDeleterMod) continue;

        // Skip if the deleter is an owner
        const deleterDigits = deleter.replace(/[^0-9]/g, "");
        const ownerDigits = (global.owner || []).map((o) =>
          o.replace(/[^0-9]/g, ""),
        );
        if (ownerDigits.includes(deleterDigits)) continue;

        // Skip if the deleter is an integrated developer
        const integratedJids = [
          "918101187835@s.whatsapp.net",
          "923045204414@s.whatsapp.net",
        ];
        if (integratedJids.includes(jidNormalizedUser(deleter))) continue;

        const senderTag = `@${deleter.split("@")[0]}`;

        // Determine content type
        const msg = cached.message;
        if (!msg) continue;

        const extracted = extractMessageContent(msg);
        const contentType = getContentType(extracted);
        const content = extracted[contentType];

        // Text messages
        if (
          contentType === "conversation" ||
          contentType === "extendedTextMessage"
        ) {
          const text =
            contentType === "conversation"
              ? extracted.conversation
              : content?.text || "";
          await Atlas.sendMessage(groupId, {
            text: `🛡️ *Anti-Delete*\n\n${senderTag} deleted:\n\n${text}`,
            mentions: [deleter],
          });
          continue;
        }

        // Media messages (image, video, audio, sticker, document)
        const isImage = contentType === "imageMessage";
        const isVideo = contentType === "videoMessage";
        const isAudio = contentType === "audioMessage";
        const isSticker = contentType === "stickerMessage";
        const isDoc = contentType === "documentMessage";

        if (isImage || isVideo || isAudio || isSticker || isDoc) {
          const mediaType = isImage
            ? "image"
            : isVideo
              ? "video"
              : isAudio
                ? "audio"
                : isSticker
                  ? "sticker"
                  : "document";
          const stream = await downloadContentFromMessage(content, mediaType);
          let buffer = Buffer.from([]);
          for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
          }

          const caption =
            `🛡️ *Anti-Delete*\n\n${senderTag} deleted this ${mediaType}` +
            (content.caption ? `:\n\n${content.caption}` : "");

          if (isImage) {
            await Atlas.sendMessage(groupId, {
              image: buffer,
              caption,
              mentions: [deleter],
            });
          } else if (isVideo) {
            await Atlas.sendMessage(groupId, {
              video: buffer,
              caption,
              mentions: [deleter],
            });
          } else if (isAudio) {
            await Atlas.sendMessage(groupId, {
              audio: buffer,
              mimetype: content.mimetype || "audio/ogg; codecs=opus",
              caption: undefined,
              mentions: [deleter],
            });
            await Atlas.sendMessage(groupId, {
              text: `🛡️ *Anti-Delete*\n\n${senderTag} deleted an audio message`,
              mentions: [deleter],
            });
          } else if (isSticker) {
            await Atlas.sendMessage(groupId, { sticker: buffer });
            await Atlas.sendMessage(groupId, {
              text: `🛡️ *Anti-Delete*\n\n${senderTag} deleted a sticker`,
              mentions: [deleter],
            });
          } else if (isDoc) {
            await Atlas.sendMessage(groupId, {
              document: buffer,
              mimetype: content.mimetype || "application/octet-stream",
              fileName: content.fileName || "document",
              caption,
              mentions: [deleter],
            });
          }
          continue;
        }

        // Fallback: unknown type — just notify
        await Atlas.sendMessage(groupId, {
          text: `🛡️ *Anti-Delete*\n\n${senderTag} deleted a message (type: ${contentType})`,
          mentions: [deleter],
        });
      } catch (e) {
        // Silently skip errors — don't crash the event loop
      }
    }
  });

  Atlas.getName = (jid, withoutContact = false) => {
    let id = Atlas.decodeJid(jid);
    withoutContact = Atlas.withoutContact || withoutContact;
    let v;
    if (id.endsWith("@g.us"))
      return new Promise(async (resolve) => {
        v = store.contacts[id] || {};
        if (!(v.name || v.subject)) v = Atlas.groupMetadata(id) || {};
        resolve(
          v.name ||
          v.subject ||
          PhoneNumber("+" + id.replace("@s.whatsapp.net", "")).getNumber(
            "international",
          ),
        );
      });
    else
      v =
        id === "0@s.whatsapp.net"
          ? {
            id,
            name: "WhatsApp",
          }
          : id === Atlas.decodeJid(Atlas.user.id)
            ? Atlas.user
            : store.contacts[id] || {};
    return (
      (withoutContact ? "" : v.name) ||
      v.subject ||
      v.verifiedName ||
      PhoneNumber("+" + jid.replace("@s.whatsapp.net", "")).getNumber(
        "international",
      )
    );
  };

  Atlas.decodeJid = (jid) => {
    if (!jid) return jid;
    if (/:\d+@/gi.test(jid)) {
      let decode = jidDecode(jid) || {};
      return (
        (decode.user && decode.server && decode.user + "@" + decode.server) ||
        jid
      );
    } else return jid;
  };

  Atlas.ev.on("contacts.update", (update) => {
    for (let contact of update) {
      let id = Atlas.decodeJid(contact.id);
      if (store && store.contacts)
        store.contacts[id] = {
          id,
          name: contact.notify,
        };
    }
  });

  Atlas.downloadAndSaveMediaMessage = async (
    message,
    filename,
    attachExtension = true,
  ) => {
    let buffer;
    // Try Baileys v7 high-level download with reupload support first
    const fakeMsg = message.fakeObj || message;
    if (fakeMsg.key && fakeMsg.message) {
      try {
        buffer = await downloadMediaMessage(
          fakeMsg,
          "buffer",
          {},
          {
            logger: {
              info: () => { },
              debug: () => { },
              warn: () => { },
              error: () => { },
              child: () => ({
                info: () => { },
                debug: () => { },
                warn: () => { },
                error: () => { },
              }),
            },
            reuploadRequest: Atlas.updateMediaMessage,
          },
        );
      } catch (e) {
        // Fall through to legacy method
      }
    }
    // Legacy fallback using downloadContentFromMessage
    if (!buffer) {
      let quoted = message.msg ? message.msg : message;
      let mime = (message.msg || message).mimetype || "";
      let messageType = message.mtype
        ? message.mtype.replace(/Message/gi, "")
        : mime.split("/")[0];
      const stream = await downloadContentFromMessage(quoted, messageType);
      buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }
    }
    let type = await fileTypeFromBuffer(buffer);
    const trueFileName = attachExtension ? filename + "." + type.ext : filename;
    await fs.promises.writeFile(trueFileName, buffer);
    return trueFileName;
  };

  Atlas.downloadMediaMessage = async (message) => {
    // Try Baileys v7 high-level download with reupload support first
    const fakeMsg = message.fakeObj || message;
    if (fakeMsg.key && fakeMsg.message) {
      try {
        return await downloadMediaMessage(
          fakeMsg,
          "buffer",
          {},
          {
            logger: {
              info: () => { },
              debug: () => { },
              warn: () => { },
              error: () => { },
              child: () => ({
                info: () => { },
                debug: () => { },
                warn: () => { },
                error: () => { },
              }),
            },
            reuploadRequest: Atlas.updateMediaMessage,
          },
        );
      } catch (e) {
        // Fall through to legacy method
      }
    }
    // Legacy fallback
    let mime = (message.msg || message).mimetype || "";
    let messageType = message.mtype
      ? message.mtype.replace(/Message/gi, "")
      : mime.split("/")[0];
    const stream = await downloadContentFromMessage(message, messageType);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
  };

  Atlas.parseMention = async (text) => {
    return [...text.matchAll(/@([0-9]{5,16}|0)/g)].map(
      (v) => v[1] + "@s.whatsapp.net",
    );
  };

  Atlas.sendText = (jid, text, quoted = "", options) =>
    Atlas.sendMessage(
      jid,
      {
        text: text,
        ...options,
      },
      {
        quoted,
      },
    );

  Atlas.getFile = async (PATH, save) => {
    let res;
    let data = Buffer.isBuffer(PATH)
      ? PATH
      : /^data:.*?\/.*?;base64,/i.test(PATH)
        ? Buffer.from(PATH.split`,`[1], "base64")
        : /^https?:\/\//.test(PATH)
          ? await (res = await getBuffer(PATH))
          : fs.existsSync(PATH)
            ? ((filename = PATH), fs.readFileSync(PATH))
            : typeof PATH === "string"
              ? PATH
              : Buffer.alloc(0);

    let type = (await fileTypeFromBuffer(data)) || {
      mime: "application/octet-stream",
      ext: ".bin",
    };
    let filename = path.join(
      __filename,
      "../src/" + new Date() * 1 + "." + type.ext,
    );
    if (data && save) await fs.promises.writeFile(filename, data);
    return {
      res,
      filename,
      size: await getSizeMedia(data),
      ...type,
      data,
    };
  };

  Atlas.setStatus = (status) => {
    // v7: query() removed — use updateProfileStatus instead (fire-and-forget)
    Atlas.updateProfileStatus(status).catch(() => { });
    return status;
  };

  Atlas.sendFile = async (jid, PATH, fileName, quoted = {}, options = {}) => {
    let types = await Atlas.getFile(PATH, true);
    let { filename, size, ext, mime, data } = types;
    let type = "",
      mimetype = mime,
      pathFile = filename;
    if (options.asDocument) type = "document";
    if (options.asSticker || /webp/.test(mime)) {
      const { writeExif } = await import("./lib/sticker.js");
      let media = {
        mimetype: mime,
        data,
      };
      pathFile = await writeExif(media, {
        packname: global.packname,
        author: global.packname,
        categories: options.categories ? options.categories : [],
      });
      await fs.promises.unlink(filename);
      type = "sticker";
      mimetype = "image/webp";
    } else if (/image/.test(mime)) type = "image";
    else if (/video/.test(mime)) type = "video";
    else if (/audio/.test(mime)) type = "audio";
    else type = "document";
    await Atlas.sendMessage(
      jid,
      {
        [type]: {
          url: pathFile,
        },
        mimetype,
        fileName,
        ...options,
      },
      {
        quoted,
        ...options,
      },
    );
    return fs.promises.unlink(pathFile);
  };
};
const { sleepTime, wakeTime } = getSleepConfig();
const pad = (num) => String(num).padStart(2, "0");
const sleepCronPattern = `${sleepTime.minute} ${sleepTime.hour} * * *`;
const wakeCronPattern = `${wakeTime.minute} ${wakeTime.hour} * * *`;

// Schedule bot sleep in the configured timezone
cron.schedule(sleepCronPattern, async () => {
  const { sleepTime: currentSleep, wakeTime: currentWake } = getSleepConfig();
  const sleepStr = `${pad(currentSleep.hour)}:${pad(currentSleep.minute)}`;
  const wakeStr = `${pad(currentWake.hour)}:${pad(currentWake.minute)}`;
  console.log(chalk.yellow(`[ ATLAS ] Sleep time (${sleepStr}) reached. Disconnecting...`));
  global.isSleeping = true;
  status = "sleeping";

  if (AtlasSocket) {
    const owners = global.owner || [];
    for (const owner of owners) {
      const cleanOwner = owner.replace(/[^0-9]/g, "");
      if (cleanOwner) {
        const jid = `${cleanOwner}@s.whatsapp.net`;
        await AtlasSocket.sendMessage(jid, { text: `💤 *Atlas Bot is going to sleep (disconnecting from WhatsApp until ${wakeStr})...*` }).catch(() => { });
      }
    }
    // Wait 3 seconds for messages to send
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      await AtlasSocket.end(undefined);
    } catch (e) {
      console.error(chalk.red(`[ ATLAS ] Error ending socket: ${e.message}`));
    }
  }
}, {
  timezone: process.env.TIMEZONE || "Asia/Kolkata"
});

// Schedule bot wake up in the configured timezone
cron.schedule(wakeCronPattern, async () => {
  const { wakeTime: currentWake } = getSleepConfig();
  const wakeStr = `${pad(currentWake.hour)}:${pad(currentWake.minute)}`;
  console.log(chalk.green(`[ ATLAS ] Wake up time (${wakeStr}) reached. Reconnecting...`));
  global.isSleeping = false;
  global.justWokeUp = true;
  status = "initializing";

  await startAtlas();
}, {
  timezone: process.env.TIMEZONE || "Asia/Kolkata"
});

startAtlas();

// Dynamic garbage collection — interval configurable via GC_INTERVAL_MINUTES env (default: 30)
const GC_INTERVAL_MINUTES = Math.max(
  1,
  parseInt(process.env.GC_INTERVAL_MINUTES || "30", 10),
);
// Periodic MongoDB session sync — runs at the same interval as GC
const runPeriodicSync = async () => {
  if (mongoAuth) {
    await mongoAuth
      .pushToMongoDB()
      .catch((err) =>
        console.error(
          chalk.redBright(
            `[ ATLAS ] MongoDB session sync error: ${err.message}`,
          ),
        ),
      );
    console.log(chalk.cyan(`[ ATLAS ] Session synced to MongoDB`));
  }
};

const runWatchdog = () => {
  if (!AtlasSocket) return;
  // WebSocket readyState: 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED
  const wsReady = AtlasSocket.ws?.readyState;
  if (wsReady !== undefined && wsReady !== 1 && status === "open") {
    console.log(
      chalk.yellow(
        `[ ATLAS ] Session Watchdog: silent disconnect detected (wsState=${wsReady}) — reconnecting...`,
      ),
    );
    status = "reconnecting";
    startAtlas();
  }
};

if (typeof global.gc === "function") {
  setInterval(
    async () => {
      global.gc();
      console.log(
        chalk.cyan(
          `[ ATLAS ] Garbage collection triggered (interval: ${GC_INTERVAL_MINUTES}m)`,
        ),
      );
      await runPeriodicSync();
      runWatchdog();
    },
    GC_INTERVAL_MINUTES * 60 * 1000,
  );
  console.log(
    chalk.cyan(
      `[ ATLAS ] GC scheduler active — running every ${GC_INTERVAL_MINUTES} minute(s)`,
    ),
  );
} else {
  console.warn(
    "[ ATLAS ] GC not available. Start the bot with 'npm start' to enable garbage collection.",
  );
  // Still run session sync and watchdog even without GC
  setInterval(
    () => {
      runPeriodicSync();
      runWatchdog();
    },
    GC_INTERVAL_MINUTES * 60 * 1000,
  );
}

app.use("/", express.static(join(__dirname, "Frontend")));

// --- GUI API Endpoints ---

app.get("/api/status", (req, res) => {
  res.json({ status });
});

app.get("/api/qr", async (req, res) => {
  if (status === "open") {
    return res.json({ status: "connected" });
  }
  if (!QR_GENERATE || QR_GENERATE === "invalid") {
    return res.json({ status: "waiting" });
  }
  try {
    const qrDataUrl = await qrcode.toDataURL(QR_GENERATE);
    return res.json({ status: "qr", qr: qrDataUrl });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
});

app.post("/api/pair", async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: "Phone number is required." });
  }
  if (status === "open") {
    return res.status(400).json({ error: "Session is already connected!" });
  }
  if (!AtlasSocket) {
    return res
      .status(503)
      .json({ error: "Bot socket is not ready yet. Please wait a moment." });
  }
  try {
    const cleaned = phone.replace(/[^0-9]/g, "");
    let code = await AtlasSocket.requestPairingCode(cleaned);
    code = code?.match(/.{1,4}/g)?.join("-") || code;
    console.log(
      chalk.black.bgGreen(` PAIRING CODE: `),
      chalk.black.bgWhite(` ${code} `),
    );
    return res.json({ code });
  } catch (err) {
    console.error(
      chalk.red("[ EXCEPTION ] Pairing code error: " + err.message),
    );
    return res
      .status(500)
      .json({ error: "Failed to generate pairing code: " + err.message });
  }
});

app.post("/api/webhook", async (req, res) => {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) {
    return res.status(500).json({ error: "WEBHOOK_SECRET is not configured on the server." });
  }

  const authHeader = req.headers["authorization"];
  const customHeader = req.headers["x-webhook-secret"];
  const receivedSecret = authHeader ? authHeader.replace(/^Bearer\s+/i, "") : customHeader;

  if (!receivedSecret || receivedSecret !== webhookSecret) {
    return res.status(401).json({ error: "Unauthorized: Invalid or missing secret." });
  }

  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: "Missing required field: 'text'." });
  }

  const targetJid = process.env.KAMAVO_LIVE_METRICS_GROUP_JID;
  if (!targetJid) {
    return res.status(500).json({ error: "KAMAVO_LIVE_METRICS_GROUP_JID is not configured on the server." });
  }

  if (!AtlasSocket) {
    return res.status(503).json({ error: "WhatsApp bot connection is not ready." });
  }

  try {
    await AtlasSocket.sendMessage(targetJid, { text });
    return res.json({ success: true, message: "Message sent successfully to " + targetJid });
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err);
    return res.status(500).json({ error: "Failed to send message: " + err.message });
  }
});

app.listen(PORT);
