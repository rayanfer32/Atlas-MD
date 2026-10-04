import { extractMessageContent, downloadContentFromMessage, getContentType } from "@whiskeysockets/baileys";

let mergedCommands = ["revive", "viewonce", "vo", "antiviewonce", "what"];

export default {
  name: "revive",
  alias: [...mergedCommands],
  uniquecommands: ["revive", "viewonce", "what"],
  description: "Download and resend view once messages",

  start: async (Atlas: any, m: any, { inputCMD, quoted, doReact, prefix }: any) => {
    const targetChat = process.env.REVIVE_TO || m.from;
    const sendTargetMsg = (text: string) =>
      Atlas.sendMessage(
        targetChat,
        { text },
        m.from === targetChat ? { quoted: m } : undefined
      );

    try {
      // Must be a reply to a message
      if (!m.quoted) {
        return sendTargetMsg(
          `Reply to a *view once* message with *${prefix}${inputCMD || "revive"}*`
        );
      }

      // Get the raw quoted message from contextInfo
      const contextInfo = m.msg?.contextInfo;
      if (!contextInfo?.quotedMessage) {
        return sendTargetMsg("Could not read the quoted message.");
      }

      const rawQuoted = contextInfo.quotedMessage;
      const quotedType = getContentType(rawQuoted);

      // Case 1: Wrapped in viewOnceMessage / viewOnceMessageV2 container
      const isWrappedViewOnce =
        quotedType === "viewOnceMessage" ||
        quotedType === "viewOnceMessageV2" ||
        quotedType === "viewOnceMessageV2Extension";

      if (!quotedType) {
        return sendTargetMsg("Could not read the quoted message.");
      }

      // Case 2: Already unwrapped — imageMessage/videoMessage with viewOnce flag
      const innerMsg = rawQuoted[quotedType];
      const isUnwrappedViewOnce =
        !isWrappedViewOnce &&
        (quotedType === "imageMessage" || quotedType === "videoMessage") &&
        innerMsg?.viewOnce === true;

      if (!isWrappedViewOnce && !isUnwrappedViewOnce) {
        return sendTargetMsg(
          `This is not a view once message.\nReply to a *view once* image or video with *${prefix}${inputCMD || "revive"}*`
        );
      }

      let mediaMsg, isImage, isVideo;

      if (isWrappedViewOnce) {
        // Unwrap the view-once container
        const extracted = extractMessageContent(rawQuoted);
        const mediaType = getContentType(extracted);
        if (!extracted || !mediaType) {
          return sendTargetMsg("Could not extract media from the view once message.");
        }
        mediaMsg = extracted[mediaType];
        isImage = mediaType.includes("image");
        isVideo = mediaType.includes("video");
      } else {
        // Already unwrapped — use directly
        mediaMsg = innerMsg;
        isImage = quotedType === "imageMessage";
        isVideo = quotedType === "videoMessage";
      }

      if (!mediaMsg) {
        return sendTargetMsg("Could not extract media from the view once message.");
      }

      // Download the media content
      const stream = await downloadContentFromMessage(
        mediaMsg,
        isImage ? "image" : "video"
      );
      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }

      if (!buffer.length) {
        return sendTargetMsg("Failed to download the view once media.");
      }

      // Build caption
      const originalCaption = mediaMsg.caption || "";
      const caption =
        `👁️ *View Once Revived*\n\n` +
        (originalCaption ? `${originalCaption}\n\n` : "");

      // Send as normal (non-view-once) message
      if (isImage) {
        await Atlas.sendMessage(
          targetChat,
          { image: buffer, caption },
          m.from === targetChat ? { quoted: m } : undefined
        );
      } else {
        await Atlas.sendMessage(
          targetChat,
          { video: buffer, caption },
          m.from === targetChat ? { quoted: m } : undefined
        );
      }
    } catch (e: any) {
      console.log("[ REVIVE ERROR ]", e.message);
      await sendTargetMsg("Failed to revive the view once message. It may have expired.");
    }
  },
};
