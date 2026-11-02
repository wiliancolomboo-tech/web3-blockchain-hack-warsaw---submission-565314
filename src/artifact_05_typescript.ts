import axios from "axios";

export interface StreamEventPayload {
  eventName: "EscrowInitialized" | "StreamClaimed" | "MilestoneReleased" | "VaultCancelled";
  escrowId: string;
  txSignature: string;
  payer?: string;
  beneficiary?: string;
  amountToken?: number;
  timestamp: number;
}

export class EnterpriseDispatcher {
  private resendApiKey: string;
  private enterpriseEmailRecipient: string;
  private enterpriseSlackWebhook: string;

  constructor() {
    this.resendApiKey = process.env.RESEND_API_KEY || "";
    this.enterpriseEmailRecipient = process.env.ENTERPRISE_AUDIT_EMAIL || "cfo@enterprisecorp.pl";
    this.enterpriseSlackWebhook = process.env.SLACK_WEBHOOK_URL || "";
  }

  public async dispatchAuditTrail(payload: StreamEventPayload): Promise<void> {
    console.log(`[DISPATCHER] Processing event: ${payload.eventName} for Escrow ID: ${payload.escrowId}`);

    const slackPromise = this.sendSlackAlert(payload);
    const emailPromise = this.sendResendReceipt(payload);

    const [slackRes, emailRes] = await Promise.allSettled([slackPromise, emailPromise]);

    if (slackRes.status === "rejected") {
      console.error("[DISPATCHER] Slack alert failed:", slackRes.reason?.message || slackRes.reason);
    }
    if (emailRes.status === "rejected") {
      console.error("[DISPATCHER] Resend dispatch failed:", emailRes.reason?.message || emailRes.reason);
    }
  }

  private async sendSlackAlert(payload: StreamEventPayload): Promise<void> {
    if (!this.enterpriseSlackWebhook) {
      console.warn("[DISPATCHER] No SLACK_WEBHOOK_URL specified. Skipping Slack notification.");
      return;
    }

    const blocks = {
      text: `🚨 WSV On-Chain Alert: *${payload.eventName}* (Vault: ${payload.escrowId})`,
      attachments: [
        {
          color: payload.eventName === "VaultCancelled" ? "#FF0000" : "#00FF88",
          fields: [
            { title: "Escrow ID", value: payload.escrowId, short: true },
            { title: "Event Type", value: payload.eventName, short: true },
            { title: "Disbursed / Handled", value: payload.amountToken ? `${payload.amountToken} Tokens` : "N/A", short: true },
            { title: "Transaction Hash", value: `https://solscan.io/tx/${payload.txSignature}?cluster=custom`, short: false }
          ],
          footer: "Warsaw StreamVault Enterprise Sentinel",
          ts: Math.floor(Date.now() / 1000)
        }
      ]
    };

    await axios.post(this.enterpriseSlackWebhook, blocks, {
      headers: { "Content-Type": "application/json" }
    });
    console.log("[DISPATCHER] Slack notification sent successfully.");
  }

  private async sendResendReceipt(payload: StreamEventPayload): Promise<void> {
    if (!this.resendApiKey) {
      console.warn("[DISPATCHER] No RESEND_API_KEY specified. Skipping transactional email.");
      return;
    }

    const emailBody = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #0f172a; margin-bottom: 8px;">Warsaw StreamVault - Cryptographic Audit Proof</h2>
        <p style="color: #64748b; font-size: 14px;">An enterprise settlement action was confirmed on the Solana Network.</p>
        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 16px 0;" />
        
        <table style="width: 100%; font-size: 14px; line-height: 24px;">
          <tr>
            <td style="color: #64748b;">Event Type:</td>
            <td style="font-weight: 600; color: #0f172a;">${payload.eventName}</td>
          </tr>
          <tr>
            <td style="color: #64748b;">Escrow ID:</td>
            <td style="font-family: monospace; font-weight: 600; color: #0f172a;">${payload.escrowId}</td>
          </tr>
          <tr>
            <td style="color: #64748b;">Amount:</td>
            <td style="font-weight: 600; color: #059669;">${payload.amountToken ?? 0} Units</td>
          </tr>
          <tr>
            <td style="color: #64748b;">Signature:</td>
            <td style="font-family: monospace; font-size: 11px; word-break: break-all;">${payload.txSignature}</td>
          </tr>
        </table>
        
        <div style="margin-top: 24px; text-align: center;">
          <a href="https://solscan.io/tx/${payload.txSignature}" style="background-color: #2563eb; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 14px; display: inline-block;">
            Inspect on Solana Explorer
          </a>
        </div>
      </div>
    `;

    await axios.post(
      "https://api.resend.com/emails",
      {
        from: "StreamVault Sentinel <onboarding@resend.dev>",
        to: [this.enterpriseEmailRecipient],
        subject: `[Settlement Confirmed] ${payload.eventName} - Escrow #${payload.escrowId}`,
        html: emailBody
      },
      {
        headers: {
          Authorization: `Bearer ${this.resendApiKey}`,
          "Content-Type": "application/json"
        }
      }
    );
    console.log(`[DISPATCHER] Resend audit email dispatched to ${this.enterpriseEmailRecipient}`);
  }
}