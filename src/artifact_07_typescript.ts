import { Command } from "commander";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

const program = new Command();
program
  .name("wsv-cli")
  .description("Warsaw StreamVault Enterprise Treasury Orchestrator")
  .version("1.0.0");

function getProvider(rpcUrl: string, keypairPath: string): { provider: AnchorProvider; walletKeypair: Keypair } {
  const secretKey = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const walletKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(walletKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return { provider, walletKeypair };
}

program
  .command("init-escrow")
  .description("Initialize and deposit funds into a stream & milestone escrow")
  .requiredOption("-e, --escrow-id <number>", "Unique escrow identifier")
  .requiredOption("-b, --beneficiary <pubkey>", "Beneficiary recipient address")
  .requiredOption("-m, --mint <pubkey>", "SPL Token Mint address")
  .requiredOption("-t, --total <amount>", "Total atomic token deposit amount")
  .requiredOption("-s, --stream-amount <amount>", "Portion allocated for linear streaming")
  .requiredOption("-d, --duration <seconds>", "Streaming duration in seconds")
  .option("-k, --keypair <path>", "Path to authority keypair", process.env.ANCHOR_WALLET || "./id.json")
  .option("-r, --rpc <url>", "Solana RPC URL", process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com")
  .action(async (options) => {
    try {
      const { provider, walletKeypair } = getProvider(options.rpc, options.keypair);
      const programId = new PublicKey(process.env.PROGRAM_ID || "WsV1111111111111111111111111111111111111111");

      const idl = JSON.parse(fs.readFileSync("./target/idl/stream_vault.json", "utf8"));
      const anchorProgram = new Program(idl, provider);

      const escrowIdBN = new BN(options.escrowId);
      const beneficiaryPubkey = new PublicKey(options.beneficiary);
      const mintPubkey = new PublicKey(options.mint);
      const totalBN = new BN(options.total);
      const streamAmountBN = new BN(options.streamAmount);

      const now = Math.floor(Date.now() / 1000);
      const startTime = new BN(now);
      const endTime = new BN(now + parseInt(options.duration));

      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), walletKeypair.publicKey.toBuffer(), escrowIdBN.toArrayLike(Buffer, "le", 8)],
        programId
      );

      const [vaultTokenPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_token"), escrowPda.toBuffer()],
        programId
      );

      const payerTokenAta = getAssociatedTokenAddressSync(mintPubkey, walletKeypair.publicKey);

      console.log(`[INIT] Escrow PDA: ${escrowPda.toBase58()}`);
      console.log(`[INIT] Vault ATA: ${vaultTokenPda.toBase58()}`);

      const tx = await (anchorProgram.methods as any)
        .initializeEscrow(escrowIdBN, totalBN, streamAmountBN, startTime, endTime, 3)
        .accounts({
          escrow: escrowPda,
          payer: walletKeypair.publicKey,
          beneficiary: beneficiaryPubkey,
          arbiter: walletKeypair.publicKey,
          mint: mintPubkey,
          payerTokenAccount: payerTokenAta,
          vaultTokenAccount: vaultTokenPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      console.log(`\x1b[32m✔ Escrow successfully created. Tx signature:\x1b[0m ${tx}`);
    } catch (err: any) {
      console.error("\x1b[31m✘ Transaction Failed:\x1b[0m", err);
    }
  });

program
  .command("claim")
  .description("Withdraw accrued streaming tokens for beneficiary")
  .requiredOption("-p, --payer <pubkey>", "Payer who created the escrow")
  .requiredOption("-e, --escrow-id <number>", "Escrow ID")
  .requiredOption("-m, --mint <pubkey>", "Token mint")
  .option("-k, --keypair <path>", "Beneficiary keypair path", "./beneficiary.json")
  .option("-r, --rpc <url>", "Solana RPC URL", "https://api.devnet.solana.com")
  .action(async (options) => {
    try {
      const { provider, walletKeypair } = getProvider(options.rpc, options.keypair);
      const programId = new PublicKey(process.env.PROGRAM_ID || "WsV1111111111111111111111111111111111111111");
      const idl = JSON.parse(fs.readFileSync("./target/idl/stream_vault.json", "utf8"));
      const anchorProgram = new Program(idl, provider);

      const payerPubkey = new PublicKey(options.payer);
      const escrowIdBN = new BN(options.escrowId);
      const mintPubkey = new PublicKey(options.mint);

      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), payerPubkey.toBuffer(), escrowIdBN.toArrayLike(Buffer, "le", 8)],
        programId
      );

      const [vaultTokenPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_token"), escrowPda.toBuffer()],
        programId
      );

      const beneficiaryTokenAta = getAssociatedTokenAddressSync(mintPubkey, walletKeypair.publicKey);

      const tx = await (anchorProgram.methods as any)
        .claimStream()
        .accounts({
          escrow: escrowPda,
          beneficiary: walletKeypair.publicKey,
          vaultTokenAccount: vaultTokenPda,
          beneficiaryTokenAccount: beneficiaryTokenAta,
          mint: mintPubkey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      console.log(`\x1b[32m✔ Stream claimed successfully. Tx signature:\x1b[0m ${tx}`);
    } catch (err: any) {
      console.error("\x1b[31m✘ Claim Failed:\x1b[0m", err);
    }
  });

program.parse(process.argv);