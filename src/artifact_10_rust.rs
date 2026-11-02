use anchor_lang::prelude::*;
use crate::state::{Bounty, Submission, SubmissionStatus};
use crate::errors::ArbiterError;
use crate::events::BountySettledEvent;

#[derive(Accounts)]
pub struct ReleasePayout<'info> {
    #[account(
        mut,
        seeds = [b"bounty", bounty.sponsor.as_ref(), &bounty.bounty_id.to_le_bytes()],
        bump = bounty.bump,
        has_one = sponsor
    )]
    pub bounty: Account<'info, Bounty>,

    /// CHECK: Checked via PDA seeds
    #[account(
        mut,
        seeds = [b"vault", bounty.key().as_ref()],
        bump = bounty.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [b"submission", bounty.key().as_ref(), &submission.submission_id.to_le_bytes()],
        bump = submission.bump,
        has_one = bounty
    )]
    pub submission: Account<'info, Submission>,

    /// CHECK: Recipient wallet matching submitter
    #[account(
        mut,
        address = submission.submitter
    )]
    pub recipient: AccountInfo<'info>,

    /// CHECK: Sponsor account matching bounty sponsor
    pub sponsor: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ReleasePayout>) -> Result<()> {
    let bounty = &mut ctx.accounts.bounty;
    let submission = &mut ctx.accounts.submission;

    require!(!bounty.is_settled, ArbiterError::AlreadySettled);
    require!(submission.status == SubmissionStatus::Approved, ArbiterError::SubmissionNotApproved);

    let payout_amount = bounty.reward_amount;
    let vault_lamports = ctx.accounts.vault.lamports();
    require!(vault_lamports >= payout_amount, ArbiterError::InsufficientEscrowFunds);

    // Atomic Lamport Reallocation from PDA Vault to Recipient
    **ctx.accounts.vault.try_borrow_mut_lamports()? = ctx
        .accounts
        .vault
        .lamports()
        .checked_sub(payout_amount)
        .ok_or(ArbiterError::NumericalOverflow)?;

    **ctx.accounts.recipient.try_borrow_mut_lamports()? = ctx
        .accounts
        .recipient
        .lamports()
        .checked_add(payout_amount)
        .ok_or(ArbiterError::NumericalOverflow)?;

    bounty.is_settled = true;
    submission.status = SubmissionStatus::Settled;

    let clock = Clock::get()?;
    emit!(BountySettledEvent {
        bounty_id: bounty.bounty_id,
        submission_id: submission.submission_id,
        winner: ctx.accounts.recipient.key(),
        amount_paid: payout_amount,
        settled_at: clock.unix_timestamp,
    });

    Ok(())
}