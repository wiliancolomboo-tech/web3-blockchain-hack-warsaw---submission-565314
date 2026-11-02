use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("WsV1111111111111111111111111111111111111111");

#[program]
pub mod stream_vault {
    use super::*;

    /// Initialize a new streaming and milestone escrow vault.
    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        escrow_id: u64,
        total_deposit: u64,
        streaming_amount: u64,
        start_time: i64,
        end_time: i64,
        milestone_count: u8,
    ) -> Result<()> {
        require!(total_deposit > 0, VaultError::ZeroAmount);
        require!(streaming_amount <= total_deposit, VaultError::InvalidStreamAllocation);
        require!(end_time > start_time, VaultError::InvalidTimeWindow);
        require!(milestone_count <= 10, VaultError::ExcessiveMilestones);

        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;
        require!(end_time > current_time, VaultError::EndTimeInPast);

        let escrow = &mut ctx.accounts.escrow;
        escrow.escrow_id = escrow_id;
        escrow.payer = ctx.accounts.payer.key();
        escrow.beneficiary = ctx.accounts.beneficiary.key();
        escrow.arbiter = ctx.accounts.arbiter.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.vault_bump = ctx.bumps.vault_token_account;
        escrow.escrow_bump = ctx.bumps.escrow;

        escrow.total_deposit = total_deposit;
        escrow.streaming_amount = streaming_amount;
        escrow.milestone_amount = total_deposit
            .checked_sub(streaming_amount)
            .ok_or(VaultError::MathOverflow)?;

        escrow.start_time = start_time;
        escrow.end_time = end_time;
        escrow.streaming_claimed = 0;
        escrow.milestones_total = milestone_count;
        escrow.milestones_approved = 0;
        escrow.milestone_claimed = 0;
        escrow.is_paused = false;
        escrow.is_cancelled = false;

        // Transfer funds from payer to vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.payer_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.payer.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, total_deposit)?;

        emit!(EscrowInitializedEvent {
            escrow_id,
            payer: ctx.accounts.payer.key(),
            beneficiary: ctx.accounts.beneficiary.key(),
            total_deposit,
            streaming_amount,
            start_time,
            end_time,
            timestamp: current_time,
        });

        Ok(())
    }

    /// Claim accrued funds from the active streaming allocation.
    pub fn claim_stream(ctx: Context<ClaimStream>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(!escrow.is_paused, VaultError::VaultPaused);
        require!(!escrow.is_cancelled, VaultError::VaultCancelled);

        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;
        require!(current_time >= escrow.start_time, VaultError::StreamNotStarted);

        let claimable_now = compute_claimable_stream(
            escrow.streaming_amount,
            escrow.start_time,
            escrow.end_time,
            current_time,
            escrow.streaming_claimed,
        )?;

        require!(claimable_now > 0, VaultError::NoClaimableFunds);

        escrow.streaming_claimed = escrow
            .streaming_claimed
            .checked_add(claimable_now)
            .ok_or(VaultError::MathOverflow)?;

        // Execute PDA signed CPI transfer
        let payer_key = escrow.payer;
        let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
        let seeds: &[&[u8]] = &[
            b"escrow",
            payer_key.as_ref(),
            escrow_id_bytes.as_ref(),
            &[escrow.escrow_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.beneficiary_token_account.to_account_info(),
            authority: escrow.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
        token::transfer(cpi_ctx, claimable_now)?;

        emit!(StreamClaimedEvent {
            escrow_id: escrow.escrow_id,
            beneficiary: ctx.accounts.beneficiary.key(),
            amount: claimable_now,
            total_stream_claimed: escrow.streaming_claimed,
            timestamp: current_time,
        });

        Ok(())
    }

    /// Approve and release a milestone tranche. Initiated by Payer or Arbiter.
    pub fn approve_milestone(ctx: Context<ApproveMilestone>, milestone_index: u8) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(!escrow.is_cancelled, VaultError::VaultCancelled);
        require!(escrow.milestones_total > 0, VaultError::NoMilestonesConfigured);
        require!(
            milestone_index == escrow.milestones_approved + 1,
            VaultError::InvalidMilestoneSequence
        );
        require!(
            milestone_index <= escrow.milestones_total,
            VaultError::MilestoneOutOfBounds
        );

        let per_milestone_amount = escrow
            .milestone_amount
            .checked_div(escrow.milestones_total as u64)
            .ok_or(VaultError::MathOverflow)?;

        escrow.milestones_approved = milestone_index;
        escrow.milestone_claimed = escrow
            .milestone_claimed
            .checked_add(per_milestone_amount)
            .ok_or(VaultError::MathOverflow)?;

        // Execute PDA signed CPI transfer to beneficiary
        let payer_key = escrow.payer;
        let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
        let seeds: &[&[u8]] = &[
            b"escrow",
            payer_key.as_ref(),
            escrow_id_bytes.as_ref(),
            &[escrow.escrow_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.beneficiary_token_account.to_account_info(),
            authority: escrow.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
        token::transfer(cpi_ctx, per_milestone_amount)?;

        let clock = Clock::get()?;
        emit!(MilestoneReleasedEvent {
            escrow_id: escrow.escrow_id,
            milestone_index,
            approved_by: ctx.accounts.authority.key(),
            amount: per_milestone_amount,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Emergency cancellation or mutual refund. Any unstreamed/unclaimed balance is returned to Payer.
    pub fn cancel_vault(ctx: Context<CancelVault>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(!escrow.is_cancelled, VaultError::AlreadyCancelled);

        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;

        // Auto-settle streaming accrued up to this exact cancellation second for beneficiary
        let accrued_stream = compute_claimable_stream(
            escrow.streaming_amount,
            escrow.start_time,
            escrow.end_time,
            current_time,
            escrow.streaming_claimed,
        )?;

        let payer_key = escrow.payer;
        let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
        let seeds: &[&[u8]] = &[
            b"escrow",
            payer_key.as_ref(),
            escrow_id_bytes.as_ref(),
            &[escrow.escrow_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_program = ctx.accounts.token_program.to_account_info();

        if accrued_stream > 0 {
            escrow.streaming_claimed = escrow
                .streaming_claimed
                .checked_add(accrued_stream)
                .ok_or(VaultError::MathOverflow)?;

            let cpi_to_beneficiary = Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.beneficiary_token_account.to_account_info(),
                authority: escrow.to_account_info(),
            };
            let cpi_ctx_ben = CpiContext::new_with_signer(
                cpi_program.clone(),
                cpi_to_beneficiary,
                signer_seeds,
            );
            token::transfer(cpi_ctx_ben, accrued_stream)?;
        }

        // Return all remaining vault tokens back to payer
        let remaining_balance = ctx.accounts.vault_token_account.amount;
        if remaining_balance > 0 {
            let cpi_to_payer = Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.payer_token_account.to_account_info(),
                authority: escrow.to_account_info(),
            };
            let cpi_ctx_payer =
                CpiContext::new_with_signer(cpi_program, cpi_to_payer, signer_seeds);
            token::transfer(cpi_ctx_payer, remaining_balance)?;
        }

        escrow.is_cancelled = true;

        emit!(VaultCancelledEvent {
            escrow_id: escrow.escrow_id,
            cancelled_by: ctx.accounts.authority.key(),
            accrued_paid_to_beneficiary: accrued_stream,
            refunded_to_payer: remaining_balance,
            timestamp: current_time,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Helper Pure Functions
// -----------------------------------------------------------------------------
pub fn compute_claimable_stream(
    total_stream: u64,
    start_time: i64,
    end_time: i64,
    current_time: i64,
    already_claimed: u64,
) -> Result<u64> {
    if current_time <= start_time {
        return Ok(0);
    }

    let effective_time = if current_time >= end_time {
        end_time
    } else {
        current_time
    };

    let elapsed = (effective_time - start_time) as u128;
    let duration = (end_time - start_time) as u128;

    if duration == 0 {
        return Ok(0);
    }

    let accrued = (total_stream as u128)
        .checked_mul(elapsed)
        .ok_or(VaultError::MathOverflow)?
        .checked_div(duration)
        .ok_or(VaultError::MathOverflow)? as u64;

    let claimable = accrued.saturating_sub(already_claimed);
    Ok(claimable)
}

// -----------------------------------------------------------------------------
// Account Validation Contexts
// -----------------------------------------------------------------------------
#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct InitializeEscrow<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + EscrowAccount::INIT_SPACE,
        seeds = [b"escrow", payer.key().as_ref(), escrow_id.to_le_bytes().as_ref()],
        bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Beneficiary is destination wallet, non-signer during init
    pub beneficiary: UncheckedAccount<'info>,

    /// CHECK: Arbiter can approve milestones or arbitrate disputes
    pub arbiter: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = payer,
    )]
    pub payer_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        seeds = [b"vault_token", escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ClaimStream<'info> {
    #[account(
        mut,
        seeds = [b"escrow", escrow.payer.as_ref(), escrow.escrow_id.to_le_bytes().as_ref()],
        bump = escrow.escrow_bump,
        has_one = beneficiary,
        has_one = mint,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(mut)]
    pub beneficiary: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault_token", escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = beneficiary,
    )]
    pub beneficiary_token_account: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ApproveMilestone<'info> {
    #[account(
        mut,
        seeds = [b"escrow", escrow.payer.as_ref(), escrow.escrow_id.to_le_bytes().as_ref()],
        bump = escrow.escrow_bump,
        has_one = beneficiary,
        has_one = mint,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    /// Must be Payer or Arbiter
    #[account(
        mut,
        constraint = authority.key() == escrow.payer || authority.key() == escrow.arbiter @ VaultError::UnauthorizedApprover
    )]
    pub authority: Signer<'info>,

    /// CHECK: Recipient of milestone payout
    pub beneficiary: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"vault_token", escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = beneficiary,
    )]
    pub beneficiary_token_account: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelVault<'info> {
    #[account(
        mut,
        seeds = [b"escrow", escrow.payer.as_ref(), escrow.escrow_id.to_le_bytes().as_ref()],
        bump = escrow.escrow_bump,
        has_one = payer,
        has_one = beneficiary,
        has_one = mint,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    /// Must be Payer or Arbiter
    #[account(
        mut,
        constraint = authority.key() == escrow.payer || authority.key() == escrow.arbiter @ VaultError::UnauthorizedCancellation
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub payer: SystemAccount<'info>,

    /// CHECK: Beneficiary receives accrued stream prior to shutdown
    pub beneficiary: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"vault_token", escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = payer,
    )]
    pub payer_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = beneficiary,
    )]
    pub beneficiary_token_account: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// State Schema
