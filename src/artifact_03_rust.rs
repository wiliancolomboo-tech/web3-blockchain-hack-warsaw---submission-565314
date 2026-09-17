use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Vist111111111111111111111111111111111111111");

pub const BATCH_SEED: &[u8] = b"batch";
pub const VAULT_SEED: &[u8] = b"vault";
pub const ORDER_SEED: &[u8] = b"order";
pub const CONFIG_SEED: &[u8] = b"config";
pub const BPS_DENOMINATOR: u64 = 10_000;

#[program]
pub mod vistula_engine {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        protocol_fee_bps: u16,
        crank_fee_bps: u16,
    ) -> Result<()> {
        require!(
            protocol_fee_bps + crank_fee_bps <= 1000,
            VistulaError::FeeExceedsMaximum
        );
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.fee_receiver = ctx.accounts.fee_receiver.key();
        config.protocol_fee_bps = protocol_fee_bps;
        config.crank_fee_bps = crank_fee_bps;
        config.bump = ctx.bumps.config;
        config.total_batches_created = 0;

        emit!(ProtocolInitializedEvent {
            authority: config.authority,
            protocol_fee_bps,
            crank_fee_bps,
        });
        Ok(())
    }

    pub fn initialize_batch(
        ctx: Context<InitializeBatch>,
        batch_id: u64,
        duration_slots: u64,
    ) -> Result<()> {
        require!(duration_slots >= 2, VistulaError::DurationTooShort);
        let current_slot = Clock::get()?.slot;

        let batch = &mut ctx.accounts.batch;
        batch.batch_id = batch_id;
        batch.creator = ctx.accounts.creator.key();
        batch.token_a_mint = ctx.accounts.token_a_mint.key();
        batch.token_b_mint = ctx.accounts.token_b_mint.key();
        batch.start_slot = current_slot;
        batch.expiry_slot = current_slot.checked_add(duration_slots).ok_or(VistulaError::MathOverflow)?;
        batch.state = BatchState::Open;
        batch.total_bid_volume = 0;
        batch.total_ask_volume = 0;
        batch.matched_volume = 0;
        batch.clearing_price = 0;
        batch.bump = ctx.bumps.batch;
        batch.vault_a_bump = ctx.bumps.vault_a;
        batch.vault_b_bump = ctx.bumps.vault_b;

        let config = &mut ctx.accounts.config;
        config.total_batches_created = config.total_batches_created.checked_add(1).ok_or(VistulaError::MathOverflow)?;

        emit!(BatchCreatedEvent {
            batch_id,
            token_a: batch.token_a_mint,
            token_b: batch.token_b_mint,
            expiry_slot: batch.expiry_slot,
        });

        Ok(())
    }

    pub fn commit_order(
        ctx: Context<CommitOrder>,
        batch_id: u64,
        is_bid: bool,
        deposit_amount: u64,
        min_output_amount: u64,
    ) -> Result<()> {
        let batch = &mut ctx.accounts.batch;
        let clock = Clock::get()?;

        require!(batch.state == BatchState::Open, VistulaError::BatchNotOpen);
        require!(clock.slot < batch.expiry_slot, VistulaError::BatchExpired);
        require!(deposit_amount > 0, VistulaError::ZeroAmount);
        require!(min_output_amount > 0, VistulaError::ZeroAmount);

        let order = &mut ctx.accounts.order;
        order.batch_id = batch_id;
        order.trader = ctx.accounts.trader.key();
        order.is_bid = is_bid;
        order.deposited_amount = deposit_amount;
        order.min_output_amount = min_output_amount;
        order.claimed = false;
        order.bump = ctx.bumps.order;

        if is_bid {
            batch.total_bid_volume = batch
                .total_bid_volume
                .checked_add(deposit_amount)
                .ok_or(VistulaError::MathOverflow)?;

            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.trader_token_account.to_account_info(),
                        to: ctx.accounts.vault_a.to_account_info(),
                        authority: ctx.accounts.trader.to_account_info(),
                    },
                ),
                deposit_amount,
            )?;
        } else {
            batch.total_ask_volume = batch
                .total_ask_volume
                .checked_add(deposit_amount)
                .ok_or(VistulaError::MathOverflow)?;

            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.trader_token_account.to_account_info(),
                        to: ctx.accounts.vault_b.to_account_info(),
                        authority: ctx.accounts.trader.to_account_info(),
                    },
                ),
                deposit_amount,
            )?;
        }

        emit!(OrderCommittedEvent {
            batch_id,
            trader: order.trader,
            is_bid,
            amount: deposit_amount,
            min_output: min_output_amount,
        });

        Ok(())
    }

    pub fn lock_batch(ctx: Context<LockBatch>, _batch_id: u64) -> Result<()> {
        let batch = &mut ctx.accounts.batch;
        let clock = Clock::get()?;

        require!(batch.state == BatchState::Open, VistulaError::InvalidState);
        require!(clock.slot >= batch.expiry_slot, VistulaError::BatchStillActive);

        batch.state = BatchState::Locked;

        emit!(BatchLockedEvent {
            batch_id: batch.batch_id,
            slot: clock.slot,
        });
        Ok(())
    }

    pub fn settle_batch(
        ctx: Context<SettleBatch>,
        batch_id: u64,
        clearing_price_scaled: u64, // Clearing price represented as (Token B / Token A) * 1e6
    ) -> Result<()> {
        let batch = &mut ctx.accounts.batch;
        require!(batch.state == BatchState::Locked, VistulaError::BatchNotLocked);
        require!(clearing_price_scaled > 0, VistulaError::InvalidClearingPrice);

        // Price scale is 1_000_000 (1e6)
        let scale = 1_000_000u128;
        let total_bid = batch.total_bid_volume as u128;
        let total_ask = batch.total_ask_volume as u128;

        // Implied B requested by bids = (total_bid * clearing_price_scaled) / 1e6
        let demand_in_b = total_bid
            .checked_mul(clearing_price_scaled as u128)
            .ok_or(VistulaError::MathOverflow)?
            .checked_div(scale)
            .ok_or(VistulaError::MathOverflow)?;

        let matched_b = demand_in_b.min(total_ask);
        let matched_a = matched_b
            .checked_mul(scale)
            .ok_or(VistulaError::MathOverflow)?
            .checked_div(clearing_price_scaled as u128)
            .ok_or(VistulaError::MathOverflow)?;

        batch.matched_volume = matched_a as u64;
        batch.clearing_price = clearing_price_scaled;
        batch.state = BatchState::Settled;

        let crank_fee_rate = ctx.accounts.config.crank_fee_bps as u64;
        let crank_bounty_a = (matched_a as u64)
            .checked_mul(crank_fee_rate)
            .unwrap_or(0)
            .checked_div(BPS_DENOMINATOR)
            .unwrap_or(0);

        if crank_bounty_a > 0 {
            let batch_id_bytes = batch_id.to_le_bytes();
            let signer_seeds: &[&[&[u8]]] = &[&[
                VAULT_SEED,
                batch_id_bytes.as_ref(),
                ctx.accounts.batch.token_a_mint.as_ref(),
                &[batch.vault_a_bump],
            ]];

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_a.to_account_info(),
                        to: ctx.accounts.crank_token_a_account.to_account_info(),
                        authority: ctx.accounts.vault_a.to_account_info(),
                    },
                    signer_seeds,
                ),
                crank_bounty_a,
            )?;
        }

        emit!(BatchSettledEvent {
            batch_id,
            clearing_price: clearing_price_scaled,
            matched_volume_a: matched_a as u64,
            crank_bounty: crank_bounty_a,
        });

        Ok(())
    }

    pub fn claim_order_fill(ctx: Context<ClaimOrderFill>, batch_id: u64) -> Result<()> {
        let batch = &ctx.accounts.batch;
        let order = &mut ctx.accounts.order;

        require!(batch.state == BatchState::Settled, VistulaError::BatchNotSettled);
        require!(!order.claimed, VistulaError::OrderAlreadyClaimed);

        order.claimed = true;

        let scale = 1_000_000u128;
        let price = batch.clearing_price as u128;

        let batch_id_bytes = batch_id.to_le_bytes();
        let seeds_vault_a: &[&[&[u8]]] = &[&[
            VAULT_SEED,
            batch_id_bytes.as_ref(),
            batch.token_a_mint.as_ref(),
            &[batch.vault_a_bump],
        ]];
        let seeds_vault_b: &[&[&[u8]]] = &[&[
            VAULT_SEED,
            batch_id_bytes.as_ref(),
            batch.token_b_mint.as_ref(),
            &[batch.vault_b_bump],
        ]];

        if order.is_bid {
            let deposit_amount = order.deposited_amount as u128;
            let output_amount = deposit_amount
                .checked_mul(price)
                .ok_or(VistulaError::MathOverflow)?
                .checked_div(scale)
                .ok_or(VistulaError::MathOverflow)? as u64;

            require!(
                output_amount >= order.min_output_amount,
                VistulaError::SlippageExceeded
            );

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_b.to_account_info(),
                        to: ctx.accounts.trader_receive_account.to_account_info(),
                        authority: ctx.accounts.vault_b.to_account_info(),
                    },
                    seeds_vault_b,
                ),
                output_amount,
            )?;
        } else {
            let deposit_amount = order.deposited_amount as u128;
            let output_amount = deposit_amount
                .checked_mul(scale)
                .ok_or(VistulaError::MathOverflow)?
                .checked_div(price)
                .ok_or(VistulaError::MathOverflow)? as u64;

            require!(
                output_amount >= order.min_output_amount,
                VistulaError::SlippageExceeded
            );

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_a.to_account_info(),
                        to: ctx.accounts.trader_receive_account.to_account_info(),
                        authority: ctx.accounts.vault_a.to_account_info(),
                    },
                    seeds_vault_a,
                ),
                output_amount,
            )?;
        }

        emit!(OrderClaimedEvent {
            batch_id,
            trader: order.trader,
            is_bid: order.is_bid,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Account Contexts
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: Protocol fee treasury safe
    pub fee_receiver: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(batch_id: u64)]
pub struct InitializeBatch<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + BatchStateAccount::INIT_SPACE,
        seeds = [BATCH_SEED, batch_id.to_le_bytes().as_ref()],
        bump
    )]
    pub batch: Account<'info, BatchStateAccount>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    pub token_a_mint: Account<'info, Mint>,
    pub token_b_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = creator,
        seeds = [VAULT_SEED, batch_id.to_le_bytes().as_ref(), token_a_mint.key().as_ref()],
        bump,
        token::mint = token_a_mint,
        token::authority = vault_a
    )]
    pub vault_a: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = creator,
        seeds = [VAULT_SEED, batch_id.to_le_bytes().as_ref(), token_b_mint.key().as_ref()],
        bump,
        token::mint = token_b_mint,
        token::authority = vault_b
    )]
    pub vault_b: Account<'info, TokenAccount>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(batch_id: u64)]
