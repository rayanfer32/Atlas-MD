import { Octokit } from "@octokit/rest";
import fs from "fs";
import path from "path";
import os from "os";
import type { WAMessage, AtlasClient, QuotedMessage } from "../types/index.js";

// ============================================================================
// 1. Constants & Types
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

export interface CommandContext {
  Atlas: AtlasClient;
  m: WAMessage;
  groupJid: string;
  groupConfig: GitHubGroupConfig;
  octokit: Octokit;
  inputCMD: string;
  text: string;
  args: string[];
  prefix: string;
  doReact: (emoji: string) => Promise<void>;
  quoted: QuotedMessage | null;
  isBotAdmin: boolean;
}

interface GraphQLFieldOption {
  id: string;
  name: string;
}

interface GraphQLProjectFieldsResponse {
  node?: {
    fields?: {
      nodes?: Array<{
        id: string;
        name: string;
        options?: GraphQLFieldOption[];
      }>;
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
// 2. In-Memory State
// ============================================================================

const draftsByGroup = new Map<string, Draft>();
const statusOptionMapCache = new Map<string, StatusOptionMap>();

// ============================================================================
// 3. Message & Media Utilities
// ============================================================================

function cleanupTempFile(filePath?: string): void {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch { }
  }
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

    if (message?.imageMessage) {
      const imgMsg = message.imageMessage;
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
          imagePath = path.join(os.tmpdir(), `qa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`);
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
        text: imgMsg.caption || undefined,
        imagePath,
        timestamp
      };
    }

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

async function extractQuotedMessage(quoted: QuotedMessage): Promise<DraftMessage | null> {
  const senderId = quoted.sender || 'unknown';
  const senderName = quoted.sender?.split('@')[0] || 'Unknown';
  const senderNumber = senderId.split('@')[0] || senderId;
  const messageId = quoted.id || `msg-${Date.now()}`;
  const timestamp = Date.now();

  if (quoted.type === "conversation" || quoted.type === "extendedTextMessage") {
    return {
      messageId,
      senderName,
      senderNumber,
      type: 'text',
      text: quoted.text || '',
      timestamp
    };
  }

  if (quoted.type === "imageMessage") {
    if (!quoted.download) throw new Error("No download method on quoted message");
    const buffer = await quoted.download();
    const imagePath = path.join(os.tmpdir(), `qa-${Date.now()}.jpg`);
    fs.writeFileSync(imagePath, buffer);

    return {
      messageId,
      senderName,
      senderNumber,
      type: 'image',
      text: quoted.caption || undefined,
      imagePath,
      timestamp
    };
  }

  return null;
}

async function inferTitle(messages: DraftMessage[]): Promise<string> {
  const textParts = messages
    .map((m, idx) => `Message ${idx + 1} (${m.senderName}): ${m.text || (m.type === 'image' ? '[Image Attachment]' : '')}`)
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
      if (title) return title;
    } catch (err: any) {
      console.error("[GITHUB] Error generating title with Gemini:", err?.message || err);
    }
  }

  for (const m of messages) {
    if (m.text && m.text.trim()) {
      const firstLine = m.text.trim().split("\n")[0].trim();
      return firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;
    }
  }

  return "Issue reported via WhatsApp";
}

