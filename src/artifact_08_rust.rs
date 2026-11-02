use anchor_lang::prelude::*;
use crate::state::{Bounty, Submission, SubmissionStatus, MAX_JUDGES, MAX_URI_LEN};
use crate::errors::ArbiterError;
use crate::events::SubmissionRegisteredEvent;

#[derive(Accounts)]
pub struct RegisterSubmission<'info> {
    #[account(
        mut,
        seeds = [b"bounty", bounty.sponsor.as_ref(), &bounty.bounty_id.to_le_bytes()],
        bump = bounty.bump
    )]
    pub bounty: Account<'info, Bounty>,

    #[account(
        init,
        payer = submitter,
        space = Submission::SPACE,
        seeds = [b"submission", bounty.key().as_ref(), &bounty.submission_count.to_le_bytes()],
        bump
    )]
    pub submission: Account<'info, Submission>,

    #[account(mut)]
    pub submitter: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RegisterSubmission>,
    content_hash: [u8; 32],
    metadata_uri: String,
) -> Result<()> {
    require!(metadata_uri.len() <= MAX_URI_LEN, ArbiterError::StringLengthExceeded);

    let clock = Clock::get()?;
    let bounty = &mut ctx.accounts.bounty;
    require!(clock.unix_timestamp <= bounty.expiry_timestamp, ArbiterError::BountyExpired);

    let submission_id = bounty.submission_count;
    let submission = &mut ctx.accounts.submission;

    submission.bounty = bounty.key();
    submission.submitter = ctx.accounts.submitter.key();
    submission.submission_id = submission_id;
    submission.content_hash = content_hash;
    submission.metadata_uri = metadata_uri;
    submission.status = SubmissionStatus::Pending;
    submission.votes_count = 0;
    submission.affirmative_votes = 0;
    submission.voted_judges = [Pubkey::default(); MAX_JUDGES];
    submission.bump = ctx.bumps.submission;

    bounty.submission_count = bounty.submission_count.checked_add(1).ok_or(ArbiterError::NumericalOverflow)?;

    emit!(SubmissionRegisteredEvent {
        bounty_id: bounty.bounty_id,
        submission_id,
        submitter: ctx.accounts.submitter.key(),
        content_hash,
    });

    Ok(())
}