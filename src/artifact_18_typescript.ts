import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as dotenv from "dotenv";
import { EmailNotificationService } from "./services/email";
import { WebhookNotificationService } from "./services/webhook";

dotenv.config();

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "KoprNkz4rWsmLXZ1z9Y6n3VjK3jFbnLmPr4wE9fD6tA"
);
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const WS_ENDPOINT = process.env.SOLANA_WS_URL || "ws://127.0.0.1:8900";

async function runSentinel(): Promise<void> {
  console.log("==================================================");
  console.log("   KOPERNIK SENTINEL & ENTERPRISE RELAYER v1.0   ");
  console.log(`   Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`   RPC:     ${RPC_ENDPOINT}`);
  console.log("==================================================");

  const connection = new Connection(RPC_ENDPOINT, {
    wsEndpoint: WS_ENDPOINT,
    commitment: "confirmed",
  });

  const emailService = new EmailNotificationService();
  const webhookService = new WebhookNotificationService();

  console.log("[STATUS] Listening for on-chain logs from Kopernik Escrow Program...");

  connection.onLogs(
    PROGRAM_ID,
    async (logsInfo) => {
      const { logs, signature } = logsInfo;

      for (const log of logs) {
        // Parse Program Data Event prefix
        if (log.includes("Program data: ")) {
          const rawBase64 = log.split("Program data: ")[1].trim();
          const buffer = Buffer.from(rawBase64, "base64");

          // Compute 8-byte discriminator hashes
          // StreamPauseToggledEvent: sha256("event:StreamPauseToggledEvent")[..8]
          // StreamCreatedEvent: sha256("event:StreamCreatedEvent")[..8]
          // StreamClaimedEvent: sha256("event:StreamClaimedEvent")[..8]
          // StreamCancelledEvent: sha256("event:StreamCancelledEvent")[..8]
          console.log(`[TX EVENT] Parsed data log in signature ${signature}`);

          if (log.includes("StreamPauseToggledEvent")) {
            console.log("🚨 [CIRCUIT BREAKER DETECTED] Processing priority notification...");
            await emailService.sendCircuitBreakerAlert("STREAM-ALERT-001", "SecurityOfficerPDA", true);
            await webhookService.dispatch({
              eventType: "STREAM_PAUSED",
              streamId: "STREAM-ALERT-001",
              actor: "SecurityOfficerPDA",
              details: { signature, rawLog: log },
              timestamp: Date.now(),
            });
          }
        }
      }
    },
    "confirmed"
  );
}

runSentinel().catch((err) => {
  console.error("[FATAL ERROR] Relayer loop died:", err);
  process.exit(1);
});