pub struct CommitOrder<'info> {
    #[account(
        mut,
        seeds = [BATCH_SEED, batch_id.to_le_bytes().as_ref()],
        bump = batch.bump
    )]
    pub batch: Account<'info, BatchStateAccount>,
    #[account(
        init,
        payer = trader,
        space = 8 + EscrowOrder::INIT_SPACE,
        seeds = [ORDER_SEED, batch_id.to_le_bytes().as_ref(), trader.key().as_ref()],
        bump
    )]
    pub order: Account<'info, EscrowOrder>,
    #[account(
        mut,
        seeds = [VAULT_SEED, batch_id.to_le_bytes().as_ref(), batch.token_a_mint.as_ref()],
        bump = batch.vault_a_bump
    )]
    pub vault_a: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [VAULT_SEED, batch_id.to_le_bytes().as_ref(), batch.token_b_mint.as_ref()],
        bump = batch.vault_b_bump
    )]
    pub vault_b: Account<'info, TokenAccount>,
    #[account(mut)]
    pub trader_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub trader: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(batch_id: u64)]
pub struct LockBatch<'info> {
    #[account(
        mut,
        seeds = [BATCH_SEED, batch_id.to_le_bytes().as_ref()],
        bump = batch.bump
    )]
    pub batch: Account<'info, BatchStateAccount>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(batch_id: u64)]
