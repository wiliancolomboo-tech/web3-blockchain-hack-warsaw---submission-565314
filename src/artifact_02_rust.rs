use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("StrMsh1eLd1111111111111111111111111111111111");

pub const DISCRIMINATOR_LENGTH: usize = 8;
pub const MAX_MILESTONES: usize = 5;
pub const MAX_TITLE_LEN: usize = 64;

#[program]
pub mod streamshield {
    use super::*;

    /// Initializes an enterprise milestone escrow contract and deposits funds into a PDA.
    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        escrow_id: u64,
        milestone_amounts: Vec<u64>,
        milestone_titles: Vec<String>,
    ) -> Result<()> {
        require!(
            !milestone_amounts.is_empty() && milestone_amounts.len() <= MAX_MILESTONES,
            StreamShieldError::InvalidMilestoneCount
        );
        require!(
            milestone_amounts.len() == milestone_titles.len(),
            StreamShieldError::MilestoneMismatch
        );

        let mut total_deposit: u64 = 0;
        let mut milestones: Vec<Milestone> = Vec::new();

        for (i, &amount) in milestone_amounts.iter().enumerate() {
            require!(amount > 0, StreamShieldError::ZeroAmount);
            total_deposit = total_deposit
                .checked_add(amount)
                .ok_or(StreamShieldError::ArithmeticOverflow)?;

            let title_bytes = milestone_titles[i].as_bytes();
            require!(
                title_bytes.len() <= MAX_TITLE_LEN,
                StreamShieldError::TitleTooLong
            );

            milestones.push(Milestone {
                amount,
                status: MilestoneStatus::Pending,
                deliverable_hash: [0u8; 32],
            });
        }

        // Fund the Escrow PDA via CPI from client
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.client.to_account_info(),
                to: ctx.accounts.escrow_account.to_account_info(),
            },
        );
        transfer(cpi_context, total_deposit)?;

        let escrow = &mut ctx.accounts.escrow_account;
        escrow.escrow_id = escrow_id;
        escrow.client = ctx.accounts.client.key();
        escrow.vendor = ctx.accounts.vendor.key();
        escrow.arbiter = ctx.accounts.arbiter.key();
        escrow.total_amount = total_deposit;
        escrow.remaining_balance = total_deposit;
        escrow.bump = ctx.bumps.escrow_account;
        escrow.is_disputed = false;
        escrow.milestones = milestones;

        emit!(EscrowInitializedEvent {
            escrow_id,
            client: escrow.client,
            vendor: escrow.vendor,
            total_amount: total_deposit,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Allows the vendor to submit deliverables with a 32-byte cryptographic hash.
    pub fn submit_deliverable(
        ctx: Context<SubmitDeliverable>,
        milestone_index: u8,
        deliverable_hash: [u8; 32],
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_account;
        require!(!escrow.is_disputed, StreamShieldError::EscrowInDispute);

        let idx = milestone_index as usize;
        require!(idx < escrow.milestones.len(), StreamShieldError::InvalidIndex);

        let milestone = &mut escrow.milestones[idx];
        require!(
            milestone.status == MilestoneStatus::Pending,
            StreamShieldError::MilestoneNotPending
        );

        milestone.status = MilestoneStatus::Submitted;
        milestone.deliverable_hash = deliverable_hash;

        emit!(MilestoneSubmittedEvent {
            escrow_id: escrow.escrow_id,
            milestone_index,
            deliverable_hash,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Authorizes release of funds for an approved milestone to the vendor.
    pub fn release_milestone(
        ctx: Context<ReleaseMilestone>,
        milestone_index: u8,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_account;
        require!(!escrow.is_disputed, StreamShieldError::EscrowInDispute);

        let idx = milestone_index as usize;
        require!(idx < escrow.milestones.len(), StreamShieldError::InvalidIndex);

        let amount_to_release: u64;
        {
            let milestone = &mut escrow.milestones[idx];
            require!(
                milestone.status == MilestoneStatus::Submitted || milestone.status == MilestoneStatus::Pending,
                StreamShieldError::MilestoneAlreadyCompleted
            );

            milestone.status = MilestoneStatus::Approved;
            amount_to_release = milestone.amount;
        }

        require!(
            escrow.remaining_balance >= amount_to_release,
            StreamShieldError::InsufficientContractBalance
        );

        escrow.remaining_balance = escrow
            .remaining_balance
            .checked_sub(amount_to_release)
            .ok_or(StreamShieldError::ArithmeticOverflow)?;

        // Transfer funds from PDA to vendor
        **escrow.to_account_info().try_borrow_mut_lamports()? = escrow
            .to_account_info()
            .lamports()
            .checked_sub(amount_to_release)
            .ok_or(StreamShieldError::ArithmeticOverflow)?;

        **ctx.accounts.vendor.try_borrow_mut_lamports()? = ctx
            .accounts
            .vendor
            .lamports()
            .checked_add(amount_to_release)
            .ok_or(StreamShieldError::ArithmeticOverflow)?;

        emit!(MilestoneReleasedEvent {
            escrow_id: escrow.escrow_id,
            milestone_index,
            amount: amount_to_release,
            vendor: ctx.accounts.vendor.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Raises a dispute flag, locking milestone releases until arbitration is executed.
    pub fn raise_dispute(ctx: Context<RaiseDispute>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_account;
        require!(!escrow.is_disputed, StreamShieldError::AlreadyDisputed);

        escrow.is_disputed = true;

        emit!(DisputeRaisedEvent {
            escrow_id: escrow.escrow_id,
            raised_by: ctx.accounts.caller.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// The designated arbiter resolves the dispute and partitions remaining escrow balance.
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        client_amount: u64,
        vendor_amount: u64,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_account;
        require!(escrow.is_disputed, StreamShieldError::NotInDispute);

        let total_settlement = client_amount
            .checked_add(vendor_amount)
            .ok_or(StreamShieldError::ArithmeticOverflow)?;

        require!(
            total_settlement == escrow.remaining_balance,
            StreamShieldError::InvalidSettlementAmount
        );

        let escrow_info = escrow.to_account_info();

        if client_amount > 0 {
            **escrow_info.try_borrow_mut_lamports()? = escrow_info
                .lamports()
                .checked_sub(client_amount)
                .ok_or(StreamShieldError::ArithmeticOverflow)?;
            **ctx.accounts.client.try_borrow_mut_lamports()? = ctx
                .accounts
                .client
                .lamports()
                .checked_add(client_amount)
                .ok_or(StreamShieldError::ArithmeticOverflow)?;
        }

        if vendor_amount > 0 {
            **escrow_info.try_borrow_mut_lamports()? = escrow_info
                .lamports()
                .checked_sub(vendor_amount)
                .ok_or(StreamShieldError::ArithmeticOverflow)?;
            **ctx.accounts.vendor.try_borrow_mut_lamports()? = ctx
                .accounts
                .vendor
                .lamports()
                .checked_add(vendor_amount)
                .ok_or(StreamShieldError::ArithmeticOverflow)?;
        }

        escrow.remaining_balance = 0;
        escrow.is_disputed = false;

        for milestone in escrow.milestones.iter_mut() {
            if milestone.status != MilestoneStatus::Approved {
                milestone.status = MilestoneStatus::DisputeResolved;
            }
        }

        emit!(DisputeResolvedEvent {
            escrow_id: escrow.escrow_id,
            client_amount,
            vendor_amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT STRUCTS & CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct InitializeEscrow<'info> {
    #[account(
        init,
        payer = client,
        space = DISCRIMINATOR_LENGTH + EscrowAccount::space(MAX_MILESTONES),
        seeds = [b"streamshield_escrow", client.key().as_ref(), &escrow_id.to_le_bytes()],
        bump
    )]
    pub escrow_account: Account<'info, EscrowAccount>,

    #[account(mut)]
    pub client: Signer<'info>,

    /// CHECK: Safe authority key for vendor payee
    pub vendor: AccountInfo<'info>,

    /// CHECK: Arbitrating entity key
    pub arbiter: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitDeliverable<'info> {
    #[account(
        mut,
        seeds = [b"streamshield_escrow", escrow_account.client.as_ref(), &escrow_account.escrow_id.to_le_bytes()],
        bump = escrow_account.bump,
        has_one = vendor @ StreamShieldError::UnauthorizedVendor
    )]
    pub escrow_account: Account<'info, EscrowAccount>,
    pub vendor: Signer<'info>,
}

#[derive(Accounts)]
pub struct ReleaseMilestone<'info> {
    #[account(
        mut,
        seeds = [b"streamshield_escrow", escrow_account.client.as_ref(), &escrow_account.escrow_id.to_le_bytes()],
        bump = escrow_account.bump,
        has_one = client @ StreamShieldError::UnauthorizedClient,
        has_one = vendor @ StreamShieldError::UnauthorizedVendor
    )]
    pub escrow_account: Account<'info, EscrowAccount>,

    pub client: Signer<'info>,

    /// CHECK: Vendor account to receive the released lamports
    #[account(mut)]
    pub vendor: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    #[account(
        mut,
        seeds = [b"streamshield_escrow", escrow_account.client.as_ref(), &escrow_account.escrow_id.to_le_bytes()],
        bump = escrow_account.bump
    )]
    pub escrow_account: Account<'info, EscrowAccount>,

    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(
        mut,
        seeds = [b"streamshield_escrow", escrow_account.client.as_ref(), &escrow_account.escrow_id.to_le_bytes()],
        bump = escrow_account.bump,
        has_one = arbiter @ StreamShieldError::UnauthorizedArbiter,
        has_one = client @ StreamShieldError::UnauthorizedClient,
        has_one = vendor @ StreamShieldError::UnauthorizedVendor
    )]
    pub escrow_account: Account<'info, EscrowAccount>,

    pub arbiter: Signer<'info>,

    /// CHECK: Escrow client receiving arbitrated refund
    #[account(mut)]
    pub client: AccountInfo<'info>,

    /// CHECK: Escrow vendor receiving arbitrated payment
    #[account(mut)]
    pub vendor: AccountInfo<'info>,
}

// -----------------------------------------------------------------------------
// DATA STRUCTURES
// -----------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MilestoneStatus {
    Pending,
    Submitted,
    Approved,
    DisputeResolved,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Milestone {
    pub amount: u64,
    pub status: MilestoneStatus,
    pub deliverable_hash: [u8; 32],
}

#[account]
pub struct EscrowAccount {
    pub escrow_id: u64,
    pub client: Pubkey,
    pub vendor: Pubkey,
    pub arbiter: Pubkey,
    pub total_amount: u64,
    pub remaining_balance: u64,
    pub is_disputed: bool,
    pub bump: u8,
    pub milestones: Vec<Milestone>,
}

impl EscrowAccount {
    pub fn space(max_milestones: usize) -> usize {
        8  + // escrow_id
        32 + // client
        32 + // vendor
        32 + // arbiter
        8  + // total_amount
        8  + // remaining_balance
        1  + // is_disputed
        1  + // bump
        4  + (max_milestones * (8 + 1 + 32)) // Vec<Milestone>
    }
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct EscrowInitializedEvent {
    pub escrow_id: u64,
    pub client: Pubkey,
    pub vendor: Pubkey,
    pub total_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct MilestoneSubmittedEvent {
    pub escrow_id: u64,
    pub milestone_index: u8,
    pub deliverable_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct MilestoneReleasedEvent {
    pub escrow_id: u64,
    pub milestone_index: u8,
    pub amount: u64,
    pub vendor: Pubkey,
    pub timestamp: i64,
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
    pub client_amount: u64,
    pub vendor_amount: u64,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum StreamShieldError {
    #[msg("Invalid milestone count specified.")]
    InvalidMilestoneCount,
    #[msg("Milestone amounts and titles lengths do not match.")]
    MilestoneMismatch,
    #[msg("Milestone amount must be strictly greater than zero.")]
    ZeroAmount,
    #[msg("Milestone title exceeds 64 bytes.")]
    TitleTooLong,
    #[msg("Arithmetic overflow detected.")]
    ArithmeticOverflow,
    #[msg("Milestone index out of bounds.")]
    InvalidIndex,
    #[msg("Escrow is currently locked in dispute.")]
    EscrowInDispute,
    #[msg("Milestone is not in a valid pending state.")]
    MilestoneNotPending,
    #[msg("Milestone is already completed.")]
    MilestoneAlreadyCompleted,
    #[msg("Insufficient lamport balance in escrow.")]
    InsufficientContractBalance,
    #[msg("Escrow is already marked in dispute.")]
    AlreadyDisputed,
    #[msg("Escrow is not under active dispute.")]
    NotInDispute,
    #[msg("Arbitration settlement sum does not equal remaining balance.")]
    InvalidSettlementAmount,
    #[msg("Signer is not authorized client.")]
    UnauthorizedClient,
    #[msg("Signer is not authorized vendor.")]
    UnauthorizedVendor,
    #[msg("Signer is not authorized arbiter.")]
    UnauthorizedArbiter,
}