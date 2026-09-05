import {
  userData,
  groupData,
  systemData,
  pluginData,
} from "./MongoDB_Schema.js";

// ─── In-Memory Cache ──────────────────────────────────────────────────────────
// TTLs are configurable via env; sensible defaults shown below.
const positiveEnvMs = (name: string, fallback: number): number => {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const USER_CACHE_TTL = positiveEnvMs("USER_CACHE_TTL_MS", 300_000); // 5 min
const GROUP_CACHE_TTL = positiveEnvMs("GROUP_CACHE_TTL_MS", 300_000); // 5 min
const SYSTEM_CACHE_TTL = positiveEnvMs("SYS_CACHE_TTL_MS", 600_000); // 10 min

interface UserCacheEntry {
  ban?: boolean;
  addedMods?: boolean;
  expiresAt: number;
}

interface GroupCacheEntry {
  antilink?: boolean;
  antidelete?: boolean;
  bangroup?: boolean;
  chatBot?: boolean;
  switchWelcome?: boolean;
  nsfw?: boolean;
  expiresAt: number;
}

interface SystemCacheEntry {
  data: {
    seletedCharacter?: string;
    PMchatBot?: boolean;
    botMode?: string;
  } | null;
  expiresAt: number;
}

// user cache  : Map<userId, { ban, addedMods, expiresAt }>
// group cache : Map<groupId, { antilink, bangroup, chatBot, switchWelcome, expiresAt }>
// system cache: single object (one "id: 1" row)
const userCache = new Map<string, UserCacheEntry>();
const groupCache = new Map<string, GroupCacheEntry>();
let systemCache: SystemCacheEntry = { data: null, expiresAt: 0 };

// ── helpers ──────────────────────────────────────────────────────────────────
function _getUser(userId: string): UserCacheEntry | null {
  const e = userCache.get(userId);
  if (e && Date.now() < e.expiresAt) return e;
  if (e) userCache.delete(userId);
  return null;
}
function _setUser(userId: string, fields: Partial<UserCacheEntry>): void {
  const prev = userCache.get(userId) || ({} as Partial<UserCacheEntry>);
  userCache.set(userId, {
    ...prev,
    ...fields,
    expiresAt: Date.now() + USER_CACHE_TTL,
  });
}
function _delUser(userId: string): void {
  userCache.delete(userId);
}

function _getGroup(groupId: string): GroupCacheEntry | null {
  const e = groupCache.get(groupId);
  if (e && Date.now() < e.expiresAt) return e;
  if (e) groupCache.delete(groupId);
  return null;
}
function _setGroup(groupId: string, fields: Partial<GroupCacheEntry>): void {
  const prev = groupCache.get(groupId) || ({} as Partial<GroupCacheEntry>);
  groupCache.set(groupId, {
    ...prev,
    ...fields,
    expiresAt: Date.now() + GROUP_CACHE_TTL,
  });
}
function _delGroup(groupId: string): void {
  groupCache.delete(groupId);
}

function _getSys(): SystemCacheEntry["data"] {
  return systemCache.data && Date.now() < systemCache.expiresAt
    ? systemCache.data
    : null;
}
function _setSys(fields: Partial<NonNullable<SystemCacheEntry["data"]>>): void {
  systemCache.data = { ...(systemCache.data || {}), ...fields };
  systemCache.expiresAt = Date.now() + SYSTEM_CACHE_TTL;
}
function _delSys(): void {
  systemCache.data = null;
  systemCache.expiresAt = 0;
}

const cacheSweepTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [userId, entry] of userCache) {
      if (now >= entry.expiresAt) userCache.delete(userId);
    }
    for (const [groupId, entry] of groupCache) {
      if (now >= entry.expiresAt) groupCache.delete(groupId);
    }
    if (systemCache.data && now >= systemCache.expiresAt) _delSys();
  },
  Math.max(60_000, Math.min(USER_CACHE_TTL, GROUP_CACHE_TTL, 5 * 60_000)),
);
cacheSweepTimer.unref?.();

