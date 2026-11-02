import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";
import { AegisEscrow } from "../target/types/aegis_escrow";

describe("AegisPay Enterprise Escrow Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AegisEscrow as Program<AegisEscrow>;

  const payer = Keypair.generate();
  const recipient = Keypair.generate();
  const arbiter = Keypair.generate();
  const unauthorizedParty = Keypair.generate();

  const escrowId = new anchor.BN(1001);
  const depositAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
  const metadataHash = Array.from(crypto.createHash("sha256").update("Specification v1.0").digest());

  let escrowPDA: PublicKey;
  let vaultPDA: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    for (const kp of [payer, recipient, arbiter, unauthorizedParty]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        ...latestBlockhash,
      });
    }

    [escrowPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("aegis_escrow"), payer.publicKey.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("aegis_vault"), escrowPDA.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes the milestone escrow", async () => {
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600); // 1 hour in future

    await program.methods
      .initializeEscrow(escrowId, depositAmount, deadline, metadataHash)
      .accounts({
        escrow: escrowPDA,
        vault: vaultPDA,
        payer: payer.publicKey,
        recipient: recipient.publicKey,
        arbiter: arbiter.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    const account = await program.account.escrowAccount.fetch(escrowPDA);
    expect(account.escrowId.toString()).to.equal(escrowId.toString());
    expect(account.payer.toBase58()).to.equal(payer.publicKey.toBase58());
    expect(account.recipient.toBase58()).to.equal(recipient.publicKey.toBase58());
    expect(account.arbiter.toBase58()).to.equal(arbiter.publicKey.toBase58());
    expect(JSON.stringify(account.status)).to.include("initialized");
  });

  it("2. Deposits funds into Escrow Vault PDA", async () => {
    const vaultBalBefore = await provider.connection.getBalance(vaultPDA);

    await program.methods
      .depositFunds()
      .accounts({
        escrow: escrowPDA,
        vault: vaultPDA,
        payer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    const vaultBalAfter = await provider.connection.getBalance(vaultPDA);
    expect(vaultBalAfter - vaultBalBefore).to.equal(depositAmount.toNumber());

    const account = await program.account.escrowAccount.fetch(escrowPDA);
    expect(JSON.stringify(account.status)).to.include("funded");
  });

  it("3. Recipient submits milestone deliverable hash", async () => {
    const deliverableHash = Array.from(crypto.createHash("sha256").update("github.com/aegis/pr/42").digest());

    await program.methods
      .submitMilestone(deliverableHash)
      .accounts({
        escrow: escrowPDA,
        recipient: recipient.publicKey,
      })
      .signers([recipient])
      .rpc();

    const account = await program.account.escrowAccount.fetch(escrowPDA);
    expect(JSON.stringify(account.status)).to.include("deliverableSubmitted");
    expect(Buffer.from(account.submissionHash).toString("hex")).to.equal(Buffer.from(deliverableHash).toString("hex"));
  });

  it("4. Prevents unauthorized party from releasing milestone", async () => {
    try {
      await program.methods
        .approveAndRelease()
        .accounts({
          escrow: escrowPDA,
          vault: vaultPDA,
          recipient: recipient.publicKey,
          signer: unauthorizedParty.publicKey,
        })
        .signers([unauthorizedParty])
        .rpc();
      expect.fail("Should have thrown unauthorized error");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedSigner");
    }
  });

  it("5. Raises a dispute by Payer", async () => {
    await program.methods
      .raiseDispute()
      .accounts({
        escrow: escrowPDA,
        signer: payer.publicKey,
      })
      .signers([payer])
      .rpc();

    const account = await program.account.escrowAccount.fetch(escrowPDA);
    expect(JSON.stringify(account.status)).to.include("disputed");
  });

  it("6. Arbiter resolves dispute with 70/30 split (7,000 / 3,000 bps)", async () => {
    const payerPreBalance = await provider.connection.getBalance(payer.publicKey);
    const recipientPreBalance = await provider.connection.getBalance(recipient.publicKey);

    // 70% to Payer, 30% to Recipient
    await program.methods
      .resolveDispute(7000, 3000)
      .accounts({
        escrow: escrowPDA,
        vault: vaultPDA,
        payer: payer.publicKey,
        recipient: recipient.publicKey,
        arbiter: arbiter.publicKey,
      })
      .signers([arbiter])
      .rpc();

    const payerPostBalance = await provider.connection.getBalance(payer.publicKey);
    const recipientPostBalance = await provider.connection.getBalance(recipient.publicKey);

    const payerDelta = payerPostBalance - payerPreBalance;
    const recipientDelta = recipientPostBalance - recipientPreBalance;

    expect(payerDelta).to.equal(0.7 * depositAmount.toNumber());
    expect(recipientDelta).to.equal(0.3 * depositAmount.toNumber());

    const account = await program.account.escrowAccount.fetch(escrowPDA);
    expect(JSON.stringify(account.status)).to.include("resolved");
  });

  it("7. Validates deadline expiration & auto-refund logic", async () => {
    const expiredEscrowId = new anchor.BN(9999);
    const [expEscrowPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("aegis_escrow"), payer.publicKey.toBuffer(), expiredEscrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [expVaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("aegis_vault"), expEscrowPDA.toBuffer()],
      program.programId
    );

    // Initialize with deadline in the past + 2s
    const pastDeadline = new anchor.BN(Math.floor(Date.now() / 1000) + 2);

    await program.methods
      .initializeEscrow(expiredEscrowId, depositAmount, pastDeadline, metadataHash)
      .accounts({
        escrow: expEscrowPDA,
        vault: expVaultPDA,
        payer: payer.publicKey,
        recipient: recipient.publicKey,
        arbiter: arbiter.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    await program.methods
      .depositFunds()
      .accounts({
        escrow: expEscrowPDA,
        vault: expVaultPDA,
        payer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    // Wait 3 seconds to breach deadline
    await new Promise((r) => setTimeout(r, 3000));

    // Claim refund
    await program.methods
      .claimExpiredRefund()
      .accounts({
        escrow: expEscrowPDA,
        vault: expVaultPDA,
        payer: payer.publicKey,
      })
      .signers([payer])
      .rpc();

    const account = await program.account.escrowAccount.fetch(expEscrowPDA);
    expect(JSON.stringify(account.status)).to.include("refunded");
  });
});