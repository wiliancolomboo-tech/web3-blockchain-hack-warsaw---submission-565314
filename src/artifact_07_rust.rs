use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use crate::state::{Bounty, MAX_JUDGES, MAX_TITLE_LEN};
use crate::errors::ArbiterError;
use crate::events::BountyInitializedEvent;

#[derive(Accounts)]
#[instruction(bounty_id: u64, title: String, reward_amount: u64)]
pub struct InitializeBounty<'info> {
    #[account(
        init,
        payer = sponsor,
        space = Bounty::SPACE,
        seeds = [b"bounty", sponsor.key().as_ref(), &bounty_id.to_le_bytes()],
        bump
    )]
    pub bounty: Account<'info, Bounty>,

    /// CHECK: Native SOL vault PDA acting as trustless escrow container
    #[account(
        mut,
        seeds = [b"vault", bounty.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub sponsor: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeBounty>,
    bounty_id: u64,
    title: String,
    reward_amount: u64,
    quorum_threshold: u8,
    judges: Vec<Pubkey>,
    expiry_timestamp: i64,
) -> Result<()> {
    require!(title.len() <= MAX_TITLE_LEN, ArbiterError::StringLengthExceeded);
    require!(!judges.is_empty() && judges.len() <= MAX_JUDGES, ArbiterError::TooManyJudges);
    require!(
        quorum_threshold > 0 && quorum_threshold as usize <= judges.len(),
        ArbiterError::InvalidQuorumThreshold
    );

    let clock = Clock::get()?;
    require!(expiry_timestamp > clock.unix_timestamp, ArbiterError::BountyExpired);

    let bounty = &mut ctx.accounts.bounty;
    bounty.sponsor = ctx.accounts.sponsor.key();
    bounty.bounty_id = bounty_id;
    bounty.reward_amount = reward_amount;
    bounty.quorum_threshold = quorum_threshold;
    bounty.judge_count = judges.len() as u8;
    bounty.expiry_timestamp = expiry_timestamp;
    bounty.is_settled = false;
    bounty.submission_count = 0;
    bounty.bump = ctx.bumps.bounty;
    bounty.vault_bump = ctx.bumps.vault;
    bounty.title = title;

    let mut judge_array = [Pubkey::default(); MAX_JUDGES];
    for (i, judge) in judges.iter().enumerate() {
        judge_array[i] = *judge;
    }
    bounty.judges = judge_array;

    // Transfer SOL from Sponsor to Vault PDA
    if reward_amount > 0 {
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.sponsor.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        transfer(cpi_context, reward_amount)?;
    }

    emit!(BountyInitializedEvent {
        bounty_id,
        sponsor: ctx.accounts.sponsor.key(),
        total_reward: reward_amount,
        quorum_threshold,
        expiry_timestamp,
    });

    Ok(())
}