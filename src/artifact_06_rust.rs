use anchor_lang::prelude::*;

pub const MAX_JUDGES: usize = 10;
pub const MAX_TITLE_LEN: usize = 64;
pub const MAX_URI_LEN: usize = 128;

#[account]
pub struct Bounty {
    pub sponsor: Pubkey,            // 32
    pub bounty_id: u64,             // 8
    pub reward_amount: u64,         // 8
    pub quorum_threshold: u8,       // 1
    pub judge_count: u8,            // 1
    pub judges: [Pubkey; MAX_JUDGES],// 32 * 10 = 320
    pub expiry_timestamp: i64,      // 8
    pub is_settled: bool,           // 1
    pub submission_count: u64,      // 8
    pub bump: u8,                   // 1
    pub vault_bump: u8,             // 1
    pub title: String,              // 4 + MAX_TITLE_LEN
}

impl Bounty {
    pub const SPACE: usize = 8      // Discriminator
        + 32                        // sponsor
        + 8                         // bounty_id
        + 8                         // reward_amount
        + 1                         // quorum_threshold
        + 1                         // judge_count
        + (32 * MAX_JUDGES)         // judges
        + 8                         // expiry_timestamp
        + 1                         // is_settled
        + 8                         // submission_count
        + 1                         // bump
        + 1                         // vault_bump
        + (4 + MAX_TITLE_LEN);      // title
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum SubmissionStatus {
    Pending,
    Approved,
    Settled,
    Rejected,
}

#[account]
pub struct Submission {
    pub bounty: Pubkey,                  // 32
    pub submitter: Pubkey,               // 32
    pub submission_id: u64,              // 8
    pub content_hash: [u8; 32],          // 32 (SHA-256 of code/demo)
    pub metadata_uri: String,            // 4 + MAX_URI_LEN
    pub status: SubmissionStatus,        // 1
    pub votes_count: u8,                 // 1
    pub affirmative_votes: u8,           // 1
    pub voted_judges: [Pubkey; MAX_JUDGES], // 320
    pub bump: u8,                        // 1
}

impl Submission {
    pub const SPACE: usize = 8           // Discriminator
        + 32                             // bounty
        + 32                             // submitter
        + 8                              // submission_id
        + 32                             // content_hash
        + (4 + MAX_URI_LEN)              // metadata_uri
        + 1                              // status enum
        + 1                              // votes_count
        + 1                              // affirmative_votes
        + (32 * MAX_JUDGES)              // voted_judges
        + 1;                             // bump
}