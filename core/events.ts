import { serialize } from "../System/whatsapp.js";
import welcomeLeft from "../System/Welcome.js";
import core from "./core.js";
import { commands } from "../System/ReadCommands.js";
import { store } from "./store.js";
import { handleAntiDelete } from "./antidelete.js";

export interface SocketEventContext {
  Atlas: any;
  generation: number;
  isCurrentSocket: (socket: any, generation: number) => boolean;
  saveCreds: () => Promise<void> | void;
}

/**
 * Binds WhatsApp event listeners for message handling, participant updates, anti-delete, and contact syncing.
 */
export function bindSocketEvents({
  Atlas,
  generation,
  isCurrentSocket,
  saveCreds,
}: SocketEventContext): void {
  Atlas.ev.on("creds.update", saveCreds);

  Atlas.ev.on("group-participants.update", async (m: any) => {
    if (!isCurrentSocket(Atlas, generation)) return;
    welcomeLeft(Atlas, m);
  });

  Atlas.ev.on("messages.upsert", async (chatUpdate: any) => {
    if (!isCurrentSocket(Atlas, generation)) return;
    if (chatUpdate.type !== "notify") return;
    const msg = chatUpdate.messages?.[0];
    if (!msg) return;
    const m = serialize(Atlas, msg);

    if (!m?.message) return;
    if (m.key?.remoteJid === "status@broadcast") return;
    if (m.key?.id?.startsWith("BAE5") && m.key.id.length === 16) return;

    core(Atlas, m, commands, chatUpdate);
  });

  Atlas.ev.on("messages.update", async (updates: any) => {
    if (!isCurrentSocket(Atlas, generation)) return;
    await handleAntiDelete(Atlas, updates, store);
  });

  Atlas.ev.on("contacts.update", (updates: any[]) => {
    if (!isCurrentSocket(Atlas, generation)) return;
    for (const contact of updates) {
      const id = (Atlas as any).decodeJid(contact.id);
      if (store && store.contacts) {
        store.contacts[id] = {
          id,
          name: contact.notify,
        };
      }
    }
  });
}
