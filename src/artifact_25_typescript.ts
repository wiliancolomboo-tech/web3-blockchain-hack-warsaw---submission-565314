import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Solveritas } from "../target/types/solveritas";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import crypto from "crypto";

describe("solveritas-e2e-matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Solveritas as Program<Solveritas>;

  const funder = Keypair.generate();
  const worker = Keypair.generate();
  const arbitrator = Keypair.generate();

  const escrowId = new anchor.BN(Date.now());
  const escrowAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
  const reviewWindow = new anchor.BN(2); // 2 seconds for test speed
  const metadataHash = Array.from(crypto.createHash("sha256").update("SLA-SPEC-WARSAW-001").digest());
  const submissionHash = Array.from(crypto.createHash("sha256").update("GITHUB-COMMIT-DELIVERY-PR42").digest());
  const disputeEvidenceHash = Array.from(crypto.createHash("sha256").update("EVIDENCE-BROKEN-INTEGRATION").digest());

  let escrowPda: PublicKey;
  let vaultPda: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    const sig1 = await provider.connection.requestAirdrop(funder.publicKey, 10 * LAMPORTS_PER_SOL);
    const sig2 = await provider.connection.requestAirdrop(worker.publicKey, 2 * LAMPORTS_PER_SOL);
    const sig3 = await provider.connection.requestAirdrop(arbitrator.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig1);
    await provider.connection.confirmTransaction(sig2);
    await provider.connection.confirmTransaction(sig3);

    const idBuf = Buffer.alloc(8);
    idBuf.writeBigUInt64LE(BigInt(escrowId.toString()));

    [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), funder.publicKey.toBuffer(), idBuf],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes an Escrow with PDA Vault locks", async () => {
    const tx = await program.methods
      .initializeEscrow(escrowId, escrowAmount, reviewWindow, metadataHash)
      .accounts({
        funder: funder.publicKey,
        worker: worker.publicKey,
        arbitrator: arbitrator.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([funder])
      .rpc();

    expect(tx).to.be.a("string");

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccount.escrowId.toString()).to.equal(escrowId.toString());
    expect(escrowAccount.funder.toBase58()).to.equal(funder.publicKey.toBase58());
    expect(escrowAccount.worker.toBase58()).to.equal(worker.publicKey.toBase58());
    expect(escrowAccount.totalAmount.toNumber()).to.equal(1 * LAMPORTS_PER_SOL);

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.equal(1 * LAMPORTS_PER_SOL);
  });

  it("2. Rejects unauthorized worker submissions", async () => {
    const attacker = Keypair.generate();
    await provider.connection.requestAirdrop(attacker.publicKey, 1 * LAMPORTS_PER_SOL);

    try {
      await program.methods
        .submitMilestone(submissionHash)
        .accounts({
          worker: attacker.publicKey,
          escrow: escrowPda,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have failed with Unauthorized");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("Unauthorized");
    }
  });

  it("3. Contributor submits valid deliverable hash", async () => {
    await program.methods
      .submitMilestone(submissionHash)
      .accounts({
        worker: worker.publicKey,
        escrow: escrowPda,
      })
      .signers([worker])
      .rpc();

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccount.submissionTimestamp.toNumber()).to.be.greaterThan(0);
  });

  it("4. Rejects premature timeout release before review SLA expiry", async () => {
    try {
      await program.methods
        .claimTimeoutRelease()
        .accounts({
          worker: worker.publicKey,
          escrow: escrowPda,
          vault: vaultPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker])
        .rpc();
      expect.fail("Premature claim should have failed");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ReviewWindowStillActive");
    }
  });

  it("5. Allows funder to approve milestone and transfers lamports cleanly", async () => {
    const workerInitialBalance = await provider.connection.getBalance(worker.publicKey);

    await program.methods
      .approveMilestone()
      .accounts({
        funder: funder.publicKey,
        worker: worker.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([funder])
      .rpc();

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccount.state).to.deep.equal({ completed: {} });

    const workerFinalBalance = await provider.connection.getBalance(worker.publicKey);
    expect(workerFinalBalance - workerInitialBalance).to.equal(1 * LAMPORTS_PER_SOL);

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.equal(0);
  });

  it("6. Scenario B: Dispute and Arbitration 50/50 Split", async () => {
    const escrowId2 = new anchor.BN(Date.now() + 100);
    const idBuf2 = Buffer.alloc(8);
    idBuf2.writeBigUInt64LE(BigInt(escrowId2.toString()));

    const [escrowPda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), funder.publicKey.toBuffer(), idBuf2],
      program.programId
    );
    const [vaultPda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda2.toBuffer()],
      program.programId
    );

    // Initialize second escrow
    await program.methods
      .initializeEscrow(escrowId2, escrowAmount, reviewWindow, metadataHash)
      .accounts({
        funder: funder.publicKey,
        worker: worker.publicKey,
        arbitrator: arbitrator.publicKey,
        escrow: escrowPda2,
        vault: vaultPda2,
        systemProgram: SystemProgram.programId,
      })
      .signers([funder])
      .rpc();

    // Funder raises dispute
    await program.methods
      .raiseDispute(disputeEvidenceHash)
      .accounts({
        caller: funder.publicKey,
        escrow: escrowPda2,
      })
      .signers([funder])
      .rpc();

    const disputedAccount = await program.account.escrowAccount.fetch(escrowPda2);
    expect(disputedAccount.state).to.deep.equal({ disputed: {} });

    // Arbitrator resolves with 50/50 split (0.5 SOL each)
    const halfSol = new anchor.BN(0.5 * LAMPORTS_PER_SOL);

    await program.methods
      .resolveDispute(halfSol, halfSol)
      .accounts({
        arbitrator: arbitrator.publicKey,
        funder: funder.publicKey,
        worker: worker.publicKey,
        escrow: escrowPda2,
        vault: vaultPda2,
        systemProgram: SystemProgram.programId,
      })
      .signers([arbitrator])
      .rpc();

    const finalizedAccount = await program.account.escrowAccount.fetch(escrowPda2);
    expect(finalizedAccount.state).to.deep.equal({ completed: {} });

    const remainingVaultBalance = await provider.connection.getBalance(vaultPda2);
    expect(remainingVaultBalance).to.equal(0);
  });
});