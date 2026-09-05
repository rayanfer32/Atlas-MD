import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import fs from "fs";
import path from "path";
import os from "os";
import type { WAMessage, AtlasClient, QuotedMessage } from "../types/index.js";

// ============================================================================
// 1. Constants & Type Definitions
// ============================================================================

export const VALID_CATEGORIES = ['app', 'web', 'backend', 'admin'] as const;
export type TicketCategory = (typeof VALID_CATEGORIES)[number];

export const VALID_STATUSES = ['todo', 'in-progress', 'testing', 'done'] as const;
export type TicketStatus = (typeof VALID_STATUSES)[number];

export interface DraftMessage {
  messageId: string;
  senderName: string;
  senderNumber: string;
  type: 'text' | 'image';
  text?: string;
  imagePath?: string;
  timestamp: number;
}

export interface Draft {
  title: string;
  category: string;
  createdBy: string;
  createdByName: string;
  messages: DraftMessage[];
  createdAt: number;
  draftStartedMsgKey?: any;
  ghaddMsgKeys?: any[];
}

export interface StatusOptionMap {
  todo: string;
  'in-progress': string;
  testing: string;
  done: string;
}

export interface GitHubGroupConfig {
  owner: string;
  repo: string;
  projectId: string;
  statusFieldId: string;
  token?: string;
}

export interface ProjectBoardItem {
  id: string;
  status: string;
  type: 'issue' | 'pr' | 'draft';
  number?: number;
  title: string;
  url?: string;
  state?: string;
}

export interface ProjectBoardData {
  title: string;
  url: string;
  columns: { id: string; name: string }[];
  items: ProjectBoardItem[];
}

type GraphQLClient = ReturnType<typeof graphql.defaults>;

interface GitHubClients {
  octokit: Octokit;
  graphqlClient: GraphQLClient;
}

export interface CommandContext {
  Atlas: AtlasClient;
  m: WAMessage;
  groupJid: string;
  groupConfig: GitHubGroupConfig;
  octokit: Octokit;
  graphqlClient: GraphQLClient;
  inputCMD: string;
  text: string;
  args: string[];
  prefix: string;
  doReact: (emoji: string) => Promise<void>;
  quoted: QuotedMessage | null;
  isBotAdmin: boolean;
}

// GraphQL Response Interfaces
interface GraphQLFieldOption {
  id: string;
  name: string;
}

interface GraphQLSingleSelectField {
  id: string;
  name: string;
  options?: GraphQLFieldOption[];
}

interface GraphQLProjectFieldsResponse {
  node?: {
    fields?: {
      nodes?: Array<GraphQLSingleSelectField | { id: string; name: string }>;
    };
  };
}

interface GraphQLAddItemResponse {
  addProjectV2ItemById?: {
    item?: {
      id: string;
    };
  };
}

interface GraphQLFindItemResponse {
  node?: {
    items?: {
      pageInfo?: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
      nodes?: Array<{
        id: string;
        content?: {
          number?: number;
        };
      }>;
    };
  };
}

interface GraphQLBoardItemNode {
  id: string;
  isArchived?: boolean;
  fieldValues?: {
    nodes?: Array<{
      name?: string;
      field?: {
        id?: string;
      };
    }>;
  };
  content?: {
    __typename?: 'Issue' | 'PullRequest' | 'DraftIssue';
    number?: number;
    title?: string;
    state?: string;
    url?: string;
  };
}

interface GraphQLBoardResponse {
  node?: {
    title?: string;
    url?: string;
    fields?: {
      nodes?: Array<{
        id: string;
        name: string;
        options?: GraphQLFieldOption[];
      }>;
    };
    items?: {
      pageInfo?: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
      nodes?: GraphQLBoardItemNode[];
    };
  };
}

// ============================================================================
// 2. In-Memory Draft State Management
// ============================================================================

const draftsByGroup = new Map<string, Draft>();
const statusOptionMapCache = new Map<string, StatusOptionMap>();

export const draftService = {
  startDraft(groupJid: string, title: string, category: string, createdBy: string, createdByName: string): Draft {
    const draft: Draft = {
      title,
      category,
      createdBy,
      createdByName,
      messages: [],
      createdAt: Date.now(),
      ghaddMsgKeys: []
    };
    draftsByGroup.set(groupJid, draft);
    return draft;
  },
  getDraft(groupJid: string): Draft | null {
    return draftsByGroup.get(groupJid) ?? null;
  },
  addMessage(groupJid: string, message: DraftMessage): void {
    const draft = draftsByGroup.get(groupJid);
    if (!draft) {
      throw new Error("No active draft");
    }
    draft.messages.push(message);
  },
  clearDraft(groupJid: string): void {
    draftsByGroup.delete(groupJid);
  },
  hasDraft(groupJid: string): boolean {
    return draftsByGroup.has(groupJid);
  }
};

// ============================================================================
// 3. Message & Media Cleanup Helpers
// ============================================================================

function cleanupTempFile(filePath?: string): void {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch { }
}

function cleanupDraftMedia(draft: Draft): void {
  for (const msg of draft.messages) {
    if (msg.type === 'image' && msg.imagePath) {
      cleanupTempFile(msg.imagePath);
    }
  }
}

async function safeDeleteMessage(Atlas: AtlasClient, jid: string, key?: any): Promise<void> {
  if (!key) return;
  try {
    await Atlas.sendMessage(jid, { delete: key });
  } catch (err) {
    console.error("[GITHUB] Failed to delete message:", err);
  }
}

async function cleanupDraftBotMessages(
  Atlas: AtlasClient,
  jid: string,
  draft: Draft,
  isBotAdmin: boolean
): Promise<void> {
  if (draft.draftStartedMsgKey) {
    await safeDeleteMessage(Atlas, jid, draft.draftStartedMsgKey);
    draft.draftStartedMsgKey = undefined;
  }

  if (isBotAdmin && draft.ghaddMsgKeys && draft.ghaddMsgKeys.length > 0) {
    for (const key of draft.ghaddMsgKeys) {
      if (!key) continue;
      try {
        if (!(global as any).botDeletedMsgIds) {
          (global as any).botDeletedMsgIds = new Set();
        }
        if (key.id) {
          (global as any).botDeletedMsgIds.add(key.id);
          setTimeout(() => (global as any).botDeletedMsgIds?.delete(key.id), 300000);
        }
        await Atlas.sendMessage(jid, { delete: key });
      } catch (err) {
        console.error("[GITHUB] Failed to delete ghadd message:", err);
      }
    }
    draft.ghaddMsgKeys = [];
  }
}

