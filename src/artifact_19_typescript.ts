import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AegisEscrow } from "../target/types/aegis_escrow";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { expect } from "chai";

describe("aegis_escrow verification suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AegisEscrow as Program<AegisEscrow>;

  const depositor = Keypair.generate();
  const payee = Keypair.generate();
  const arbiter = Keypair.generate();
  const feeRecipient = Keypair.generate();

  const escrowId = new anchor.BN(42069);
  const milestone1 = new anchor.BN(1 * LAMPORTS_PER_SOL);
  const milestone2 = new anchor.BN(2 * LAMPORTS_PER_SOL);
  const totalAmount = milestone1.add(milestone2);
  const feeBasisPoints = 250; // 2.5%

  let escrowPda: PublicKey;
  let vaultPda: PublicKey;

  before(async () => {
    // Fund all participants from local provider wallet
    const airdropSignatures = await Promise.all([
      provider.connection.requestAirdrop(depositor.publicKey, 10 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(payee.publicKey, 2 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(arbiter.publicKey, 2 * LAMPORTS_PER_SOL),
    ]);
    for (const sig of airdropSignatures) {
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        ...latestBlockhash,
      });
    }

    [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        depositor.publicKey.toBuffer(),
        escrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes an enterprise escrow contract", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expiryTimestamp = new anchor.BN(now + 86400 * 14); // 14 days out

    await program.methods
      .initializeEscrow(
        escrowId,
        totalAmount,
        [milestone1, milestone2],
        expiryTimestamp,
        feeBasisPoints
      )
      .accounts({
        escrowAccount: escrowPda,
        vault: vaultPda,
        depositor: depositor.publicKey,
        payee: payee.publicKey,
        arbiter: arbiter.publicKey,
        feeRecipient: feeRecipient.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccount.escrowId.toString()).to.equal(escrowId.toString());
    expect(escrowAccount.depositor.toBase58()).to.equal(depositor.publicKey.toBase58());
    expect(escrowAccount.payee.toBase58()).to.equal(payee.publicKey.toBase58());
    expect(escrowAccount.totalAmount.toString()).to.equal(totalAmount.toString());
    expect(escrowAccount.depositedAmount.toString()).to.equal("0");
    expect(escrowAccount.totalMilestones).to.equal(2);
    expect(escrowAccount.feeBasisPoints).to.equal(250);
  });

  it("2. Rejects funding that exceeds the required commitment", async () => {
    const excessiveAmount = totalAmount.add(new anchor.BN(1 * LAMPORTS_PER_SOL));
    try {
      await program.methods
        .depositFunds(excessiveAmount)
        .accounts({
          escrowAccount: escrowPda,
          vault: vaultPda,
          depositor: depositor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([depositor])
        .rpc();
      expect.fail("Deposit should have failed due to excessive amount");
    } catch (err: any) {
      expect(err.message).to.contain("ExcessiveDeposit");
    }
  });

  it("3. Deposits full funding into the non-custodial Vault PDA", async () => {
    await program.methods
      .depositFunds(totalAmount)
      .accounts({
        escrowAccount: escrowPda,
        vault: vaultPda,
        depositor: depositor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.equal(totalAmount.toNumber());

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccount.depositedAmount.toString()).to.equal(totalAmount.toString());
    expect(escrowAccount.status).to.deep.equal({ funded: {} });
  });

  it("4. Releases Milestone 0 with proper protocol fee deduction", async () => {
    const initialPayeeBal = await provider.connection.getBalance(payee.publicKey);
    const initialFeeRecipientBal = await provider.connection.getBalance(feeRecipient.publicKey);

    // Release Milestone 0 (1 SOL)
    await program.methods
      .releaseMilestone(0)
      .accounts({
        escrowAccount: escrowPda,
        vault: vaultPda,
        authority: depositor.publicKey,
        payee: payee.publicKey,
        feeRecipient: feeRecipient.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();

    const expectedFee = (1 * LAMPORTS_PER_SOL * 250) / 10000; // 0.025 SOL
    const expectedPayeeNet = 1 * LAMPORTS_PER_SOL - expectedFee; // 0.975 SOL

    const finalPayeeBal = await provider.connection.getBalance(payee.publicKey);
    const finalFeeRecipientBal = await provider.connection.getBalance(feeRecipient.publicKey);

    expect(finalPayeeBal - initialPayeeBal).to.equal(expectedPayeeNet);
    expect(finalFeeRecipientBal - initialFeeRecipientBal).to.equal(expectedFee);

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccount.status).to.deep.equal({ partiallyReleased: {} });
    expect(escrowAccount.releasedAmount.toString()).to.equal(milestone1.toString());
  });

  it("5. Prevents double-spending already released milestones", async () => {
    try {
      await program.methods
        .releaseMilestone(0)
        .accounts({
          escrowAccount: escrowPda,
          vault: vaultPda,
          authority: depositor.publicKey,
          payee: payee.publicKey,
          feeRecipient: feeRecipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([depositor])
        .rpc();
      expect.fail("Should prevent re-release of milestone 0");
    } catch (err: any) {
      expect(err.message).to.contain("MilestoneAlreadyReleased");
    }
  });

  it("6. Raises a dispute from Payee and blocks subsequent unadjudicated releases", async () => {
    const reasonHash = new Array(32).fill(7);

    await program.methods
      .raiseDispute(reasonHash)
      .accounts({
        escrowAccount: escrowPda,
        initiator: payee.publicKey,
      })
      .signers([payee])
      .rpc();

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccount.status).to.deep.equal({ disputed: {} });

    // Attempting normal release while disputed must fail
    try {
      await program.methods
        .releaseMilestone(1)
        .accounts({
          escrowAccount: escrowPda,
          vault: vaultPda,
          authority: depositor.publicKey,
          payee: payee.publicKey,
          feeRecipient: feeRecipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([depositor])
        .rpc();
      expect.fail("Release must be blocked under dispute");
    } catch (err: any) {
      expect(err.message).to.contain("EscrowDisputed");
    }
  });

  it("7. Arbiter resolves dispute with deterministic 50/50 payout split", async () => {
    const vaultBalBefore = await provider.connection.getBalance(vaultPda);
    const depositorBalBefore = await provider.connection.getBalance(depositor.publicKey);
    const payeeBalBefore = await provider.connection.getBalance(payee.publicKey);

    // Arbiter awards 50% (5,000 bps) to payee, remaining 50% to depositor
    await program.methods
      .resolveDispute(5000)
      .accounts({
        escrowAccount: escrowPda,
        vault: vaultPda,
        arbiter: arbiter.publicKey,
        depositor: depositor.publicKey,
        payee: payee.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([arbiter])
      .rpc();

    const vaultBalAfter = await provider.connection.getBalance(vaultPda);
    expect(vaultBalAfter).to.equal(0);

    const depositorBalAfter = await provider.connection.getBalance(depositor.publicKey);
    const payeeBalAfter = await provider.connection.getBalance(payee.publicKey);

    const halfBalance = vaultBalBefore / 2;
    expect(payeeBalAfter - payeeBalBefore).to.equal(halfBalance);
    expect(depositorBalAfter - depositorBalBefore).to.equal(halfBalance);

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccount.status).to.deep.equal({ completed: {} });
  });
});