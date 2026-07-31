//! Settlement: unlocking the prize, paying winners, and refunds.

use anchor_lang::prelude::*;
use anchor_lang::AccountsExit;

use crate::constants::*;
use crate::errors::ArenaError;
use crate::events::*;
use crate::settlement_math::validate_payouts;
use crate::state::*;
use crate::utils::*;

// ---------------------------------------------------------------------------
// unlock_prize
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct UnlockPrize<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [ROOM_SEED, room.room_id.as_ref()], bump = room.bump)]
    pub room: Account<'info, Room>,

    #[account(
        constraint = settlement_authority.key() == config.settlement_authority
            @ ArenaError::UnauthorizedSettlement
    )]
    pub settlement_authority: Signer<'info>,
}

/// Commits the split of the escrowed pot between winners and the house.
///
/// No lamports move here. Separating "decide the split" from "pay it out" means
/// the prize pool is fixed on-chain before any transfer, so a distribution can
/// be retried or split across transactions without the target ever shifting.
pub fn unlock_prize(ctx: Context<UnlockPrize>) -> Result<()> {
    let room = &mut ctx.accounts.room;

    require!(
        room.status == RoomStatus::InProgress,
        ArenaError::RoomNotInProgress
    );

    // Uses the fee snapshotted at room creation, not the live config value.
    let rake_amount = apply_bps(room.total_locked, room.fee_bps)?;
    let prize_pool = sub(room.total_locked, rake_amount)?;

    room.rake_amount = rake_amount;
    room.prize_pool = prize_pool;
    room.status = RoomStatus::Unlocked;
    room.unlocked_at = Clock::get()?.unix_timestamp;

    emit!(PrizeUnlocked {
        room: room.key(),
        total_locked: room.total_locked,
        prize_pool,
        rake_amount,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// distribute_winnings
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct DistributeWinnings<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [ROOM_SEED, room.room_id.as_ref()], bump = room.bump)]
    pub room: Account<'info, Room>,

    /// CHECK: Seed-validated escrow vault for this room.
    #[account(mut, seeds = [ROOM_VAULT_SEED, room.room_id.as_ref()], bump = room.vault_bump)]
    pub room_vault: UncheckedAccount<'info>,

    /// CHECK: Seed-validated custody vault. Winnings land here because winners
    /// are credited a custody balance, not paid directly to their wallet.
    #[account(mut, seeds = [POOL_SEED], bump = config.pool_bump)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: The game owner's wallet. The platform fee is paid here directly
    /// rather than into a vault they would then have to withdraw from — the
    /// constraint against `config.fee_destination` is what stops a caller
    /// substituting their own address.
    #[account(mut, constraint = fee_destination.key() == config.fee_destination
        @ ArenaError::TreasuryMismatch)]
    pub fee_destination: UncheckedAccount<'info>,

    #[account(
        constraint = settlement_authority.key() == config.settlement_authority
            @ ArenaError::UnauthorizedSettlement
    )]
    pub settlement_authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Pays the winners and sweeps the rake, atomically.