// ─── User Functions ───────────────────────────────────────────────────────────

// BAN USER
async function banUser(userId: string): Promise<void> {
  const user = await userData.findOne({ id: userId });
  if (!user) {
    await userData.create({ id: userId, ban: true });
    _setUser(userId, { ban: true, addedMods: false });
    return;
  }
  if (user.ban) {
    _setUser(userId, { ban: true, addedMods: user.addedMods });
    return;
  }
  await userData.findOneAndUpdate({ id: userId }, { $set: { ban: true } });
  _setUser(userId, { ban: true, addedMods: user.addedMods });
}

// CHECK BAN STATUS
async function checkBan(userId: string): Promise<boolean> {
  const cached = _getUser(userId);
  if (cached) return cached.ban ?? false;

  const user = await userData.findOne({ id: userId });
  if (!user) {
    _setUser(userId, { ban: false, addedMods: false });
    return false;
  }
  _setUser(userId, { ban: user.ban, addedMods: user.addedMods });
  return user.ban;
}

// UNBAN USER
async function unbanUser(userId: string): Promise<void> {
  const user = await userData.findOne({ id: userId });
  if (!user) {
    await userData.create({ id: userId, ban: false });
    _setUser(userId, { ban: false, addedMods: false });
    return;
  }
  if (!user.ban) {
    _setUser(userId, { ban: false, addedMods: user.addedMods });
    return;
  }
  await userData.findOneAndUpdate({ id: userId }, { $set: { ban: false } });
  _setUser(userId, { ban: false, addedMods: user.addedMods });
}

// ─── Mod Functions ────────────────────────────────────────────────────────────

// ADD MOD
async function addMod(userId: string): Promise<void> {
  if ((global as any).owner?.includes(userId)) return;
  const user = await userData.findOne({ id: userId });
  if (!user) {
    await userData.create({ id: userId, addedMods: true });
    _setUser(userId, { ban: false, addedMods: true });
    return;
  }
  if (user.addedMods) {
    _setUser(userId, { ban: user.ban, addedMods: true });
    return;
  }
  await userData.findOneAndUpdate(
    { id: userId },
    { $set: { addedMods: true } },
  );
  _setUser(userId, { ban: user.ban, addedMods: true });
}

// CHECK MOD STATUS
async function checkMod(userId: string): Promise<boolean> {
  if ((global as any).owner?.includes(userId)) return true;

  const cached = _getUser(userId);
  if (cached) return cached.addedMods ?? false;

  const user = await userData.findOne({ id: userId });
  if (!user) {
    _setUser(userId, { ban: false, addedMods: false });
    return false;
  }
  _setUser(userId, { ban: user.ban, addedMods: user.addedMods });
  return user.addedMods;
}

// DEL MOD
async function delMod(userId: string): Promise<void> {
  if ((global as any).owner?.includes(userId)) return;
  const user = await userData.findOne({ id: userId });
  if (!user) {
    await userData.create({ id: userId, addedMods: false });
    _setUser(userId, { ban: false, addedMods: false });
    return;
  }
  if (!user.addedMods) {
    _setUser(userId, { ban: user.ban, addedMods: false });
    return;
  }
  await userData.findOneAndUpdate(
    { id: userId },
    { $set: { addedMods: false } },
  );
  _setUser(userId, { ban: user.ban, addedMods: false });
}

// ─── System / Character Functions ────────────────────────────────────────────

// SET CHAR ID
async function setChar(charId: string | number): Promise<void> {
  const strId = String(charId);
  const character = await systemData.findOne({ id: "1" });
  if (!character) {
    await systemData.create({ id: "1", seletedCharacter: strId });
  } else {
    await systemData.findOneAndUpdate(
      { id: "1" },
      { $set: { seletedCharacter: strId } },
    );
  }
  _setSys({ seletedCharacter: strId });
}

