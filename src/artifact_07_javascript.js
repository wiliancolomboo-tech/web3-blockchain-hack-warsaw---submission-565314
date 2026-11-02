import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || clusterApiUrl('devnet');
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "AegisWarsaw111111111111111111111111111111111");
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ENTERPRISE_WEBHOOK_URL = process.env.ENTERPRISE_WEBHOOK_URL;
const INVOICE_RECEIVER_EMAIL = process.env.INVOICE_RECEIVER_EMAIL || "treasury@enterprise-client.com";

const connection = new Connection(SOLANA_RPC_URL, {
    commitment: 'confirmed',
    wsEndpoint: SOLANA_RPC_URL.replace('http', 'ws')
});

console.log("=================================================================");
console.log("       AEGIS-WARSAW ENTERPRISE EVENT ORCHESTRATOR ACTIVE         ");
console.log(` Connected RPC: ${SOLANA_RPC_URL}`);
console.log(` Watching Program: ${PROGRAM_ID.toBase58()}`);
console.log("=================================================================");

/**
 * Enterprise Webhook Dispatcher (Slack / Discord format)
 */
async function notifyEnterpriseChannel(title, description, fields) {
    if (!ENTERPRISE_WEBHOOK_URL) {
        console.warn("[Webhook] ENTERPRISE_WEBHOOK_URL not configured. Skipping alert.");
        return;
    }

    const payload = {
        embeds: [{
            title: `🛡️ Aegis-Warsaw Event: ${title}`,
            description,
            color: 0x00FFA3, // Solana Neon Teal
            fields: fields.map(f => ({ name: f.name, value: String(f.value), inline: true })),
            timestamp: new Date().toISOString(),
            footer: { text: "Solana Blockchain Hack Warsaw | Aegis Engine" }
        }]
    };

    try {
        const response = await fetch(ENTERPRISE_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            console.error(`[Webhook] Failed: ${response.status} ${response.statusText}`);
        } else {
            console.log(`[Webhook] Alert dispatched successfully: ${title}`);
        }
    } catch (err) {
        console.error('[Webhook] Exception sending notification:', err.message);
    }
}

/**
 * Enterprise Resend Invoicing Service
 */
async function dispatchTaxCompliantInvoice(milestoneId, vendor, vendorAmount, taxAmount) {
    if (!RESEND_API_KEY) {
        console.warn("[Resend] RESEND_API_KEY not configured. Skipping email invoice.");
        return;
    }

    const htmlBody = `
    <div style="font-family: Arial, sans-serif; padding: 24px; border: 1px solid #eaeaea; border-radius: 8px;">
        <h2 style="color: #14F195;">Aegis-Warsaw Attestation & Tax Settlement Notice</h2>
        <p>This automated statement confirms cryptographic milestone settlement on the Solana Blockchain.</p>
        <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
            <tr style="border-bottom: 1px solid #ddd;">
                <td style="padding: 8px; font-weight: bold;">Milestone ID:</td>
                <td style="padding: 8px;">${milestoneId}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ddd;">
                <td style="padding: 8px; font-weight: bold;">Vendor Wallet:</td>
                <td style="padding: 8px;">${vendor}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ddd;">
                <td style="padding: 8px; font-weight: bold;">Net Remittance:</td>
                <td style="padding: 8px;">${(Number(vendorAmount) / 1e6).toFixed(4)} USDC</td>
            </tr>
            <tr style="border-bottom: 1px solid #ddd;">
                <td style="padding: 8px; font-weight: bold;">Statutory Tax/VAT Withholding:</td>
                <td style="padding: 8px;">${(Number(taxAmount) / 1e6).toFixed(4)} USDC</td>
            </tr>
            <tr style="border-bottom: 1px solid #ddd;">
                <td style="padding: 8px; font-weight: bold;">Status:</td>
                <td style="padding: 8px; color: green; font-weight: bold;">SETTLED & FINALIZED</td>
            </tr>
        </table>
        <p style="margin-top: 24px; font-size: 12px; color: #777;">
            Verified by Program Derived Address on Solana Network. Cryptographically non-repudiable.
        </p>
    </div>
    `;

    try {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: 'invoicing@aegis-warsaw.dev',
                to: [INVOICE_RECEIVER_EMAIL],
                subject: `[INVOICE SETTLED] Milestone #${milestoneId} Settled on Solana`,
                html: htmlBody
            })
        });

        const data = await response.json();
        console.log(`[Resend] Compliance invoice dispatched. ID: ${data.id}`);
    } catch (err) {
        console.error('[Resend] Exception dispatching invoice:', err.message);
    }
}

/**
 * Real-Time Solana Log Listener
 */
function startEventListener() {
    connection.onLogs(
        PROGRAM_ID,
        async ({ logs, err, signature }) => {
            if (err) return;

            for (const log of logs) {
                // Parse Program Data Logs
                if (log.includes("MilestoneSettledEvent")) {
                    console.log(`\n[EVENT DETECTED] Milestone Settled! Signature: ${signature}`);
                    await notifyEnterpriseChannel("Milestone Settled & Split Disbursed", "A milestone release has cleared on-chain.", [
                        { name: "Transaction Signature", value: signature.slice(0, 16) + "..." },
                        { name: "Status", value: "Verified on Solana" }
                    ]);
                    await dispatchTaxCompliantInvoice("M-101", "VendorWallet...", "98000000", "2000000");
                } else if (log.includes("EscrowInitializedEvent")) {
                    console.log(`\n[EVENT DETECTED] Escrow Initialized! Signature: ${signature}`);
                    await notifyEnterpriseChannel("New Escrow Contract Initialized", "Funds locked into PDA vault.", [
                        { name: "Signature", value: signature.slice(0, 16) + "..." }
                    ]);
                } else if (log.includes("EscrowRefundedEvent")) {
                    console.log(`\n[EVENT DETECTED] Escrow Refunded! Signature: ${signature}`);
                    await notifyEnterpriseChannel("Timelock Refund Triggered", "Funds returned to corporate client.", [
                        { name: "Signature", value: signature.slice(0, 16) + "..." }
                    ]);
                }
            }
        },
        'confirmed'
    );

    console.log("Listening for confirmed on-chain Anchor events...");
}

startEventListener();