import { Command } from "commander";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { config } from "./config";
import { SolVeritasSDK } from "./solveritas-sdk";

const program = new Command();

function loadKeypair(path: string): Keypair {
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf-8")));
  return Keypair.fromSecretKey(secretKey);
}

program
  .name("solveritas-cli")
  .description("Enterprise CLI management tool for SolVeritas Escrows on Solana")
  .version("1.0.0");

program
  .command("derive-pda")
  .description("Derive the Escrow PDA and Vault PDA")
  .requiredOption("-f, --funder <pubkey>", "Funder public key")
  .requiredOption("-i, --id <number>", "Escrow ID")
  .action((opts) => {
    const sdk = new SolVeritasSDK(new Connection(config.solanaRpcUrl), config.programId);
    const funderPubkey = new PublicKey(opts.funder);
    const [escrowPda, bump] = sdk.getEscrowPda(funderPubkey, BigInt(opts.id));
    const [vaultPda, vaultBump] = sdk.getVaultPda(escrowPda);

    console.log("--- PDA Derivation Result ---");
    console.log(`Escrow PDA: ${escrowPda.toBase58()} (bump: ${bump})`);
    console.log(`Vault PDA:  ${vaultPda.toBase58()} (bump: ${vaultBump})`);
  });

program
  .command("check-balance")
  .description("Query SOL balance of an escrow vault")
  .requiredOption("-v, --vault <pubkey>", "Vault PDA public key")
  .action(async (opts) => {
    const connection = new Connection(config.solanaRpcUrl, "confirmed");
    const vaultKey = new PublicKey(opts.vault);
    const balance = await connection.getBalance(vaultKey);
    console.log(`Vault ${vaultKey.toBase58()} balance: ${balance / LAMPORTS_PER_SOL} SOL (${balance} lamports)`);
  });

program.parse(process.argv);