import "./configurations.js";
import "../System/BotCharacters.js";
import chalk from "chalk";
import axios from "axios";
import { GoogleGenAI } from "@google/genai";
import { getGeminiConfig, GEMINI_MODEL } from "../System/systemPrompt.js";
import {
  checkBan,
  checkMod,
  getChar,
  checkPmChatbot,
  getBotMode,
  checkBanGroup,
  checkAntilink,
  checkGroupChatbot,
} from "../System/MongoDB/MongoDb_Core.js";

const DEFAULT_SUPPORT_URL = "https://cutt.ly/AtlasBotSupport";
const FALLBACK_AI_URL = "https://api-faa.my.id/faa/gemini-ai";

const CORE_MAINTAINERS = new Set([
  "918101187835@s.whatsapp.net",
  "923045204414@s.whatsapp.net",
]);

const INFO_COMMANDS = new Set([
  "mods",
  "modlist",
  "owner",
  "owners",
  "support",
  "supportgc",
]);

/**
 * Strips device/instance suffixes from WhatsApp JIDs (e.g. 1234:5@s.whatsapp.net -> 1234@s.whatsapp.net)
 */
export const sanitizeJid = (jid?: string): string => {
  if (!jid) return "";
  const parts = jid.split("@");
  if (parts.length < 2) return jid;
  return `${parts[0].split(":")[0]}@${parts[1]}`;
};

/**
 * Format JID for user-friendly console display
 */
const formatDisplayJid = (jid?: string): string => {
  if (!jid) return "unknown";
  const [local, domain] = jid.split("@");
  if (domain === "lid") return `LID:${local}`;
  return `+${local.split(":")[0]}`;
};

/**
 * Capitalize first letter of string
 */
export const toUpper = (query: string): string =>
  query.replace(/^\w/, (c) => c.toUpperCase());

/**
 * Extract message text or button/list response ID safely
 */
const extractMessageBody = (m: any): string => {
  if (!m) return "";
  const type = m.type;
  if (type === "buttonsResponseMessage") {
    return m.message?.[type]?.selectedButtonId || "";
  }
  if (type === "listResponseMessage") {
    return m.message?.[type]?.singleSelectReply?.selectedRowId || "";
  }
  if (type === "templateButtonReplyMessage") {
    return m.message?.[type]?.selectedId || "";
  }
  return typeof m.text === "string" ? m.text : "";
};

/**
 * Resolve sender phone JID when Baileys receives a LID (@lid) JID
 */
const resolveSenderJid = (
  m: any,
  botIdClean: string,
  botLid: string,
  participants: any[],
): string => {
  if (!m.sender || !m.sender.endsWith("@lid")) {
    return m.sender || "";
  }

  const cleanSender = sanitizeJid(m.sender);

  // 1. Cached LID -> phone JID
  const cached = global.lidToJidMap?.get(cleanSender);
  if (cached && cached.endsWith("@s.whatsapp.net")) {
    return cached;
  }

  // 2. Baileys v7 participantAlt
  if (m.key?.participantAlt?.endsWith("@s.whatsapp.net")) {
    const resolved = sanitizeJid(m.key.participantAlt);
    global.lidToJidMap?.set(cleanSender, resolved);
    return resolved;
  }

  // 3. Group metadata participants
  if (m.isGroup && Array.isArray(participants)) {
    const match = participants.find(
      (p: any) => sanitizeJid(p.id) === cleanSender && p.phoneNumber,
    );
    if (match) {
      const resolved = sanitizeJid(match.phoneNumber);
      global.lidToJidMap?.set(cleanSender, resolved);
      return resolved;
    }
  }

  // 4. Bot self-check
  if (cleanSender === botLid) {
    global.lidToJidMap?.set(cleanSender, botIdClean);
    return botIdClean;
  }

  return m.sender;
};

/**
 * Fallback free AI endpoint when Gemini API is unavailable or rate-limited
 */
const fetchFallbackAi = async (promptText: string): Promise<string | null> => {
  try {
    const url = `${FALLBACK_AI_URL}?text=${encodeURIComponent(promptText)}`;
    const response = await axios.get(url, { timeout: 15000 });
    if (response.data && response.data.status) {
      return response.data.result;
    }
  } catch (e: any) {
    console.error("[ ATLAS ] Fallback AI API request failed:", e?.message);
  }
  return null;
};

