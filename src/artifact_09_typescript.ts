import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import { EnterpriseNotifier } from "./integrations/notifier";
import * as dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const WS_RPC_URL = process.env.SOLANA_WS_RPC_URL || "wss://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.AEGIS_PROGRAM_ID || "Aegis11111111111111111111111111111111111111"
);

// Minimal inline IDL to parse event logs without external files
const IDL_EVENTS_DEF: Idl = {
  version: "0.1.0",
  name: "aegis_escrow",
  instructions: [],
  events: [
    {
      name: "EscrowInitializedEvent",
      fields: [
        { name: "escrowId", type: "u64", index: false },
        { name: "payer", type: "publicKey", index: false },
        { name: "recipient", type: "publicKey", index: false },
        { name: "arbiter", type: "publicKey", index: false },
        { name: "amount", type: "u64", index: false },
        { name: "deadlineTimestamp", type: "i64", index: false },
      ],
    },
    {
      name: "EscrowFundedEvent",
      fields: [
        { name: "escrowId", type: "u64", index: false },
        { name: "payer", type: "publicKey", index: false },
        { name: "amount", type: "u64", index: false },
      ],
    },
    {
      name: "MilestoneSubmittedEvent",
      fields: [
        { name: "escrowId", type: "u64", index: false },
        { name: "recipient", type: "publicKey", index: false },
        { name: "submissionHash", type: { array: ["u8", 32] }, index: false },
        { name: "timestamp", type: "i64", index: false },
      ],
    },
    {
      name: "EscrowReleasedEvent",
      fields: [
        { name: "escrowId", type: "u64", index: false },
        { name: "releasedTo", type: "publicKey", index: false },
        { name: "amount", type: "u64", index: false },
      ],
    },
    {
      name: "DisputeRaisedEvent",
      fields: [
        { name: "escrowId", type: "u64", index: false },
        { name: "raisedBy", type: "publicKey", index: false },
        { name: "timestamp", type: "i64", index: false },
      ],
    },
    {
      name: "DisputeResolvedEvent",
      fields: [
        { name: "escrowId", type: "u64", index: false },
        { name: "payerRefund", type: "u64", index: false },
        { name: "recipientPayout", type: "u64", index: false },
      ],
    },
    {
      name: "EscrowRefundedEvent",
      fields: [
        { name: "escrowId", type: "u64", index: false },
        { name: "refundedTo", type: "publicKey", index: false },
        { name: "amount", type: "u64", index: false },
      ],
    },
  ],
};

async function main() {
  console.log("=================================================");
  console.log("🛡️  AegisPay Enterprise Event & Keeper Daemon");
  console.log(`RPC Endpoint: ${RPC_URL}`);
  console.log(`Listening to Program: ${PROGRAM_ID.toBase58()}`);
  console.log("=================================================");

  const connection = new Connection(RPC_URL, {
    wsEndpoint: WS_RPC_URL,
    commitment: "confirmed",
  });

  const notifier = new EnterpriseNotifier();
  const dummyWallet: any = {
    publicKey: PublicKey.default,
    signTransaction: async (tx: any) => tx,
    signAllTransactions: async (txs: any) => txs,
  };
  const provider = new AnchorProvider(connection, dummyWallet, { commitment: "confirmed" });
  const program = new Program(IDL_EVENTS_DEF, PROGRAM_ID, provider);

  // Subscribe to program event logs
  connection.onLogs(
    PROGRAM_ID,
    async (logsInfo, ctx) => {
      if (logsInfo.err) return;
      const signature = logsInfo.signature;

      for (const log of logsInfo.logs) {
        if (!log.includes("Program data: ")) continue;

        try {
          const eventParser = program.coder.events;
          const parsedEvent = eventParser.parse(log);
          if (!parsedEvent) continue;

          console.log(`[Daemon] Parsed Event: ${parsedEvent.name} in tx ${signature}`);

          let details = "";
          let amount = 0;
          let actor = "";
          const escrowId = parsedEvent.data.escrowId ? parsedEvent.data.escrowId.toString() : "N/A";

          switch (parsedEvent.name) {
            case "EscrowFundedEvent":
              amount = Number(parsedEvent.data.amount);
              actor = parsedEvent.data.payer.toBase58();
              details = `Escrow #${escrowId} funded with ${amount / 1e9} SOL.`;
              break;
            case "MilestoneSubmittedEvent":
              actor = parsedEvent.data.recipient.toBase58();
              details = `Deliverable submitted by recipient. Waiting for approval or dispute.`;
              break;
            case "EscrowReleasedEvent":
              amount = Number(parsedEvent.data.amount);
              actor = parsedEvent.data.releasedTo.toBase58();
              details = `Milestone approved! ${amount / 1e9} SOL released to contractor.`;
              break;
            case "DisputeRaisedEvent":
              actor = parsedEvent.data.raisedBy.toBase58();
              details = `CRITICAL: Dispute raised by ${actor}. Arbiter intervention required.`;
              break;
            case "DisputeResolvedEvent":
              details = `Dispute resolved: Payer refunded ${Number(parsedEvent.data.payerRefund) / 1e9} SOL; Recipient paid ${Number(parsedEvent.data.recipientPayout) / 1e9} SOL.`;
              break;
            case "EscrowRefundedEvent":
              amount = Number(parsedEvent.data.amount);
              actor = parsedEvent.data.refundedTo.toBase58();
              details = `Escrow expired! Refunded ${amount / 1e9} SOL back to Payer.`;
              break;
            default:
              details = `Event ${parsedEvent.name} triggered.`;
          }

          await notifier.broadcast({
            escrowId,
            eventType: parsedEvent.name,
            amountLamports: amount,
            actor: actor || "Solana Account",
            details,
            txHash: signature,
          });
        } catch (err: any) {
          // Log parsing error safeguard
          // console.debug("Log parse error", err.message);
        }
      }
    },
    "confirmed"
  );

  console.log("[Daemon] Subscriptions active. Worker running smoothly.");
}

main().catch((err) => {
  console.error("[Daemon Fatal Error]", err);
  process.exit(1);
});