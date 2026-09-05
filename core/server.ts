import express, { type Request, type Response } from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import qrcode from "qrcode";
import chalk from "chalk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const app = express();
app.use(express.json());

// Serve Frontend static assets
app.use("/", express.static(join(__dirname, "../frontend")));

let serverStatus = "initializing";
let qrCodeValue: string | null = "invalid";
let socketInstance: any = null;

export function setServerStatus(status: string): void {
  serverStatus = status;
}

export function getServerStatus(): string {
  return serverStatus;
}

export function setServerQR(qr: string | null): void {
  qrCodeValue = qr;
}

export function getServerQR(): string | null {
  return qrCodeValue;
}

export function setServerSocket(socket: any): void {
  socketInstance = socket;
  (global as any).AtlasSocket = socket;
}

export interface ConnectionDiagnostics {
  websocketOpen?: boolean;
  reconnectAttempt?: number;
  healthProbeFailures?: number;
  lastConnectionUpdate?: string;
}

let diagnostics: ConnectionDiagnostics = {};

export function setConnectionDiagnostics(diag: Partial<ConnectionDiagnostics>): void {
  diagnostics = { ...diagnostics, ...diag };
}

export function getConnectionDiagnostics(): ConnectionDiagnostics {
  return diagnostics;
}

export function getServerSocket(): any {
  return socketInstance;
}

// --- GUI API Endpoints ---

app.get("/api/status", (_req: Request, res: Response) => {
  res.json({
    status: serverStatus,
    websocketOpen: Boolean(socketInstance?.ws?.isOpen),
    reconnectAttempt: diagnostics.reconnectAttempt ?? 0,
    healthProbeFailures: diagnostics.healthProbeFailures ?? 0,
    lastConnectionUpdate: diagnostics.lastConnectionUpdate ?? new Date().toISOString(),
  });
});

app.get("/api/qr", async (_req: Request, res: Response) => {
  if (serverStatus === "open") {
    return res.json({ status: "connected" });
  }
  if (!qrCodeValue || qrCodeValue === "invalid") {
    return res.json({ status: "waiting" });
  }
  try {
    const qrDataUrl = await qrcode.toDataURL(qrCodeValue);
    return res.json({ status: "qr", qr: qrDataUrl });
  } catch (err: any) {
    return res.status(500).json({ status: "error", message: err.message });
  }
});

app.post("/api/pair", async (req: Request, res: Response) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: "Phone number is required." });
  }
  if (serverStatus === "open") {
    return res.status(400).json({ error: "Session is already connected!" });
  }
  if (!socketInstance) {
    return res
      .status(503)
      .json({ error: "Bot socket is not ready yet. Please wait a moment." });
  }
  try {
    const cleaned = String(phone).replace(/[^0-9]/g, "");
    let code = await socketInstance.requestPairingCode(cleaned);
    code = code?.match(/.{1,4}/g)?.join("-") || code;
    console.log(
      chalk.black.bgGreen(` PAIRING CODE: `),
      chalk.black.bgWhite(` ${code} `)
    );
    return res.json({ code });
  } catch (err: any) {
    console.error(
      chalk.red("[ EXCEPTION ] Pairing code error: " + err.message)
    );
    return res
      .status(500)
      .json({ error: "Failed to generate pairing code: " + err.message });
  }
});

app.post("/api/webhook", async (req: Request, res: Response) => {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) {
    return res.status(500).json({ error: "WEBHOOK_SECRET is not configured on the server." });
  }

  const authHeader = req.headers["authorization"];
  const customHeader = req.headers["x-webhook-secret"] as string | undefined;
  const receivedSecret = authHeader ? authHeader.replace(/^Bearer\s+/i, "") : customHeader;

  if (!receivedSecret || receivedSecret !== webhookSecret) {
    return res.status(401).json({ error: "Unauthorized: Invalid or missing secret." });
  }

  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: "Missing required field: 'text'." });
  }

  const targetJid = process.env.KAMAVO_LIVE_METRICS_GROUP_JID;
  if (!targetJid) {
    return res.status(500).json({ error: "KAMAVO_LIVE_METRICS_GROUP_JID is not configured on the server." });
  }

  if (!socketInstance) {
    return res.status(503).json({ error: "WhatsApp bot connection is not ready." });
  }

  try {
    await socketInstance.sendMessage(targetJid, { text });
    return res.json({ success: true, message: "Message sent successfully to " + targetJid });
  } catch (err: any) {
    console.error("[WEBHOOK ERROR]", err);
    return res.status(500).json({ error: "Failed to send message: " + err.message });
  }
});

export function startServer(port: number | string): void {
  app.listen(port, () => {
    console.log(chalk.green(`[ ATLAS ] HTTP Server listening on port ${port}`));
  });
}
