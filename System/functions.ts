import { proto, getContentType } from "@whiskeysockets/baileys";
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
 * Serialize Message
 * @param {any} conn
 * @param {any} m
 * @param {any} store
 */
export const smsg = (conn: any, m: any, store?: any): any => {
  if (!m) return m;
  const M = proto.WebMessageInfo;
  if (m.key) {
    m.id = m.key.id;
    m.isBaileys = m.id.startsWith("BAE5") && m.id.length === 16;
    m.chat = m.key.remoteJid;
    m.fromMe = m.key.fromMe;
    m.isGroup = m.chat.endsWith("@g.us");
    m.sender = conn.decodeJid(
      (m.fromMe && conn.user?.id) ||
        m.participant ||
        m.key.participant ||
        m.chat ||
        ""
    );
    if (m.isGroup) m.participant = conn.decodeJid(m.key.participant) || "";
  }
  if (m.message) {
    m.mtype = getContentType(m.message);
    const mtype = m.mtype as any;
    m.msg =
      m.mtype === "viewOnceMessage"
        ? (m.message as any)[mtype]?.message?.[getContentType((m.message as any)[mtype]?.message) as any]
        : (m.message as any)[mtype];
    m.body =
      m.message.conversation ||
      m.msg?.caption ||
      m.msg?.text ||
      (m.mtype === "listResponseMessage" &&
        m.msg?.singleSelectReply?.selectedRowId) ||
      (m.mtype === "buttonsResponseMessage" && m.msg?.selectedButtonId) ||
      (m.mtype === "viewOnceMessage" && m.msg?.caption) ||
      m.text;
    const quoted = (m.quoted = m.msg?.contextInfo
      ? m.msg.contextInfo.quotedMessage
      : null);
    m.mentionedJid = m.msg?.contextInfo ? m.msg.contextInfo.mentionedJid : [];
    if (m.quoted) {
      let type: any = getContentType(quoted);
      m.quoted = m.quoted[type];
      if (["productMessage"].includes(type)) {
        type = getContentType(m.quoted);
        m.quoted = m.quoted[type];
      }
      if (typeof m.quoted === "string") {
        m.quoted = {
          text: m.quoted,
        };
      }
      m.quoted.mtype = type;
      m.quoted.id = m.msg.contextInfo.stanzaId;
      m.quoted.chat = m.msg.contextInfo.remoteJid || m.chat;
      m.quoted.isBaileys = m.quoted.id
        ? m.quoted.id.startsWith("BAE5") && m.quoted.id.length === 16
        : false;
      m.quoted.sender = conn.decodeJid(m.msg.contextInfo.participant);
      m.quoted.fromMe = m.quoted.sender === (conn.user && conn.user.id);
      m.quoted.text =
        m.quoted.text ||
        m.quoted.caption ||
        m.quoted.conversation ||
        m.quoted.contentText ||
        m.quoted.selectedDisplayText ||
        m.quoted.title ||
        "";
      m.quoted.mentionedJid = m.msg.contextInfo
        ? m.msg.contextInfo.mentionedJid
        : [];
      m.getQuotedObj = m.getQuotedMessage = async () => {
        if (!m.quoted.id || !store) return false;
        const q = await store.loadMessage(m.chat, m.quoted.id, conn);
        return smsg(conn, q, store);
      };
      const vM = (m.quoted.fakeObj = M.create({
        key: {
          remoteJid: m.quoted.chat,
          fromMe: m.quoted.fromMe,
          id: m.quoted.id,
        },
        message: quoted,
        ...(m.isGroup ? { participant: m.quoted.sender } : {}),
      }));

      m.quoted.delete = () =>
        conn.sendMessage(m.quoted.chat, { delete: vM.key });

      m.quoted.copyNForward = (jid: string, forceForward = false, options = {}) =>
        conn.copyNForward(jid, vM, forceForward, options);

      m.quoted.download = () => conn.downloadMediaMessage(m.quoted);
    }
  }
  m.text =
    m.msg?.text ||
    m.msg?.caption ||
    m.message?.conversation ||
    m.msg?.contentText ||
    m.msg?.selectedDisplayText ||
    m.msg?.title ||
    "";

  m.reply = (text: string | Buffer, chatId = m.chat, options = {}) =>
    Buffer.isBuffer(text)
      ? conn.sendMedia(chatId, text, "file", "", m, { ...options })
      : conn.sendText(chatId, text, m, { ...options });

  m.copy = () => smsg(conn, M.create(M.toObject(m)), store);

  m.copyNForward = (jid = m.chat, forceForward = false, options = {}) =>
    conn.copyNForward(jid, m, forceForward, options);

  return m;
};