// -----------------------------------------------------------------------------
#[account]
pub struct EscrowAccount {
    pub escrow_id: u64,          // 8
    pub payer: Pubkey,           // 32
    pub beneficiary: Pubkey,     // 32
    pub arbiter: Pubkey,         // 32
    pub mint: Pubkey,            // 32
    pub total_deposit: u64,      // 8
    pub streaming_amount: u64,   // 8
    pub milestone_amount: u64,   // 8
    pub streaming_claimed: u64,  // 8
    pub milestone_claimed: u64,  // 8
    pub start_time: i64,         // 8
    pub end_time: i64,           // 8
    pub milestones_total: u8,    // 1
    pub milestones_approved: u8, // 1
    pub is_paused: bool,         // 1
    pub is_cancelled: bool,      // 1
    pub escrow_bump: u8,         // 1
    pub vault_bump: u8,          // 1
}

impl EscrowAccount {
    pub const INIT_SPACE: usize = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 1 + 1 + 1;
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------
#[event]
pub struct EscrowInitializedEvent {
    pub escrow_id: u64,
    pub payer: Pubkey,
    pub beneficiary: Pubkey,
    pub total_deposit: u64,
    pub streaming_amount: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub timestamp: i64,
}

#[event]
pub struct StreamClaimedEvent {
    pub escrow_id: u64,
    pub beneficiary: Pubkey,
    pub amount: u64,
    pub total_stream_claimed: u64,
    pub timestamp: i64,
}

#[event]
pub struct MilestoneReleasedEvent {
    pub escrow_id: u64,
    pub milestone_index: u8,
    pub approved_by: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct VaultCancelledEvent {
    pub escrow_id: u64,
    pub cancelled_by: Pubkey,
    pub accrued_paid_to_beneficiary: u64,
    pub refunded_to_payer: u64,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// Error Codes
// -----------------------------------------------------------------------------
#[error_code]
pub enum VaultError {
    #[msg("Total deposit amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Streaming allocation cannot exceed total escrow deposit.")]
    InvalidStreamAllocation,
    #[msg("Vault end time must be greater than start time.")]
    InvalidTimeWindow,
    #[msg("Escrow end time cannot be set in the past.")]
    EndTimeInPast,
    #[msg("Milestone count exceeds maximum configured limit of 10.")]
    ExcessiveMilestones,
    #[msg("Vault is currently paused by arbiter.")]
    VaultPaused,
    #[msg("Vault has been cancelled.")]
    VaultCancelled,
    #[msg("Streaming period has not started yet.")]
    StreamNotStarted,
    #[msg("No claimable streaming funds available at this timestamp.")]
    NoClaimableFunds,
    #[msg("Vault does not have milestone tranches configured.")]
    NoMilestonesConfigured,
    #[msg("Milestones must be approved in sequential order.")]
    InvalidMilestoneSequence,
    #[msg("Milestone index is out of bounds.")]
    MilestoneOutOfBounds,
    #[msg("Signer is not authorized to approve milestones for this escrow.")]
    UnauthorizedApprover,
    #[msg("Signer is not authorized to cancel or arbitrate this escrow.")]
    UnauthorizedCancellation,
    #[msg("Escrow is already cancelled.")]
    AlreadyCancelled,
    #[msg("Numerical arithmetic overflow detected.")]
    MathOverflow,
}