// GET CHAR ID
async function getChar(): Promise<string> {
  const cached = _getSys();
  if (cached?.seletedCharacter !== undefined) return cached.seletedCharacter;

  const character = await systemData.findOne({ id: "1" });
  if (!character) {
    _setSys({ seletedCharacter: "0" });
    return "0";
  }
  _setSys({
    seletedCharacter: character.seletedCharacter,
    PMchatBot: character.PMchatBot,
    botMode: character.botMode,
  });
  return character.seletedCharacter;
}

// ─── PM Chatbot Functions ─────────────────────────────────────────────────────

// ACTIVATE PM CHATBOT
async function activateChatBot(): Promise<void> {
  const chatbotpm = await systemData.findOne({ id: "1" });
  if (!chatbotpm) {
    await systemData.create({ id: "1", PMchatBot: true });
  } else if (!chatbotpm.PMchatBot) {
    await systemData.findOneAndUpdate(
      { id: "1" },
      { $set: { PMchatBot: true } },
    );
  }
  _setSys({ PMchatBot: true });
}

// CHECK PM CHATBOT STATUS
async function checkPmChatbot(): Promise<boolean> {
  const cached = _getSys();
  if (cached?.PMchatBot !== undefined) return cached.PMchatBot;

  const chatbotpm = await systemData.findOne({ id: "1" });
  if (!chatbotpm) {
    _setSys({ PMchatBot: false });
    return false;
  }
  _setSys({
    PMchatBot: chatbotpm.PMchatBot,
    seletedCharacter: chatbotpm.seletedCharacter,
    botMode: chatbotpm.botMode,
  });
  return chatbotpm.PMchatBot;
}

// DEACTIVATE PM CHATBOT
async function deactivateChatBot(): Promise<void> {
  const chatbotpm = await systemData.findOne({ id: "1" });
  if (!chatbotpm) {
    await systemData.create({ id: "1", PMchatBot: false });
  } else if (chatbotpm.PMchatBot) {
    await systemData.findOneAndUpdate(
      { id: "1" },
      { $set: { PMchatBot: false } },
    );
  }
  _setSys({ PMchatBot: false });
}

// ─── Bot Mode ─────────────────────────────────────────────────────────────────

// SET BOT MODE
async function setBotMode(mode: string): Promise<void> {
  const selectedMode = await systemData.findOne({ id: "1" });
  if (!selectedMode) {
    await systemData.create({ id: "1", botMode: mode });
  } else if (selectedMode.botMode !== mode) {
    await systemData.findOneAndUpdate({ id: "1" }, { $set: { botMode: mode } });
  }
  _setSys({ botMode: mode });
}

// GET BOT MODE
async function getBotMode(): Promise<string> {
  const cached = _getSys();
  if (cached?.botMode !== undefined) return cached.botMode;

  const selectedMode = await systemData.findOne({ id: "1" });
  if (!selectedMode) {
    _setSys({ botMode: "public" });
    return "public";
  }
  _setSys({
    botMode: selectedMode.botMode,
    PMchatBot: selectedMode.PMchatBot,
    seletedCharacter: selectedMode.seletedCharacter,
  });
  return selectedMode.botMode;
}

// ─── Group Functions ──────────────────────────────────────────────────────────

// SET WELCOME MESSAGE
async function setWelcome(groupID: string): Promise<void> {
  const group = await groupData.findOne({ id: groupID });
  if (!group) {
    await groupData.create({ id: groupID, switchWelcome: true });
  } else if (!group.switchWelcome) {
    await groupData.findOneAndUpdate(
      { id: groupID },
      { $set: { switchWelcome: true } },
    );
  }
  _setGroup(groupID, { switchWelcome: true });
}

