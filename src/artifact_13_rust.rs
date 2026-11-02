use anchor_lang::prelude::*;
use crate::errors::AegisError;
use crate::events::{DisputeRaised, DisputeResolved};
use crate::state::{EscrowAccount, EscrowStatus};

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    #[account(
        mut,
        seeds = [b"escrow", escrow_account.depositor.as_ref(), &escrow_account.escrow_id.to_le_bytes()],
        bump = escrow_account.bump
    )]
    pub escrow_account: Account<'info, EscrowAccount>,

    pub initiator: Signer<'info>,
}

pub fn raise_dispute_handler(ctx: Context<RaiseDispute>, reason_hash: [u8; 32]) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow_account;
    require!(
        ctx.accounts.initiator.key() == escrow.depositor || ctx.accounts.initiator.key() == escrow.payee,
        AegisError::Unauthorized
    );
    require!(
        escrow.status == EscrowStatus::Funded || escrow.status == EscrowStatus::PartiallyReleased,
        AegisError::InvalidStateForDeposit
    );

    escrow.status = EscrowStatus::Disputed;

    emit!(DisputeRaised {
        escrow_id: escrow.escrow_id,
        initiator: ctx.accounts.initiator.key(),
        reason_hash,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(
        mut,
        seeds = [b"escrow", escrow_account.depositor.as_ref(), &escrow_account.escrow_id.to_le_bytes()],
        bump = escrow_account.bump,
        has_one = arbiter @ AegisError::Unauthorized,
        has_one = depositor @ AegisError::Unauthorized,
        has_one = payee @ AegisError::Unauthorized
    )]
    pub escrow_account: Account<'info, EscrowAccount>,

    /// CHECK: Vault holding remaining balance
    #[account(
        mut,
        seeds = [b"vault", escrow_account.key().as_ref()],
        bump = escrow_account.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    pub arbiter: Signer<'info>,

    #[account(mut)]
    /// CHECK: Depositor receives unallocated portion
    pub depositor: AccountInfo<'info>,

    #[account(mut)]
    /// CHECK: Payee receives awarded portion
    pub payee: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn resolve_dispute_handler(ctx: Context<ResolveDispute>, payee_share_bps: u16) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow_account;
    require!(escrow.status == EscrowStatus::Disputed, AegisError::EscrowNotFunded);
    require!(payee_share_bps <= 10_000, AegisError::InvalidShareBps);

    let remaining_balance = ctx.accounts.vault.to_account_info().lamports();
    require!(remaining_balance > 0, AegisError::ZeroBalance);

    let payee_amount = (remaining_balance as u128)
        .checked_mul(payee_share_bps as u128)
        .ok_or(AegisError::MathOverflow)?
        / 10_000u128;
    let payee_payout = payee_amount as u64;
    let depositor_refund = remaining_balance.saturating_sub(payee_payout);

    let escrow_key = escrow.key();
    let vault_seeds: &[&[u8]] = &[
        b"vault",
        escrow_key.as_ref(),
        &[escrow.vault_bump],
    ];
    let signer = &[vault_seeds];

    if payee_payout > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.payee.to_account_info(),
                },
                signer,
            ),
            payee_payout,
        )?;
    }

    if depositor_refund > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.depositor.to_account_info(),
                },
                signer,
            ),
            depositor_refund,
        )?;
    }

    escrow.status = EscrowStatus::Completed;

    emit!(DisputeResolved {
        escrow_id: escrow.escrow_id,
        arbiter: ctx.accounts.arbiter.key(),
        payee_refund: payee_payout,
        depositor_refund,
    });

    Ok(())
}