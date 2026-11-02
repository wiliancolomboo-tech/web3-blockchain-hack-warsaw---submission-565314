use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("Aegis111111111111111111111111111111111111111");

pub const MAX_MILESTONES: usize = 10;
pub const PROTOCOL_FEE_BPS: u64 = 50; // 0.5% protocol fee
pub const BPS_DENOMINATOR: u64 = 10_000;

#[program]
pub mod aegis_stream {
    use super::*;

    /// Initializes an escrow vault and configures milestone commitments.
    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        escrow_seed: u64,
        total_amount: u64,
        review_window_seconds: i64,
        milestone_amounts: Vec<u64>,
    ) -> Result<()> {
        require!(
            !milestone_amounts.is_empty() && milestone_amounts.len() <= MAX_MILESTONES,
            AegisError::InvalidMilestoneCount
        );
        require!(review_window_seconds >= 60, AegisError::ReviewWindowTooShort);

        let sum: u64 = milestone_amounts.iter().sum();
        require!(sum == total_amount, AegisError::MilestoneSumMismatch);

        // Fund vault via native SOL transfer from buyer
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        transfer(cpi_context, total_amount)?;

        let escrow = &mut ctx.accounts.escrow_state;
        escrow.buyer = ctx.accounts.buyer.key();
        escrow.seller = ctx.accounts.seller.key();
        escrow.arbitrator = ctx.accounts.arbitrator.key();
        escrow.protocol_treasury = ctx.accounts.protocol_treasury.key();
        escrow.vault = ctx.accounts.vault.key();
        escrow.escrow_seed = escrow_seed;
        escrow.total_amount = total_amount;
        escrow.remaining_balance = total_amount;
        escrow.review_window_seconds = review_window_seconds;
        escrow.created_at = Clock::get()?.unix_timestamp;
        escrow.bump = ctx.bumps.escrow_state;
        escrow.vault_bump = ctx.bumps.vault;
        escrow.milestone_count = milestone_amounts.len() as u8;

        for (i, amt) in milestone_amounts.iter().enumerate() {
            escrow.milestones[i] = MilestoneItem {
                amount: *amt,
                status: MilestoneStatus::Pending,
                submission_ts: 0,
                deliverable_hash: [0u8; 32],
            };
        }

        emit!(EscrowCreatedEvent {
            escrow: escrow.key(),
            buyer: escrow.buyer,
            seller: escrow.seller,
            total_amount,
            milestones_count: escrow.milestone_count,
        });

        Ok(())
    }

    /// Seller submits deliverable commitment (SHA-256 hash) for a given milestone.
    pub fn submit_milestone(
        ctx: Context<SubmitMilestone>,
        milestone_idx: u8,
        deliverable_hash: [u8; 32],
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        let idx = milestone_idx as usize;

        require!(idx < escrow.milestone_count as usize, AegisError::IndexOutOfBounds);
        require!(
            escrow.milestones[idx].status == MilestoneStatus::Pending,
            AegisError::MilestoneNotPending
        );

        let current_ts = Clock::get()?.unix_timestamp;
        escrow.milestones[idx].status = MilestoneStatus::Submitted;
        escrow.milestones[idx].submission_ts = current_ts;
        escrow.milestones[idx].deliverable_hash = deliverable_hash;

        emit!(MilestoneSubmittedEvent {
            escrow: escrow.key(),
            milestone_idx,
            deliverable_hash,
            submission_ts: current_ts,
        });

        Ok(())
    }

    /// Buyer explicitly reviews and approves the milestone, immediately disbursing funds.
    pub fn approve_milestone(ctx: Context<BuyerAction>, milestone_idx: u8) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        let idx = milestone_idx as usize;

        require!(idx < escrow.milestone_count as usize, AegisError::IndexOutOfBounds);
        require!(
            escrow.milestones[idx].status == MilestoneStatus::Submitted,
            AegisError::MilestoneNotSubmitted
        );

        execute_milestone_payout(
            escrow,
            &ctx.accounts.vault,
            &ctx.accounts.seller,
            &ctx.accounts.protocol_treasury,
            idx,
        )?;

        escrow.milestones[idx].status = MilestoneStatus::Approved;

        emit!(MilestoneSettledEvent {
            escrow: escrow.key(),
            milestone_idx,
            settled_by: ctx.accounts.buyer.key(),
            payout_amount: escrow.milestones[idx].amount,
            auto_released: false,
        });

        Ok(())
    }

    /// Automated Crank or Seller claims funds if buyer fails to review within `review_window_seconds`.
    pub fn trigger_auto_release(ctx: Context<AutoRelease>, milestone_idx: u8) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        let idx = milestone_idx as usize;

        require!(idx < escrow.milestone_count as usize, AegisError::IndexOutOfBounds);
        require!(
            escrow.milestones[idx].status == MilestoneStatus::Submitted,
            AegisError::MilestoneNotSubmitted
        );

        let current_ts = Clock::get()?.unix_timestamp;
        let deadline = escrow.milestones[idx]
            .submission_ts
            .checked_add(escrow.review_window_seconds)
            .ok_or(AegisError::MathOverflow)?;

        require!(current_ts >= deadline, AegisError::ReviewWindowStillActive);

        execute_milestone_payout(
            escrow,
            &ctx.accounts.vault,
            &ctx.accounts.seller,
            &ctx.accounts.protocol_treasury,
            idx,
        )?;

        escrow.milestones[idx].status = MilestoneStatus::Approved;

        emit!(MilestoneSettledEvent {
            escrow: escrow.key(),
            milestone_idx,
            settled_by: ctx.accounts.caller.key(),
            payout_amount: escrow.milestones[idx].amount,
            auto_released: true,
        });

        Ok(())
    }

    /// Buyer disputes a submitted milestone before the review window expires.
    pub fn dispute_milestone(ctx: Context<BuyerAction>, milestone_idx: u8) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        let idx = milestone_idx as usize;

        require!(idx < escrow.milestone_count as usize, AegisError::IndexOutOfBounds);
        require!(
            escrow.milestones[idx].status == MilestoneStatus::Submitted,
            AegisError::MilestoneNotSubmitted
        );

        escrow.milestones[idx].status = MilestoneStatus::Disputed;

        emit!(MilestoneDisputedEvent {
            escrow: escrow.key(),
            milestone_idx,
            disputed_by: ctx.accounts.buyer.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Designated arbitrator arbitrates a disputed milestone with split basis points (buyer_bps + seller_bps = 10000).
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        milestone_idx: u8,
        seller_bps: u64,
    ) -> Result<()> {
        require!(seller_bps <= BPS_DENOMINATOR, AegisError::InvalidBasisPoints);
        let escrow = &mut ctx.accounts.escrow_state;
        let idx = milestone_idx as usize;

        require!(idx < escrow.milestone_count as usize, AegisError::IndexOutOfBounds);
        require!(
            escrow.milestones[idx].status == MilestoneStatus::Disputed,
            AegisError::MilestoneNotInDispute
        );

        let amount = escrow.milestones[idx].amount;
        let seller_portion = (amount as u128)
            .checked_mul(seller_bps as u128)
            .ok_or(AegisError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR as u128)
            .ok_or(AegisError::MathOverflow)? as u64;

        let buyer_portion = amount
            .checked_sub(seller_portion)
            .ok_or(AegisError::MathOverflow)?;

        let escrow_seed = escrow.escrow_seed.to_le_bytes();
        let buyer_key = escrow.buyer;
        let seeds: &[&[u8]] = &[
            b"escrow_vault",
            buyer_key.as_ref(),
            &escrow_seed,
            &[escrow.vault_bump],
        ];
        let signer = &[seeds];

        if seller_portion > 0 {
            **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= seller_portion;
            **ctx.accounts.seller.to_account_info().try_borrow_mut_lamports()? += seller_portion;
        }

        if buyer_portion > 0 {
            **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= buyer_portion;
            **ctx.accounts.buyer.to_account_info().try_borrow_mut_lamports()? += buyer_portion;
        }

        escrow.remaining_balance = escrow
            .remaining_balance
            .checked_sub(amount)
            .ok_or(AegisError::MathOverflow)?;
        escrow.milestones[idx].status = MilestoneStatus::Resolved;

        emit!(DisputeResolvedEvent {
            escrow: escrow.key(),
            milestone_idx,
            seller_portion,
            buyer_portion,
        });

        Ok(())
    }
}