// ============================================================================
// 4. Message Parsing, Unwrapping & Title Inference
// ============================================================================

function unwrapBaileysMessage(rawMessage: any): any {
  let message = rawMessage;
  while (
    message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message?.documentWithCaptionMessage?.message
  ) {
    message =
      message.ephemeralMessage?.message ||
      message.viewOnceMessage?.message ||
      message.viewOnceMessageV2?.message ||
      message.documentWithCaptionMessage?.message;
  }
  return message;
}

async function extractMessageData(Atlas: AtlasClient, candidate: any): Promise<DraftMessage | null> {
  const msg = candidate.msg;
  const messageId = candidate.id || candidate.key?.id || `msg-${Date.now()}`;
  const timestamp = candidate.timestamp || (msg?.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now());

  const senderId =
    candidate.sender ||
    msg?.key?.participant ||
    msg?.participant ||
    (msg?.key?.fromMe ? (Atlas as any).user?.id : 'unknown') ||
    'unknown';
  const senderName =
    candidate.pushName ||
    msg?.pushName ||
    senderId.split('@')[0] ||
    'Unknown';
  const senderNumber = senderId.split('@')[0] || senderId;

  if (!msg || !msg.message) {
    console.warn(`[GITHUB] Cannot extract content for message ${messageId}: message body not cached in memory.`);
    return null;
  }

  try {
    const message = unwrapBaileysMessage(msg.message);

    // 1. Image message (with or without caption)
    if (message?.imageMessage) {
      const imgMsg = message.imageMessage;
      const caption = imgMsg.caption || undefined;
      let imagePath: string | undefined;

      try {
        const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
        const buffer = await downloadMediaMessage(
          { key: msg.key, message: { imageMessage: imgMsg } } as any,
          "buffer",
          {},
          {
            logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as any,
            reuploadRequest: (Atlas as any).updateMediaMessage,
          }
        );

        if (buffer && Buffer.isBuffer(buffer)) {
          const tempDir = os.tmpdir();
          const filename = `qa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
          imagePath = path.join(tempDir, filename);
          fs.writeFileSync(imagePath, buffer);
        }
      } catch (err) {
        console.error("[GITHUB] Failed to download image from message:", err);
      }

      return {
        messageId,
        senderName,
        senderNumber,
        type: 'image',
        text: caption,
        imagePath,
        timestamp
      };
    }

    // 2. Text message (conversation, extendedTextMessage, captions on documents/videos)
    let textContent =
      message.conversation ||
      message.extendedTextMessage?.text ||
      message.documentMessage?.caption ||
      message.videoMessage?.caption ||
      '';

    if (!textContent && (Atlas as any).serializeM) {
      try {
        const s = await (Atlas as any).serializeM(msg);
        textContent = s.text || s.body || '';
      } catch { }
    }

    if (textContent && textContent.trim()) {
      return {
        messageId,
        senderName,
        senderNumber,
        type: 'text',
        text: textContent.trim(),
        timestamp
      };
    }
  } catch (err) {
    console.error("[GITHUB] Error extracting message data:", err);
  }

  return null;
}

async function inferTitle(messages: DraftMessage[]): Promise<string> {
  const textParts = messages
    .map((m, idx) => {
      const content = m.text ? m.text : (m.type === 'image' ? '[Image Attachment]' : '');
      return `Message ${idx + 1} (${m.senderName}): ${content}`;
    })
    .filter(Boolean)
    .join("\n");

  const geminiKey = process.env.GEMINI_API?.split(",")[0]?.trim();
  if (geminiKey && !geminiKey.startsWith("your-gemini-key")) {
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: geminiKey });
      const prompt = `You are a developer assistant. Based on the following WhatsApp chat messages from a user reporting a bug or requesting a feature, generate a single concise, descriptive issue title (5 to 10 words maximum). Do NOT include prefixes like [BUG], [FEATURE], quotes, markdown formatting, or trailing punctuation:\n\n${textParts}`;

      const response = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      });

      const title = response.text?.trim()?.replace(/^["']|["']$/g, '');
      if (title && title.length > 0) {
        return title;
      }
    } catch (err: any) {
      console.error("[GITHUB] Error generating title with Gemini:", err?.message || err);
    }
  }

  // Fallback: use first non-empty text message
  for (const m of messages) {
    if (m.text && m.text.trim()) {
      const firstLine = m.text.trim().split("\n")[0].trim();
      return firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;
    }
  }

  return "Issue reported via WhatsApp";
}

function extractIssueNumber(text: string): number | null {
  const ghMatch = text.match(/GH-(\d+)/i);
  if (ghMatch) return parseInt(ghMatch[1], 10);

  const hashMatch = text.match(/#(\d+)/);
  if (hashMatch) return parseInt(hashMatch[1], 10);

  return null;
}

function matchUser(userA: string, userB: string): boolean {
  if (!userA || !userB) return false;
  if (userA === userB) return true;

  const cleanA = userA.split('@')[0];
  const cleanB = userB.split('@')[0];
  if (cleanA === cleanB) return true;

  const lidMap = (global as any).lidToJidMap as Map<string, string> | undefined;
  if (lidMap) {
    if (lidMap.get(userA) === userB || lidMap.get(userB) === userA) return true;
    const mappedA = lidMap.get(userA);
    if (mappedA && mappedA.split('@')[0] === cleanB) return true;
    const mappedB = lidMap.get(userB);
    if (mappedB && mappedB.split('@')[0] === cleanA) return true;
  }

  return false;
}

// ============================================================================
// 5. Configuration Management
// ============================================================================

function getGroupConfig(groupJid: string): GitHubGroupConfig | null {
  if (process.env.GITHUB_PROJECTS_MAPPING) {
    try {
      const mapping: Record<string, GitHubGroupConfig> = JSON.parse(process.env.GITHUB_PROJECTS_MAPPING);
      if (mapping[groupJid]) {
        return mapping[groupJid];
      }
    } catch (err) {
      console.error("[GITHUB] Error parsing GITHUB_PROJECTS_MAPPING:", err);
    }
    return null;
  }

  // Fallback to legacy single project env vars if mapping is not configured
  if (
    process.env.GITHUB_OWNER &&
    process.env.GITHUB_REPO &&
    process.env.GITHUB_PROJECT_ID &&
    process.env.GITHUB_STATUS_FIELD_ID
  ) {
    return {
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      projectId: process.env.GITHUB_PROJECT_ID,
      statusFieldId: process.env.GITHUB_STATUS_FIELD_ID,
      token: process.env.GITHUB_TOKEN,
    };
  }

  return null;
}

function checkConfig(): void {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error("Missing required GitHub environment variable: GITHUB_TOKEN");
  }

  if (process.env.GITHUB_PROJECTS_MAPPING) {
    try {
      JSON.parse(process.env.GITHUB_PROJECTS_MAPPING);
    } catch (err: any) {
      throw new Error(`Invalid JSON in GITHUB_PROJECTS_MAPPING: ${err.message}`);
    }
    return;
  }

  const required = [
    'GITHUB_OWNER',
    'GITHUB_REPO',
    'GITHUB_PROJECT_ID',
    'GITHUB_STATUS_FIELD_ID'
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required GitHub environment variable(s): ${missing.join(', ')} (or configure GITHUB_PROJECTS_MAPPING)`);
  }
}

function createGitHubClients(groupConfig: GitHubGroupConfig): GitHubClients {
  const token = groupConfig.token || process.env.GITHUB_TOKEN;
  const octokit = new Octokit({ auth: token });
  const graphqlClient = graphql.defaults({
    headers: {
      authorization: `token ${token}`,
    },
  });
  return { octokit, graphqlClient };
}

// ============================================================================
// 6. Formatting & Markdown Utilities
// ============================================================================

function formatTimestamp(ts: number | string): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function formatMessage(msg: DraftMessage, index: number): string {
  const lines: string[] = [];
  lines.push(`### Message ${index + 1}`);
  lines.push('');
  lines.push(
    `**From:** ${msg.senderName} (\`${msg.senderNumber}\`) — ${formatTimestamp(msg.timestamp)}`
  );
  lines.push('');

  if (msg.type === 'text' && msg.text) {
    lines.push(msg.text);
  } else if (msg.type === 'image') {
    if (msg.imagePath) {
      lines.push(`![attachment](${msg.imagePath})`);
    } else {
      lines.push('_[Image attachment — upload failed]_');
    }
    if (msg.text) {
      lines.push('');
      lines.push(msg.text);
    }
  }

  return lines.join('\n');
}

function buildIssueBody(draft: Draft): string {
  const sections: string[] = [];

  sections.push('## Summary');
  sections.push('');
  sections.push(draft.title);
  sections.push('');
  sections.push('---');
  sections.push('');
  sections.push('## Reported By');
  sections.push('');
  sections.push(`${draft.createdByName}`);
  sections.push('');
  sections.push('---');

  if (draft.messages.length > 0) {
    sections.push('');
    sections.push('## Messages');
    sections.push('');

    for (let i = 0; i < draft.messages.length; i++) {
      sections.push(formatMessage(draft.messages[i], i));
      sections.push('');
    }

    sections.push('---');
  }

  const imageMessages = draft.messages.filter(
    (m: DraftMessage) => m.type === 'image' && m.imagePath
  );
  if (imageMessages.length > 0) {
    sections.push('');
    sections.push('## Attachments');
    sections.push('');
    for (const img of imageMessages) {
      const filename = img.imagePath?.split('/').pop() ?? 'attachment';
      sections.push(`* ${filename}`);
    }
    sections.push('');
    sections.push('---');
  }

  sections.push('');
  sections.push('## Source');
  sections.push('');
  sections.push('WhatsApp QA Group');
  sections.push('');

  return sections.join('\n');
}

function renderProgressBar(percentage: number, length: number = 10): string {
  const filled = Math.min(length, Math.max(0, Math.round((percentage / 100) * length)));
  const empty = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function getColumnEmoji(columnName: string): string {
  const lower = columnName.toLowerCase();
  if (lower.includes('backlog') || lower.includes('todo') || lower.includes('to do')) return '⚪';
  if (lower.includes('progress') || lower.includes('doing') || lower.includes('wip')) return '🟡';
  if (lower.includes('review') || lower.includes('qa') || lower.includes('testing')) return '🟣';
  if (lower.includes('done') || lower.includes('completed') || lower.includes('closed')) return '🟢';
  if (lower.includes('v2') || lower.includes('future') || lower.includes('roadmap') || lower.includes('icebox')) return '🚀';
  return '🔹';
}

function findMatchingColumn(
  columns: { id: string; name: string }[],
  query: string
): { id: string; name: string } | null {
  const clean = (s: string) => s.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  const q = clean(query);
  if (!q) return null;

  const exact = columns.find(c => clean(c.name) === q);
  if (exact) return exact;

  const sub = columns.find(c => clean(c.name).includes(q) || q.includes(clean(c.name)));
  if (sub) return sub;

  if (q.includes('rev') || q.includes('qa') || q.includes('test')) {
    const rev = columns.find(c => /review|qa|test/i.test(c.name));
    if (rev) return rev;
  }
  if (q.includes('prog') || q.includes('do') || q.includes('wip')) {
    const prog = columns.find(c => /progress|doing|wip/i.test(c.name));
    if (prog) return prog;
  }
  if (q.includes('todo') || q.includes('backlog')) {
    const todo = columns.find(c => /todo|to do|backlog/i.test(c.name));
    if (todo) return todo;
  }
  if (q.includes('done') || q.includes('close') || q.includes('finish') || q.includes('comp')) {
    const done = columns.find(c => /done|closed|complete/i.test(c.name));
    if (done) return done;
  }

  return null;
}

function formatBoardItemLine(item: ProjectBoardItem, maxLen: number = 80): string {
  let title = item.title;
  if (title.length > maxLen) {
    title = title.slice(0, maxLen - 3) + '...';
  }
  if (item.type === 'issue') {
    return `• #${item.number} ${title}`;
  } else if (item.type === 'pr') {
    return `• 🔀 #${item.number} ${title}`;
  } else {
    return `• 📝 ${title}`;
  }
}

function formatColumnItemLine(item: ProjectBoardItem, index: number): string {
  if (item.type === 'issue') {
    return `${index + 1}. *#${item.number}* ${item.title}`;
  } else if (item.type === 'pr') {
    return `${index + 1}. 🔀 *#${item.number}* ${item.title}`;
  } else {
    return `${index + 1}. 📝 ${item.title}`;
  }
}

// ============================================================================
// 7. GitHub API Operations
// ============================================================================

async function fetchStatusOptions(
  graphqlClient: GraphQLClient,
  projectId: string,
  statusFieldId: string
): Promise<StatusOptionMap> {
  if (statusOptionMapCache.has(projectId)) {
    return statusOptionMapCache.get(projectId)!;
  }

  console.log(`[GITHUB] Fetching GitHub Project status options for project ${projectId}...`);

  const query = `
    query GetProjectFields($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 20) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }
  `;

  const result: GraphQLProjectFieldsResponse = await graphqlClient(query, {
    projectId,
  });

  const fields = result.node?.fields?.nodes ?? [];
  const statusField = fields.find(
    (f: any) => f?.id === statusFieldId
  ) as GraphQLSingleSelectField | undefined;

  if (!statusField) {
    throw new Error(
      `Status field with ID "${statusFieldId}" not found in project fields.`
    );
  }

  const options: Record<string, string> = {};
  for (const opt of statusField.options ?? []) {
    options[opt.name.toLowerCase().replace(/\s+/g, '-')] = opt.id;
  }

  const resolveStatusId = (opts: Record<string, string>, candidates: string[]): string => {
    for (const candidate of candidates) {
      if (opts[candidate]) return opts[candidate];
    }
    const first = Object.values(opts)[0];
    if (!first) throw new Error('No status options found in GitHub Project');
    return first;
  };

  const map: StatusOptionMap = {
    todo: resolveStatusId(options, ['todo', 'to do', 'backlog']),
    'in-progress': resolveStatusId(options, ['in-progress', 'in progress', 'doing']),
    testing: resolveStatusId(options, ['testing', 'in testing', 'qa', 'review']),
    done: resolveStatusId(options, ['done', 'complete', 'completed', 'closed']),
  };

  statusOptionMapCache.set(projectId, map);
  console.log(`[GITHUB] Status options loaded for ${projectId}:`, map);
  return map;
}

async function uploadImageToRepo(
  octokit: Octokit,
  imagePath: string,
  owner: string,
  repo: string
): Promise<string> {
  const filename = path.basename(imagePath);
  const content = fs.readFileSync(imagePath);
  const base64Content = content.toString("base64");
  const repoPath = `qa-attachments/${Date.now()}-${filename}`;

  console.log(`[GITHUB] Uploading image to ${owner}/${repo}: ${repoPath}`);

  const res = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: repoPath,
    message: `Add QA attachment: ${filename}`,
    content: base64Content,
  });

  return (res.data.content as any)?.download_url || `https://github.com/${owner}/${repo}/raw/master/${repoPath}`;
}

async function createIssue(
  octokit: Octokit,
  draft: Draft,
  owner: string,
  repo: string
): Promise<{ number: number; url: string; nodeId: string }> {
  const messagesWithUrls = [...draft.messages];
  for (const msg of messagesWithUrls) {
    if (msg.type === 'image' && msg.imagePath) {
      try {
        const url = await uploadImageToRepo(octokit, msg.imagePath, owner, repo);
        cleanupTempFile(msg.imagePath);
        msg.imagePath = url;
      } catch (err: any) {
        console.error("Failed to upload image, skipping:", err);
        msg.imagePath = undefined;
      }
    }
  }

  const body = buildIssueBody({ ...draft, messages: messagesWithUrls });
  const labels = [draft.category];

  console.log(`[GITHUB] Creating issue in ${owner}/${repo}: [${draft.category}] ${draft.title}`);

  const response = await octokit.issues.create({
    owner,
    repo,
    title: `[${draft.category.toUpperCase()}] ${draft.title}`,
    body,
    labels,
  });

  return {
    number: response.data.number,
    url: response.data.html_url,
    nodeId: response.data.node_id,
  };
}

async function addIssueToProject(
  graphqlClient: GraphQLClient,
  projectId: string,
  issueNodeId: string
): Promise<{ itemId: string }> {
  const mutation = `
    mutation AddItemToProject($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: {
        projectId: $projectId
        contentId: $contentId
      }) {
        item {
          id
        }
      }
    }
  `;

  const result: GraphQLAddItemResponse = await graphqlClient(mutation, {
    projectId,
    contentId: issueNodeId,
  });

  const itemId = result.addProjectV2ItemById?.item?.id;
  if (!itemId) throw new Error('Failed to add item to project');

  return { itemId };
}

async function setProjectItemStatus(
  graphqlClient: GraphQLClient,
  projectId: string,
  statusFieldId: string,
  itemId: string,
  status: TicketStatus
): Promise<void> {
  const statusOptions = await fetchStatusOptions(graphqlClient, projectId, statusFieldId);
  const optionId = statusOptions[status];

  if (!optionId) {
    throw new Error(`Unknown status: "${status}"`);
  }

  const mutation = `
    mutation UpdateProjectItemStatus(
      $projectId: ID!
      $itemId: ID!
      $fieldId: ID!
      $optionId: String!
    ) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item {
          id
        }
      }
    }
  `;

  await graphqlClient(mutation, {
    projectId,
    itemId,
    fieldId: statusFieldId,
    optionId,
  });
}

async function findProjectItemByIssueNumber(
  graphqlClient: GraphQLClient,
  projectId: string,
  issueNumber: number
): Promise<string | null> {
  const query = `
    query FindProjectItem($projectId: ID!, $after: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              content {
                ... on Issue {
                  number
                }
              }
            }
          }
        }
      }
    }
  `;

  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const result: GraphQLFindItemResponse = await graphqlClient(query, {
      projectId,
      after,
    });

    const items = result.node?.items?.nodes ?? [];
    for (const item of items) {
      if (item?.content?.number === issueNumber) {
        return item.id;
      }
    }

    hasNextPage = result.node?.items?.pageInfo?.hasNextPage ?? false;
    after = result.node?.items?.pageInfo?.endCursor ?? null;
  }

  return null;
}

