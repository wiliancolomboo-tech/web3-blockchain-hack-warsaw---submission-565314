import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { WarsawArbiter } from "../target/types/warsaw_arbiter";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("warsaw_arbiter test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.WarsawArbiter as Program<WarsawArbiter>;

  const sponsor = Keypair.generate();
  const hacker = Keypair.generate();
  const judge1 = Keypair.generate();
  const judge2 = Keypair.generate();
  const unauthorizedJudge = Keypair.generate();

  const bountyId = new anchor.BN(42);
  const rewardAmount = new anchor.BN(2 * LAMPORTS_PER_SOL);
  const quorumThreshold = 2; // 2-of-2 votes required

  let bountyPda: PublicKey;
  let bountyBump: number;
  let vaultPda: PublicKey;
  let vaultBump: number;
  let submissionPda: PublicKey;
  let submissionBump: number;

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [sponsor, hacker, judge1, judge2, unauthorizedJudge]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 10 * LAMPORTS_PER_SOL);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        ...latestBlockhash,
      });
    }

    [bountyPda, bountyBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("bounty"), sponsor.publicKey.toBuffer(), bountyId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), bountyPda.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initialises bounty and escrows SOL in vault PDA", async () => {
    const title = "Blockchain Hack Warsaw - Grand Prize";
    const expiryTimestamp = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
    const judgesList = [judge1.publicKey, judge2.publicKey];

    const initialSponsorBalance = await provider.connection.getBalance(sponsor.publicKey);

    await program.methods
      .initializeBounty(
        bountyId,
        title,
        rewardAmount,
        quorumThreshold,
        judgesList,
        expiryTimestamp
      )
      .accounts({
        bounty: bountyPda,
        vault: vaultPda,
        sponsor: sponsor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([sponsor])
      .rpc();

    const bountyAccount = await program.account.bounty.fetch(bountyPda);
    expect(bountyAccount.bountyId.toNumber()).to.equal(42);
    expect(bountyAccount.quorumThreshold).to.equal(2);
    expect(bountyAccount.isSettled).to.be.false;

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.equal(rewardAmount.toNumber());
  });

  it("2. Hacker registers submission manifest with SHA-256 code hash", async () => {
    const submissionId = new anchor.BN(0);
    [submissionPda, submissionBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("submission"), bountyPda.toBuffer(), submissionId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const dummyCodeManifest = "https://github.com/developer/warsaw-solana-project";
    const sha256Hash = crypto.createHash("sha256").update(dummyCodeManifest).digest();
    const hashArray = Array.from(new Uint8Array(sha256Hash));

    await program.methods
      .registerSubmission(hashArray, "ipfs://QmWarsawSubmissionMetadata")
      .accounts({
        bounty: bountyPda,
        submission: submissionPda,
        submitter: hacker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([hacker])
      .rpc();

    const subAccount = await program.account.submission.fetch(submissionPda);
    expect(subAccount.submitter.toBase58()).to.equal(hacker.publicKey.toBase58());
    expect(subAccount.affirmativeVotes).to.equal(0);
  });

  it("3. Unauthorized judge is rejected from casting verdict", async () => {
    try {
      await program.methods
        .castVerdict(true)
        .accounts({
          bounty: bountyPda,
          submission: submissionPda,
          judge: unauthorizedJudge.publicKey,
        })
        .signers([unauthorizedJudge])
        .rpc();
      expect.fail("Expected UnauthorizedJudge error was not thrown");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedJudge");
    }
  });

  it("4. Authorized judges vote and reach consensus quorum", async () => {
    // Judge 1 approves
    await program.methods
      .castVerdict(true)
      .accounts({
        bounty: bountyPda,
        submission: submissionPda,
        judge: judge1.publicKey,
      })
      .signers([judge1])
      .rpc();

    let subAccount = await program.account.submission.fetch(submissionPda);
    expect(subAccount.affirmativeVotes).to.equal(1);

    // Judge 1 cannot vote twice
    try {
      await program.methods
        .castVerdict(true)
        .accounts({
          bounty: bountyPda,
          submission: submissionPda,
          judge: judge1.publicKey,
        })
        .signers([judge1])
        .rpc();
      expect.fail("Expected JudgeAlreadyVoted error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("JudgeAlreadyVoted");
    }

    // Judge 2 approves -> meets 2-of-2 quorum
    await program.methods
      .castVerdict(true)
      .accounts({
        bounty: bountyPda,
        submission: submissionPda,
        judge: judge2.publicKey,
      })
      .signers([judge2])
      .rpc();

    subAccount = await program.account.submission.fetch(submissionPda);
    expect(subAccount.affirmativeVotes).to.equal(2);
    expect(subAccount.status).to.deep.equal({ approved: {} });
  });

  it("5. Release payout disburses funds atomically to hacker", async () => {
    const hackerBalanceBefore = await provider.connection.getBalance(hacker.publicKey);

    await program.methods
      .releasePayout()
      .accounts({
        bounty: bountyPda,
        vault: vaultPda,
        submission: submissionPda,
        recipient: hacker.publicKey,
        sponsor: sponsor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const hackerBalanceAfter = await provider.connection.getBalance(hacker.publicKey);
    expect(hackerBalanceAfter - hackerBalanceBefore).to.equal(rewardAmount.toNumber());

    const bountyAccount = await program.account.bounty.fetch(bountyPda);
    expect(bountyAccount.isSettled).to.be.true;

    const subAccount = await program.account.submission.fetch(submissionPda);
    expect(subAccount.status).to.deep.equal({ settled: {} });
  });
});