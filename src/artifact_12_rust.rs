use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("WarsawArb1ter1111111111111111111111111111111");

#[program]
pub mod warsaw_arbiter {
    use super::*;

    pub fn initialize_bounty(
        ctx: Context<InitializeBounty>,
        bounty_id: u64,
        title: String,
        reward_amount: u64,
        quorum_threshold: u8,
        judges: Vec<Pubkey>,
        expiry_timestamp: i64,
    ) -> Result<()> {
        instructions::initialize_bounty::handler(
            ctx,
            bounty_id,
            title,
            reward_amount,
            quorum_threshold,
            judges,
            expiry_timestamp,
        )
    }

    pub fn register_submission(
        ctx: Context<RegisterSubmission>,
        content_hash: [u8; 32],
        metadata_uri: String,
    ) -> Result<()> {
        instructions::register_submission::handler(ctx, content_hash, metadata_uri)
    }

    pub fn cast_verdict(ctx: Context<CastVerdict>, approve: bool) -> Result<()> {
        instructions::cast_verdict::handler(ctx, approve)
    }

    pub fn release_payout(ctx: Context<ReleasePayout>) -> Result<()> {
        instructions::release_payout::handler(ctx)
    }
}