async function fetchProjectBoard(
  graphqlClient: GraphQLClient,
  projectId: string,
  statusFieldId: string
): Promise<ProjectBoardData> {
  const query = `
    query GetProjectBoard($projectId: ID!, $after: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          title
          url
          fields(first: 30) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options {
                  id
                  name
                }
              }
            }
          }
          items(first: 100, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              isArchived
              fieldValues(first: 15) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field {
                      ... on ProjectV2SingleSelectField {
                        id
                      }
                    }
                  }
                }
              }
              content {
                __typename
                ... on Issue {
                  number
                  title
                  state
                  url
                }
                ... on PullRequest {
                  number
                  title
                  state
                  url
                }
                ... on DraftIssue {
                  title
                }
              }
            }
          }
        }
      }
    }
  `;

  let after: string | null = null;
  let hasNextPage = true;
  let title = "GitHub Project";
  let url = "";
  let columns: { id: string; name: string }[] = [];
  const items: ProjectBoardItem[] = [];

  let pageCount = 0;
  while (hasNextPage && pageCount < 10) {
    pageCount++;
    const res: GraphQLBoardResponse = await graphqlClient(query, { projectId, after });
    const projectNode = res.node;
    if (!projectNode) {
      throw new Error(`GitHub Project with ID "${projectId}" not found.`);
    }

    if (!title || title === "GitHub Project") {
      title = projectNode.title || "GitHub Project";
      url = projectNode.url || "";
    }

    if (columns.length === 0) {
      const fields: any[] = projectNode.fields?.nodes ?? [];
      let statusField = fields.find((f: any) => f?.id === statusFieldId);
      if (!statusField) {
        statusField = fields.find((f: any) => /status/i.test(f?.name) && f?.options);
      }
      if (statusField && statusField.options) {
        columns = statusField.options.map((opt: any) => ({
          id: opt.id,
          name: opt.name,
        }));
      }
    }

    const itemNodes = projectNode.items?.nodes ?? [];
    for (const node of itemNodes) {
      if (node.isArchived) continue;

      const fvNodes = node.fieldValues?.nodes ?? [];
      const statusVal = fvNodes.find((fv: any) => fv?.field?.id === statusFieldId);
      const statusName = statusVal?.name || "No Status";

      let type: 'issue' | 'pr' | 'draft' = 'draft';
      let number: number | undefined;
      let itemTitle = 'Untitled';
      let itemUrl: string | undefined;
      let state: string | undefined;

      if (node.content) {
        if (node.content.__typename === 'Issue') {
          type = 'issue';
          number = node.content.number;
          itemTitle = node.content.title || 'Untitled';
          itemUrl = node.content.url;
          state = node.content.state;
        } else if (node.content.__typename === 'PullRequest') {
          type = 'pr';
          number = node.content.number;
          itemTitle = node.content.title || 'Untitled';
          itemUrl = node.content.url;
          state = node.content.state;
        } else if (node.content.__typename === 'DraftIssue') {
          type = 'draft';
          itemTitle = node.content.title || 'Untitled';
        }
      }

      items.push({
        id: node.id,
        status: statusName,
        type,
        number,
        title: itemTitle.replace(/\r?\n|\r/g, ' ').trim(),
        url: itemUrl,
        state,
      });
    }

    hasNextPage = projectNode.items?.pageInfo?.hasNextPage ?? false;
    after = projectNode.items?.pageInfo?.endCursor ?? null;
  }

  return { title, url, columns, items };
}

