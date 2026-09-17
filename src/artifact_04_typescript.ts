import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VistulaEngine } from "../target/types/vistula_engine";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("vistula-engine QA Test Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.VistulaEngine as Program<VistulaEngine>;

  let authority = Keypair.generate();
  let feeReceiver = Keypair.generate();
  let traderA = Keypair.generate(); // Buyer (bids Token A for Token B)
  let traderB = Keypair.generate(); // Seller (asks Token B for Token A)
  let crankKeeper = Keypair.generate();

  let tokenAMint: PublicKey;
  let tokenBMint: PublicKey;

  let traderATokenA: PublicKey;
  let traderATokenB: PublicKey;
  let traderBTokenA: PublicKey;
  let traderBTokenB: PublicKey;
  let crankTokenA: PublicKey;

  let configPda: PublicKey;
  let configBump: number;

  const batchId = new anchor.BN(42);

  before(async () => {
    // Fund test wallets
    const airdropSigners = [authority, traderA, traderB, crankKeeper];
    for (const signer of airdropSigners) {
      const sig = await provider.connection.requestAirdrop(
        signer.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Create dual mints: Token A (e.g. USDC), Token B (e.g. SOL)
    tokenAMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );
    tokenBMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // ATA setup
    traderATokenA = await createAccount(provider.connection, traderA, tokenAMint, traderA.publicKey);
    traderATokenB = await createAccount(provider.connection, traderA, tokenBMint, traderA.publicKey);
    traderBTokenA = await createAccount(provider.connection, traderB, tokenAMint, traderB.publicKey);
    traderBTokenB = await createAccount(provider.connection, traderB, tokenBMint, traderB.publicKey);
    crankTokenA = await createAccount(provider.connection, crankKeeper, tokenAMint, crankKeeper.publicKey);

    // Mint balances
    await mintTo(provider.connection, authority, tokenAMint, traderATokenA, authority, 1_000_000_000); // 1000 Token A
    await mintTo(provider.connection, authority, tokenBMint, traderBTokenB, authority, 1_000_000_000); // 1000 Token B

    [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
  });

  it("1. Initializes protocol global config", async () => {
    await program.methods
      .initializeProtocol(20, 10) // 20 bps protocol fee, 10 bps crank incentive
      .accounts({
        config: configPda,
        authority: authority.publicKey,
        feeReceiver: feeReceiver.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const configAccount = await program.account.protocolConfig.fetch(configPda);
    expect(configAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(configAccount.protocolFeeBps).to.equal(20);
    expect(configAccount.crankFeeBps).to.equal(10);
  });

  it("2. Spawns an atomic batch auction session", async () => {
    const [batchPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), batchId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), batchId.toArrayLike(Buffer, "le", 8), tokenAMint.toBuffer()],
      program.programId
    );
    const [vaultBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), batchId.toArrayLike(Buffer, "le", 8), tokenBMint.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeBatch(batchId, new anchor.BN(3)) // 3 slots duration
      .accounts({
        batch: batchPda,
        config: configPda,
        tokenAMint,
        tokenBMint,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        creator: authority.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    const batchData = await program.account.batchStateAccount.fetch(batchPda);
    expect(batchData.batchId.toNumber()).to.equal(42);
    expect(batchData.state).to.deep.equal({ open: {} });
  });

  it("3. Commits Bid and Ask orders into non-custodial PDA escrows", async () => {
    const [batchPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), batchId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), batchId.toArrayLike(Buffer, "le", 8), tokenAMint.toBuffer()],
      program.programId
    );
    const [vaultBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), batchId.toArrayLike(Buffer, "le", 8), tokenBMint.toBuffer()],
      program.programId
    );

    const [orderAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("order"), batchId.toArrayLike(Buffer, "le", 8), traderA.publicKey.toBuffer()],
      program.programId
    );

    const [orderBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("order"), batchId.toArrayLike(Buffer, "le", 8), traderB.publicKey.toBuffer()],
      program.programId
    );

    // Trader A commits 100 USDC (Token A) looking for at least 95 SOL units (Token B)
    await program.methods
      .commitOrder(batchId, true, new anchor.BN(100_000_000), new anchor.BN(95_000_000))
      .accounts({
        batch: batchPda,
        order: orderAPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        traderTokenAccount: traderATokenA,
        trader: traderA.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([traderA])
      .rpc();

    // Trader B commits 100 SOL units (Token B) looking for at least 95 USDC (Token A)
    await program.methods
      .commitOrder(batchId, false, new anchor.BN(100_000_000), new anchor.BN(95_000_000))
      .accounts({
        batch: batchPda,
        order: orderBPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        traderTokenAccount: traderBTokenB,
        trader: traderB.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([traderB])
      .rpc();

    const vaultABal = await getAccount(provider.connection, vaultAPda);
    const vaultBBal = await getAccount(provider.connection, vaultBPda);
    expect(Number(vaultABal.amount)).to.equal(100_000_000);
    expect(Number(vaultBBal.amount)).to.equal(100_000_000);
  });

  it("4. Locks the batch upon slot expiration", async () => {
    const [batchPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), batchId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Wait until slots advance past expiry
    let batch = await program.account.batchStateAccount.fetch(batchPda);
    let currentSlot = await provider.connection.getSlot();
    while (currentSlot <= batch.expirySlot.toNumber()) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      currentSlot = await provider.connection.getSlot();
    }

    await program.methods
      .lockBatch(batchId)
      .accounts({
        batch: batchPda,
        caller: crankKeeper.publicKey,
      })
      .signers([crankKeeper])
      .rpc();

    batch = await program.account.batchStateAccount.fetch(batchPda);
    expect(batch.state).to.deep.equal({ locked: {} });
  });

  it("5. Settles batch at Uniform Clearing Price (1:1 UCP = 1_000_000) and dispenses crank bounty", async () => {
    const [batchPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), batchId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), batchId.toArrayLike(Buffer, "le", 8), tokenAMint.toBuffer()],
      program.programId
    );
    const [vaultBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), batchId.toArrayLike(Buffer, "le", 8), tokenBMint.toBuffer()],
      program.programId
    );

    // Uniform Clearing Price 1.0 (represented as 1_000_000)
    await program.methods
      .settleBatch(batchId, new anchor.BN(1_000_000))
      .accounts({
        batch: batchPda,
        config: configPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        crankTokenAAccount: crankTokenA,
        crank: crankKeeper.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([crankKeeper])
      .rpc();

    const batch = await program.account.batchStateAccount.fetch(batchPda);
    expect(batch.state).to.deep.equal({ settled: {} });

    // Crank bounty check (10 bps of 100_000_000 = 100_000)
    const keeperBal = await getAccount(provider.connection, crankTokenA);
    expect(Number(keeperBal.amount)).to.equal(100_000);
  });

  it("6. Traders claim filled outputs atomically under slippage boundaries", async () => {
    const [batchPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), batchId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), batchId.toArrayLike(Buffer, "le", 8), tokenAMint.toBuffer()],
      program.programId
    );
    const [vaultBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), batchId.toArrayLike(Buffer, "le", 8), tokenBMint.toBuffer()],
      program.programId
    );

    const [orderAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("order"), batchId.toArrayLike(Buffer, "le", 8), traderA.publicKey.toBuffer()],
      program.programId
    );

    const [orderBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("order"), batchId.toArrayLike(Buffer, "le", 8), traderB.publicKey.toBuffer()],
      program.programId
    );

    // Trader A claims Token B fill
    await program.methods
      .claimOrderFill(batchId)
      .accounts({
        batch: batchPda,
        order: orderAPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        traderReceiveAccount: traderATokenB,
        trader: traderA.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([traderA])
      .rpc();

    const traderABal = await getAccount(provider.connection, traderATokenB);
    expect(Number(traderABal.amount)).to.equal(100_000_000);

    // Trader B claims Token A fill
    await program.methods
      .claimOrderFill(batchId)
      .accounts({
        batch: batchPda,
        order: orderBPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        traderReceiveAccount: traderBTokenA,
        trader: traderB.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([traderB])
      .rpc();

    const traderBBal = await getAccount(provider.connection, traderBTokenA);
    expect(Number(traderBBal.amount)).to.equal(100_000_000);
  });

  it("7. Fails gracefully when attempting to double-claim", async () => {
    const [batchPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), batchId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), batchId.toArrayLike(Buffer, "le", 8), tokenAMint.toBuffer()],
      program.programId
    );
    const [vaultBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), batchId.toArrayLike(Buffer, "le", 8), tokenBMint.toBuffer()],
      program.programId
    );
    const [orderAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("order"), batchId.toArrayLike(Buffer, "le", 8), traderA.publicKey.toBuffer()],
      program.programId
    );

    let failed = false;
    try {
      await program.methods
        .claimOrderFill(batchId)
        .accounts({
          batch: batchPda,
          order: orderAPda,
          vaultA: vaultAPda,
          vaultB: vaultBPda,
          traderReceiveAccount: traderATokenB,
          trader: traderA.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([traderA])
        .rpc();
    } catch (err: any) {
      failed = true;
      expect(err.error.errorCode.code).to.equal("OrderAlreadyClaimed");
    }
    expect(failed).to.be.true;
  });
});