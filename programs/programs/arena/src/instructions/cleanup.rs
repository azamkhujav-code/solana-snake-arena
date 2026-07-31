use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, ROOM_PLAYER_SEED, ROOM_SEED, ROOM_VAULT_SEED};
use crate::errors::ArenaError;
use crate::state::{Config, PlayerRoomState, Room, RoomPlayer, RoomStatus};

/// Reclaiming rent once a match is over.
///
/// Every room costs somebody a rent-exempt deposit: the settlement authority
/// funds the `Room` account and its vault at `create_room`, and each player
/// funds their own `RoomPlayer` at `enter_room`. Nothing closed those accounts,
/// so the deposits were never coming back — about 0.0027 SOL per match from the
/// authority and 0.0016 from every player, permanently, for accounts that stop
/// meaning anything the moment the pot is paid out.
///
/// That is not a fee anyone agreed to. On the free tier it is invisible; on the
/// cheapest paid room the player's share is a sixth of the entry fee again.
///
/// Rent goes back to whoever put it up, which is also what makes these safe to
/// leave permissionless: there is no version of calling them that pays the
/// caller, so anyone may crank them and nobody gains by racing.

/// Closes a finished room and returns its rent to the settlement authority.
#[derive(Accounts)]
pub struct CloseRoom<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// Rent returns to the authority that paid it at `create_room`.
    #[account(
        mut,
        seeds = [ROOM_SEED, room.room_id.as_ref()],
        bump = room.bump,
        close = settlement_authority,
    )]
    pub room: Account<'info, Room>,

    /// CHECK: Seed-validated escrow vault. Drained to zero, which deallocates
    /// it — it holds no data, so the runtime reaps it rather than leaving a
    /// rent-paying husk behind.
    #[account(mut, seeds = [ROOM_VAULT_SEED, room.room_id.as_ref()], bump = room.vault_bump)]
    pub room_vault: UncheckedAccount<'info>,

    /// CHECK: Receives the reclaimed rent. Constrained to the configured
    /// authority so this cannot be redirected.
    #[account(
        mut,
        constraint = settlement_authority.key() == config.settlement_authority
            @ ArenaError::UnauthorizedSettlement
    )]
    pub settlement_authority: UncheckedAccount<'info>,
}

pub fn close_room(ctx: Context<CloseRoom>) -> Result<()> {
    // Only a room that has finished paying out. `Settled` covers the normal
    // path and `Cancelled` the refunded one; anything else may still owe
    // somebody money.
    require!(
        matches!(
            ctx.accounts.room.status,
            RoomStatus::Settled | RoomStatus::Cancelled
        ),
        ArenaError::RoomNotFinished
    );

    // The vault must hold nothing but its own deposit.
    //
    // This is the real safety check, and it is stronger than reading the room's
    // own bookkeeping: whatever the status says, a vault still holding lamports
    // means a prize or a refund has not been collected, and draining it here
    // would take that money to the authority instead of the player it belongs
    // to.
    let rent_floor = Rent::get()?.minimum_balance(0);
    let vault_balance = ctx.accounts.room_vault.lamports();
    require!(
        vault_balance <= rent_floor,
        ArenaError::InsufficientVaultFunds
    );

    // Moved by direct lamport arithmetic rather than a system transfer: the
    // transfer helper refuses to break rent exemption, which is exactly what
    // reclaiming the deposit means. Taking the balance to zero deallocates the
    // account, so nothing is left underfunded.
    **ctx.accounts.room_vault.try_borrow_mut_lamports()? = 0;
    **ctx
        .accounts
        .settlement_authority
        .try_borrow_mut_lamports()? = ctx
        .accounts
        .settlement_authority
        .lamports()
        .checked_add(vault_balance)
        .ok_or(ArenaError::Overflow)?;

    emit!(RoomClosed {
        room: ctx.accounts.room.key(),
        rent_reclaimed: vault_balance,
    });

    Ok(())
}

/// Closes a settled player's entry record, returning their own rent.
#[derive(Accounts)]
pub struct CloseRoomPlayer<'info> {
    #[account(seeds = [ROOM_SEED, room.room_id.as_ref()], bump = room.bump)]
    pub room: Account<'info, Room>,

    /// Rent returns to the player who paid it at `enter_room`.
    #[account(
        mut,
        seeds = [ROOM_PLAYER_SEED, room.key().as_ref(), player.key().as_ref()],
        bump = room_player.bump,
        constraint = room_player.player == player.key() @ ArenaError::PlayerOwnerMismatch,
        close = player,
    )]
    pub room_player: Account<'info, RoomPlayer>,

    /// CHECK: Receives their own rent back. Bound to the record by its seeds,
    /// so this cannot be an arbitrary address.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
}

pub fn close_room_player(ctx: Context<CloseRoomPlayer>) -> Result<()> {
    // Settled one way or the other. A `Locked` record still has a claim on the
    // vault, and closing it would strand that money with no account left to
    // prove it was owed.
    require!(
        matches!(
            ctx.accounts.room_player.state,
            PlayerRoomState::Paid | PlayerRoomState::Refunded
        ),
        ArenaError::PlayerNotFinished
    );

    require!(
        matches!(
            ctx.accounts.room.status,
            RoomStatus::Settled | RoomStatus::Cancelled
        ),
        ArenaError::RoomNotFinished
    );

    Ok(())
}

#[event]
pub struct RoomClosed {
    pub room: Pubkey,
    pub rent_reclaimed: u64,
}
