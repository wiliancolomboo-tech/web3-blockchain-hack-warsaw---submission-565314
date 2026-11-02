import { Command } from "commander";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as crypto from "crypto";
import * as dotenv from "dotenv";

dotenv.config();

const program = new Command();
program.name("aegis-cli").description("AegisPay Enterprise CLI Management Suite").version("1.0.0");

function getProvider(keypairPath: string, rpcUrl: string): AnchorProvider {
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const keypair = Keypair.fromSecretKey(new Uint8Array(secret));
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(keypair);
  return new AnchorProvider(connection, wallet, { commitment: "confirmed" });
}

function deriveEscrowPDA(payer: PublicKey, escrowId: BN, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("aegis_escrow"), payer.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
    programId
  );
}

function deriveVaultPDA(escrowPDA: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("aegis_vault"), escrowPDA.toBuffer()],
    programId
  );
}

program
  .command("init-and-fund")
  .description("Initialize and deposit funds into a new milestone escrow agreement")
  .requiredOption("-k, --keypair <path>", "Path to payer keypair JSON", "~/.config/solana/id.json")
  .requiredOption("-r, --recipient <pubkey>", "Recipient public key")
  .requiredOption("-a, --arbiter <pubkey>", "Arbiter public key")
  .requiredOption("-s, --sol <amount>", "Amount of SOL to deposit", "0.5")
  .requiredOption("-d, --duration <seconds>", "Escrow expiration duration in seconds", "86400")
  .action(async (opts) => {
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    const provider = getProvider(opts.keypair, rpcUrl);
    const programId = new PublicKey(process.env.AEGIS_PROGRAM_ID || "Aegis11111111111111111111111111111111111111");
    
    // Load IDL
    const idl = JSON.parse(fs.readFileSync("./target/idl/aegis_escrow.json", "utf-8"));
    const aegisProgram = new Program(idl, programId, provider);

    const escrowId = new BN(Date.now());
    const amountLamports = new BN(parseFloat(opts.sol) * LAMPORTS_PER_SOL);
    const deadline = new BN(Math.floor(Date.now() / 1000) + parseInt(opts.duration, 10));
    
    const milestoneHash = crypto.createHash("sha256").update(`Milestone-${escrowId.toString()}`).digest();

    const [escrowPDA] = deriveEscrowPDA(provider.wallet.publicKey, escrowId, programId);
    const [vaultPDA] = deriveVaultPDA(escrowPDA, programId);

    console.log(`Creating Escrow #${escrowId.toString()}...`);
    console.log(`Escrow PDA: ${escrowPDA.toBase58()}`);
    console.log(`Vault PDA: ${vaultPDA.toBase58()}`);

    const tx1 = await aegisProgram.methods
      .initializeEscrow(escrowId, amountLamports, deadline, Array.from(milestoneHash))
      .accounts({
        escrow: escrowPDA,
        vault: vaultPDA,
        payer: provider.wallet.publicKey,
        recipient: new PublicKey(opts.recipient),
        arbiter: new PublicKey(opts.arbiter),
      })
      .rpc();

    console.log(`✅ Escrow Initialized. Tx: ${tx1}`);

    const tx2 = await aegisProgram.methods
      .depositFunds()
      .accounts({
        escrow: escrowPDA,
        vault: vaultPDA,
        payer: provider.wallet.publicKey,
      })
      .rpc();

    console.log(`✅ Escrow Vault Funded with ${opts.sol} SOL. Tx: ${tx2}`);
  });

program.parse(process.argv);