// ============================================================================
// 8. Individual Command Handlers
// ============================================================================

async function handleGhc(ctx: CommandContext): Promise<void> {
  const { Atlas, m, groupJid, groupConfig, octokit, graphqlClient, args, prefix, doReact } = ctx;

  const category = args[0] ? args[0].toLowerCase().trim() : "app";
  if (!VALID_CATEGORIES.includes(category as TicketCategory)) {
    await doReact("❌");
    await m.reply(`❗ Invalid Category. Must be one of: ${VALID_CATEGORIES.join(', ')}\n\n*Usage:* ${prefix}ghc [category]\n*Example:* ${prefix}ghc app`);
    return;
  }

  const senderId = m.sender || '';
  const senderName = m.pushName || senderId.split('@')[0] || 'Unknown';

  const pendingMap: Map<string, Map<string, any>> = (global as any).pendingTicketMessages;
  const groupPending = pendingMap?.get(groupJid);
  const matchingItems: any[] = groupPending ? Array.from(groupPending.values()) : [];

  if (matchingItems.length === 0) {
    await doReact("❌");
    await m.reply(
      `❗ No messages with 🙏 reaction were found in this group.\n\n` +
      `*Instructions:*\n` +
      `1. React to the messages you want to include using the 🙏 emoji.\n` +
      `2. Send \`${prefix}ghc [category]\` to create the ticket.`
    );
    return;
  }

  // Sort messages in chronological order
  matchingItems.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  await doReact("⏳");
  const statusMsg = await m.reply(`⏳ Found ${matchingItems.length} message(s) with 🙏 reaction. Preparing ticket...`);

  const draftMessages: DraftMessage[] = [];
  let missingBodyCount = 0;

  for (const item of matchingItems) {
    if (!item.msg && (global as any).store?.loadMessage) {
      item.msg = await (global as any).store.loadMessage(groupJid, item.id);
    }
    if (!item.msg || !item.msg.message) {
      missingBodyCount++;
    }
    const data = await extractMessageData(Atlas, item);
    if (data) {
      draftMessages.push(data);
    }
  }

  if (draftMessages.length === 0) {
    await safeDeleteMessage(Atlas, m.from, statusMsg?.key);
    await doReact("❌");
    if (missingBodyCount > 0) {
      await m.reply(
        `❗ Could not extract content from the reacted message(s).\n\n` +
        `*Reason:* ${missingBodyCount} message(s) were sent before the bot was started and are not stored in memory.\n\n` +
        `*Tip:* To include older messages sent before the bot started, use \`${prefix}ghcreate <category>: <title>\` and reply to the message with \`${prefix}ghadd\`.`
      );
      return;
    }
    await m.reply("❗ Could not extract valid text or image content from the reacted messages.");
    return;
  }

  const title = await inferTitle(draftMessages);

  const draft: Draft = {
    title,
    category,
    createdBy: senderId,
    createdByName: senderName,
    messages: draftMessages,
    createdAt: Date.now()
  };

  try {
    const issue = await createIssue(octokit, draft, groupConfig.owner, groupConfig.repo);
    const projectItem = await addIssueToProject(graphqlClient, groupConfig.projectId, issue.nodeId);
    await setProjectItemStatus(graphqlClient, groupConfig.projectId, groupConfig.statusFieldId, projectItem.itemId, 'todo');

    cleanupDraftMedia(draft);

    // Change reaction on the messages to 🛟
    for (const item of matchingItems) {
      try {
        await Atlas.sendMessage(m.from, {
          react: {
            text: "🛟",
            key: item.key
          }
        });
      } catch (err) {
        console.error("[GITHUB] Failed to change reaction to 🛟:", err);
      }
    }

    // Clear the pending ticket messages for this group
    groupPending?.clear();

    await safeDeleteMessage(Atlas, m.from, statusMsg?.key);

    await doReact("✅");
    await m.reply(
      `🎫 *Ticket Created*\n\n` +
      `*GH-${issue.number}*\n` +
      `${issue.url}\n\n` +
      `*Title:* ${title}\n` +
      `*Category:* \`${category}\`\n` +
      `*Status:* Todo\n\n` +
      `_Changed reaction on ${matchingItems.length} message(s) to 🛟_`
    );
  } catch (err: any) {
    console.error("Failed to create GitHub issue via /ghc:", err);
    await safeDeleteMessage(Atlas, m.from, statusMsg?.key);
    await doReact("❌");
    await m.reply(`❌ Failed to create ticket. Error: ${err.message}`);
  }
}

