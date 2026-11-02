import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VistulaSettlement } from "../target/types/vistula_settlement";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert, expect } from "chai";
import crypto from "crypto";

describe("Vistula Settlement Protocol QA Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.VistulaSettlement as Program<VistulaSettlement>;

  let mint: PublicKey;
  let buyerTokenAccount: PublicKey;
  let vendorTokenAccount: PublicKey;

  const buyer = Keypair.generate();
  const vendor = Keypair.generate();
  const unauthorizedUser = Keypair.generate();
  const attestor = Keypair.generate();

  // Test parameters
  const settlementAmount = new anchor.BN(5_000_000); // 5.000000 SPL Units
  const escrowId = new anchor.BN(99401);
  const secretPreimage = crypto.randomBytes(32);
  const attestationDigest = crypto.createHash("sha256").update(secretPreimage).digest();

  let escrowPda: PublicKey;
  let vaultPda: PublicKey;
  let authorityPda: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    const airdropSigners = [buyer, vendor, unauthorizedUser];
    for (const actor of airdropSigners) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      });
    }

    // Create Settlement Token Mint
    mint = await createMint(
      provider.connection,
      buyer,
      buyer.publicKey,
      null,
      6
    );

    // Initialize Token Accounts
    buyerTokenAccount = await createAccount(
      provider.connection,
      buyer,
      mint,
      buyer.publicKey
    );

    vendorTokenAccount = await createAccount(
      provider.connection,
      vendor,
      mint,
      vendor.publicKey
    );

    // Mint liquidity to buyer
    await mintTo(
      provider.connection,
      buyer,
      mint,
      buyerTokenAccount,
      buyer.publicKey,
      50_000_000
    );

    // Derive PDAs
    [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), escrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [authorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("authority"), escrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  });

  it("1. Successfully initializes an enterprise DvP escrow with locked liquidity", async () => {
    const currentSlotTime = (await provider.connection.getBlockTime(await provider.connection.getSlot())) || Math.floor(Date.now() / 1000);
    const expiryTs = new anchor.BN(currentSlotTime + 3600); // 1 hour buffer

    const tx = await program.methods
      .initializeEscrow(
        escrowId,
        settlementAmount,
        expiryTs,
        attestor.publicKey,
        Array.from(attestationDigest)
      )
      .accounts({
        buyer: buyer.publicKey,
        vendor: vendor.publicKey,
        mint: mint,
        buyerTokenAccount: buyerTokenAccount,
        escrowState: escrowPda,
        vaultTokenAccount: vaultPda,
        vaultAuthority: authorityPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer])
      .rpc();

    expect(tx).to.be.a("string");

    // Verify On-Chain State
    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    assert.equal(escrowAccount.escrowId.toString(), escrowId.toString());
    assert.equal(escrowAccount.buyer.toBase58(), buyer.publicKey.toBase58());
    assert.equal(escrowAccount.vendor.toBase58(), vendor.publicKey.toBase58());
    assert.equal(escrowAccount.amount.toNumber(), settlementAmount.toNumber());
    assert.equal(escrowAccount.status, 0); // Funded

    const vaultBalance = await getAccount(provider.connection, vaultPda);
    assert.equal(vaultBalance.amount.toString(), settlementAmount.toString());
  });

  it("2. Rejects settlement completion if attestation secret hash does not match digest", async () => {
    const invalidSecret = crypto.randomBytes(32); // Wrong secret

    try {
      await program.methods
        .completeSettlement(escrowId, Array.from(invalidSecret))
        .accounts({
          caller: vendor.publicKey,
          vendor: vendor.publicKey,
          vendorTokenAccount: vendorTokenAccount,
          escrowState: escrowPda,
          vaultTokenAccount: vaultPda,
          vaultAuthority: authorityPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([vendor])
        .rpc();
      assert.fail("Settlement should have failed due to invalid cryptographic proof");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidAttestationProof");
    }
  });

  it("3. Rejects refund if settlement escrow has NOT reached expiration", async () => {
    try {
      await program.methods
        .claimRefund(escrowId)
        .accounts({
          buyer: buyer.publicKey,
          buyerTokenAccount: buyerTokenAccount,
          escrowState: escrowPda,
          vaultTokenAccount: vaultPda,
          vaultAuthority: authorityPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer])
        .rpc();
      assert.fail("Refund should have failed because escrow is not yet expired");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("EscrowNotExpired");
    }
  });

  it("4. Completes settlement upon presenting valid attestation preimage and releases payout", async () => {
    const initialVendorBal = (await getAccount(provider.connection, vendorTokenAccount)).amount;

    const tx = await program.methods
      .completeSettlement(escrowId, Array.from(secretPreimage))
      .accounts({
        caller: vendor.publicKey,
        vendor: vendor.publicKey,
        vendorTokenAccount: vendorTokenAccount,
        escrowState: escrowPda,
        vaultTokenAccount: vaultPda,
        vaultAuthority: authorityPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([vendor])
      .rpc();

    expect(tx).to.be.a("string");

    // Assert funds transferred
    const finalVendorBal = (await getAccount(provider.connection, vendorTokenAccount)).amount;
    assert.equal(
      (BigInt(finalVendorBal) - BigInt(initialVendorBal)).toString(),
      settlementAmount.toString()
    );

    // Verify Escrow State is Settled
    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    assert.equal(escrowAccount.status, 1); // Settled
  });

  it("5. Verifies Clawback Refund flow when escrow passes expiration deadline", async () => {
    const expiredEscrowId = new anchor.BN(99402);
    const [expEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), expiredEscrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [expVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), expiredEscrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [expAuthPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("authority"), expiredEscrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const currentTime = (await provider.connection.getBlockTime(await provider.connection.getSlot())) || Math.floor(Date.now() / 1000);
    // Expiry set 2 seconds in the future
    const nearExpiry = new anchor.BN(currentTime + 2);

    await program.methods
      .initializeEscrow(
        expiredEscrowId,
        settlementAmount,
        nearExpiry,
        attestor.publicKey,
        Array.from(attestationDigest)
      )
      .accounts({
        buyer: buyer.publicKey,
        vendor: vendor.publicKey,
        mint: mint,
        buyerTokenAccount: buyerTokenAccount,
        escrowState: expEscrowPda,
        vaultTokenAccount: expVaultPda,
        vaultAuthority: expAuthPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer])
      .rpc();

    // Sleep 4 seconds to force timeout
    await new Promise((resolve) => setTimeout(resolve, 4000));

    const initialBuyerBal = (await getAccount(provider.connection, buyerTokenAccount)).amount;

    await program.methods
      .claimRefund(expiredEscrowId)
      .accounts({
        buyer: buyer.publicKey,
        buyerTokenAccount: buyerTokenAccount,
        escrowState: expEscrowPda,
        vaultTokenAccount: expVaultPda,
        vaultAuthority: expAuthPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const finalBuyerBal = (await getAccount(provider.connection, buyerTokenAccount)).amount;
    assert.equal(
      (BigInt(finalBuyerBal) - BigInt(initialBuyerBal)).toString(),
      settlementAmount.toString()
    );

    const escrowRecord = await program.account.escrowState.fetch(expEscrowPda);
    assert.equal(escrowRecord.status, 2); // Refunded
  });
});