/// Internal helper for milestone payouts with fee separation
fn execute_milestone_payout<'info>(
    escrow: &mut Account<'info, EscrowState>,
    vault: &AccountInfo<'info>,
    seller: &AccountInfo<'info>,
    protocol_treasury: &AccountInfo<'info>,
    idx: usize,
) -> Result<()> {
    let milestone_amount = escrow.milestones[idx].amount;

    let fee = (milestone_amount as u128)
        .checked_mul(PROTOCOL_FEE_BPS as u128)
        .ok_or(AegisError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(AegisError::MathOverflow)? as u64;

    let net_seller_amount = milestone_amount
        .checked_sub(fee)
        .ok_or(AegisError::MathOverflow)?;

    // Mutate lamports directly across PDAs
    **vault.try_borrow_mut_lamports()? = vault
        .lamports()
        .checked_sub(milestone_amount)
        .ok_or(AegisError::InsufficientVaultBalance)?;

    **seller.try_borrow_mut_lamports()? = seller
        .lamports()
        .checked_add(net_seller_amount)
        .ok_or(AegisError::MathOverflow)?;

    **protocol_treasury.try_borrow_mut_lamports()? = protocol_treasury
        .lamports()
        .checked_add(fee)
        .ok_or(AegisError::MathOverflow)?;

    escrow.remaining_balance = escrow
        .remaining_balance
        .checked_sub(milestone_amount)
        .ok_or(AegisError::MathOverflow)?;

    Ok(())
}

// ---------------------------------------------------------------------------------
// Account Contexts
// ---------------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(escrow_seed: u64)]
pub struct InitializeEscrow<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: Target recipient account of milestone deliverables.
    pub seller: AccountInfo<'info>,

    /// CHECK: Arbitrator pubkey authorized to resolve disputes.
    pub arbitrator: AccountInfo<'info>,

    /// CHECK: Protocol Treasury recipient pubkey.
    #[account(mut)]
    pub protocol_treasury: AccountInfo<'info>,

    #[account(
        init,
        payer = buyer,
        space = 8 + EscrowState::INIT_SPACE,
        seeds = [b"escrow_state", buyer.key().as_ref(), &escrow_seed.to_le_bytes()],
        bump
    )]
    pub escrow_state: Account<'info, EscrowState>,

    /// CHECK: Native Vault PDA holding SOL balance.
    #[account(
        mut,
        seeds = [b"escrow_vault", buyer.key().as_ref(), &escrow_seed.to_le_bytes()],
        bump
    )]
    pub vault: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitMilestone<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        mut,
        has_one = seller @ AegisError::UnauthorizedSeller,
    )]
    pub escrow_state: Account<'info, EscrowState>,
}