pub struct SettleBatch<'info> {
    #[account(
        mut,
        seeds = [BATCH_SEED, batch_id.to_le_bytes().as_ref()],
        bump = batch.bump
    )]
    pub batch: Account<'info, BatchStateAccount>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [VAULT_SEED, batch_id.to_le_bytes().as_ref(), batch.token_a_mint.as_ref()],
        bump = batch.vault_a_bump
    )]
    pub vault_a: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [VAULT_SEED, batch_id.to_le_bytes().as_ref(), batch.token_b_mint.as_ref()],
        bump = batch.vault_b_bump
    )]
    pub vault_b: Account<'info, TokenAccount>,
    #[account(mut)]
    pub crank_token_a_account: Account<'info, TokenAccount>,
    pub crank: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(batch_id: u64)]
pub struct ClaimOrderFill<'info> {
    #[account(
        seeds = [BATCH_SEED, batch_id.to_le_bytes().as_ref()],
        bump = batch.bump
    )]
    pub batch: Account<'info, BatchStateAccount>,
    #[account(
        mut,
        seeds = [ORDER_SEED, batch_id.to_le_bytes().as_ref(), trader.key().as_ref()],
        bump = order.bump,
        has_one = trader
    )]
    pub order: Account<'info, EscrowOrder>,
    #[account(
        mut,
        seeds = [VAULT_SEED, batch_id.to_le_bytes().as_ref(), batch.token_a_mint.as_ref()],
        bump = batch.vault_a_bump
    )]
    pub vault_a: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [VAULT_SEED, batch_id.to_le_bytes().as_ref(), batch.token_b_mint.as_ref()],
        bump = batch.vault_b_bump
    )]
    pub vault_b: Account<'info, TokenAccount>,
    #[account(mut)]
    pub trader_receive_account: Account<'info, TokenAccount>,
    pub trader: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// State Layouts
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub fee_receiver: Pubkey,
    pub protocol_fee_bps: u16,
    pub crank_fee_bps: u16,
    pub total_batches_created: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum BatchState {
    Open,
    Locked,
    Settled,
    Refundable,
}

