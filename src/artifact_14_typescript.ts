export interface SettlementPayload {
  bountyId: string;
  submissionId: string;
  winner: string;
  amountSol: number;
  txSignature: string;
}

export class EnterpriseNotifier {
  private resendApiKey: string;
  private webhookUrl: string;
  private fromEmail: string;

  constructor() {
    this.resendApiKey = process.env.RESEND_API_KEY || "";
    this.webhookUrl = process.env.NOTIFICATION_WEBHOOK_URL || "";
    this.fromEmail = process.env.NOTIFICATION_FROM_EMAIL || "bounties@warsaw-arbiter.io";
  }

  public async notifySlackOrDiscord(title: string, message: string, fields: Record<string, string>) {
    if (!this.webhookUrl) {
      console.warn("[Notifier] No webhook URL configured, skipping chat notification.");
      return;
    }

    const payload = {
      content: `🏆 **${title}**\n${message}`,
      embeds: [
        {
          title,
          description: message,
          color: 0x14f195, // Solana green
          fields: Object.entries(fields).map(([name, value]) => ({
            name,
            value,
            inline: true,
          })),
          timestamp: new Date().toISOString(),
        },
      ],
    };

    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        console.error(`[Notifier] Webhook failed with status ${response.status}`);
      } else {
        console.log("[Notifier] Chat Webhook published successfully.");
      }
    } catch (err) {
      console.error("[Notifier] Webhook dispatch error:", err);
    }
  }

  public async sendResendAttestationEmail(recipientEmail: string, settlement: SettlementPayload) {
    if (!this.resendApiKey) {
      console.warn("[Notifier] No Resend API key configured, skipping email dispatch.");
      return;
    }

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; background-color: #0b0e14; color: #ffffff; padding: 30px; border-radius: 8px;">
        <h1 style="color: #14f195;">Warsaw Arbiter: Bounty Settlement Attestation</h1>
        <p>Congratulations! Your submission has met multi-judge consensus and escrow funds have been disbursed.</p>
        <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
          <tr><td style="padding: 8px; border-bottom: 1px solid #222;"><strong>Bounty ID:</strong></td><td style="padding: 8px; border-bottom: 1px solid #222;">#${settlement.bountyId}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #222;"><strong>Submission ID:</strong></td><td style="padding: 8px; border-bottom: 1px solid #222;">#${settlement.submissionId}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #222;"><strong>Winner Wallet:</strong></td><td style="padding: 8px; border-bottom: 1px solid #222;">${settlement.winner}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #222;"><strong>Payout Amount:</strong></td><td style="padding: 8px; border-bottom: 1px solid #222;">${settlement.amountSol} SOL</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #222;"><strong>Transaction Signature:</strong></td><td style="padding: 8px; border-bottom: 1px solid #222;"><a href="https://solscan.io/tx/${settlement.txSignature}?cluster=custom" style="color: #14f195;">${settlement.txSignature.slice(0, 16)}...</a></td></tr>
        </table>
        <p style="margin-top: 30px; font-size: 12px; color: #888;">Cryptographically verified on Solana via Warsaw Arbiter Protocol.</p>
      </div>
    `;

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: [recipientEmail],
          subject: `[Settlement Verified] ${settlement.amountSol} SOL Disbursed for Bounty #${settlement.bountyId}`,
          html: htmlBody,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Notifier] Resend email dispatch failed: ${errorText}`);
      } else {
        console.log(`[Notifier] Verification email successfully sent via Resend to ${recipientEmail}`);
      }
    } catch (err) {
      console.error("[Notifier] Resend error:", err);
    }
  }
}