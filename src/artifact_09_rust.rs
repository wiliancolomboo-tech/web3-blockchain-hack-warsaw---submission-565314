use anchor_lang::prelude::*;
use crate::state::{Bounty, Submission, SubmissionStatus};
use crate::errors::ArbiterError;
use crate::events::VerdictCastEvent;

#[derive(Accounts)]
pub struct CastVerdict<'info> {
    #[account(
        seeds = [b"bounty", bounty.sponsor.as_ref(), &bounty.bounty_id.to_le_bytes()],
        bump = bounty.bump
    )]
    pub bounty: Account<'info, Bounty>,

    #[account(
        mut,
        seeds = [b"submission", bounty.key().as_ref(), &submission.submission_id.to_le_bytes()],
        bump = submission.bump
    )]
    pub submission: Account<'info, Submission>,

    pub judge: Signer<'info>,
}

pub fn handler(ctx: Context<CastVerdict>, approve: bool) -> Result<()> {
    let bounty = &ctx.accounts.bounty;
    let submission = &mut ctx.accounts.submission;
    let judge_key = ctx.accounts.judge.key();

    require!(submission.status == SubmissionStatus::Pending, ArbiterError::AlreadySettled);

    // Verify judge authorization
    let is_authorized = bounty.judges[..bounty.judge_count as usize].contains(&judge_key);
    require!(is_authorized, ArbiterError::UnauthorizedJudge);

    // Verify judge has not already voted
    let already_voted = submission.voted_judges[..submission.votes_count as usize].contains(&judge_key);
    require!(!already_voted, ArbiterError::JudgeAlreadyVoted);

    // Record vote
    submission.voted_judges[submission.votes_count as usize] = judge_key;
    submission.votes_count = submission.votes_count.checked_add(1).ok_or(ArbiterError::NumericalOverflow)?;

    if approve {
        submission.affirmative_votes = submission.affirmative_votes.checked_add(1).ok_or(ArbiterError::NumericalOverflow)?;
    }

    // Check if quorum threshold reached
    if submission.affirmative_votes >= bounty.quorum_threshold {
        submission.status = SubmissionStatus::Approved;
    }

    emit!(VerdictCastEvent {
        bounty_id: bounty.bounty_id,
        submission_id: submission.submission_id,
        judge: judge_key,
        approve,
        affirmative_votes: submission.affirmative_votes,
    });

    Ok(())
}