use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("Aegis11111111111111111111111111111111111111");

#[program]
pub mod aegis_escrow {
    use super::*;

    /// Initialize a new milestone escrow agreement with an assigned arbiter and timeout.
    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        escrow_id: u64,
        amount: u64,
        deadline_timestamp: i64,
        milestone_metadata_hash: [u8; 32],
    ) -> Result<()> {
        require!(amount > 0, AegisError::InvalidDepositAmount);
        let clock = Clock::get()?;
        require!(
            deadline_timestamp > clock.unix_timestamp,
            AegisError::InvalidDeadline
        );

        let escrow = &mut ctx.accounts.escrow;
        escrow.escrow_id = escrow_id;
        escrow.payer = ctx.accounts.payer.key();
        escrow.recipient = ctx.accounts.recipient.key();
        escrow.arbiter = ctx.accounts.arbiter.key();
        escrow.amount = amount;
        escrow.deadline_timestamp = deadline_timestamp;
        escrow.milestone_metadata_hash = milestone_metadata_hash;
        escrow.status = EscrowStatus::Initialized;
        escrow.submission_hash = [0u8; 32];
        escrow.bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.vault;

        emit!(EscrowInitializedEvent {
            escrow_id,
            payer: escrow.payer,
            recipient: escrow.recipient,
            arbiter: escrow.arbiter,
            amount,
            deadline_timestamp,
        });

        Ok(())
    }

    /// Deposit funds into the Escrow Vault PDA.
    pub fn deposit_funds(ctx: Context<DepositFunds>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::Initialized,
            AegisError::InvalidStateTransition
        );

        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        transfer(cpi_context, escrow.amount)?;

        escrow.status = EscrowStatus::Funded;

        emit!(EscrowFundedEvent {
            escrow_id: escrow.escrow_id,
            payer: escrow.payer,
            amount: escrow.amount,
        });

        Ok(())
    }

    /// Recipient submits proof of delivery (e.g. SHA-256 of code commit, shipping doc, or artifact).
    pub fn submit_milestone(
        ctx: Context<SubmitMilestone>,
        submission_hash: [u8; 32],
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::Funded,
            AegisError::InvalidStateTransition
        );
        require!(
            submission_hash != [0u8; 32],
            AegisError::InvalidSubmissionHash
        );

        escrow.submission_hash = submission_hash;
        escrow.status = EscrowStatus::DeliverableSubmitted;

        emit!(MilestoneSubmittedEvent {
            escrow_id: escrow.escrow_id,
            recipient: escrow.recipient,
            submission_hash,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Payer or Arbiter approves the milestone; releases 100% of escrowed vault to Recipient.
    pub fn approve_and_release(ctx: Context<ApproveAndRelease>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::DeliverableSubmitted
                || (escrow.status == EscrowStatus::Funded
                    && ctx.accounts.signer.key() == escrow.payer),
            AegisError::InvalidStateTransition
        );

        let signer_key = ctx.accounts.signer.key();
        require!(
            signer_key == escrow.payer || signer_key == escrow.arbiter,
            AegisError::UnauthorizedSigner
        );

        let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
        let vault_bump = escrow.vault_bump;
        let seeds: &[&[&[u8]]] = &[&[
            b"aegis_vault",
            escrow.to_account_info().key.as_ref(),
            &[vault_bump],
        ]];

        let amount_to_transfer = escrow.amount;

        // Transfer funds from Vault to Recipient using Vault PDA signer
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= amount_to_transfer;
        **ctx.accounts.recipient.to_account_info().try_borrow_mut_lamports()? += amount_to_transfer;

        escrow.status = EscrowStatus::Released;

        emit!(EscrowReleasedEvent {
            escrow_id: escrow.escrow_id,
            released_to: escrow.recipient,
            amount: amount_to_transfer,
        });

        Ok(())
    }

    /// Either party can raise a dispute if deliverables are unsatisfactory or deadline is breached.
    pub fn raise_dispute(ctx: Context<RaiseDispute>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::Funded
                || escrow.status == EscrowStatus::DeliverableSubmitted,
            AegisError::InvalidStateTransition
        );

        escrow.status = EscrowStatus::Disputed;

        emit!(DisputeRaisedEvent {
            escrow_id: escrow.escrow_id,
            raised_by: ctx.accounts.signer.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Designated Arbiter resolves dispute with explicit split (payer_bps + recipient_bps == 10000).
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        payer_split_bps: u16,
        recipient_split_bps: u16,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::Disputed,
            AegisError::InvalidStateTransition
        );
        require!(
            payer_split_bps.checked_add(recipient_split_bps) == Some(10_000),
            AegisError::InvalidSplitBasisPoints
        );

        let total_lamports = escrow.amount;
        let payer_share = (total_lamports as u128 * payer_split_bps as u128 / 10_000) as u64;
        let recipient_share = total_lamports.saturating_sub(payer_share);

        let vault_info = ctx.accounts.vault.to_account_info();
        let payer_info = ctx.accounts.payer.to_account_info();
        let recipient_info = ctx.accounts.recipient.to_account_info();

        **vault_info.try_borrow_mut_lamports()? -= total_lamports;
        **payer_info.try_borrow_mut_lamports()? += payer_share;
        **recipient_info.try_borrow_mut_lamports()? += recipient_share;

        escrow.status = EscrowStatus::Resolved;

        emit!(DisputeResolvedEvent {
            escrow_id: escrow.escrow_id,
            payer_refund: payer_share,
            recipient_payout: recipient_share,
        });

        Ok(())
    }

    /// Auto-refund to Payer if deadline expired without submission.
    pub fn claim_expired_refund(ctx: Context<ClaimExpiredRefund>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let clock = Clock::get()?;

        require!(
            escrow.status == EscrowStatus::Funded,
            AegisError::InvalidStateTransition
        );
        require!(
            clock.unix_timestamp > escrow.deadline_timestamp,
            AegisError::DeadlineNotBreached
        );

        let amount = escrow.amount;
        let vault_info = ctx.accounts.vault.to_account_info();
        let payer_info = ctx.accounts.payer.to_account_info();

        **vault_info.try_borrow_mut_lamports()? -= amount;
        **payer_info.try_borrow_mut_lamports()? += amount;

        escrow.status = EscrowStatus::Refunded;

        emit!(EscrowRefundedEvent {
            escrow_id: escrow.escrow_id,
            refunded_to: escrow.payer,
            amount,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT STRUCTURES
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct InitializeEscrow<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + EscrowAccount::INIT_SPACE,
        seeds = [b"aegis_escrow", payer.key().as_ref(), &escrow_id.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    /// CHECK: Vault PDA holding escrowed lamports. Guaranteed safe via PDA derivation.
    #[account(
        mut,
        seeds = [b"aegis_vault", escrow.key().as_ref()],
        bump
    )]
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Recipient receiving unlocked milestone funds.
    pub recipient: AccountInfo<'info>,

    /// CHECK: Arbiter authorized to resolve potential disputes.
    pub arbiter: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositFunds<'info> {
    #[account(
        mut,
        has_one = payer,
        seeds = [b"aegis_escrow", payer.key().as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    /// CHECK: Vault PDA derived from escrow key.
    #[account(
        mut,
        seeds = [b"aegis_vault", escrow.key().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitMilestone<'info> {
    #[account(
        mut,
        has_one = recipient,
        seeds = [b"aegis_escrow", escrow.payer.as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    pub recipient: Signer<'info>,
}

#[derive(Accounts)]
pub struct ApproveAndRelease<'info> {
    #[account(
        mut,
        has_one = recipient,
        seeds = [b"aegis_escrow", escrow.payer.as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    /// CHECK: Escrow Vault account to withdraw from
    #[account(
        mut,
        seeds = [b"aegis_vault", escrow.key().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault: AccountInfo<'info>,

    /// CHECK: Recipient wallet
    #[account(mut, address = escrow.recipient)]
    pub recipient: AccountInfo<'info>,

    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    #[account(
        mut,
        seeds = [b"aegis_escrow", escrow.payer.as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        constraint = signer.key() == escrow.payer || signer.key() == escrow.recipient @ AegisError::UnauthorizedSigner
    )]
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(
        mut,
        has_one = arbiter,
        seeds = [b"aegis_escrow", escrow.payer.as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    /// CHECK: Escrow Vault account
    #[account(
        mut,
        seeds = [b"aegis_vault", escrow.key().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault: AccountInfo<'info>,

    /// CHECK: Escrow Payer wallet
    #[account(mut, address = escrow.payer)]
    pub payer: AccountInfo<'info>,

    /// CHECK: Escrow Recipient wallet
    #[account(mut, address = escrow.recipient)]
    pub recipient: AccountInfo<'info>,

    pub arbiter: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimExpiredRefund<'info> {
    #[account(
        mut,
        has_one = payer,
        seeds = [b"aegis_escrow", payer.key().as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    /// CHECK: Escrow Vault
    #[account(
        mut,
        seeds = [b"aegis_vault", escrow.key().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,
}

// -----------------------------------------------------------------------------
// STATE & ENUMS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct EscrowAccount {
    pub escrow_id: u64,
    pub payer: Pubkey,
    pub recipient: Pubkey,
    pub arbiter: Pubkey,
    pub amount: u64,
    pub deadline_timestamp: i64,
    pub milestone_metadata_hash: [u8; 32],
    pub submission_hash: [u8; 32],
    pub status: EscrowStatus,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowStatus {
    Initialized,
    Funded,
    DeliverableSubmitted,
    Released,
    Disputed,
    Resolved,
    Refunded,
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct EscrowInitializedEvent {
    pub escrow_id: u64,
    pub payer: Pubkey,
    pub recipient: Pubkey,
    pub arbiter: Pubkey,
    pub amount: u64,
    pub deadline_timestamp: i64,
}

#[event]
pub struct EscrowFundedEvent {
    pub escrow_id: u64,
    pub payer: Pubkey,
    pub amount: u64,
}

#[event]
pub struct MilestoneSubmittedEvent {
    pub escrow_id: u64,
    pub recipient: Pubkey,
    pub submission_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct EscrowReleasedEvent {
    pub escrow_id: u64,
    pub released_to: Pubkey,
    pub amount: u64,
}

#[event]
pub struct DisputeRaisedEvent {
    pub escrow_id: u64,
    pub raised_by: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct DisputeResolvedEvent {
    pub escrow_id: u64,
    pub payer_refund: u64,
    pub recipient_payout: u64,
}

#[event]
pub struct EscrowRefundedEvent {
    pub escrow_id: u64,
    pub refunded_to: Pubkey,
    pub amount: u64,
}

// -----------------------------------------------------------------------------
// ERRORS
// -----------------------------------------------------------------------------

#[error_code]
pub enum AegisError {
    #[msg("Deposit amount must be strictly greater than zero.")]
    InvalidDepositAmount,
    #[msg("Deadline timestamp must be in the future.")]
    InvalidDeadline,
    #[msg("Invalid state transition for current escrow status.")]
    InvalidStateTransition,
    #[msg("Submission deliverable hash cannot be empty.")]
    InvalidSubmissionHash,
    #[msg("Unauthorized signer for this escrow instruction.")]
    UnauthorizedSigner,
    #[msg("Dispute split basis points must total exactly 10,000 (100%).")]
    InvalidSplitBasisPoints,
    #[msg("Cannot claim expired refund prior to deadline expiration.")]
    DeadlineNotBreached,
}