async function handleGhCreate(ctx: CommandContext): Promise<void> {
  const { Atlas, m, groupJid, text, prefix, doReact, isBotAdmin } = ctx;

  if (!text) {
    await doReact("❔");
    await m.reply(`❗ Invalid Format.\n\n*Usage:* ${prefix}ghcreate <category>: <title>\n*Example:* ${prefix}ghcreate app: Login button does not work\n\n*Categories:* ${VALID_CATEGORIES.join(', ')}`);
    return;
  }

  const match = text.match(/^(\w+):\s+([\s\S]+)$/);
  if (!match) {
    await doReact("❔");
    await m.reply(`❗ Invalid Format.\n\n*Usage:* ${prefix}ghcreate <category>: <title>\n*Example:* ${prefix}ghcreate app: Login button does not work`);
    return;
  }

  const category = match[1].toLowerCase();
  const title = match[2].trim();

  if (!VALID_CATEGORIES.includes(category as TicketCategory)) {
    await doReact("❌");
    await m.reply(`❗ Invalid Category. Must be one of: ${VALID_CATEGORIES.join(', ')}`);
    return;
  }

  const senderId = m.sender || 'unknown';
  const senderName = m.pushName || senderId.split('@')[0] || 'Unknown';

  const previousDraft = draftService.getDraft(groupJid);
  if (previousDraft) {
    await cleanupDraftBotMessages(Atlas, m.from, previousDraft, isBotAdmin);
  }

  const hadPrevious = draftService.hasDraft(groupJid);
  const draft = draftService.startDraft(groupJid, title, category, senderId, senderName);

  const warning = hadPrevious ? '\n\n_Previous draft was cancelled._' : '';

  await doReact("🧩");
  const startMsg = await m.reply(
    `🧩 *Draft Started*${warning}\n\n` +
    `*Category:* \`${category}\`\n` +
    `*Title:* ${title}\n\n` +
    `Reply to related messages using:\n\`${prefix}ghadd\`\n\n` +
    `Finish using:\n\`${prefix}ghdone\`\n\n` +
    `_Starting a new draft cancels the previous one._`
  );
  if (startMsg && startMsg.key) {
    draft.draftStartedMsgKey = startMsg.key;
  }
}