/**
 * Generate AI chatbot response via Gemini or secondary fallback
 */
const fetchGeminiReply = async (promptText: string): Promise<string> => {
  const geminiKey = global.pickKey ? global.pickKey(global.geminiAPIKeys) : null;
  let responseText: string | null = null;

  if (geminiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey: geminiKey });
      const result = await ai.models.generateContent({
        model: GEMINI_MODEL,
        config: getGeminiConfig() as any,
        contents: [{ role: "user", parts: [{ text: promptText }] }],
      });
      responseText = result.text ?? null;
    } catch (err: any) {
      console.log(
        "[ ATLAS ] Gemini API error, falling back to backup AI...\nDetails:",
        err?.message || err,
      );
      responseText = await fetchFallbackAi(promptText);
    }
  } else {
    console.log("[ ATLAS ] No valid Gemini key available, using backup AI API.");
    responseText = await fetchFallbackAi(promptText);
  }

  return responseText ? responseText.trim() : "Service unavailable at the moment.";
};

/**
 * Sync active bot character assets from database to global namespace
 */
const syncBotCharacter = async (): Promise<void> => {
  let characterSelection = "0";
  try {
    const charx = await getChar();
    characterSelection = charx || "0";
  } catch {
    characterSelection = "0";
  }

  const charConfig = (global as any)[`charID${characterSelection}`] || (global as any)["charID0"] || {};
  global.botName = charConfig.botName;
  global.botVideo = charConfig.botVideo;
  global.botImage1 = charConfig.botImage1;
  global.botImage2 = charConfig.botImage2;
  global.botImage3 = charConfig.botImage3;
  global.botImage4 = charConfig.botImage4;
  global.botImage5 = charConfig.botImage5;
  global.botImage6 = charConfig.botImage6;
};

/**
 * Handle anti-link enforcement in groups
 */
const handleAntilinkEnforcement = async (
  Atlas: any,
  m: any,
  from: string,
  budy: string,
): Promise<void> => {
  const urlRegex = /https?:\/\/[^\s]+/gi;
  const detectedUrls = budy.match(urlRegex);
  if (!detectedUrls || detectedUrls.length === 0) return;

  let isOwnLink = false;
  try {
    const linkCode = await Atlas.groupInviteCode(from);
    isOwnLink = detectedUrls.every((u: string) => u.includes(`chat.whatsapp.com/${linkCode}`));
  } catch {
    // Unable to retrieve group invite code; proceed with enforcement
  }

  if (isOwnLink) return;

  if (!global.botDeletedMsgIds) {
    global.botDeletedMsgIds = new Set();
  }
  global.botDeletedMsgIds.add(m.id);
  setTimeout(() => global.botDeletedMsgIds?.delete(m.id), 300000);

  await Atlas.sendMessage(from, {
    delete: {
      remoteJid: m.from,
      fromMe: false,
      id: m.id,
      participant: m.sender,
    },
  });

  const warningText = `\`\`\`「  Antilink System  」\`\`\`\n\n*⚠️ Link detected !*\n\n*🚫 @${m.sender.split("@")[0]}, you are not allowed to send links in this group !*\n`;
  await Atlas.sendMessage(from, { text: warningText, mentions: [m.sender] }, { quoted: m });
};

/**
 * Core Message & Command Dispatcher
 */
