import {
  extractMessageContent,
  getContentType,
  downloadContentFromMessage,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import {
  checkAntidelete,
  checkGlobalAntidelete,
  checkMod,
} from "../System/MongoDB/MongoDb_Core.js";
import type { AtlasStore } from "./store.js";

/**
 * Handles message revocation ("delete for everyone") across groups and direct messages.
 * - Group Anti-Delete: Re-sends the deleted content in the group if enabled for that group.
 * - Global Anti-Delete: Forwards recovered deleted content to the primary bot owner's private chat.
 */
export async function handleAntiDelete(
  Atlas: any,
  updates: any[],
  store: AtlasStore
): Promise<void> {
  for (const { key, update } of updates) {
    try {
      // Only care about "delete for everyone" events (messageStubType 1 = REVOKE)
      if (!update?.messageStubType || update.messageStubType !== 1) continue;

      const chatId = key.remoteJid;
      if (!chatId || chatId === "status@broadcast") continue;

      const isGroup = chatId.endsWith("@g.us");

      // Verify anti-delete settings
      const isGroupAntidelete = isGroup ? await checkAntidelete(chatId) : false;
      const isGlobalAntidelete = await checkGlobalAntidelete();

      if (!isGroupAntidelete && !isGlobalAntidelete) continue;

      // Skip if this message was deleted by the bot itself (antilink, -delete cmd, etc.)
      if ((global as any).botDeletedMsgIds?.has(key.id)) {
        (global as any).botDeletedMsgIds.delete(key.id);
        continue;
      }

      // Look up original message from store cache
      const cached = store.messages[chatId]?.[key.id];
      if (!cached) continue;

      const deleter = isGroup
        ? key.participant || key.remoteJid
        : cached.key?.participant || key.remoteJid;
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

      // Skip if deleter is an owner
      const deleterDigits = deleter.replace(/[^0-9]/g, "");
      const ownerList: string[] = (global as any).owner || [];
      const ownerDigits = ownerList.map((o: string) => o.replace(/[^0-9]/g, ""));
      if (ownerDigits.includes(deleterDigits)) continue;

      // Skip if deleter is a mod
      const isDeleterMod = await checkMod(deleter);
      if (isDeleterMod) continue;

      // If group, skip if deleter is a group admin
      if (isGroup) {
        try {
          const groupMeta = await Atlas.groupMetadata(chatId);
          const admins = (groupMeta.participants || [])
            .filter((p: any) => p.admin === "admin" || p.admin === "superadmin")
            .map((p: any) => jidNormalizedUser(p.id));
          if (admins.includes(deleterNormalized)) continue;
        } catch {}
      }

      // Determine delivery targets
      const primaryOwner = ownerList[0];
      const primaryOwnerJid = primaryOwner
        ? `${primaryOwner.replace(/[^0-9]/g, "")}@s.whatsapp.net`
        : null;

      const sendToGroup = isGroup && isGroupAntidelete;
      const sendToOwner = isGlobalAntidelete && !!primaryOwnerJid;

      if (!sendToGroup && !sendToOwner) continue;

      // Retrieve chat name for owner notification
      let groupName = "";
      if (isGroup && sendToOwner) {
        try {
          const meta = await Atlas.groupMetadata(chatId);
          groupName = meta?.subject || chatId;
        } catch {
          groupName = chatId;
        }
      }

      const senderTag = `@${deleter.split("@")[0]}`;
      const msg = cached.message;
      if (!msg) continue;

      const extracted = extractMessageContent(msg);
      if (!extracted) continue;

      const contentType = getContentType(extracted);
      if (!contentType) continue;

      const content: any = (extracted as any)[contentType];
      if (!content) continue;

      const ownerHeader = isGroup
        ? `🛡️ *Global Anti-Delete*\n\n📍 *Group:* ${groupName}\n👤 *Sender:* ${senderTag} (${deleter.split("@")[0]})\n\n`
        : `🛡️ *Global Anti-Delete*\n\n💬 *Direct Message (DM)*\n👤 *Sender:* ${senderTag} (${deleter.split("@")[0]})\n\n`;

      // Text messages
      if (contentType === "conversation" || contentType === "extendedTextMessage") {
        const text =
          contentType === "conversation"
            ? extracted.conversation || ""
            : content?.text || "";

        if (sendToGroup) {
          await Atlas.sendMessage(chatId, {
            text: `🛡️ *Anti-Delete*\n\n${senderTag} deleted:\n\n${text}`,
            mentions: [deleter],
          });
        }

        if (sendToOwner && primaryOwnerJid) {
          await Atlas.sendMessage(primaryOwnerJid, {
            text: `${ownerHeader}${text}`,
            mentions: [deleter],
          });
        }
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

        const groupCaption =
          `🛡️ *Anti-Delete*\n\n${senderTag} deleted this ${mediaType}` +
          (content?.caption ? `:\n\n${content.caption}` : "");

        const ownerMediaCaption =
          `${ownerHeader.trimEnd()}\nDeleted this ${mediaType}` +
          (content?.caption ? `:\n\n${content.caption}` : "");

        // Resend to group if group anti-delete is active
        if (sendToGroup) {
          if (isImage) {
            await Atlas.sendMessage(chatId, {
              image: buffer,
              caption: groupCaption,
              mentions: [deleter],
            });
          } else if (isVideo) {
            await Atlas.sendMessage(chatId, {
              video: buffer,
              caption: groupCaption,
              mentions: [deleter],
            });
          } else if (isAudio) {
            await Atlas.sendMessage(chatId, {
              audio: buffer,
              mimetype: content?.mimetype || "audio/ogg; codecs=opus",
              caption: undefined,
              mentions: [deleter],
            });
            await Atlas.sendMessage(chatId, {
              text: `🛡️ *Anti-Delete*\n\n${senderTag} deleted an audio message`,
              mentions: [deleter],
            });
          } else if (isSticker) {
            await Atlas.sendMessage(chatId, { sticker: buffer });
            await Atlas.sendMessage(chatId, {
              text: `🛡️ *Anti-Delete*\n\n${senderTag} deleted a sticker`,
              mentions: [deleter],
            });
          } else if (isDoc) {
            await Atlas.sendMessage(chatId, {
              document: buffer,
              mimetype: content?.mimetype || "application/octet-stream",
              fileName: content?.fileName || "document",
              caption: groupCaption,
              mentions: [deleter],
            });
          }
        }

        // Forward to primary owner if global anti-delete is active
        if (sendToOwner && primaryOwnerJid) {
          if (isImage) {
            await Atlas.sendMessage(primaryOwnerJid, {
              image: buffer,
              caption: ownerMediaCaption,
              mentions: [deleter],
            });
          } else if (isVideo) {
            await Atlas.sendMessage(primaryOwnerJid, {
              video: buffer,
              caption: ownerMediaCaption,
              mentions: [deleter],
            });
          } else if (isAudio) {
            await Atlas.sendMessage(primaryOwnerJid, {
              audio: buffer,
              mimetype: content?.mimetype || "audio/ogg; codecs=opus",
              caption: undefined,
              mentions: [deleter],
            });
            await Atlas.sendMessage(primaryOwnerJid, {
              text: `${ownerHeader.trimEnd()}\nDeleted an audio message.`,
              mentions: [deleter],
            });
          } else if (isSticker) {
            await Atlas.sendMessage(primaryOwnerJid, { sticker: buffer });
            await Atlas.sendMessage(primaryOwnerJid, {
              text: `${ownerHeader.trimEnd()}\nDeleted a sticker.`,
              mentions: [deleter],
            });
          } else if (isDoc) {
            await Atlas.sendMessage(primaryOwnerJid, {
              document: buffer,
              mimetype: content?.mimetype || "application/octet-stream",
              fileName: content?.fileName || "document",
              caption: ownerMediaCaption,
              mentions: [deleter],
            });
          }
        }
        continue;
      }

      // Fallback: unknown type
      if (sendToGroup) {
        await Atlas.sendMessage(chatId, {
          text: `🛡️ *Anti-Delete*\n\n${senderTag} deleted a message (type: ${contentType})`,
          mentions: [deleter],
        });
      }

      if (sendToOwner && primaryOwnerJid) {
        await Atlas.sendMessage(primaryOwnerJid, {
          text: `${ownerHeader.trimEnd()}\nDeleted a message (type: ${contentType})`,
          mentions: [deleter],
        });
      }
    } catch {
      // Silently skip errors — don't crash the event loop
    }
  }
}
