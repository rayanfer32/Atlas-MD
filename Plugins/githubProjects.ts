import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import fs from "fs";
import path from "path";
import os from "os";
import type { WAMessage, AtlasClient, QuotedMessage } from "../types/index.js";

// 1. In-memory draft state
interface DraftMessage {
  messageId: string;
  senderName: string;
  senderNumber: string;
  type: string;
  text?: string;
  imagePath?: string;
  timestamp: number;
}

interface Draft {
  title: string;
  category: string;
  createdBy: string;
  createdByName: string;
  messages: DraftMessage[];
  createdAt: number;
  draftStartedMsgKey?: any;
  ghaddMsgKeys?: any[];
}

interface StatusOptionMap {
  todo: string;
  'in-progress': string;
  testing: string;
  done: string;
}

interface GitHubGroupConfig {
  owner: string;
  repo: string;
  projectId: string;
  statusFieldId: string;
  token?: string;
}

const draftsByGroup = new Map<string, Draft>();

const draftService = {
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

// 2. Status option caching per projectId
const statusOptionMapCache = new Map<string, StatusOptionMap>();

async function fetchStatusOptions(graphqlClient: any, projectId: string, statusFieldId: string): Promise<StatusOptionMap> {
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

  const result: any = await graphqlClient(query, {
    projectId,
  });

  const fields: any[] = result.node?.fields?.nodes ?? [];
  const statusField = fields.find(
    (f: any) => f?.id === statusFieldId
  );

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

// 3. Image uploading to Github repo
async function uploadImageToRepo(octokit: Octokit, imagePath: string, owner: string, repo: string): Promise<string> {
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

// 4. Issue formatting utilities
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

// 5. Project helpers
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
        msg.imagePath = url;
        try {
          if (fs.existsSync(msg.imagePath)) {
            fs.unlinkSync(msg.imagePath);
          }
        } catch { }
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

async function addIssueToProject(graphqlClient: any, projectId: string, issueNodeId: string): Promise<{ itemId: string }> {
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

  const result: any = await graphqlClient(mutation, {
    projectId,
    contentId: issueNodeId,
  });

  const itemId = result.addProjectV2ItemById?.item?.id;
  if (!itemId) throw new Error('Failed to add item to project');

  return { itemId };
}

async function setProjectItemStatus(
  graphqlClient: any,
  projectId: string,
  statusFieldId: string,
  itemId: string,
  status: keyof StatusOptionMap
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
  graphqlClient: any,
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
    const result: any = await graphqlClient(query, {
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

function extractIssueNumber(text: string): number | null {
  const ghMatch = text.match(/GH-(\d+)/i);
  if (ghMatch) return parseInt(ghMatch[1], 10);

  const hashMatch = text.match(/#(\d+)/);
  if (hashMatch) return parseInt(hashMatch[1], 10);

  return null;
}

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

// 6. Export Plugin Definition
export default {
  name: "githubprojects",
  alias: ["ghcreate", "ghadd", "ghdone", "ghcancel", "ghmove"],
  uniquecommands: ["ghcreate", "ghadd", "ghdone", "ghcancel", "ghmove"],
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

    const isGroup = m.isGroup;

    // Restrict to Group Chats
    if (!isGroup) {
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
    const token = groupConfig.token || process.env.GITHUB_TOKEN;
    const octokit = new Octokit({ auth: token });
    const graphqlClient = graphql.defaults({
      headers: {
        authorization: `token ${token}`,
      },
    });

    switch (inputCMD) {
      case "ghcreate": {
        if (!text) {
          await doReact("❔");
          return m.reply(`❗ Invalid Format.\n\n*Usage:* ${prefix}ghcreate <category>: <title>\n*Example:* ${prefix}ghcreate app: Login button does not work\n\n*Categories:* app, web, backend, admin`);
        }

        const match = text.match(/^(\w+):\s+([\s\S]+)$/);
        if (!match) {
          await doReact("❔");
          return m.reply(`❗ Invalid Format.\n\n*Usage:* ${prefix}ghcreate <category>: <title>\n*Example:* ${prefix}ghcreate app: Login button does not work`);
        }

        const category = match[1].toLowerCase();
        const title = match[2].trim();

        const VALID_CATEGORIES = ['app', 'web', 'backend', 'admin'];
        if (!VALID_CATEGORIES.includes(category)) {
          await doReact("❌");
          return m.reply(`❗ Invalid Category. Must be one of: ${VALID_CATEGORIES.join(', ')}`);
        }

        const senderId = m.sender || 'unknown';
        const senderName = m.pushName || senderId.split('@')[0] || 'Unknown';

        const previousDraft = draftService.getDraft(groupJid);
        if (previousDraft) {
          if (previousDraft.draftStartedMsgKey) {
            try {
              await Atlas.sendMessage(m.from, { delete: previousDraft.draftStartedMsgKey });
            } catch (err) {
              console.error("Failed to delete previous draft started message:", err);
            }
          }
          if (isBotAdmin && previousDraft.ghaddMsgKeys && previousDraft.ghaddMsgKeys.length > 0) {
            for (const key of previousDraft.ghaddMsgKeys) {
              try {
                if (!(global as any).botDeletedMsgIds) (global as any).botDeletedMsgIds = new Set();
                (global as any).botDeletedMsgIds.add(key.id);
                setTimeout(() => (global as any).botDeletedMsgIds?.delete(key.id), 300000);
                await Atlas.sendMessage(m.from, { delete: key });
              } catch (err) {
                console.error("Failed to delete previous ghadd message:", err);
              }
            }
          }
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
        break;
      }

      case "ghadd": {
        const draft = draftService.getDraft(groupJid);
        if (!draft) {
          await doReact("❌");
          return m.reply(`❗ No active draft. Start one with:\n\`${prefix}ghcreate <category>: <title>\``);
        }

        if (!m.quoted) {
          await doReact("❌");
          return m.reply(`❗ \`${prefix}ghadd\` must be used as a *reply* to a message you want to attach.`);
        }

        const senderId = m.quoted?.sender || 'unknown';
        const senderName = m.quoted?.sender?.split('@')[0] || 'Unknown';
        const senderNumber = senderId.split('@')[0] || senderId;
        const messageId = m.quoted?.id || `msg-${Date.now()}`;
        const timestamp = Date.now();

        console.log("quoted : ", m.quoted);
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
        break;
      }

      case "ghdone": {
        const draft = draftService.getDraft(groupJid);
        if (!draft) {
          await doReact("❌");
          return m.reply(`❗ No active draft. Start one with:\n\`${prefix}ghcreate <category>: <title>\``);
        }

        await doReact("⏳");
        const creatingMsg = await m.reply("⏳ Creating GitHub issue...");

        try {
          const issue = await createIssue(octokit, draft, groupConfig.owner, groupConfig.repo);
          const projectItem = await addIssueToProject(graphqlClient, groupConfig.projectId, issue.nodeId);
          await setProjectItemStatus(graphqlClient, groupConfig.projectId, groupConfig.statusFieldId, projectItem.itemId, 'todo');

          // Clean up local temp images
          for (const msg of draft.messages) {
            if (msg.type === 'image' && msg.imagePath) {
              try {
                if (fs.existsSync(msg.imagePath)) {
                  fs.unlinkSync(msg.imagePath);
                }
              } catch { }
            }
          }

          // Delete "Draft Started", "Creating GitHub issue..." and all /ghadd messages
          if (draft.draftStartedMsgKey) {
            try {
              await Atlas.sendMessage(m.from, { delete: draft.draftStartedMsgKey });
            } catch (err) {
              console.error("Failed to delete draft started message:", err);
            }
          }
          if (creatingMsg && creatingMsg.key) {
            try {
              await Atlas.sendMessage(m.from, { delete: creatingMsg.key });
            } catch (err) {
              console.error("Failed to delete creating message:", err);
            }
          }
          if (isBotAdmin && draft.ghaddMsgKeys && draft.ghaddMsgKeys.length > 0) {
            for (const key of draft.ghaddMsgKeys) {
              try {
                if (!(global as any).botDeletedMsgIds) (global as any).botDeletedMsgIds = new Set();
                (global as any).botDeletedMsgIds.add(key.id);
                setTimeout(() => (global as any).botDeletedMsgIds?.delete(key.id), 300000);
                await Atlas.sendMessage(m.from, { delete: key });
              } catch (err) {
                console.error("Failed to delete ghadd message:", err);
              }
            }
          }

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
          if (creatingMsg && creatingMsg.key) {
            try {
              await Atlas.sendMessage(m.from, { delete: creatingMsg.key });
            } catch (deleteErr) {
              console.error("Failed to delete creating message on failure:", deleteErr);
            }
          }
          await doReact("❌");
          await m.reply(`❌ Failed to create ticket. Error: ${err.message}`);
        }
        break;
      }

      case "ghcancel": {
        const draft = draftService.getDraft(groupJid);
        if (!draft) {
          await doReact("❌");
          return m.reply("❗ No active draft to cancel.");
        }

        for (const msg of draft.messages) {
          if (msg.type === 'image' && msg.imagePath) {
            try {
              if (fs.existsSync(msg.imagePath)) {
                fs.unlinkSync(msg.imagePath);
              }
            } catch { }
          }
        }

        // Delete "Draft Started" and all /ghadd messages on cancel
        if (draft.draftStartedMsgKey) {
          try {
            await Atlas.sendMessage(m.from, { delete: draft.draftStartedMsgKey });
          } catch (err) {
            console.error("Failed to delete draft started message on cancel:", err);
          }
        }
        if (isBotAdmin && draft.ghaddMsgKeys && draft.ghaddMsgKeys.length > 0) {
          for (const key of draft.ghaddMsgKeys) {
            try {
              if (!(global as any).botDeletedMsgIds) (global as any).botDeletedMsgIds = new Set();
              (global as any).botDeletedMsgIds.add(key.id);
              setTimeout(() => (global as any).botDeletedMsgIds?.delete(key.id), 300000);
              await Atlas.sendMessage(m.from, { delete: key });
            } catch (err) {
              console.error("Failed to delete ghadd message on cancel:", err);
            }
          }
        }

        draftService.clearDraft(groupJid);
        await doReact("❌");
        await m.reply("❌ *Draft Cancelled*");
        break;
      }

      case "ghmove": {
        if (!m.quoted) {
          await doReact("❌");
          return m.reply(`❗ \`${prefix}ghmove\` must be used as a *reply* to a bot ticket message.\n\n*Example:* Reply to the 🎫 ticket message with \`${prefix}ghmove testing\``);
        }

        const quotedText = m.quoted.text || '';
        const issueNumber = extractIssueNumber(quotedText);

        if (!issueNumber) {
          await doReact("❌");
          return m.reply(`❗ Could not find a GitHub issue number in the replied message.\n\nMake sure you are replying to the bot's ticket message (e.g. "GH-142").`);
        }

        const status = text.toLowerCase().trim();
        const VALID_STATUSES = ['todo', 'in-progress', 'testing', 'done'] as const;

        if (!status || !VALID_STATUSES.includes(status as any)) {
          await doReact("❌");
          return m.reply(`❗ Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
        }

        await doReact("⏳");

        try {
          const itemId = await findProjectItemByIssueNumber(graphqlClient, groupConfig.projectId, issueNumber);

          if (!itemId) {
            await doReact("❌");
            return m.reply(`❗ GH-${issueNumber} was not found in the GitHub Project board.`);
          }

          await setProjectItemStatus(graphqlClient, groupConfig.projectId, groupConfig.statusFieldId, itemId, status as keyof StatusOptionMap);

          const statusNames = {
            todo: 'Todo',
            'in-progress': 'In Progress',
            testing: 'Testing',
            done: 'Done'
          } as const;

          await doReact("✅");
          await m.reply(`✅ *GH-${issueNumber}* moved to *${statusNames[status as keyof typeof statusNames]}*`);
        } catch (err: any) {
          console.error("Failed to move ticket:", err);
          await doReact("❌");
          await m.reply(`❌ Failed to update status. Error: ${err.message}`);
        }
        break;
      }
    }
  }
};
