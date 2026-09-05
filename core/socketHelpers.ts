import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fileTypeFromBuffer } from "file-type";
import {
  jidDecode,
  downloadContentFromMessage,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import { smsg, getBuffer, getSizeMedia } from "../System/functions.js";
import type { AtlasStore } from "./store.js";

const __filename = fileURLToPath(import.meta.url);

function formatPhoneNumber(jid: string): string {
  const clean = jid.replace("@s.whatsapp.net", "").replace(/^\+/, "");
  return "+" + clean;
}

/**
 * Attaches custom helper and convenience methods directly onto the Atlas Baileys socket instance.
 */
export function attachSocketHelpers(Atlas: any, store: AtlasStore): void {
  Atlas.serializeM = (m: any) => smsg(Atlas, m, store);

  Atlas.decodeJid = (jid: string): string => {
    if (!jid) return jid;
    if (/:\d+@/gi.test(jid)) {
      const decode: any = jidDecode(jid) || {};
      return (
        (decode.user && decode.server && decode.user + "@" + decode.server) ||
        jid
      );
    }
    return jid;
  };

  Atlas.getName = (jid: string, withoutContact = false): any => {
    const id = Atlas.decodeJid(jid);
    const noContact = Atlas.withoutContact || withoutContact;
    let v: any;

    if (id.endsWith("@g.us")) {
      return new Promise(async (resolve) => {
        v = store.contacts[id] || {};
        if (!(v.name || v.subject)) v = (await Atlas.groupMetadata(id).catch(() => ({}))) || {};
        resolve(v.name || v.subject || formatPhoneNumber(id));
      });
    }

    v =
      id === "0@s.whatsapp.net"
        ? { id, name: "WhatsApp" }
        : id === Atlas.decodeJid(Atlas.user?.id)
          ? Atlas.user
          : store.contacts[id] || {};

    return (
      (noContact ? "" : v.name) ||
      v.subject ||
      v.verifiedName ||
      formatPhoneNumber(jid)
    );
  };

  Atlas.downloadAndSaveMediaMessage = async (
    message: any,
    filename: string,
    attachExtension = true
  ): Promise<string> => {
    let buffer: Buffer | undefined;
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
            } as any,
            reuploadRequest: Atlas.updateMediaMessage,
          }
        );
      } catch {
        // Fall through to legacy method
      }
    }

    // Legacy fallback using downloadContentFromMessage
    if (!buffer) {
      const quoted = message.msg ? message.msg : message;
      const mime = (message.msg || message).mimetype || "";
      const messageType = message.mtype
        ? message.mtype.replace(/Message/gi, "")
        : mime.split("/")[0];
      const stream = await downloadContentFromMessage(quoted, messageType);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      buffer = Buffer.concat(chunks);
    }

    const type = await fileTypeFromBuffer(buffer);
    const ext = type?.ext || "bin";
    const trueFileName = attachExtension ? `${filename}.${ext}` : filename;
    await fs.promises.writeFile(trueFileName, buffer);
    return trueFileName;
  };

  Atlas.downloadMediaMessage = async (message: any): Promise<Buffer> => {
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
            } as any,
            reuploadRequest: Atlas.updateMediaMessage,
          }
        );
      } catch {
        // Fall through to legacy method
      }
    }

    const mime = (message.msg || message).mimetype || "";
    const messageType = message.mtype
      ? message.mtype.replace(/Message/gi, "")
      : mime.split("/")[0];
    const stream = await downloadContentFromMessage(message, messageType);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };

  Atlas.parseMention = async (text: string): Promise<string[]> => {
    return [...text.matchAll(/@([0-9]{5,16}|0)/g)].map(
      (v) => v[1] + "@s.whatsapp.net"
    );
  };

  Atlas.sendText = (jid: string, text: string, quoted = "", options: any = {}): Promise<any> =>
    Atlas.sendMessage(
      jid,
      {
        text,
        ...options,
      },
      {
        quoted,
      }
    );

  Atlas.getFile = async (PATH: any, save = false): Promise<any> => {
    let res: any;
    let data = Buffer.isBuffer(PATH)
      ? PATH
      : /^data:.*?\/.*?;base64,/i.test(PATH)
        ? Buffer.from(PATH.split`,`[1], "base64")
        : /^https?:\/\//.test(PATH)
          ? await (res = await getBuffer(PATH))
          : fs.existsSync(PATH)
            ? fs.readFileSync(PATH)
            : typeof PATH === "string"
              ? PATH
              : Buffer.alloc(0);

    const type = (await fileTypeFromBuffer(data)) || {
      mime: "application/octet-stream",
      ext: ".bin",
    };
    const filename = path.join(
      path.dirname(__filename),
      "../src/" + Date.now() + "." + type.ext
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

  Atlas.setStatus = (status: string): string => {
    Atlas.updateProfileStatus(status).catch(() => { });
    return status;
  };

  Atlas.sendFile = async (
    jid: string,
    PATH: any,
    fileName?: string,
    quoted: any = {},
    options: any = {}
  ): Promise<any> => {
    const types = await Atlas.getFile(PATH, true);
    const { filename, mime, data } = types;
    let type = "";
    let mimetype = mime;
    let pathFile = filename;

    if (options.asDocument) type = "document";
    if (options.asSticker || /webp/.test(mime)) {
      try {
        const { writeExif }: any = await (import("../lib/sticker.js" as any) as Promise<any>);
        const media = {
          mimetype: mime,
          data,
        };
        pathFile = await writeExif(media, {
          packname: (global as any).packname,
          author: (global as any).packname,
          categories: options.categories ? options.categories : [],
        });
        await fs.promises.unlink(filename);
      } catch {
        pathFile = filename;
      }
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
      }
    );
    return fs.promises.unlink(pathFile).catch(() => {});
  };
}