async function handleGhAdd(ctx: CommandContext): Promise<void> {
  const { m, groupJid, prefix, doReact } = ctx;

  const draft = draftService.getDraft(groupJid);
  if (!draft) {
    await doReact("❌");
    await m.reply(`❗ No active draft. Start one with:\n\`${prefix}ghcreate <category>: <title>\``);
    return;
  }

  if (!m.quoted) {
    await doReact("❌");
    await m.reply(`❗ \`${prefix}ghadd\` must be used as a *reply* to a message you want to attach.`);
    return;
  }

  const senderId = m.quoted?.sender || 'unknown';
  const senderName = m.quoted?.sender?.split('@')[0] || 'Unknown';
  const senderNumber = senderId.split('@')[0] || senderId;
  const messageId = m.quoted?.id || `msg-${Date.now()}`;
  const timestamp = Date.now();
  const mtype = m.quoted?.type;

  if (mtype === "conversation" || mtype === "extendedTextMessage") {
    const collected: DraftMessage = {
      messageId,
      senderName,
      senderNumber,
      type: 'text',
      text: m.quoted.text || '',
      timestamp
    };
    draftService.addMessage(groupJid, collected);
    await doReact("✅");
    if (!draft.ghaddMsgKeys) draft.ghaddMsgKeys = [];
    draft.ghaddMsgKeys.push(m.key);
  } else if (mtype === "imageMessage") {
    const caption = m.quoted.caption || undefined;
    await doReact("⏳");

    try {
      if (!m.quoted.download) {
        throw new Error("No download method available on quoted message");
      }
      const buffer = await m.quoted.download();
      const tempDir = os.tmpdir();
      const filename = `qa-${Date.now()}.jpg`;
      const imagePath = path.join(tempDir, filename);
      fs.writeFileSync(imagePath, buffer);

      const collected: DraftMessage = {
        messageId,
        senderName,
        senderNumber,
        type: 'image',
        text: caption,
        imagePath,
        timestamp
      };
      draftService.addMessage(groupJid, collected);
      await doReact("🖼️");
      if (!draft.ghaddMsgKeys) draft.ghaddMsgKeys = [];
      draft.ghaddMsgKeys.push(m.key);
    } catch (err: any) {
      console.error("Failed to download image:", err);
      await doReact("❌");
      await m.reply("❗ Failed to download the image. Please try again.");
    }
  } else {
    await doReact("⚠️");
    await m.reply("⚠️ Unsupported message type. Only text and images can be added.");
  }
}

