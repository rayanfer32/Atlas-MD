import {
  extractMessageContent,
  getContentType,
  downloadContentFromMessage,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import { checkAntidelete, checkMod } from "../System/MongoDB/MongoDb_Core.js";
import type { AtlasStore } from "./store.js";

const INTEGRATED_DEVELOPER_JIDS = [];

/**
 * Handles group message revocation ("delete for everyone") and re-sends
 * the deleted content if anti-delete is enabled for the group.
 */
export async function handleAntiDelete(
  Atlas: any,
  updates: any[],
  store: AtlasStore
): Promise<void> {
  for (const { key, update } of updates) {
    try {
      // Only care about group "delete for everyone" events (messageStubType 1 = REVOKE)
      if (!key.remoteJid?.endsWith("@g.us")) continue;
      if (!update?.messageStubType || update.messageStubType !== 1) continue;

      const groupId = key.remoteJid;
      const isEnabled = await checkAntidelete(groupId);
      if (!isEnabled) continue;

      // Skip if this message was deleted by the bot itself (antilink, -delete cmd, etc.)
      if ((global as any).botDeletedMsgIds?.has(key.id)) {
        (global as any).botDeletedMsgIds.delete(key.id);
        continue;
      }

      // Look up the original message from store cache
      const cached = store.messages[groupId]?.[key.id];
      if (!cached) continue;

      const deleter = key.participant || key.remoteJid;
      const deleterNormalized = jidNormalizedUser(deleter);

      // Skip if the original message was sent by the bot itself
      const botJid = Atlas.user?.id ? jidNormalizedUser(Atlas.user.id) : null;
      if (
        cached.key?.fromMe ||
        (botJid &&
          jidNormalizedUser(cached.key?.participant || cached.key?.remoteJid) === botJid)
      ) {
        continue;
      }

      // Skip if the deleter is a group admin
      try {
        const groupMeta = await Atlas.groupMetadata(groupId);
        const admins = (groupMeta.participants || [])
          .filter((p: any) => p.admin === "admin" || p.admin === "superadmin")
          .map((p: any) => jidNormalizedUser(p.id));
        if (admins.includes(deleterNormalized)) continue;
      } catch { }

      // Skip if the deleter is a mod
      const isDeleterMod = await checkMod(deleter);
      if (isDeleterMod) continue;

      // Skip if the deleter is an owner
      const deleterDigits = deleter.replace(/[^0-9]/g, "");
      const ownerDigits = ((global as any).owner || []).map((o: string) =>
        o.replace(/[^0-9]/g, "")
      );
      if (ownerDigits.includes(deleterDigits)) continue;

      // Skip if the deleter is an integrated developer
      // if (INTEGRATED_DEVELOPER_JIDS.includes(deleterNormalized)) continue;

      const senderTag = `@${deleter.split("@")[0]}`;
      const msg = cached.message;
      if (!msg) continue;

      const extracted = extractMessageContent(msg);
      if (!extracted) continue;

      const contentType = getContentType(extracted);
      if (!contentType) continue;

      const content: any = (extracted as any)[contentType];
      if (!content) continue;

      // Text messages
      if (contentType === "conversation" || contentType === "extendedTextMessage") {
        const text =
          contentType === "conversation"
            ? extracted.conversation || ""
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
        const mediaType: any = isImage
          ? "image"
          : isVideo
            ? "video"
            : isAudio
              ? "audio"
              : isSticker
                ? "sticker"
                : "document";

        const stream = await downloadContentFromMessage(content as any, mediaType);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
          buffer = Buffer.concat([buffer, chunk]);
        }

        const caption =
          `🛡️ *Anti-Delete*\n\n${senderTag} deleted this ${mediaType}` +
          (content?.caption ? `:\n\n${content.caption}` : "");

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
            mimetype: content?.mimetype || "audio/ogg; codecs=opus",
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
            mimetype: content?.mimetype || "application/octet-stream",
            fileName: content?.fileName || "document",
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
    } catch {
      // Silently skip errors — don't crash the event loop
    }
  }
}
