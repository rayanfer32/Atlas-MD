import {
  proto,
  getContentType,
  extractMessageContent,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import child_process from "node:child_process";
import axios, { type AxiosRequestConfig } from "axios";
import ffmpegStatic from "ffmpeg-static";

const { unlink } = fs.promises;
const execAsync = util.promisify(child_process.exec);

export const unixTimestampSeconds = (date = new Date()): number =>
  Math.floor(date.getTime() / 1000);

export const generateMessageTag = (epoch?: string | number): string => {
  let tag = unixTimestampSeconds().toString();
  if (epoch) tag += ".--" + epoch;
  return tag;
};

export const getRandom = (ext = ""): string => {
  return `${Math.floor(Math.random() * 10000)}${ext}`;
};

export const getBuffer = async (url: string, options: AxiosRequestConfig = {}): Promise<Buffer | any> => {
  try {
    const res = await axios({
      method: "get",
      url,
      headers: {
        DNT: "1",
        "Upgrade-Insecure-Request": "1",
      },
      ...options,
      responseType: "arraybuffer",
    });
    return res.data;
  } catch (err) {
    return err;
  }
};

export const fetchBuffer = getBuffer;

export const fetchJson = async (url: string, options: AxiosRequestConfig = {}): Promise<any> => {
  try {
    const res = await axios({
      method: "GET",
      url,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.69 Safari/537.36",
      },
      ...options,
    });
    return res.data;
  } catch (err) {
    return err;
  }
};

export const fetchUrl = fetchJson;

export const runtime = (seconds: number | string): string => {
  seconds = Number(seconds);
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const dDisplay = d > 0 ? d + (d === 1 ? " day, " : " days, ") : "";
  const hDisplay = h > 0 ? h + (h === 1 ? " hr, " : " hrs, ") : "";
  const mDisplay = m > 0 ? m + (m === 1 ? " min, " : " mins, ") : "";
  const sDisplay = s > 0 ? s + (s === 1 ? " sec" : " secs") : "";
  return dDisplay + hDisplay + mDisplay + sDisplay;
};

export const sleep = async (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export const isUrl = (url: string): RegExpMatchArray | null => {
  return url.match(
    new RegExp(
      /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/,
      "gi"
    )
  );
};

export const jsonformat = (string: any): string => {
  return JSON.stringify(string, null, 2);
};

export const bytesToSize = (bytes: number, decimals = 2): string => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
};

export const getSizeMedia = (pathOrBuffer: string | Buffer): Promise<string> => {
  return new Promise((resolve, reject) => {
    if (typeof pathOrBuffer === "string" && /http/.test(pathOrBuffer)) {
      axios.get(pathOrBuffer).then((res) => {
        const length = parseInt((res.headers["content-length"] as string) || "0");
        const size = bytesToSize(length, 3);
        if (!isNaN(length)) resolve(size);
      }).catch(reject);
    } else if (Buffer.isBuffer(pathOrBuffer)) {
      const length = Buffer.byteLength(pathOrBuffer);
      const size = bytesToSize(length, 3);
      if (!isNaN(length)) resolve(size);
    } else {
      reject("Invalid media input for getSizeMedia");
    }
  });
};

export const parseMention = (text = ""): string[] => {
  return [...text.matchAll(/@([0-9]{5,16}|0)/g)].map(
    (v) => v[1] + "@s.whatsapp.net"
  );
};

export const GIFBufferToVideoBuffer = async (image: Buffer): Promise<Buffer> => {
  const cacheDir = path.resolve("./System/Cache");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const filename = `${Math.random().toString(36).slice(2)}`;
  const gifPath = path.join(cacheDir, `${filename}.gif`);
  const mp4Path = path.join(cacheDir, `${filename}.mp4`);

  await fs.promises.writeFile(gifPath, image);
  await execAsync(
    `"${ffmpegStatic}" -i "${gifPath}" -movflags faststart -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" "${mp4Path}"`
  );
  const buffer = await fs.promises.readFile(mp4Path);
  await Promise.all([unlink(mp4Path).catch(() => {}), unlink(gifPath).catch(() => {})]);
  return buffer;
};

/**
 * Unified Message Serializer
 * Normalizes incoming Baileys messages into a clean, accessible context object.
 *
 * @param {any} Atlas Baileys socket instance
 * @param {any} m Raw or proto WebMessageInfo
 * @param {any} store Optional in-memory message store
 */
