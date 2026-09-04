export interface StoredMessageEntry {
  id: string;
  key: any;
  msg: any;
  pushName?: string;
  sender: string;
  timestamp: number;
  reactions: Map<string, string>;
}

export interface AtlasStore {
  contacts: Record<string, any>;
  messages: Record<string, Record<string, any>>;
  bind: (ev: any) => void;
  loadMessage: (jid: string, id: string) => Promise<any>;
}

// Global mappings used across plugins and event handlers
(global as any).lidToJidMap = new Map<string, string>();
(global as any).recentGroupMessages = new Map<string, StoredMessageEntry[]>();

export const store: AtlasStore = {
  contacts: {},
  messages: {},
  bind(ev: any) {
    let lidLogTimer: NodeJS.Timeout | null = null;

    ev.on("contacts.upsert", (contacts: any[]) => {
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
          (global as any).lidToJidMap.set(lidJid, phoneJid);
          (global as any).lidToJidMap.set(phoneJid, lidJid);
        }
      }

      // Debounce: print one summary line after the batch settles
      if (lidLogTimer) clearTimeout(lidLogTimer);
      lidLogTimer = setTimeout(() => {
        const size = (global as any).lidToJidMap.size;
        if (size > 0) {
          console.log(`[ ATLAS ] LID map ready: ${size / 2} contact(s) mapped`);
        }
      }, 300);
    });

    ev.on("contacts.update", (updates: any[]) => {
      for (const update of updates) {
        if (store.contacts[update.id]) {
          Object.assign(store.contacts[update.id], update);
        } else {
          store.contacts[update.id] = update;
        }

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
          (global as any).lidToJidMap.set(lidJid, phoneJid);
          (global as any).lidToJidMap.set(phoneJid, lidJid);
        }
      }
    });

    ev.on("messages.upsert", ({ messages }: { messages: any[] }) => {
      for (const msg of messages) {
        if (!msg.key?.remoteJid || !msg.key?.id) continue;
        const jid = msg.key.remoteJid;
        if (!store.messages[jid]) store.messages[jid] = {};
        store.messages[jid][msg.key.id] = msg;

        // Track in recentGroupMessages if it's a group
        if (jid.endsWith("@g.us")) {
          // Handle reaction message delivered via messages.upsert
          const reactionMsg = msg.message?.reactionMessage;
          if (reactionMsg) {
            const targetId = reactionMsg.key?.id;
            const reactor = msg.key?.participant || msg.participant || msg.key?.remoteJid;
            const emoji = reactionMsg.text;
            if (targetId && reactor) {
              const list: StoredMessageEntry[] = (global as any).recentGroupMessages.get(jid);
              if (list) {
                const target = list.find((m) => m.id === targetId);
                if (target) {
                  if (!target.reactions) target.reactions = new Map();
                  if (emoji) {
                    target.reactions.set(reactor, emoji);
                  } else {
                    target.reactions.delete(reactor);
                  }
                }
              }
            }
            continue;
          }

          if (msg.message?.protocolMessage || msg.message?.senderKeyDistributionMessage) {
            continue;
          }

          if (!(global as any).recentGroupMessages.has(jid)) {
            (global as any).recentGroupMessages.set(jid, []);
          }
          const list: StoredMessageEntry[] = (global as any).recentGroupMessages.get(jid);
          const existingIdx = list.findIndex((m) => m.id === msg.key.id);
          const entry: StoredMessageEntry = {
            id: msg.key.id,
            key: msg.key,
            msg: msg,
            pushName: msg.pushName,
            sender: msg.key.participant || msg.participant || jid,
            timestamp: Number(msg.messageTimestamp || Date.now() / 1000) * 1000,
            reactions: new Map(),
          };

          if (existingIdx !== -1) {
            entry.reactions = list[existingIdx].reactions || new Map();
            list[existingIdx] = entry;
          } else {
            list.push(entry);
            if (list.length > 100) list.shift();
          }
        }
      }
    });

    ev.on("messages.reaction", (reactions: any[]) => {
      for (const item of reactions) {
        const jid = item.key?.remoteJid;
        const targetId = item.key?.id;
        if (!jid || !targetId || !jid.endsWith("@g.us")) continue;
        const list: StoredMessageEntry[] = (global as any).recentGroupMessages?.get(jid);
        if (!list) continue;
        const target = list.find((m) => m.id === targetId);
        if (!target) continue;
        if (!target.reactions) target.reactions = new Map();

        const reactor = item.reaction?.key?.participant || item.reaction?.key?.remoteJid;
        const emoji = item.reaction?.text;
        if (reactor) {
          if (emoji) {
            target.reactions.set(reactor, emoji);
          } else {
            target.reactions.delete(reactor);
          }
        }
      }
    });
  },
  loadMessage: async (jid: string, id: string) => store.messages[jid]?.[id],
};

(global as any).store = store;