// CHECK WELCOME MESSAGE STATUS
async function checkWelcome(groupID: string): Promise<boolean> {
  const cached = _getGroup(groupID);
  if (cached?.switchWelcome !== undefined) return cached.switchWelcome;

  const group = await groupData.findOne({ id: groupID });
  if (!group) {
    _setGroup(groupID, { switchWelcome: false });
    return false;
  }
  _setGroup(groupID, {
    switchWelcome: group.switchWelcome,
    antilink: group.antilink,
    chatBot: group.chatBot,
    bangroup: group.bangroup,
  });
  return group.switchWelcome;
}

// DELETE WELCOME MESSAGE
async function delWelcome(groupID: string): Promise<void> {
  const group = await groupData.findOne({ id: groupID });
  if (!group) {
    await groupData.create({ id: groupID, switchWelcome: false });
  } else if (group.switchWelcome) {
    await groupData.findOneAndUpdate(
      { id: groupID },
      { $set: { switchWelcome: false } },
    );
  }
  _setGroup(groupID, { switchWelcome: false });
}

// SET ANTI-LINK
async function setAntilink(groupID: string): Promise<void> {
  const group = await groupData.findOne({ id: groupID });
  if (!group) {
    await groupData.create({ id: groupID, antilink: true });
  } else if (!group.antilink) {
    await groupData.findOneAndUpdate(
      { id: groupID },
      { $set: { antilink: true } },
    );
  }
  _setGroup(groupID, { antilink: true });
}

// CHECK ANTI-LINK STATUS
async function checkAntilink(groupID: string): Promise<boolean> {
  const cached = _getGroup(groupID);
  if (cached?.antilink !== undefined) return cached.antilink;

  const group = await groupData.findOne({ id: groupID });
  if (!group) {
    _setGroup(groupID, { antilink: false });
    return false;
  }
  _setGroup(groupID, {
    antilink: group.antilink,
    switchWelcome: group.switchWelcome,
    chatBot: group.chatBot,
    bangroup: group.bangroup,
  });
  return group.antilink;
}

// DELETE ANTI-LINK
async function delAntilink(groupID: string): Promise<void> {
  const group = await groupData.findOne({ id: groupID });
  if (!group) {
    await groupData.create({ id: groupID, antilink: false });
  } else if (group.antilink) {
    await groupData.findOneAndUpdate(
      { id: groupID },
      { $set: { antilink: false } },
    );
  }
  _setGroup(groupID, { antilink: false });
}

// SET ANTI-DELETE
async function setAntidelete(groupID: string): Promise<void> {
  const group = await groupData.findOne({ id: groupID });
  if (!group) {
    await groupData.create({ id: groupID, antidelete: true });
  } else if (!group.antidelete) {
    await groupData.findOneAndUpdate(
      { id: groupID },
      { $set: { antidelete: true } },
    );
  }
  _setGroup(groupID, { antidelete: true });
}

// CHECK ANTI-DELETE STATUS
async function checkAntidelete(groupID: string): Promise<boolean> {
  const cached = _getGroup(groupID);
  if (cached?.antidelete !== undefined) return cached.antidelete;

  const group = await groupData.findOne({ id: groupID });
  if (!group) {
    _setGroup(groupID, { antidelete: false });
    return false;
  }
  _setGroup(groupID, {
    antidelete: group.antidelete,
    antilink: group.antilink,
    switchWelcome: group.switchWelcome,
    chatBot: group.chatBot,
    bangroup: group.bangroup,
  });
  return group.antidelete;
}

// DELETE ANTI-DELETE
async function delAntidelete(groupID: string): Promise<void> {
  const group = await groupData.findOne({ id: groupID });
  if (!group) {
    await groupData.create({ id: groupID, antidelete: false });
  } else if (group.antidelete) {
    await groupData.findOneAndUpdate(
      { id: groupID },
      { $set: { antidelete: false } },
    );
  }
  _setGroup(groupID, { antidelete: false });
}

// SET GROUP CHATBOT
async function setGroupChatbot(groupID: string): Promise<void> {
  const group = await groupData.findOne({ id: groupID });
  if (!group) {
    await groupData.create({ id: groupID, chatBot: true });
  } else if (!group.chatBot) {
    await groupData.findOneAndUpdate(
      { id: groupID },
      { $set: { chatBot: true } },
    );
  }
  _setGroup(groupID, { chatBot: true });
}

