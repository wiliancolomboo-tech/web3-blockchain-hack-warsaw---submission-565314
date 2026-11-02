use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("Vist111111111111111111111111111111111111111");

#[program]
pub mod vistula_protocol {
    use super::*;

    pub fn initialize_treasury(
        ctx: Context<InitializeTreasury>,
        fee_basis_points: u16,
    ) -> Result<()> {
        instructions::initialize_treasury::handler(ctx, fee_basis_points)
    }

    pub fn create_stream(
        ctx: Context<CreateStream>,
        stream_id: u64,
        dispute_window_seconds: i64,
        milestone_hashes: Vec<[u8; 32]>,
        milestone_allocations: Vec<u64>,
    ) -> Result<()> {
        instructions::create_stream::handler(
            ctx,
            stream_id,
            dispute_window_seconds,
            milestone_hashes,
            milestone_allocations,
        )
    }

    pub fn submit_milestone(
        ctx: Context<SubmitMilestone>,
        milestone_index: u8,
        proof_hash: [u8; 32],
    ) -> Result<()> {
        instructions::submit_milestone::handler(ctx, milestone_index, proof_hash)
    }

    pub fn release_milestone(
        ctx: Context<ReleaseMilestone>,
        milestone_index: u8,
    ) -> Result<()> {
        instructions::release_milestone::handler(ctx, milestone_index)
    }

    pub fn challenge_milestone(
        ctx: Context<ChallengeMilestone>,
        milestone_index: u8,
    ) -> Result<()> {
        instructions::challenge_milestone::handler(ctx, milestone_index)
    }

    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        recipient_award_lamports: u64,
    ) -> Result<()> {
        instructions::resolve_dispute::handler(ctx, recipient_award_lamports)
    }
}