///
/// `remaining_accounts` holds one `[RoomPlayer, PlayerAccount]` pair per entry
/// in `payouts`, in the same order. Every pair is verified against its expected
/// PDA — passing an arbitrary account here would otherwise be a way to credit a
/// balance that was never wagered.
///
/// The whole payout table must be supplied in one call: `sum(payouts)` has to
/// equal the unlocked prize pool exactly. That is what makes it impossible for
/// the settlement authority to under-pay and pocket the difference, or to
/// over-pay and drain another room's escrow.
pub fn distribute_winnings<'info>(
    // The third lifetime is pinned to 'info so `remaining_accounts` borrows for
    // long enough to build `Account<'info, _>` wrappers from it.
    ctx: Context<'_, '_, 'info, 'info, DistributeWinnings<'info>>,
    payouts: Vec<u64>,
) -> Result<()> {
    let winner_count = payouts.len();
    require!(
        ctx.remaining_accounts.len() == winner_count * 2,
        ArenaError::WinnerAccountMismatch
    );
    require!(
        ctx.accounts.room.status == RoomStatus::Unlocked,
        ArenaError::PrizeNotUnlocked
    );

    // Count, positivity, overflow and the sum-equals-pool check all live in
    // `settlement_math`, which is unit tested without a validator. Keeping the
    // arithmetic there and calling it here is what stops the tests describing a
    // parallel implementation that production never runs.
    let total_payout = validate_payouts(&payouts, ctx.accounts.room.prize_pool)?;

    let room_key = ctx.accounts.room.key();
    let mut seen = [Pubkey::default(); MAX_WINNERS_PER_DISTRIBUTION];

    for (index, amount) in payouts.iter().enumerate() {
        let room_player_info = &ctx.remaining_accounts[index * 2];
        let player_account_info = &ctx.remaining_accounts[index * 2 + 1];

        require!(
            room_player_info.is_writable && player_account_info.is_writable,
            ArenaError::WinnerAccountMismatch
        );

        // `try_from` checks program ownership and the account discriminator.
        let mut room_player: Account<RoomPlayer> = Account::try_from(room_player_info)?;
        require_keys_eq!(room_player.room, room_key, ArenaError::RoomPlayerMismatch);
        require!(
            room_player.state == PlayerRoomState::Locked,
            ArenaError::EntryFeeNotLocked
        );

        let winner = room_player.player;

        // Two winners resolving to the same player would double-credit them
        // while still summing to the prize pool.
        for previous in seen.iter().take(index) {
            require_keys_neq!(*previous, winner, ArenaError::DuplicateWinner);
        }
        seen[index] = winner;

        // Address verification: ownership and discriminator alone do not prove
        // this is *this room's* record for *this* player.
        let expected_room_player = Pubkey::create_program_address(
            &[
                ROOM_PLAYER_SEED,
                room_key.as_ref(),
                winner.as_ref(),
                &[room_player.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(ArenaError::RoomPlayerMismatch))?;
        require_keys_eq!(
            room_player_info.key(),
            expected_room_player,
            ArenaError::RoomPlayerMismatch
        );

        let mut player_account: Account<PlayerAccount> = Account::try_from(player_account_info)?;
        require_keys_eq!(
            player_account.owner,
            winner,
            ArenaError::PlayerOwnerMismatch
        );
        let expected_player_account = Pubkey::create_program_address(
            &[PLAYER_SEED, winner.as_ref(), &[player_account.bump]],
            &crate::ID,
        )
        .map_err(|_| error!(ArenaError::PlayerOwnerMismatch))?;
        require_keys_eq!(
            player_account_info.key(),
            expected_player_account,
            ArenaError::PlayerOwnerMismatch
        );

        player_account.balance = add(player_account.balance, *amount)?;
        player_account.total_winnings = add(player_account.total_winnings, *amount)?;

        room_player.payout = *amount;
        room_player.state = PlayerRoomState::Paid;

        // Written back immediately so a duplicate later in the same call reads
        // the updated state rather than a stale copy.
        room_player.exit(&crate::ID)?;
        player_account.exit(&crate::ID)?;

        emit!(WinnerPaid {
            room: room_key,
            player: winner,
            amount: *amount,
        });
    }

    let room_id = ctx.accounts.room.room_id;
    let vault_bump = ctx.accounts.room.vault_bump;
    let rake_amount = ctx.accounts.room.rake_amount;

    let bump_seed = [vault_bump];
    let seeds: &[&[u8]] = &[ROOM_VAULT_SEED, room_id.as_ref(), &bump_seed];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    // Prize lamports move escrow -> pool; the winners now hold a custody claim
    // against the pool, which they withdraw separately.
    transfer_from_vault(
        &ctx.accounts.room_vault.to_account_info(),
        &ctx.accounts.pool.to_account_info(),
        total_payout,
        &ctx.accounts.system_program,
        signer_seeds,
    )?;

    transfer_from_vault(
        &ctx.accounts.room_vault.to_account_info(),
        &ctx.accounts.fee_destination.to_account_info(),
        rake_amount,
        &ctx.accounts.system_program,
        signer_seeds,
    )?;

    let room = &mut ctx.accounts.room;
    room.distributed = total_payout;
    room.winners_paid = winner_count as u16;
    room.status = RoomStatus::Settled;
    room.settled_at = Clock::get()?.unix_timestamp;

    emit!(WinningsDistributed {
        room: room_key,
        winners_paid: room.winners_paid,
        total_distributed: total_payout,
        rake_amount,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// cancel_room
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct CancelRoom<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [ROOM_SEED, room.room_id.as_ref()], bump = room.bump)]
    pub room: Account<'info, Room>,

    /// Anyone may call. The authority can cancel immediately; everyone else
    /// must wait out the delay.
    pub signer: Signer<'info>,
}

/// Aborts a room and opens refunds.
///
/// The permissionless path after `PERMISSIONLESS_CANCEL_DELAY_SECONDS` is the
/// players' escape hatch. Without it, escrowed funds would be recoverable only
/// if the backend chose to act — which is exactly the dependency an on-chain
/// escrow is supposed to remove.
pub fn cancel_room(ctx: Context<CancelRoom>) -> Result<()> {
    let clock = Clock::get()?;
    let is_authority = ctx.accounts.signer.key() == ctx.accounts.config.settlement_authority;

    let room = &mut ctx.accounts.room;

    require!(
        room.status != RoomStatus::Settled,
        ArenaError::RoomAlreadySettled
    );
    require!(
        room.status != RoomStatus::Cancelled,
        ArenaError::RoomCancelled
    );

    if !is_authority {
        let unlock_at = room
            .created_at
            .checked_add(PERMISSIONLESS_CANCEL_DELAY_SECONDS)
            .ok_or(ArenaError::Overflow)?;
        require!(
            clock.unix_timestamp >= unlock_at,
            ArenaError::CancelDelayNotElapsed
        );
    }

    room.status = RoomStatus::Cancelled;

    emit!(RoomCancelled {
        room: room.key(),
        cancelled_by: ctx.accounts.signer.key(),
        permissionless: !is_authority,
        total_locked: room.total_locked,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// claim_refund
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [ROOM_SEED, room.room_id.as_ref()], bump = room.bump)]
    pub room: Account<'info, Room>,

    #[account(
        mut,
        seeds = [ROOM_PLAYER_SEED, room.key().as_ref(), player.key().as_ref()],
        bump = room_player.bump,
        constraint = room_player.room == room.key() @ ArenaError::RoomPlayerMismatch,
        constraint = room_player.player == player.key() @ ArenaError::RoomPlayerOwnerMismatch
    )]
    pub room_player: Account<'info, RoomPlayer>,

    #[account(
        mut,
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump = player_account.bump,
        constraint = player_account.owner == player.key() @ ArenaError::PlayerOwnerMismatch
    )]
    pub player_account: Account<'info, PlayerAccount>,

    /// CHECK: Seed-validated escrow vault for this room.
    #[account(mut, seeds = [ROOM_VAULT_SEED, room.room_id.as_ref()], bump = room.vault_bump)]
    pub room_vault: UncheckedAccount<'info>,

    /// CHECK: Seed-validated custody vault.
    #[account(mut, seeds = [POOL_SEED], bump = config.pool_bump)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: The refunded player. Not a signer — the refund can only ever
    /// credit this player's own custody account, so letting anyone crank it is
    /// safe and means a stuck player does not need SOL for fees to recover.
    pub player: UncheckedAccount<'info>,

    #[account(mut)]
    pub claimant: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
    require!(
        ctx.accounts.room.status == RoomStatus::Cancelled,
        ArenaError::RoomNotCancelled
    );
    require!(
        ctx.accounts.room_player.state == PlayerRoomState::Locked,
        ArenaError::EntryFeeNotLocked
    );

    let amount = ctx.accounts.room_player.locked_amount;

    let room_player = &mut ctx.accounts.room_player;
    room_player.state = PlayerRoomState::Refunded;

    let player_account = &mut ctx.accounts.player_account;
    player_account.balance = add(player_account.balance, amount)?;
    // The wager never happened, so it should not count toward lifetime volume.
    player_account.total_wagered = player_account.total_wagered.saturating_sub(amount);

    let room = &mut ctx.accounts.room;
    room.total_locked = sub(room.total_locked, amount)?;

    let room_id = room.room_id;
    let vault_bump = room.vault_bump;
    let bump_seed = [vault_bump];
    let seeds: &[&[u8]] = &[ROOM_VAULT_SEED, room_id.as_ref(), &bump_seed];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    transfer_from_vault(
        &ctx.accounts.room_vault.to_account_info(),
        &ctx.accounts.pool.to_account_info(),
        amount,
        &ctx.accounts.system_program,
        signer_seeds,
    )?;

    emit!(RefundClaimed {
        room: ctx.accounts.room.key(),
        player: ctx.accounts.player.key(),
        amount,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// settle_to_winner
// ---------------------------------------------------------------------------

/// Pays the last surviving player directly, and sweeps the rake.
///
/// The direct-entry counterpart to `distribute_winnings`. That one splits a
/// prize across up to eight winners by crediting each a custody balance, which
/// they then withdraw — correct for the custodial model, and wrong here twice
/// over: winner-take-all has exactly one winner, and there is no custody
/// balance to credit. A player who won would be told they had won and still
/// have to make a second transaction to see the money.
///
/// So the prize moves from the room vault to the winner's own wallet in the
/// same instruction that marks the room settled. The rake continues to go
/// straight to the fee destination, which was already direct.
#[derive(Accounts)]
pub struct SettleToWinner<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [ROOM_SEED, room.room_id.as_ref()], bump = room.bump)]
    pub room: Account<'info, Room>,

    /// CHECK: Seed-validated escrow vault for this room.
    #[account(mut, seeds = [ROOM_VAULT_SEED, room.room_id.as_ref()], bump = room.vault_bump)]
    pub room_vault: UncheckedAccount<'info>,

    /// The winner's entry record. Seed-derived from the room and the winner, so
    /// a caller cannot nominate somebody who never entered: the address only
    /// exists because `enter_room` created it, and it only holds a locked
    /// amount because that player paid.
    #[account(
        mut,
        seeds = [ROOM_PLAYER_SEED, room.key().as_ref(), winner.key().as_ref()],
        bump = winner_room_player.bump,
        constraint = winner_room_player.player == winner.key() @ ArenaError::PlayerOwnerMismatch
    )]
    pub winner_room_player: Account<'info, RoomPlayer>,

    /// CHECK: The winner's own wallet, receiving lamports. It is bound to the
    /// entry record above by that account's seeds, so this cannot be an
    /// arbitrary address.
    #[account(mut)]
    pub winner: UncheckedAccount<'info>,

    /// CHECK: The game owner's wallet, constrained against config.
    #[account(mut, constraint = fee_destination.key() == config.fee_destination
        @ ArenaError::TreasuryMismatch)]
    pub fee_destination: UncheckedAccount<'info>,

    #[account(
        constraint = settlement_authority.key() == config.settlement_authority
            @ ArenaError::UnauthorizedSettlement
    )]
    pub settlement_authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn settle_to_winner(ctx: Context<SettleToWinner>) -> Result<()> {
    // `unlock_prize` must have run: it is what fixes the prize/rake split, so
    // the amounts cannot shift between a failed attempt and a retry.
    require!(
        ctx.accounts.room.status == RoomStatus::Unlocked,
        ArenaError::RoomAlreadySettled
    );
    require!(
        ctx.accounts.winner_room_player.state == PlayerRoomState::Locked,
        ArenaError::AlreadyPaid
    );

    let prize = ctx.accounts.room.prize_pool;
    let rake = ctx.accounts.room.rake_amount;
    let room_key = ctx.accounts.room.key();
    let room_id = ctx.accounts.room.room_id;
    let vault_bump = ctx.accounts.room.vault_bump;

    let bump_seed = [vault_bump];
    let seeds: &[&[u8]] = &[ROOM_VAULT_SEED, room_id.as_ref(), &bump_seed];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    // Straight to the winner's wallet. No custody claim, no second transaction.
    transfer_from_vault(
        &ctx.accounts.room_vault.to_account_info(),
        &ctx.accounts.winner.to_account_info(),
        prize,
        &ctx.accounts.system_program,
        signer_seeds,
    )?;

    transfer_from_vault(
        &ctx.accounts.room_vault.to_account_info(),
        &ctx.accounts.fee_destination.to_account_info(),
        rake,
        &ctx.accounts.system_program,
        signer_seeds,
    )?;

    let room_player = &mut ctx.accounts.winner_room_player;
    room_player.payout = prize;
    room_player.state = PlayerRoomState::Paid;

    let room = &mut ctx.accounts.room;
    room.distributed = prize;
    room.winners_paid = 1;
    room.status = RoomStatus::Settled;
    room.settled_at = Clock::get()?.unix_timestamp;

    emit!(WinnerPaid {
        room: room_key,
        player: ctx.accounts.winner.key(),
        amount: prize,
    });

    Ok(())
}