// CHECK GROUP CHATBOT STATUS
async function checkGroupChatbot(groupID: string): Promise<boolean> {
  const cached = _getGroup(groupID);
  if (cached?.chatBot !== undefined) return cached.chatBot;

  const group = await groupData.findOne({ id: groupID });
  if (!group) {
    _setGroup(groupID, { chatBot: false });
    return false;
  }
  _setGroup(groupID, {
    chatBot: group.chatBot,
    antilink: group.antilink,
    switchWelcome: group.switchWelcome,
    bangroup: group.bangroup,
  });
  return group.chatBot;
}

// DELETE GROUP CHATBOT
async function delGroupChatbot(groupID: string): Promise<void> {
  const group = await groupData.findOne({ id: groupID });
  if (!group) {
    await groupData.create({ id: groupID, chatBot: false });
  } else if (group.chatBot) {
    await groupData.findOneAndUpdate(
      { id: groupID },
      { $set: { chatBot: false } },
    );
  }
  _setGroup(groupID, { chatBot: false });
}

// BAN GROUP
async function banGroup(groupID: string): Promise<void> {
  const group = await groupData.findOne({ id: groupID });
  if (!group) {
    await groupData.create({ id: groupID, bangroup: true });
  } else if (!group.bangroup) {
    await groupData.findOneAndUpdate(
      { id: groupID },
      { $set: { bangroup: true } },
    );
  }
  _setGroup(groupID, { bangroup: true });
}

// CHECK BAN GROUP STATUS
async function checkBanGroup(groupID: string): Promise<boolean> {
  const cached = _getGroup(groupID);
  if (cached?.bangroup !== undefined) return cached.bangroup;

  const group = await groupData.findOne({ id: groupID });
  if (!group) {
    _setGroup(groupID, { bangroup: false });
    return false;
  }
  _setGroup(groupID, {
    bangroup: group.bangroup,
    antilink: group.antilink,
    switchWelcome: group.switchWelcome,
    chatBot: group.chatBot,
  });
  return group.bangroup;
}

// UNBAN GROUP
async function unbanGroup(groupID: string): Promise<void> {
  const group = await groupData.findOne({ id: groupID });
  if (!group) {
    await groupData.create({ id: groupID, bangroup: false });
  } else if (group.bangroup) {
    await groupData.findOneAndUpdate(
      { id: groupID },
      { $set: { bangroup: false } },
    );
  }
  _setGroup(groupID, { bangroup: false });
}

// SET NSFW
async function setNSFW(groupID: string): Promise<void> {
  const group = await groupData.findOne({ id: groupID });

  if (!group) {
    await groupData.create({ id: groupID, nsfw: true });
  } else if (!group.nsfw) {
    await groupData.findOneAndUpdate({ id: groupID }, { $set: { nsfw: true } });
  }

  _setGroup(groupID, { nsfw: true });
}

// CHECK NSFW
async function checkNSFW(groupID: string): Promise<boolean> {
  const cached = _getGroup(groupID);
  if (cached?.nsfw !== undefined) return cached.nsfw;

  const group = await groupData.findOne({ id: groupID });

  if (!group) {
    _setGroup(groupID, { nsfw: false });
    return false;
  }

  _setGroup(groupID, { nsfw: group.nsfw });
  return group.nsfw;
}

// DISABLE NSFW
async function delNSFW(groupID: string): Promise<void> {
  const group = await groupData.findOne({ id: groupID });

  if (!group) {
    await groupData.create({ id: groupID, nsfw: false });
  } else if (group.nsfw) {
    await groupData.findOneAndUpdate(
      { id: groupID },
      { $set: { nsfw: false } },
    );
  }

  _setGroup(groupID, { nsfw: false });
}

