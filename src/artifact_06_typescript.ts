import { Connection, PublicKey } from "@solana/web3.js";
import { EnterpriseDispatcher } from "./dispatcher";
import * as dotenv from "dotenv";

dotenv.config();

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "WsV1111111111111111111111111111111111111111"
);
const RPC_WS_URL = process.env.SOLANA_WS_URL || "wss://api.devnet.solana.com";
const RPC_HTTP_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

export async function runEventDaemon() {
  console.log("=================================================");
  console.log("   WSV Sentinel Event Listener Daemon Active     ");
  console.log(`   Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`   RPC WS:  ${RPC_WS_URL}`);
  console.log("=================================================");

  const connection = new Connection(RPC_HTTP_URL, {
    wsEndpoint: RPC_WS_URL,
    commitment: "confirmed"
  });

  const dispatcher = new EnterpriseDispatcher();

  connection.onLogs(
    PROGRAM_ID,
    async (logsInfo, ctx) => {
      if (logsInfo.err) return;

      const signature = logsInfo.signature;
      const logs = logsInfo.logs;

      for (const log of logs) {
        if (log.includes("StreamClaimedEvent")) {
          console.log(`[DAEMON] Detected StreamClaimed in tx: ${signature}`);
          await dispatcher.dispatchAuditTrail({
            eventName: "StreamClaimed",
            escrowId: "DYNAMIC_PARSE",
            txSignature: signature,
            amountToken: 0,
            timestamp: Date.now()
          });
        } else if (log.includes("MilestoneReleasedEvent")) {
          console.log(`[DAEMON] Detected MilestoneReleased in tx: ${signature}`);
          await dispatcher.dispatchAuditTrail({
            eventName: "MilestoneReleased",
            escrowId: "DYNAMIC_PARSE",
            txSignature: signature,
            amountToken: 0,
            timestamp: Date.now()
          });
        } else if (log.includes("VaultCancelledEvent")) {
          console.log(`[DAEMON] Detected VaultCancelled in tx: ${signature}`);
          await dispatcher.dispatchAuditTrail({
            eventName: "VaultCancelled",
            escrowId: "DYNAMIC_PARSE",
            txSignature: signature,
            timestamp: Date.now()
          });
        }
      }
    },
    "confirmed"
  );
}

if (require.main === module) {
  runEventDaemon().catch(err => {
    console.error("Daemon fatal crash:", err);
    process.exit(1);
  });
}