import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import { EnterpriseNotifier } from "./notifier";
import * as dotenv from "dotenv";

dotenv.config();

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "WarsawArb1ter1111111111111111111111111111111"
);
const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const WS_URL = process.env.SOLANA_WS_URL || "ws://127.0.0.1:8900";

async function runDaemon() {
  console.log("==================================================");
  console.log("🚀 Warsaw Arbiter Enterprise Daemon Initializing");
  console.log(`📡 RPC Endpoint: ${RPC_URL}`);
  console.log(`🔐 Program ID: ${PROGRAM_ID.toBase58()}`);
  console.log("==================================================");

  const connection = new Connection(RPC_URL, {
    wsEndpoint: WS_URL,
    commitment: "confirmed",
  });

  const notifier = new EnterpriseNotifier();

  // Listen to program logs for events
  connection.onLogs(
    PROGRAM_ID,
    async (logs, ctx) => {
      if (logs.err) return;

      for (const log of logs.logs) {
        // Detect Program Data events (BountySettledEvent)
        if (log.includes("BountySettledEvent")) {
          console.log(`[Event Detected] Bounty Settled in tx: ${logs.signature}`);
          
          await notifier.notifySlackOrDiscord(
            "Bounty Settlement Finalized",
            `Escrow payout executed on-chain at slot ${ctx.slot}.`,
            {
              "Transaction": logs.signature.slice(0, 12) + "...",
              "Slot": ctx.slot.toString(),
            }
          );
        } else if (log.includes("SubmissionRegisteredEvent")) {
          console.log(`[Event Detected] New Submission Registered in tx: ${logs.signature}`);
          await notifier.notifySlackOrDiscord(
            "New Project Submitted",
            `A developer has anchored a submission manifest on-chain.`,
            {
              "Tx": logs.signature.slice(0, 12) + "...",
              "Slot": ctx.slot.toString(),
            }
          );
        }
      }
    },
    "confirmed"
  );

  console.log("🟢 WebSocket Subscriptions Active. Awaiting on-chain activity...");
}

runDaemon().catch((err) => {
  console.error("Fatal daemon crash:", err);
  process.exit(1);
});