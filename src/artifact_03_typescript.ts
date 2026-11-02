import { Connection, PublicKey } from "@solana/web3.js";
import axios from "axios";
import * as dotenv from "dotenv";
import express, { Request, Response } from "express";

dotenv.config();

// Configuration environment variables
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const SOLANA_WS_URL = process.env.SOLANA_WS_URL || "ws://127.0.0.1:8900";
const PROGRAM_ID_STR = process.env.PROGRAM_ID || "StrMsh1eLd1111111111111111111111111111111111";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FINANCE_AUDIT_EMAIL = process.env.FINANCE_AUDIT_EMAIL || "cfo@enterprise-client.com";
const PORT = process.env.PORT || 8080;

interface EventPayload {
  eventName: string;
  signature: string;
  slot: number;
  details: Record<string, unknown>;
}

class StreamShieldAuditor {
  private connection: Connection;
  private programId: PublicKey;

  constructor() {
    this.connection = new Connection(SOLANA_RPC_URL, {
      wsEndpoint: SOLANA_WS_URL,
      commitment: "confirmed",
    });
    this.programId = new PublicKey(PROGRAM_ID_STR);
  }

  public async start(): Promise<void> {
    console.log(`[StreamShield Auditor] Initializing on Program: ${this.programId.toBase58()}`);

    this.connection.onLogs(
      this.programId,
      async (logsContext) => {
        const { signature, logs, err } = logsContext;
        if (err) {
          console.warn(`[StreamShield] Transaction failed: ${signature}`);
          return;
        }

        for (const line of logs) {
          if (line.includes("Instruction: ReleaseMilestone")) {
            await this.processMilestoneReleased(signature);
          } else if (line.includes("Instruction: RaiseDispute")) {
            await this.processDisputeAlert(signature);
          }
        }
      },
      "confirmed"
    );

    console.log("[StreamShield Auditor] WebSocket listener actively tracking transactions.");
  }

  private async processMilestoneReleased(signature: string): Promise<void> {
    const tx = await this.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
    const slot = tx?.slot || 0;

    const payload: EventPayload = {
      eventName: "MilestoneReleased",
      signature,
      slot,
      details: {
        explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${SOLANA_RPC_URL}`,
        timestamp: new Date().toISOString(),
      },
    };

    console.log(`[Event Detected] MilestoneReleased at tx: ${signature}`);
    await Promise.allSettled([
      this.notifySlack(payload),
      this.notifyDiscord(payload),
      this.sendResendEmailReceipt(payload),
    ]);
  }

  private async processDisputeAlert(signature: string): Promise<void> {
    const payload: EventPayload = {
      eventName: "DisputeRaised",
      signature,
      slot: 0,
      details: {
        urgent: true,
        explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${SOLANA_RPC_URL}`,
        timestamp: new Date().toISOString(),
      },
    };

    console.warn(`[CRITICAL] Dispute raised at tx: ${signature}`);
    await Promise.allSettled([
      this.notifySlack(payload),
      this.notifyDiscord(payload),
    ]);
  }

  private async notifySlack(event: EventPayload): Promise<void> {
    if (!SLACK_WEBHOOK_URL) return;
    const body = {
      text: `*StreamShield Solana Alert: ${event.eventName}*\n- *Tx:* \`${event.signature}\`\n- *Explorer:* ${event.details.explorerUrl}\n- *Time:* ${event.details.timestamp}`,
    };
    await axios.post(SLACK_WEBHOOK_URL, body).catch((e) => console.error("Slack post error:", e.message));
  }

  private async notifyDiscord(event: EventPayload): Promise<void> {
    if (!DISCORD_WEBHOOK_URL) return;
    const body = {
      content: `🛡️ **[Warsaw StreamShield Protocol Event]**\n**Event:** \`${event.eventName}\`\n**Signature:** \`${event.signature}\`\n**Explorer:** <${event.details.explorerUrl}>`,
    };
    await axios.post(DISCORD_WEBHOOK_URL, body).catch((e) => console.error("Discord post error:", e.message));
  }

  private async sendResendEmailReceipt(event: EventPayload): Promise<void> {
    if (!RESEND_API_KEY) return;
    const emailData = {
      from: "audit@streamshield.io",
      to: [FINANCE_AUDIT_EMAIL],
      subject: `[Audit Receipt] Solana Milestone Release Confirmed - Tx: ${event.signature.slice(0, 8)}`,
      html: `
        <h2>StreamShield Milestone Settlement Notice</h2>
        <p>A deterministic milestone payment was authorized and settled on Solana.</p>
        <ul>
          <li><strong>Event:</strong> ${event.eventName}</li>
          <li><strong>Transaction:</strong> <code>${event.signature}</code></li>
          <li><strong>Timestamp:</strong> ${event.details.timestamp}</li>
        </ul>
        <p><a href="${event.details.explorerUrl}" style="background-color:#14F195;color:#000;padding:10px 20px;text-decoration:none;border-radius:4px;font-weight:bold;">View Solana Explorer</a></p>
      `,
    };

    await axios.post("https://api.resend.com/emails", emailData, {
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
    }).catch((e) => console.error("Resend API error:", e.message));
  }
}

// Telemetry & Healthcheck Server
const app = express();
app.use(express.json());

app.get("/healthz", (_req: Request, res: Response) => {
  res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.get("/metrics", (_req: Request, res: Response) => {
  res.status(200).json({
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    solanaRpc: SOLANA_RPC_URL,
    status: "connected",
  });
});

const auditor = new StreamShieldAuditor();
auditor.start().catch((err) => {
  console.error("Failed to start StreamShield Auditor:", err);
  process.exit(1);
});

app.listen(PORT, () => {
  console.log(`[StreamShield Telemetry] Microservice active on port ${PORT}`);
});