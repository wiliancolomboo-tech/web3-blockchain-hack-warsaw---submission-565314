import axios from "axios";
import { Resend } from "resend";

export interface EscrowNotificationPayload {
  escrowId: string;
  eventType: string;
  amountLamports: number;
  actor: string;
  details: string;
  txHash: string;
}

export class EnterpriseNotifier {
  private resend: Resend | null = null;
  private slackWebhookUrl: string | undefined;
  private discordWebhookUrl: string | undefined;
  private alertEmailRecipient: string | undefined;

  constructor() {
    if (process.env.RESEND_API_KEY) {
      this.resend = new Resend(process.env.RESEND_API_KEY);
    }
    this.slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
    this.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
    this.alertEmailRecipient = process.env.NOTIFICATION_EMAIL || "treasury@enterprise.org";
  }

  public async broadcast(payload: EscrowNotificationPayload): Promise<void> {
    const solAmount = (payload.amountLamports / 1e9).toFixed(4);
    const title = `🚨 [AegisPay Alert] Event: ${payload.eventType} | Escrow #${payload.escrowId}`;
    const textBody = `AegisPay Protocol Alert:\n- Event: ${payload.eventType}\n- Escrow ID: ${payload.escrowId}\n- Amount: ${solAmount} SOL\n- Triggered By: ${payload.actor}\n- Summary: ${payload.details}\n- Tx: https://explorer.solana.com/tx/${payload.txHash}?cluster=devnet`;

    const tasks: Promise<any>[] = [];

    // 1. Slack Webhook Dispatch
    if (this.slackWebhookUrl) {
      tasks.push(
        axios.post(this.slackWebhookUrl, {
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: `🛡️ AegisPay: ${payload.eventType}` },
            },
            {
              type: "section",
              fields: [
                { type: "mrkdwn", text: `*Escrow ID:*\n#${payload.escrowId}` },
                { type: "mrkdwn", text: `*Amount:*\n${solAmount} SOL` },
                { type: "mrkdwn", text: `*Actor:*\n\`${payload.actor}\`` },
                { type: "mrkdwn", text: `*Transaction:*\n<https://explorer.solana.com/tx/${payload.txHash}?cluster=devnet|View on Explorer>` },
              ],
            },
            {
              type: "section",
              text: { type: "mrkdwn", text: `*Details:* ${payload.details}` },
            },
          ],
        }).catch((err) => console.error("[Notifier] Slack post failed:", err.message))
      );
    }

    // 2. Discord Webhook Dispatch
    if (this.discordWebhookUrl) {
      tasks.push(
        axios.post(this.discordWebhookUrl, {
          embeds: [
            {
              title,
              color: payload.eventType.includes("Dispute") ? 0xff0000 : 0x00ff88,
              fields: [
                { name: "Escrow ID", value: `#${payload.escrowId}`, inline: true },
                { name: "Amount", value: `${solAmount} SOL`, inline: true },
                { name: "Actor", value: `\`${payload.actor.slice(0, 8)}...\``, inline: true },
                { name: "Status Update", value: payload.details },
              ],
              url: `https://explorer.solana.com/tx/${payload.txHash}?cluster=devnet`,
              timestamp: new Date().toISOString(),
            },
          ],
        }).catch((err) => console.error("[Notifier] Discord post failed:", err.message))
      );
    }

    // 3. Resend Enterprise Transactional Email
    if (this.resend && this.alertEmailRecipient) {
      tasks.push(
        this.resend.emails.send({
          from: "notifications@aegispay.dev",
          to: this.alertEmailRecipient,
          subject: title,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
              <h2 style="color: #0f172a; margin-top: 0;">🛡️ AegisPay Escrow Event Notification</h2>
              <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                <tr><td style="padding: 8px 0; color: #64748b;">Event Type:</td><td style="padding: 8px 0; font-weight: bold; color: #0f172a;">${payload.eventType}</td></tr>
                <tr><td style="padding: 8px 0; color: #64748b;">Escrow ID:</td><td style="padding: 8px 0; font-weight: bold; color: #0f172a;">#${payload.escrowId}</td></tr>
                <tr><td style="padding: 8px 0; color: #64748b;">Collateral Value:</td><td style="padding: 8px 0; font-weight: bold; color: #059669;">${solAmount} SOL</td></tr>
                <tr><td style="padding: 8px 0; color: #64748b;">Actor Address:</td><td style="padding: 8px 0; font-family: monospace; font-size: 13px;">${payload.actor}</td></tr>
              </table>
              <div style="background-color: #f8fafc; padding: 12px; border-radius: 6px; margin: 16px 0;">
                <strong>Event Details:</strong> ${payload.details}
              </div>
              <p style="margin-top: 24px;">
                <a href="https://explorer.solana.com/tx/${payload.txHash}?cluster=devnet" style="background-color: #2563eb; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500; display: inline-block;">View Transaction on Solana Explorer</a>
              </p>
            </div>
          `,
        }).catch((err) => console.error("[Notifier] Resend email failed:", err.message))
      );
    }

    await Promise.all(tasks);
    console.log(`[Notifier] Broadcast completed for event: ${payload.eventType}`);
  }
}