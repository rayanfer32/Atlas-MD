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
}

interface StatusOptionMap {
  todo: string;
  'in-progress': string;
  testing: string;
  done: string;
}

let currentDraft: Draft | null = null;

const draftService = {
  startDraft(title: string, category: string, createdBy: string, createdByName: string): Draft {
    currentDraft = {
      title,
      category,
      createdBy,
      createdByName,
      messages: [],
      createdAt: Date.now()
    };
    return currentDraft;
  },
  getDraft(): Draft | null {
    return currentDraft;
  },
  addMessage(message: DraftMessage): void {
    if (!currentDraft) {
      throw new Error("No active draft");
    }
    currentDraft.messages.push(message);
  },
  clearDraft(): void {
    currentDraft = null;
  },
  hasDraft(): boolean {
    return currentDraft !== null;
  }
};

// 2. Status option caching
let statusOptionMap: StatusOptionMap | null = null;

async function fetchStatusOptions(graphqlClient: any): Promise<StatusOptionMap> {
  if (statusOptionMap) return statusOptionMap;

  console.log("[GITHUB] Fetching GitHub Project status options...");

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
    projectId: process.env.GITHUB_PROJECT_ID,
  });

  const fields: any[] = result.node?.fields?.nodes ?? [];
  const statusField = fields.find(
    (f: any) => f?.id === process.env.GITHUB_STATUS_FIELD_ID
  );

  if (!statusField) {
    throw new Error(
      `Status field with ID "${process.env.GITHUB_STATUS_FIELD_ID}" not found in project fields.`
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

  statusOptionMap = {
    todo: resolveStatusId(options, ['todo', 'to do', 'backlog']),
    'in-progress': resolveStatusId(options, ['in-progress', 'in progress', 'doing']),
    testing: resolveStatusId(options, ['testing', 'in testing', 'qa', 'review']),
    done: resolveStatusId(options, ['done', 'complete', 'completed', 'closed']),
  };

  console.log("[GITHUB] Status options loaded:", statusOptionMap);
  return statusOptionMap;
}

// 3. Image uploading to Github repo
async function uploadImageToRepo(octokit: Octokit, imagePath: string): Promise<string> {
  const filename = path.basename(imagePath);
  const content = fs.readFileSync(imagePath);
  const base64Content = content.toString("base64");
  const repoPath = `qa-attachments/${Date.now()}-${filename}`;

  console.log(`[GITHUB] Uploading image to repo: ${repoPath}`);

  await octokit.repos.createOrUpdateFileContents({
    owner: process.env.GITHUB_OWNER ?? "",
    repo: process.env.GITHUB_REPO ?? "",
    path: repoPath,
    message: `Add QA attachment: ${filename}`,
    content: base64Content,
  });

  return `https://raw.githubusercontent.com/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/main/${repoPath}`;
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
async function createIssue(octokit: Octokit, graphqlClient: any, draft: Draft): Promise<{ number: number; url: string; nodeId: string }> {
  const messagesWithUrls = [...draft.messages];
  for (const msg of messagesWithUrls) {
    if (msg.type === 'image' && msg.imagePath) {
      try {
        const url = await uploadImageToRepo(octokit, msg.imagePath);
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

  console.log(`[GITHUB] Creating issue: [${draft.category}] ${draft.title}`);

  const response = await octokit.issues.create({
    owner: process.env.GITHUB_OWNER ?? "",
    repo: process.env.GITHUB_REPO ?? "",
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

async function addIssueToProject(graphqlClient: any, issueNodeId: string): Promise<{ itemId: string }> {
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
    projectId: process.env.GITHUB_PROJECT_ID,
    contentId: issueNodeId,
  });

  const itemId = result.addProjectV2ItemById?.item?.id;
  if (!itemId) throw new Error('Failed to add item to project');

  return { itemId };
}

async function setProjectItemStatus(graphqlClient: any, itemId: string, status: keyof StatusOptionMap): Promise<void> {
  const statusOptions = await fetchStatusOptions(graphqlClient);
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
    projectId: process.env.GITHUB_PROJECT_ID,
    itemId,
    fieldId: process.env.GITHUB_STATUS_FIELD_ID,
    optionId,
  });
}

async function findProjectItemByIssueNumber(graphqlClient: any, issueNumber: number): Promise<string | null> {
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
      projectId: process.env.GITHUB_PROJECT_ID,
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

function checkConfig(): void {
  const required = [
    'GITHUB_TOKEN',
    'GITHUB_OWNER',
    'GITHUB_REPO',
    'GITHUB_PROJECT_ID',
    'GITHUB_STATUS_FIELD_ID'
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required GitHub environment variable(s): ${missing.join(', ')}`);
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
    { inputCMD, text, args, prefix, doReact, quoted }: {
      inputCMD: string;
      text: string;
      args: string[];
      prefix: string;
      doReact: (emoji: string) => Promise<void>;
      quoted: QuotedMessage | null;
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

    // Initialize Octokit and GraphQL Clients
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const graphqlClient = graphql.defaults({
      headers: {
        authorization: `token ${process.env.GITHUB_TOKEN}`,
      },
    });

    switch (inputCMD) {
      case "ghcreate": {
        if (!text) {
          await doReact("❔");
          return m.reply(`❗ Invalid Format.\n\n*Usage:* ${prefix}ghcreate <category>: <title>\n*Example:* ${prefix}ghcreate app: Login button does not work\n\n*Categories:* app, web, backend, admin`);
        }

        const match = text.match(/^(\w+):\s+(.+)$/);
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

        const hadPrevious = draftService.hasDraft();
        draftService.startDraft(title, category, senderId, senderName);

        const warning = hadPrevious ? '\n\n_Previous draft was cancelled._' : '';

        await doReact("🧩");
        await m.reply(
          `🧩 *Draft Started*${warning}\n\n` +
          `*Category:* \`${category}\`\n` +
          `*Title:* ${title}\n\n` +
          `Reply to related messages using:\n\`${prefix}ghadd\`\n\n` +
          `Finish using:\n\`${prefix}ghdone\`\n\n` +
          `_Starting a new draft cancels the previous one._`
        );
        break;
      }

      case "ghadd": {
        if (!draftService.hasDraft()) {
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

        console.log("quoted : ", m.quoted)
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
          draftService.addMessage(collected);
          await doReact("✅");
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
            draftService.addMessage(collected);
            await doReact("🖼️");
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
        const draft = draftService.getDraft();
        if (!draft) {
          await doReact("❌");
          return m.reply(`❗ No active draft. Start one with:\n\`${prefix}ghcreate <category>: <title>\``);
        }

        await doReact("⏳");
        await m.reply("⏳ Creating GitHub issue...");

        try {
          const issue = await createIssue(octokit, graphqlClient, draft);
          const projectItem = await addIssueToProject(graphqlClient, issue.nodeId);
          await setProjectItemStatus(graphqlClient, projectItem.itemId, 'todo');

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

          draftService.clearDraft();

          await doReact("✅");
          await m.reply(
            `🎫 *Ticket Created*\n\n` +
            `*GH-${issue.number}*\n` +
            `${issue.url}\n\n` +
            `*Status:* Todo`
          );
        } catch (err: any) {
          console.error("Failed to create GitHub issue:", err);
          await doReact("❌");
          await m.reply(`❌ Failed to create ticket. Error: ${err.message}`);
        }
        break;
      }

      case "ghcancel": {
        const draft = draftService.getDraft();
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

        draftService.clearDraft();
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
          const itemId = await findProjectItemByIssueNumber(graphqlClient, issueNumber);

          if (!itemId) {
            await doReact("❌");
            return m.reply(`❗ GH-${issueNumber} was not found in the GitHub Project board.`);
          }

          await setProjectItemStatus(graphqlClient, itemId, status as keyof StatusOptionMap);

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