export const serialize = (Atlas: any, m: any, store?: any): any => {
  if (!m) return m;
  const M = proto.WebMessageInfo;
  m = M.create(m);

  if (m.key) {
    m.from = jidNormalizedUser(m.key.remoteJid || m.key.participant);
    m.chat = m.from;
    m.fromMe = m.key.fromMe;
    m.id = m.key.id;
    m.isBot = m.id?.startsWith("BAE5") && m.id.length === 16;
    m.isBaileys = m.isBot;
    m.isGroup = m.from?.endsWith("@g.us");
    m.sender = jidNormalizedUser(
      (m.fromMe && Atlas.user?.id) || m.key.participant || m.participant || m.from || ""
    );
    if (m.isGroup) {
      m.participant = m.key.participant ? jidNormalizedUser(m.key.participant) : "";
    }
  }

  if (m.message) {
    m.message = extractMessageContent(m.message);
    m.type = getContentType(m.message);
    m.mtype = m.type;
    m.msg = m.message?.[m.type];
    m.mentions = m.msg?.contextInfo ? m.msg?.contextInfo.mentionedJid || [] : [];
    m.mentionedJid = m.mentions;

    const rawQuoted = m.msg?.contextInfo ? m.msg?.contextInfo.quotedMessage : null;
    m.quoted = rawQuoted ? extractMessageContent(rawQuoted) : null;

    if (m.quoted) {
      m.quoted.type = getContentType(m.quoted);
      m.quoted.mtype = m.quoted.type;
      m.quoted.msg = m.quoted[m.quoted.type];
      m.quoted.mentions = m.msg?.contextInfo?.mentionedJid || [];
      m.quoted.mentionedJid = m.quoted.mentions;
      m.quoted.id = m.msg?.contextInfo?.stanzaId;
      m.quoted.sender = jidNormalizedUser(
        m.msg?.contextInfo?.participant || m.sender
      );
      m.quoted.from = m.msg?.contextInfo?.remoteJid || m.from;
      m.quoted.chat = m.quoted.from;
      m.quoted.isGroup = m.quoted.from?.endsWith("@g.us");
      m.quoted.isBot = m.quoted.id?.startsWith("BAE5") && m.quoted.id.length === 16;
      m.quoted.isBaileys = m.quoted.isBot;
      m.quoted.fromMe =
        m.quoted.sender === jidNormalizedUser(Atlas.user && Atlas.user?.id);
      m.quoted.text =
        (typeof m.quoted.msg === "string" ? m.quoted.msg : "") ||
        m.quoted.msg?.text ||
        m.quoted.msg?.caption ||
        m.quoted.msg?.conversation ||
        m.quoted.conversation ||
        m.quoted.msg?.contentText ||
        m.quoted.msg?.selectedDisplayText ||
        m.quoted.msg?.title ||
        "";

      const vM = (m.quoted.fakeObj = M.create({
        key: {
          remoteJid: m.quoted.from,
          fromMe: m.quoted.fromMe,
          id: m.quoted.id,
        },
        message: m.quoted,
        ...(m.quoted.isGroup ? { participant: m.quoted.sender } : {}),
      }));

      m.quoted.delete = () =>
        Atlas.sendMessage(m.quoted.from, { delete: vM.key });

      m.quoted.download = (pathFile?: string) =>
        Atlas.downloadMediaMessage(m.quoted.msg, pathFile);

      m.quoted.copyNForward = (jid: string, forceForward = false, options = {}) =>
        Atlas.copyNForward ? Atlas.copyNForward(jid, vM, forceForward, options) : undefined;
    }

    m.getQuotedObj = m.getQuotedMessage = async () => {
      if (!m.quoted?.id || !store) return false;
      const q = await store.loadMessage(m.from, m.quoted.id, Atlas);
      return q ? serialize(Atlas, q, store) : false;
    };
  }

  m.download = (pathFile?: string) => Atlas.downloadMediaMessage(m.msg, pathFile);

  m.body = m.text =
    m.message?.conversation ||
    m.message?.[m.type]?.text ||
    m.message?.[m.type]?.caption ||
    m.message?.[m.type]?.contentText ||
    m.message?.[m.type]?.selectedDisplayText ||
    m.message?.[m.type]?.title ||
    m.msg?.text ||
    m.msg?.caption ||
    "";

  m.reply = (text: string | Buffer, chatId = m.from, options = {}) =>
    Buffer.isBuffer(text)
      ? Atlas.sendFile(chatId, text, "file", "", m, { ...options })
      : Atlas.sendText(chatId, text, m, { ...options });

  m.copy = () => serialize(Atlas, M.create(M.toObject(m)), store);

  m.copyNForward = (jid = m.from, forceForward = false, options = {}) =>
    Atlas.copyNForward ? Atlas.copyNForward(jid, m, forceForward, options) : undefined;

  return m;
};

export const smsg = serialize;
export default serialize;