// ─── Plugin Functions ─────────────────────────────────────────────────────────

// PUSH NEW INSTALLED PLUGIN IN DATABASE
async function pushPlugin(newPlugin: string, url: string): Promise<void> {
  const plugin = new pluginData({ plugin: newPlugin, url: url });
  await plugin.save();
}

// Check if plugin is installed
async function isPluginPresent(pluginName: string): Promise<boolean> {
  const plugin = await pluginData.findOne({ plugin: pluginName });
  return !!plugin;
}

// DELETE A PLUGIN FROM THE DATABASE
async function delPlugin(pluginName: string): Promise<void> {
  const plugin = await pluginData.findOne({ plugin: pluginName });
  if (!plugin) {
    throw new Error("The plugin is not present in the database.");
  }
  await pluginData.deleteOne({ plugin: pluginName });
}

// Get all installed plugin URLs as an array
async function getPluginURLs(): Promise<string[]> {
  const plugins = await pluginData.find({}, "url");
  return plugins.map((plugin) => plugin.url);
}

// Getting all plugins as an array
async function getAllPlugins(): Promise<any[]> {
  return pluginData.find({}, { plugin: 1, url: 1 });
}

// ─── Cache Management ─────────────────────────────────────────────────────────

// Expose cache clear helpers (useful for testing or force-refresh scenarios)
function clearUserCache(userId?: string): void {
  if (userId) _delUser(userId);
  else userCache.clear();
}

function clearGroupCache(groupId?: string): void {
  if (groupId) _delGroup(groupId);
  else groupCache.clear();
}

function clearSystemCache(): void {
  _delSys();
}

// ─── Exports ──────────────────────────────────────────────────────────────────
export {
  banUser, // BAN
  checkBan, // CHECK BAN STATUS
  unbanUser, // UNBAN
  addMod, // ADD MOD
  checkMod, // CHECK MOD STATUS
  delMod, // DEL MOD
  setChar, // SET CHAR ID
  getChar, // GET CHAR ID
  activateChatBot, // ACTIVATE PM CHATBOT
  checkPmChatbot, // CHECK PM CHATBOT STATUS
  deactivateChatBot, // DEACTIVATE PM CHATBOT
  pushPlugin, // PUSH NEW INSTALLED PLUGIN IN DATABASE
  isPluginPresent, // CHECK IF PLUGIN IS INSTALLED
  delPlugin, // DELETE A PLUGIN FROM THE DATABASE
  setWelcome, // SET WELCOME MESSAGE
  checkWelcome, // CHECK WELCOME MESSAGE STATUS
  delWelcome, // DELETE WELCOME MESSAGE
  setAntilink, // SET ANTILINK
  checkAntilink, // CHECK ANTILINK STATUS
  delAntilink, // DELETE ANTILINK
  setGroupChatbot, // SET GROUP CHATBOT
  checkGroupChatbot, // CHECK GROUP CHATBOT STATUS
  delGroupChatbot, // DELETE GROUP CHATBOT
  setBotMode, // SET BOT MODE
  getBotMode, // GET BOT MODE
  banGroup, // BAN GROUP
  checkBanGroup, // CHECK BAN STATUS OF A GROUP
  unbanGroup, // UNBAN GROUP
  setAntidelete, // SET ANTI-DELETE
  checkAntidelete, // CHECK ANTI-DELETE STATUS
  delAntidelete, // DELETE ANTI-DELETE
  setNSFW, // ENABLE NSFW MODE
  checkNSFW, // CHECK NSFW STATUS
  delNSFW, // DISABLE NSFW MODE
  getPluginURLs, // GET ALL INSTALLED PLUGIN URLs
  getAllPlugins, // GET ALL INSTALLED PLUGINS
  clearUserCache, // CLEAR USER CACHE (userId or all)
  clearGroupCache, // CLEAR GROUP CACHE (groupId or all)
  clearSystemCache, // CLEAR SYSTEM CACHE
};