#[derive(Accounts)]
pub struct BuyerAction<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        has_one = buyer @ AegisError::UnauthorizedBuyer,
        has_one = vault @ AegisError::InvalidVaultAccount,
        has_one = seller @ AegisError::InvalidSellerAccount,
        has_one = protocol_treasury @ AegisError::InvalidTreasuryAccount,
    )]
    pub escrow_state: Account<'info, EscrowState>,

    /// CHECK: Vault PDA verified via state constraint.
    #[account(mut)]
    pub vault: AccountInfo<'info>,

    /// CHECK: Seller account verified via state constraint.
    #[account(mut)]
    pub seller: AccountInfo<'info>,

    /// CHECK: Treasury account verified via state constraint.
    #[account(mut)]
    pub protocol_treasury: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct AutoRelease<'info> {
    /// Permissionless crank or seller trigger
    pub caller: Signer<'info>,

    #[account(
        mut,
        has_one = vault @ AegisError::InvalidVaultAccount,
        has_one = seller @ AegisError::InvalidSellerAccount,
        has_one = protocol_treasury @ AegisError::InvalidTreasuryAccount,
    )]
    pub escrow_state: Account<'info, EscrowState>,

    /// CHECK: Vault PDA verified via state constraint.
    #[account(mut)]
    pub vault: AccountInfo<'info>,

    /// CHECK: Seller account verified via state constraint.
    #[account(mut)]
    pub seller: AccountInfo<'info>,

    /// CHECK: Treasury account verified via state constraint.
    #[account(mut)]
    pub protocol_treasury: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    pub arbitrator: Signer<'info>,

    #[account(
        mut,
        has_one = arbitrator @ AegisError::UnauthorizedArbitrator,
        has_one = buyer @ AegisError::InvalidBuyerAccount,
        has_one = seller @ AegisError::InvalidSellerAccount,
        has_one = vault @ AegisError::InvalidVaultAccount,
    )]
    pub escrow_state: Account<'info, EscrowState>,

    /// CHECK: Buyer account.
    #[account(mut)]
    pub buyer: AccountInfo<'info>,

    /// CHECK: Seller account.
    #[account(mut)]
    pub seller: AccountInfo<'info>,

    /// CHECK: Vault account.
    #[account(mut)]
    pub vault: AccountInfo<'info>,
}