export default async (Atlas: any, m: any, commands: any, chatUpdate: any) => {
  try {
    const prefix = global.prefa || "-";
    const { type, isGroup, sender, from } = m;

    const body = extractMessageBody(m);
    const budy = typeof m.text === "string" ? m.text : "";
    const isCmd = body.startsWith(prefix);

    const metadata = isGroup ? await Atlas.groupMetadata(from).catch(() => ({})) : {};
    const pushname = m.pushName || "NO name";
    const participants = isGroup ? metadata.participants || [] : [sender];
    const quoted = m.quoted ? m.quoted : m;

    const botNumber = Atlas.decodeJid ? await Atlas.decodeJid(Atlas.user.id) : Atlas.user?.id;
    const botIdClean = sanitizeJid(botNumber);
    const botLid = Atlas.user?.lid ? sanitizeJid(Atlas.user.lid) : botIdClean;

    const groupAdmins: string[] = isGroup
      ? participants
        .filter((p: any) => p.admin === "admin" || p.admin === "superadmin")
        .map((p: any) => p.id)
      : [];

    const isBotAdmin = isGroup
      ? groupAdmins.includes(botIdClean) ||
      groupAdmins.includes(botLid) ||
      groupAdmins.some((admin: any) => sanitizeJid(admin) === botIdClean)
      : false;

    const isAdmin = isGroup
      ? groupAdmins.includes(m.sender) || groupAdmins.includes(sanitizeJid(m.sender))
      : false;

    const resolvedSender = resolveSenderJid(m, botIdClean, botLid, participants);

    const ownerDigits = new Set(
      [botIdClean, ...(global.owner || [])]
        .filter(Boolean)
        .map((v: any) => String(v).replace(/[^0-9]/g, "")),
    );

    const isCreator =
      ownerDigits.has(resolvedSender.replace(/[^0-9]/g, "")) ||
      ownerDigits.has(m.sender.replace(/[^0-9]/g, ""));

    const messSender = m.sender;
    const itsMe = m.sender.includes(botIdClean.split("@")[0]);
    const groupAdmin = groupAdmins;

    const mime = (quoted.msg || m.msg)?.mimetype || " ";
    const isMedia = /image|video|sticker|audio/.test(mime);
    const args = body.trim().split(/\s+/).slice(1);
    const ar = args.map((v: string) => v.toLowerCase());
    const text = args.join(" ");
    global.suppL = DEFAULT_SUPPORT_URL;

    const inputCMD = isCmd
      ? body.slice(prefix.length).trim().split(/\s+/)[0]?.toLowerCase() || ""
      : "";
    const groupName = isGroup ? metadata.subject || "" : "";

    const isintegrated = (): boolean => CORE_MAINTAINERS.has(sanitizeJid(messSender));

    const doReact = async (emoji: string) => {
      await Atlas.sendMessage(m.from, {
        react: {
          text: emoji,
          key: m.key,
        },
      });
    };

    // Command lookup (by primary name or alias)
    const cmdName = inputCMD;
    const resolvedCommand = cmdName
      ? commands.get(cmdName) ||
      Array.from(commands.values()).find((v: any) =>
        v.alias?.some((alias: string) => alias.toLowerCase() === cmdName),
      )
      : null;

    const cmd = resolvedCommand || "";
    const icmd = resolvedCommand;

    const mentionByTag =
      type === "extendedTextMessage" &&
        m.message?.extendedTextMessage?.contextInfo?.mentionedJid
        ? m.message.extendedTextMessage.contextInfo.mentionedJid
        : [];

    const timeNow = new Date().toLocaleTimeString();
    const dateNow = new Date().toLocaleDateString();
    const timePrefix = chalk.black(chalk.bgCyan(`[ ${dateNow} - ${timeNow} ]`));

    // Terminal Logging
    if (m.message && isGroup) {
      console.log(
        `${timePrefix} ` + chalk.black(chalk.bgWhite("[ GROUP ]")) + " " +
        chalk.black(chalk.bgBlueBright(metadata.subject || m.pushName)) + "\n" +
        `${timePrefix} ` + chalk.black(chalk.bgWhite("[ SENDER ]")) + " " +
        chalk.black(chalk.bgBlueBright(m.pushName)) + "\n" +
        `${timePrefix} ` + chalk.black(chalk.bgWhite("[ MESSAGE ]")) + " " +
        chalk.black(chalk.bgBlueBright(body || type)),
      );
    } else if (m.message && !isGroup) {
      console.log(
        `${timePrefix} ` + chalk.black(chalk.bgWhite("[ PRIVATE ]")) + " " +
        chalk.black(chalk.bgRedBright(formatDisplayJid(m.from))) + "\n" +
        `${timePrefix} ` + chalk.black(chalk.bgWhite("[ SENDER ]")) + " " +
        chalk.black(chalk.bgRedBright(m.pushName)) + "\n" +
        `${timePrefix} ` + chalk.black(chalk.bgWhite("[ MESSAGE ]")) + " " +
        chalk.black(chalk.bgRedBright(body || type)),
      );
    }

    // Parallel system and authorization checks
    const [
      isBannedUser,
      modcheck,
      botWorkMode,
      isBannedGroup,
      isAntilinkOn,
      isGroupChatbotOn,
      isPmChatbotOn,
    ] = await Promise.all([
      checkBan(m.sender),
      checkMod(m.sender),
      getBotMode(),
      isGroup ? checkBanGroup(m.from) : Promise.resolve(false),
      isGroup ? checkAntilink(m.from) : Promise.resolve(false),
      isGroup ? checkGroupChatbot(m.from) : Promise.resolve(false),
      !isGroup ? checkPmChatbot() : Promise.resolve(false),
    ]);

    // Work mode enforcement
    if (isCmd || icmd) {
      if (botWorkMode === "private" && !isCreator && !modcheck) {
        console.log(`${timePrefix} ` + chalk.black(chalk.bgYellow("[ REJECTED ]")) + " " + chalk.black(chalk.bgYellow(`Private mode — ${m.pushName} (${body})`)));
        return;
      }
      if (botWorkMode === "self" && m.sender !== botNumber) {
        console.log(`${timePrefix} ` + chalk.black(chalk.bgYellow("[ REJECTED ]")) + " " + chalk.black(chalk.bgYellow(`Self mode — ${m.pushName} (${body})`)));
        return;
      }
    }

    // Ignore banned users
    if ((isCmd || icmd) && isBannedUser && !isCreator && !modcheck) {
      return;
    }

    // Ignore banned groups (except unban and support commands)
    if (
      (isCmd || icmd) &&
      isBannedGroup &&
      budy !== `${prefix}unbangc` &&
      budy !== `${prefix}unbangroup` &&
      !isCreator &&
      !modcheck &&
      !INFO_COMMANDS.has(inputCMD)
    ) {
      return;
    }

    // Single prefix sent
    if (body === prefix) {
      await doReact("❌");
      return m.reply(`Bot is active, type *${prefix}help* to see the list of commands.`);
    }

    // Unknown command
    if (isCmd && !resolvedCommand) {
      await doReact("❌");
      return m.reply(
        `*${budy.replace(
          prefix,
          "",
        )}* - Command not found or plug-in not installed !\n\nIf you want to see the list of commands, type:    *_${prefix}help_*\n\nOr type:  *_${prefix}pluginlist_* to see installable plug-in list.`,
      );
    }

    // Anti-link enforcement
    if (isAntilinkOn && isGroup && !isAdmin && !isCreator && !modcheck && !isintegrated() && isBotAdmin) {
      await handleAntilinkEnforcement(Atlas, m, from, budy);
    }

    // Group AI Chatbot
    if (isGroup && !isCmd && !resolvedCommand && isGroupChatbotOn) {
      const txtSender = m.quoted ? m.quoted.sender : mentionByTag[0];
      const senderClean = sanitizeJid(txtSender);
      const isBotMentioned =
        txtSender &&
        (senderClean === botIdClean ||
          senderClean === botLid ||
          txtSender === botNumber);

      if (isBotMentioned) {
        try {
          await Atlas.sendPresenceUpdate("composing", m.from);
          const aiReply = await fetchGeminiReply(budy);
          await m.reply(aiReply);
          await Atlas.sendPresenceUpdate("paused", m.from);
        } catch (e: any) {
          console.error("[ ATLAS ] Group chatbot error:", e?.message);
        }
      }
    }

    // Private Message AI Chatbot
    if (!isGroup && !isCmd && !resolvedCommand && isPmChatbotOn) {
      try {
        await Atlas.sendPresenceUpdate("composing", m.from);
        const aiReply = await fetchGeminiReply(budy);
        await m.reply(aiReply);
        await Atlas.sendPresenceUpdate("paused", m.from);
      } catch (e: any) {
        console.error("[ ATLAS ] PM chatbot error:", e?.message);
      }
    }

    // Character configuration synchronization
    await syncBotCharacter();

    // Command Execution
    if (resolvedCommand && typeof resolvedCommand.start === "function") {
      await resolvedCommand.start(Atlas, m, {
        name: "Atlas",
        metadata,
        pushName: pushname,
        participants,
        body,
        inputCMD,
        args,
        botNumber,
        botLid,
        isCmd,
        isMedia,
        ar,
        isAdmin,
        groupAdmin,
        text,
        itsMe,
        doReact,
        modcheck,
        isCreator,
        quoted,
        isintegrated,
        groupName,
        mentionByTag,
        mime,
        isBotAdmin,
        prefix,
        command: resolvedCommand.name,
        commands,
        toUpper,
      });
    }
  } catch (e: any) {
    console.error("[ ATLAS ] Core message handling error:", e);
  }
};
