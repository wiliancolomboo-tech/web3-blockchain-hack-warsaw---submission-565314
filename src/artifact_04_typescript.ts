import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import crypto from "crypto";

describe("Warsaw StreamShield Contract Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Access the compiled program
  const program = anchor.workspace.Streamshield as Program<any>;

  const client = Keypair.generate();
  const vendor = Keypair.generate();
  const arbiter = Keypair.generate();
  const escrowId = new anchor.BN(Date.now());

  const milestone1Amount = new anchor.BN(1 * LAMPORTS_PER_SOL);
  const milestone2Amount = new anchor.BN(2 * LAMPORTS_PER_SOL);
  const amounts = [milestone1Amount, milestone2Amount];
  const titles = ["Deliverable Alpha - Core Engine", "Deliverable Beta - Enterprise API"];

  let escrowPda: PublicKey;
  let escrowBump: number;

  before(async () => {
    // Airdrop funds to client and arbiter
    const sig1 = await provider.connection.requestAirdrop(client.publicKey, 10 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig1);

    const sig2 = await provider.connection.requestAirdrop(arbiter.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig2);

    [escrowPda, escrowBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("streamshield_escrow"),
        client.publicKey.toBuffer(),
        escrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
  });

  it("Initializes the escrow and transfers 3 SOL into PDA", async () => {
    await program.methods
      .initializeEscrow(escrowId, amounts, titles)
      .accounts({
        escrowAccount: escrowPda,
        client: client.publicKey,
        vendor: vendor.publicKey,
        arbiter: arbiter.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([client])
      .rpc();

    const escrowData = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowData.client.toBase58()).to.equal(client.publicKey.toBase58());
    expect(escrowData.vendor.toBase58()).to.equal(vendor.publicKey.toBase58());
    expect(escrowData.arbiter.toBase58()).to.equal(arbiter.publicKey.toBase58());
    expect(escrowData.totalAmount.toNumber()).to.equal(3 * LAMPORTS_PER_SOL);
    expect(escrowData.remainingBalance.toNumber()).to.equal(3 * LAMPORTS_PER_SOL);
    expect(escrowData.isDisputed).to.equal(false);
    expect(escrowData.milestones.length).to.equal(2);

    const pdaLamports = await provider.connection.getBalance(escrowPda);
    expect(pdaLamports).to.be.gte(3 * LAMPORTS_PER_SOL);
  });

  it("Allows vendor to submit a deliverable SHA256 digest for Milestone 0", async () => {
    const deliverableHash = crypto.createHash("sha256").update("Alpha Release Codebase v1.0.0").digest();

    await program.methods
      .submitDeliverable(0, Array.from(deliverableHash))
      .accounts({
        escrowAccount: escrowPda,
        vendor: vendor.publicKey,
      })
      .signers([vendor])
      .rpc();

    const escrowData = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowData.milestones[0].status).to.deep.equal({ submitted: {} });
    expect(escrowData.milestones[0].deliverableHash).to.deep.equal(Array.from(deliverableHash));
  });

  it("Allows client to release Milestone 0 and transfers 1 SOL to vendor", async () => {
    const vendorBalBefore = await provider.connection.getBalance(vendor.publicKey);

    await program.methods
      .releaseMilestone(0)
      .accounts({
        escrowAccount: escrowPda,
        client: client.publicKey,
        vendor: vendor.publicKey,
      })
      .signers([client])
      .rpc();

    const vendorBalAfter = await provider.connection.getBalance(vendor.publicKey);
    expect(vendorBalAfter - vendorBalBefore).to.equal(1 * LAMPORTS_PER_SOL);

    const escrowData = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowData.milestones[0].status).to.deep.equal({ approved: {} });
    expect(escrowData.remainingBalance.toNumber()).to.equal(2 * LAMPORTS_PER_SOL);
  });

  it("Prevents non-client from releasing milestones", async () => {
    const maliciousActor = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(maliciousActor.publicKey, 1 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .releaseMilestone(1)
        .accounts({
          escrowAccount: escrowPda,
          client: maliciousActor.publicKey,
          vendor: vendor.publicKey,
        })
        .signers([maliciousActor])
        .rpc();
      expect.fail("Should have thrown unauthorized client error");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedClient");
    }
  });

  it("Allows client to raise a dispute, locking any further releases", async () => {
    await program.methods
      .raiseDispute()
      .accounts({
        escrowAccount: escrowPda,
        caller: client.publicKey,
      })
      .signers([client])
      .rpc();

    const escrowData = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowData.isDisputed).to.equal(true);

    // Attempting release now must fail
    try {
      await program.methods
        .releaseMilestone(1)
        .accounts({
          escrowAccount: escrowPda,
          client: client.publicKey,
          vendor: vendor.publicKey,
        })
        .signers([client])
        .rpc();
      expect.fail("Should have failed due to active dispute");
    } catch (err: any) {
      expect(err.toString()).to.include("EscrowInDispute");
    }
  });

  it("Enforces authorized arbiter resolution to partition remaining balance (1 SOL client, 1 SOL vendor)", async () => {
    const clientBalBefore = await provider.connection.getBalance(client.publicKey);
    const vendorBalBefore = await provider.connection.getBalance(vendor.publicKey);

    const refundToClient = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const payoutToVendor = new anchor.BN(1 * LAMPORTS_PER_SOL);

    await program.methods
      .resolveDispute(refundToClient, payoutToVendor)
      .accounts({
        escrowAccount: escrowPda,
        arbiter: arbiter.publicKey,
        client: client.publicKey,
        vendor: vendor.publicKey,
      })
      .signers([arbiter])
      .rpc();

    const clientBalAfter = await provider.connection.getBalance(client.publicKey);
    const vendorBalAfter = await provider.connection.getBalance(vendor.publicKey);

    expect(clientBalAfter - clientBalBefore).to.equal(1 * LAMPORTS_PER_SOL);
    expect(vendorBalAfter - vendorBalBefore).to.equal(1 * LAMPORTS_PER_SOL);

    const escrowData = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowData.remainingBalance.toNumber()).to.equal(0);
    expect(escrowData.isDisputed).to.equal(false);
  });
});