// ---------------------------------------------------------------------------------
// State & Structs
// ---------------------------------------------------------------------------------

#[account]
pub struct EscrowState {
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub arbitrator: Pubkey,
    pub protocol_treasury: Pubkey,
    pub vault: Pubkey,
    pub escrow_seed: u64,
    pub total_amount: u64,
    pub remaining_balance: u64,
    pub review_window_seconds: i64,
    pub created_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
    pub milestone_count: u8,
    pub milestones: [MilestoneItem; MAX_MILESTONES],
}

impl EscrowState {
    pub const INIT_SPACE: usize = 32 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + (MilestoneItem::SPACE * MAX_MILESTONES);
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub struct MilestoneItem {
    pub amount: u64,
    pub status: MilestoneStatus,
    pub submission_ts: i64,
    pub deliverable_hash: [u8; 32],
}

impl MilestoneItem {
    pub const SPACE: usize = 8 + 1 + 8 + 32;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum MilestoneStatus {
    Pending,
    Submitted,
    Approved,
    Disputed,
    Resolved,
}

// ---------------------------------------------------------------------------------
// Events & Errors
// ---------------------------------------------------------------------------------

#[event]
pub struct EscrowCreatedEvent {
    pub escrow: Pubkey,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub total_amount: u64,
    pub milestones_count: u8,
}

#[event]
pub struct MilestoneSubmittedEvent {
    pub escrow: Pubkey,
    pub milestone_idx: u8,
    pub deliverable_hash: [u8; 32],
    pub submission_ts: i64,
}

#[event]
pub struct MilestoneSettledEvent {
    pub escrow: Pubkey,
    pub milestone_idx: u8,
    pub settled_by: Pubkey,
    pub payout_amount: u64,
    pub auto_released: bool,
}

#[event]
pub struct MilestoneDisputedEvent {
    pub escrow: Pubkey,
    pub milestone_idx: u8,
    pub disputed_by: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct DisputeResolvedEvent {
    pub escrow: Pubkey,
    pub milestone_idx: u8,
    pub seller_portion: u64,
    pub buyer_portion: u64,
}

#[error_code]
pub enum AegisError {
    #[msg("Invalid milestone count. Must be between 1 and 10.")]
    InvalidMilestoneCount,
    #[msg("Review window must be at least 60 seconds.")]
    ReviewWindowTooShort,
    #[msg("Sum of milestone amounts does not match total amount.")]
    MilestoneSumMismatch,
    #[msg("Milestone index out of bounds.")]
    IndexOutOfBounds,
    #[msg("Milestone is not in Pending status.")]
    MilestoneNotPending,
    #[msg("Milestone is not in Submitted status.")]
    MilestoneNotSubmitted,
    #[msg("Review window is still active; auto-release cannot be triggered yet.")]
    ReviewWindowStillActive,
    #[msg("Milestone is not in Disputed status.")]
    MilestoneNotInDispute,
    #[msg("Invalid basis points. Must not exceed 10000.")]
    InvalidBasisPoints,
    #[msg("Mathematical overflow occurred.")]
    MathOverflow,
    #[msg("Insufficient balance in escrow vault.")]
    InsufficientVaultBalance,
    #[msg("Unauthorized: Signer is not the registered Buyer.")]
    UnauthorizedBuyer,
    #[msg("Unauthorized: Signer is not the registered Seller.")]
    UnauthorizedSeller,
    #[msg("Unauthorized: Signer is not the registered Arbitrator.")]
    UnauthorizedArbitrator,
    #[msg("Invalid vault PDA provided.")]
    InvalidVaultAccount,
    #[msg("Invalid seller account provided.")]
    InvalidSellerAccount,
    #[msg("Invalid buyer account provided.")]
    InvalidBuyerAccount,
    #[msg("Invalid treasury account provided.")]
    InvalidTreasuryAccount,
}