async function handleGhDone(ctx: CommandContext): Promise<void> {
  const { Atlas, m, groupJid, groupConfig, octokit, graphqlClient, prefix, doReact, isBotAdmin } = ctx;

  const draft = draftService.getDraft(groupJid);
  if (!draft) {
    await doReact("❌");
    await m.reply(`❗ No active draft. Start one with:\n\`${prefix}ghcreate <category>: <title>\``);
    return;
  }

  await doReact("⏳");
  const creatingMsg = await m.reply("⏳ Creating GitHub issue...");

  try {
    const issue = await createIssue(octokit, draft, groupConfig.owner, groupConfig.repo);
    const projectItem = await addIssueToProject(graphqlClient, groupConfig.projectId, issue.nodeId);
    await setProjectItemStatus(graphqlClient, groupConfig.projectId, groupConfig.statusFieldId, projectItem.itemId, 'todo');

    cleanupDraftMedia(draft);
    await cleanupDraftBotMessages(Atlas, m.from, draft, isBotAdmin);
    await safeDeleteMessage(Atlas, m.from, creatingMsg?.key);

    draftService.clearDraft(groupJid);

    await doReact("✅");
    await m.reply(
      `🎫 *Ticket Created*\n\n` +
      `*GH-${issue.number}*\n` +
      `${issue.url}\n\n` +
      `*Status:* Todo`
    );
  } catch (err: any) {
    console.error("Failed to create GitHub issue:", err);
    await safeDeleteMessage(Atlas, m.from, creatingMsg?.key);
    await doReact("❌");
    await m.reply(`❌ Failed to create ticket. Error: ${err.message}`);
  }
}

async function handleGhCancel(ctx: CommandContext): Promise<void> {
  const { Atlas, m, groupJid, doReact, isBotAdmin } = ctx;

  const draft = draftService.getDraft(groupJid);
  const groupPending = (global as any).pendingTicketMessages?.get(groupJid);
  const hasPending = groupPending && groupPending.size > 0;

  if (!draft && !hasPending) {
    await doReact("❌");
    await m.reply("❗ No active draft or pending reacted messages to cancel.");
    return;
  }

  if (draft) {
    cleanupDraftMedia(draft);
    await cleanupDraftBotMessages(Atlas, m.from, draft, isBotAdmin);
    draftService.clearDraft(groupJid);
  }

  if (hasPending) {
    groupPending.clear();
  }

  await doReact("❌");
  await m.reply("❌ *Draft and pending reacted messages cancelled.*");
}

