import { Command } from "commander";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";

const programId = new PublicKey("Aegis11111111111111111111111111111111111111");

function getProvider(keypairPath: string, rpcUrl: string): { provider: AnchorProvider; keypair: Keypair } {
  const secretKey = JSON.parse(fs.readFileSync(path.resolve(keypairPath), "utf-8"));
  const keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(keypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return { provider, keypair };
}

const program = new Command();
program
  .name("aegis-cli")
  .description("Enterprise CLI for managing AegisPay Milestone Escrows on Solana")
  .version("1.0.0");

program
  .command("create")
  .description("Create a new multi-milestone escrow")
  .requiredOption("-k, --keypair <path>", "Path to depositor keypair JSON")
  .requiredOption("-p, --payee <pubkey>", "Payee Solana public key")
  .requiredOption("-a, --arbiter <pubkey>", "Arbiter Solana public key")
  .requiredOption("-f, --fee-recipient <pubkey>", "Fee recipient Solana public key")
  .requiredOption("-m, --milestones <amounts>", "Comma-separated milestone SOL amounts (e.g. 1.5,2.0,1.5)")
  .option("-e, --expiry-days <days>", "Escrow expiration duration in days", "30")
  .option("-r, --rpc <url>", "RPC URL", "https://api.devnet.solana.com")
  .action(async (options) => {
    const { provider, keypair } = getProvider(options.keypair, options.rpc);
    const payee = new PublicKey(options.payee);
    const arbiter = new PublicKey(options.arbiter);
    const feeRecipient = new PublicKey(options.feeRecipient);

    const milestoneFloats = options.milestones.split(",").map((s: string) => parseFloat(s.trim()));
    const milestoneAmounts = milestoneFloats.map((s: number) => new BN(s * LAMPORTS_PER_SOL));
    const totalAmount = milestoneAmounts.reduce((acc: BN, val: BN) => acc.add(val), new BN(0));

    const escrowId = new BN(Date.now());
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), keypair.publicKey.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
      programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      programId
    );

    const now = Math.floor(Date.now() / 1000);
    const expiryTimestamp = new BN(now + parseInt(options.expiryDays, 10) * 86400);

    console.log(`[Aegis CLI] Initializing Escrow PDA: ${escrowPda.toBase58()}`);
    console.log(`[Aegis CLI] Escrow ID: ${escrowId.toString()}`);
    console.log(`[Aegis CLI] Total Commitment: ${totalAmount.toNumber() / LAMPORTS_PER_SOL} SOL across ${milestoneAmounts.length} milestones.`);

    // In a live environment, load IDL from target cluster
    console.log(`[Aegis CLI] Vault PDA prepared: ${vaultPda.toBase58()}`);
    console.log("[Aegis CLI] Escrow setup payload constructed successfully.");
  });

program.parse(process.argv);