function extractIssueNumber(text: string): number | null {
  const match = text.match(/GH-(\d+)/i) || text.match(/#(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// ============================================================================
// 4. Configuration Management
// ============================================================================

function getGroupConfig(groupJid: string): GitHubGroupConfig | null {
  if (process.env.GITHUB_PROJECTS_MAPPING) {
    try {
      const mapping: Record<string, GitHubGroupConfig> = JSON.parse(process.env.GITHUB_PROJECTS_MAPPING);
      if (mapping[groupJid]) return mapping[groupJid];
    } catch (err: any) {
      console.error("[GITHUB] Error parsing GITHUB_PROJECTS_MAPPING:", err?.message || err);
    }
    return null;
  }

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

// ============================================================================
// 5. Formatting Utilities
// ============================================================================

function formatTimestamp(ts: number | string): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function formatMessage(msg: DraftMessage, index: number): string {
  const lines: string[] = [
    `### Message ${index + 1}`,
    '',
    `**From:** ${msg.senderName} (\`${msg.senderNumber}\`) — ${formatTimestamp(msg.timestamp)}`,
    ''
  ];

  if (msg.type === 'text' && msg.text) {
    lines.push(msg.text);
  } else if (msg.type === 'image') {
    lines.push(msg.imagePath ? `![attachment](${msg.imagePath})` : '_[Image attachment — upload failed]_');
    if (msg.text) {
      lines.push('', msg.text);
    }
  }

  return lines.join('\n');
}

function buildIssueBody(draft: Draft): string {
  const sections: string[] = [
    '## Summary',
    '',
    draft.title,
    '',
    '---',
    '',
    '## Reported By',
    '',
    draft.createdByName,
    '',
    '---'
  ];

  if (draft.messages.length > 0) {
    sections.push('', '## Messages', '');
    for (let i = 0; i < draft.messages.length; i++) {
      sections.push(formatMessage(draft.messages[i], i), '');
    }
    sections.push('---');
  }

  const imageMessages = draft.messages.filter(m => m.type === 'image' && m.imagePath);
  if (imageMessages.length > 0) {
    sections.push('', '## Attachments', '');
    for (const img of imageMessages) {
      sections.push(`* ${img.imagePath?.split('/').pop() ?? 'attachment'}`);
    }
    sections.push('', '---');
  }

  sections.push('', '## Source', '', 'WhatsApp QA Group', '');
  return sections.join('\n');
}

function renderProgressBar(percentage: number, length = 10): string {
  const filled = Math.min(length, Math.max(0, Math.round((percentage / 100) * length)));
  return '█'.repeat(filled) + '░'.repeat(length - filled);
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

  return columns.find(c => clean(c.name) === q)
    || columns.find(c => clean(c.name).includes(q) || q.includes(clean(c.name)))
    || columns.find(c => {
      if (/rev|qa|test/.test(q)) return /review|qa|test/i.test(c.name);
      if (/prog|do|wip/.test(q)) return /progress|doing|wip/i.test(c.name);
      if (/todo|backlog/.test(q)) return /todo|to do|backlog/i.test(c.name);
      if (/done|close|finish|comp/.test(q)) return /done|closed|complete/i.test(c.name);
      return false;
    })
    || null;
}

function getItemBadge(item: ProjectBoardItem, bold = false): string {
  const num = bold ? `*#${item.number}*` : `#${item.number}`;
  if (item.type === 'issue') return num;
  if (item.type === 'pr') return `🔀 ${num}`;
  return '📝';
}

function formatBoardItemLine(item: ProjectBoardItem, maxLen = 80): string {
  const title = item.title.length > maxLen ? item.title.slice(0, maxLen - 3) + '...' : item.title;
  return `• ${getItemBadge(item)} ${title}`;
}

function formatColumnItemLine(item: ProjectBoardItem, index: number): string {
  return `${index + 1}. ${getItemBadge(item, true)} ${item.title}`;
}

// ============================================================================
// 6. GitHub API Operations
// ============================================================================

async function fetchStatusOptions(
  octokit: Octokit,
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

  const result: GraphQLProjectFieldsResponse = await octokit.graphql(query, { projectId });
  const fields = result.node?.fields?.nodes ?? [];
  const statusField = fields.find(f => f?.id === statusFieldId);

  if (!statusField) {
    throw new Error(`Status field with ID "${statusFieldId}" not found in project fields.`);
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
  octokit: Octokit,
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

  const result: GraphQLAddItemResponse = await octokit.graphql(mutation, {
    projectId,
    contentId: issueNodeId,
  });

  const itemId = result.addProjectV2ItemById?.item?.id;
  if (!itemId) throw new Error('Failed to add item to project');

  return { itemId };
}

async function setProjectItemStatus(
  octokit: Octokit,
  projectId: string,
  statusFieldId: string,
  itemId: string,
  status: TicketStatus
): Promise<void> {
  const statusOptions = await fetchStatusOptions(octokit, projectId, statusFieldId);
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

  await octokit.graphql(mutation, {
    projectId,
    itemId,
    fieldId: statusFieldId,
    optionId,
  });
}

async function findProjectItemByIssueNumber(
  octokit: Octokit,
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
    const result: GraphQLFindItemResponse = await octokit.graphql(query, {
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
  octokit: Octokit,
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
    const res: GraphQLBoardResponse = await octokit.graphql(query, { projectId, after });
    const projectNode = res.node;
    if (!projectNode) {
      throw new Error(`GitHub Project with ID "${projectId}" not found.`);
    }

    if (!title || title === "GitHub Project") {
      title = projectNode.title || "GitHub Project";
      url = projectNode.url || "";
    }

    if (columns.length === 0) {
      const fields = projectNode.fields?.nodes ?? [];
      let statusField = fields.find(f => f?.id === statusFieldId);
      if (!statusField) {
        statusField = fields.find(f => /status/i.test(f?.name) && f?.options);
      }
      if (statusField && statusField.options) {
        columns = statusField.options.map(opt => ({
          id: opt.id,
          name: opt.name,
        }));
      }
    }

    const itemNodes = projectNode.items?.nodes ?? [];
    for (const node of itemNodes) {
      if (node.isArchived) continue;

      const fvNodes = node.fieldValues?.nodes ?? [];
      const statusVal = fvNodes.find(fv => fv?.field?.id === statusFieldId);
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
// 7. Command Handlers
// ============================================================================

async function handleGhc(ctx: CommandContext): Promise<void> {
  const { Atlas, m, groupJid, groupConfig, octokit, args, prefix, doReact } = ctx;

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
    const projectItem = await addIssueToProject(octokit, groupConfig.projectId, issue.nodeId);
    await setProjectItemStatus(octokit, groupConfig.projectId, groupConfig.statusFieldId, projectItem.itemId, 'todo');

    for (const item of matchingItems) {
      try {
        await Atlas.sendMessage(m.from, { react: { text: "🛟", key: item.key } });
      } catch (err) {
        console.error("[GITHUB] Failed to change reaction to 🛟:", err);
      }
    }

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

  const previousDraft = draftsByGroup.get(groupJid);
  if (previousDraft) {
    await cleanupDraftBotMessages(Atlas, m.from, previousDraft, isBotAdmin);
  }

  const hadPrevious = draftsByGroup.has(groupJid);
  const draft: Draft = {
    title,
    category,
    createdBy: senderId,
    createdByName: senderName,
    messages: [],
    createdAt: Date.now(),
    ghaddMsgKeys: []
  };
  draftsByGroup.set(groupJid, draft);

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

  const draft = draftsByGroup.get(groupJid);
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

  try {
    const collected = await extractQuotedMessage(m.quoted);
    if (!collected) {
      await doReact("⚠️");
      await m.reply("⚠️ Unsupported message type. Only text and images can be added.");
      return;
    }

    draft.messages.push(collected);
    draft.ghaddMsgKeys = draft.ghaddMsgKeys || [];
    draft.ghaddMsgKeys.push(m.key);
    await doReact(collected.type === 'image' ? "🖼️" : "✅");
  } catch (err: any) {
    console.error("Failed to add message to draft:", err);
    await doReact("❌");
    await m.reply(`❗ Failed to process attachment: ${err.message}`);
  }
}

async function handleGhDone(ctx: CommandContext): Promise<void> {
  const { Atlas, m, groupJid, groupConfig, octokit, prefix, doReact, isBotAdmin } = ctx;

  const draft = draftsByGroup.get(groupJid);
  if (!draft) {
    await doReact("❌");
    await m.reply(`❗ No active draft. Start one with:\n\`${prefix}ghcreate <category>: <title>\``);
    return;
  }

  await doReact("⏳");
  const creatingMsg = await m.reply("⏳ Creating GitHub issue...");

  try {
    const issue = await createIssue(octokit, draft, groupConfig.owner, groupConfig.repo);
    const projectItem = await addIssueToProject(octokit, groupConfig.projectId, issue.nodeId);
    await setProjectItemStatus(octokit, groupConfig.projectId, groupConfig.statusFieldId, projectItem.itemId, 'todo');

    await cleanupDraftBotMessages(Atlas, m.from, draft, isBotAdmin);
    await safeDeleteMessage(Atlas, m.from, creatingMsg?.key);

    draftsByGroup.delete(groupJid);

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

  const draft = draftsByGroup.get(groupJid);
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
    draftsByGroup.delete(groupJid);
  }

  if (hasPending) {
    groupPending.clear();
  }

  await doReact("❌");
  await m.reply("❌ *Draft and pending reacted messages cancelled.*");
}

async function handleGhMove(ctx: CommandContext): Promise<void> {
  const { m, groupConfig, octokit, text, prefix, doReact } = ctx;

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
    const itemId = await findProjectItemByIssueNumber(octokit, groupConfig.projectId, issueNumber);

    if (!itemId) {
      await doReact("❌");
      await m.reply(`❗ GH-${issueNumber} was not found in the GitHub Project board.`);
      return;
    }

    await setProjectItemStatus(octokit, groupConfig.projectId, groupConfig.statusFieldId, itemId, status);

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
  const { m, groupConfig, octokit, text, prefix, doReact } = ctx;

  await doReact("⏳");

  try {
    const boardData = await fetchProjectBoard(octokit, groupConfig.projectId, groupConfig.statusFieldId);

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
// 8. Plugin Definition & Dispatcher
// ============================================================================

const COMMANDS = ["ghcreate", "ghadd", "ghdone", "ghcancel", "ghmove", "ghc", "ghboard", "ghb"];

export default {
  name: "githubprojects",
  alias: COMMANDS,
  uniquecommands: COMMANDS,
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
    if (!m.isGroup) {
      await doReact("❌");
      return m.reply("❗ This command can only be used in group chats.");
    }

    const groupJid = m.from;
    const groupConfig = getGroupConfig(groupJid);
    const token = groupConfig?.token || process.env.GITHUB_TOKEN;

    if (!token) {
      await doReact("⚠️");
      return m.reply("❌ Missing GitHub token. Please configure GITHUB_TOKEN in your .env file or group mapping.");
    }

    if (!groupConfig || !groupConfig.owner || !groupConfig.repo || !groupConfig.projectId || !groupConfig.statusFieldId) {
      await doReact("❌");
      return m.reply("❗ This WhatsApp group is not configured for GitHub projects.");
    }

    const octokit = new Octokit({ auth: token });

    const ctx: CommandContext = {
      Atlas,
      m,
      groupJid,
      groupConfig,
      octokit,
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