#[account]
#[derive(InitSpace)]
pub struct BatchStateAccount {
    pub batch_id: u64,
    pub creator: Pubkey,
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub start_slot: u64,
    pub expiry_slot: u64,
    pub state: BatchState,
    pub total_bid_volume: u64,
    pub total_ask_volume: u64,
    pub matched_volume: u64,
    pub clearing_price: u64,
    pub bump: u8,
    pub vault_a_bump: u8,
    pub vault_b_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct EscrowOrder {
    pub batch_id: u64,
    pub trader: Pubkey,
    pub is_bid: bool,
    pub deposited_amount: u64,
    pub min_output_amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

// -----------------------------------------------------------------------------
// Events & Errors
// -----------------------------------------------------------------------------

#[event]
pub struct ProtocolInitializedEvent {
    pub authority: Pubkey,
    pub protocol_fee_bps: u16,
    pub crank_fee_bps: u16,
}

#[event]
pub struct BatchCreatedEvent {
    pub batch_id: u64,
    pub token_a: Pubkey,
    pub token_b: Pubkey,
    pub expiry_slot: u64,
}

#[event]
pub struct OrderCommittedEvent {
    pub batch_id: u64,
    pub trader: Pubkey,
    pub is_bid: bool,
    pub amount: u64,
    pub min_output: u64,
}

#[event]
pub struct BatchLockedEvent {
    pub batch_id: u64,
    pub slot: u64,
}

#[event]
pub struct BatchSettledEvent {
    pub batch_id: u64,
    pub clearing_price: u64,
    pub matched_volume_a: u64,
    pub crank_bounty: u64,
}

#[event]
pub struct OrderClaimedEvent {
    pub batch_id: u64,
    pub trader: Pubkey,
    pub is_bid: bool,
}

#[error_code]
pub enum VistulaError {
    #[msg("Protocol and crank fee combination exceeds system max ceiling (1000 bps)")]
    FeeExceedsMaximum,
    #[msg("Batch duration must be at least 2 slots")]
    DurationTooShort,
    #[msg("Batch is not in Open status")]
    BatchNotOpen,
    #[msg("Current slot has exceeded the batch expiration boundary")]
    BatchExpired,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Operation requires Batch to be in Locked status")]
    BatchNotLocked,
    #[msg("Current slot is lower than batch expiry boundary")]
    BatchStillActive,
    #[msg("Invalid clearing price submitted")]
    InvalidClearingPrice,
    #[msg("Batch has not settled")]
    BatchNotSettled,
    #[msg("Order output falls below strict min_output slippage limit")]
    SlippageExceeded,
    #[msg("Order fill has already been claimed")]
    OrderAlreadyClaimed,
    #[msg("Arithmetic overflow or underflow detected")]
    MathOverflow,
    #[msg("Invalid state transition")]
    InvalidState,
}