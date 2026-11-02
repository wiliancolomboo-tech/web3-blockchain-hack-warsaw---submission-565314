use anchor_lang::prelude::*;
use crate::errors::AegisError;
use crate::events::EscrowRefunded;
use crate::state::{EscrowAccount, EscrowStatus};

#[derive(Accounts)]
pub struct RefundExpired<'info> {
    #[account(
        mut,
        seeds = [b"escrow", escrow_account.depositor.as_ref(), &escrow_account.escrow_id.to_le_bytes()],
        bump = escrow_account.bump,
        has_one = depositor @ AegisError::Unauthorized
    )]
    pub escrow_account: Account<'info, EscrowAccount>,

    /// CHECK: Escrow Vault PDA
    #[account(
        mut,
        seeds = [b"vault", escrow_account.key().as_ref()],
        bump = escrow_account.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RefundExpired>) -> Result<()> {
    let clock = Clock::get()?;
    let escrow = &mut ctx.accounts.escrow_account;

    require!(clock.unix_timestamp >= escrow.expiry_timestamp, AegisError::EscrowNotExpired);
    require!(escrow.status != EscrowStatus::Completed && escrow.status != EscrowStatus::Refunded, AegisError::EscrowClosed);
    require!(escrow.status != EscrowStatus::Disputed, AegisError::EscrowDisputed);

    let remaining_lamports = ctx.accounts.vault.to_account_info().lamports();
    require!(remaining_lamports > 0, AegisError::ZeroBalance);

    let escrow_key = escrow.key();
    let vault_seeds: &[&[u8]] = &[
        b"vault",
        escrow_key.as_ref(),
        &[escrow.vault_bump],
    ];
    let signer = &[vault_seeds];

    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.depositor.to_account_info(),
            },
            signer,
        ),
        remaining_lamports,
    )?;

    escrow.status = EscrowStatus::Refunded;

    emit!(EscrowRefunded {
        escrow_id: escrow.escrow_id,
        depositor: ctx.accounts.depositor.key(),
        refunded_amount: remaining_lamports,
    });

    Ok(())
}