async function handleGhMove(ctx: CommandContext): Promise<void> {
  const { m, groupConfig, graphqlClient, text, prefix, doReact } = ctx;

  if (!m.quoted) {
    await doReact("❌");
    await m.reply(`❗ \`${prefix}ghmove\` must be used as a *reply* to a bot ticket message.\n\n*Example:* Reply to the 🎫 ticket message with \`${prefix}ghmove testing\``);
    return;
  }

  const quotedText = m.quoted.text || '';
  const issueNumber = extractIssueNumber(quotedText);

  if (!issueNumber) {
    await doReact("❌");
    await m.reply(`❗ Could not find a GitHub issue number in the replied message.\n\nMake sure you are replying to the bot's ticket message (e.g. "GH-142").`);
    return;
  }

  const status = text.toLowerCase().trim() as TicketStatus;
  if (!status || !VALID_STATUSES.includes(status)) {
    await doReact("❌");
    await m.reply(`❗ Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
    return;
  }

  await doReact("⏳");

  try {
    const itemId = await findProjectItemByIssueNumber(graphqlClient, groupConfig.projectId, issueNumber);

    if (!itemId) {
      await doReact("❌");
      await m.reply(`❗ GH-${issueNumber} was not found in the GitHub Project board.`);
      return;
    }

    await setProjectItemStatus(graphqlClient, groupConfig.projectId, groupConfig.statusFieldId, itemId, status);

    const statusNames: Record<TicketStatus, string> = {
      todo: 'Todo',
      'in-progress': 'In Progress',
      testing: 'Testing',
      done: 'Done'
    };

    await doReact("✅");
    await m.reply(`✅ *GH-${issueNumber}* moved to *${statusNames[status]}*`);
  } catch (err: any) {
    console.error("Failed to move ticket:", err);
    await doReact("❌");
    await m.reply(`❌ Failed to update status. Error: ${err.message}`);
  }
}

async function handleGhBoard(ctx: CommandContext): Promise<void> {
  const { m, groupConfig, graphqlClient, text, prefix, doReact } = ctx;

  await doReact("⏳");

  try {
    const boardData = await fetchProjectBoard(graphqlClient, groupConfig.projectId, groupConfig.statusFieldId);

    const itemsByStatus = new Map<string, ProjectBoardItem[]>();
    for (const col of boardData.columns) {
      itemsByStatus.set(col.name, []);
    }
    const noStatusItems: ProjectBoardItem[] = [];

    for (const item of boardData.items) {
      if (itemsByStatus.has(item.status)) {
        itemsByStatus.get(item.status)!.push(item);
      } else {
        noStatusItems.push(item);
      }
    }

    const filterArg = text.trim();

    // 1. Single Column Inspection (/ghboard [column])
    if (filterArg) {
      const targetCol = findMatchingColumn(boardData.columns, filterArg);
      if (!targetCol) {
        const availableCols = boardData.columns.map(c => `\`${c.name}\``).join(', ');
        await doReact("❌");
        await m.reply(
          `❗ Column "*${filterArg}*" not found on the board.\n\n` +
          `*Available columns:* ${availableCols}\n\n` +
          `*Usage:* \`${prefix}ghboard\` or \`${prefix}ghboard [column]\``
        );
        return;
      }

      const colItems = itemsByStatus.get(targetCol.name) || [];
      const emoji = getColumnEmoji(targetCol.name);

      let itemsBody = '';
      if (colItems.length === 0) {
        itemsBody = `_No items in this column._`;
      } else {
        const displayItems = colItems.slice(0, 30);
        const lines = displayItems.map((it, idx) => formatColumnItemLine(it, idx));
        if (colItems.length > 30) {
          lines.push(`\n_...and ${colItems.length - 30} more items on GitHub._`);
        }
        itemsBody = lines.join('\n');
      }

      const message = [
        `${emoji} *${targetCol.name}* (${colItems.length} items)`,
        `📋 *${boardData.title}*`,
        boardData.url ? `🔗 ${boardData.url}` : '',
        '',
        `━━━━━━━━━━━━━━━━━━━━━`,
        itemsBody,
        '',
        `💡 _Use \`${prefix}ghboard\` to view the entire board overview._`
      ].filter(Boolean).join('\n');

      await doReact("📋");
      await m.reply(message);
      return;
    }

    // 2. Full Board Overview & Sneak Peek (/ghboard)
    const doneCol = boardData.columns.find(c => /done|closed|complete/i.test(c.name));
    const doneCount = doneCol ? (itemsByStatus.get(doneCol.name)?.length || 0) : 0;
    const totalCount = boardData.items.length;
    const donePercent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
    const progressBar = renderProgressBar(donePercent, 10);

    const statsLines = boardData.columns.map(col => {
      const count = itemsByStatus.get(col.name)?.length || 0;
      const emoji = getColumnEmoji(col.name);
      return `• ${emoji} *${col.name}:* ${count}`;
    });

    if (noStatusItems.length > 0) {
      statsLines.push(`• ❓ *No Status:* ${noStatusItems.length}`);
    }

    const previewSections: string[] = [];
    for (const col of boardData.columns) {
      const colItems = itemsByStatus.get(col.name) || [];
      const emoji = getColumnEmoji(col.name);
      const header = `${emoji} *${col.name}* (${colItems.length})`;

      if (colItems.length === 0) {
        previewSections.push(`${header}\n_No items_`);
      } else {
        const topItems = colItems.slice(0, 4);
        const itemLines = topItems.map(it => formatBoardItemLine(it, 80));
        const remaining = colItems.length - topItems.length;
        if (remaining > 0) {
          const slug = col.name.toLowerCase().replace(/\s+/g, '-');
          itemLines.push(`_...and ${remaining} more (\`${prefix}ghboard ${slug}\`)_`);
        }
        previewSections.push(`${header}\n${itemLines.join('\n')}`);
      }
    }

    if (noStatusItems.length > 0) {
      const topItems = noStatusItems.slice(0, 4);
      const itemLines = topItems.map(it => formatBoardItemLine(it, 80));
      const remaining = noStatusItems.length - topItems.length;
      if (remaining > 0) {
        itemLines.push(`_...and ${remaining} more_`);
      }
      previewSections.push(`❓ *No Status* (${noStatusItems.length})\n${itemLines.join('\n')}`);
    }

    const message = [
      `📋 *${boardData.title}*`,
      boardData.url ? `🔗 ${boardData.url}` : '',
      '',
      `📊 *Board Statistics:*`,
      `• 📦 *Total Items:* ${totalCount}`,
      ...statsLines,
      `📈 *Progress:* [${progressBar}] ${donePercent}% (${doneCount}/${totalCount} Done)`,
      '',
      `━━━━━━━━━━━━━━━━━━━━━`,
      `👀 *Board Sneak Peek:*`,
      '',
      previewSections.join('\n\n'),
      '',
      `💡 _Use \`${prefix}ghboard [status]\` (e.g. \`${prefix}ghboard review\`) to see all items in a column._`
    ].filter(Boolean).join('\n');

    await doReact("📋");
    await m.reply(message);
  } catch (err: any) {
    console.error("Failed to fetch project board:", err);
    await doReact("❌");
    await m.reply(`❌ Failed to fetch project board. Error: ${err.message}`);
  }
}

// ============================================================================
// 9. Export Plugin Definition & Dispatcher
// ============================================================================

export default {
  name: "githubprojects",
  alias: ["ghcreate", "ghadd", "ghdone", "ghcancel", "ghmove", "ghc", "ghboard", "ghb"],
  uniquecommands: ["ghcreate", "ghadd", "ghdone", "ghcancel", "ghmove", "ghc", "ghboard", "ghb"],
  description: "GitHub Projects ticketing system inside WhatsApp group chats",
  start: async (
    Atlas: AtlasClient,
    m: WAMessage,
    { inputCMD, text, args, prefix, doReact, quoted, isBotAdmin }: {
      inputCMD: string;
      text: string;
      args: string[];
      prefix: string;
      doReact: (emoji: string) => Promise<void>;
      quoted: QuotedMessage | null;
      isBotAdmin: boolean;
    }
  ) => {
    // Restrict to Group Chats
    if (!m.isGroup) {
      await doReact("❌");
      return m.reply("❗ This command can only be used in group chats.");
    }

    // Validate environment variables
    try {
      checkConfig();
    } catch (e: any) {
      await doReact("⚠️");
      return m.reply(`❌ Configuration Error:\n\n${e.message}\n\nPlease add the missing environment variables to your .env file.`);
    }

    const groupJid = m.from;
    const groupConfig = getGroupConfig(groupJid);
    if (!groupConfig || !groupConfig.owner || !groupConfig.repo || !groupConfig.projectId || !groupConfig.statusFieldId) {
      await doReact("❌");
      return m.reply("❗ This WhatsApp group is not configured for GitHub projects.");
    }

    // Initialize Octokit and GraphQL Clients
    const { octokit, graphqlClient } = createGitHubClients(groupConfig);

    const ctx: CommandContext = {
      Atlas,
      m,
      groupJid,
      groupConfig,
      octokit,
      graphqlClient,
      inputCMD,
      text,
      args,
      prefix,
      doReact,
      quoted,
      isBotAdmin
    };

    switch (inputCMD) {
      case "ghc":
        return await handleGhc(ctx);
      case "ghcreate":
        return await handleGhCreate(ctx);
      case "ghadd":
        return await handleGhAdd(ctx);
      case "ghdone":
        return await handleGhDone(ctx);
      case "ghcancel":
        return await handleGhCancel(ctx);
      case "ghmove":
        return await handleGhMove(ctx);
      case "ghboard":
      case "ghb":
        return await handleGhBoard(ctx);
      default:
        break;
    }
  }
};
