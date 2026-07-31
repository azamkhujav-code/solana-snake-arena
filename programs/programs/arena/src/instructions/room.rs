//! Room lifecycle: creation, joining, and escrowing entry fees.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::ArenaError;
use crate::events::*;
use crate::state::*;
use crate::utils::*;

// ---------------------------------------------------------------------------
// create_room
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(room_id: [u8; ROOM_ID_LEN])]
pub struct CreateRoom<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ ArenaError::ProgramPaused
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = settlement_authority,
        space = 8 + Room::INIT_SPACE,
        seeds = [ROOM_SEED, room_id.as_ref()],
        bump
    )]
    pub room: Account<'info, Room>,

    /// CHECK: Seed-validated escrow vault for this room.
    #[account(mut, seeds = [ROOM_VAULT_SEED, room_id.as_ref()], bump)]
    pub room_vault: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = settlement_authority.key() == config.settlement_authority
            @ ArenaError::UnauthorizedSettlement
    )]
    pub settlement_authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn create_room(
    ctx: Context<CreateRoom>,
    room_id: [u8; ROOM_ID_LEN],
    entry_fee: u64,
    max_players: u16,
) -> Result<()> {
    require!(
        entry_fee >= MIN_ENTRY_FEE_LAMPORTS,
        ArenaError::EntryFeeTooSmall
    );
    require!(
        (MIN_PLAYERS_PER_ROOM..=MAX_PLAYERS_PER_ROOM).contains(&max_players),
        ArenaError::InvalidRoomCapacity
    );

    fund_rent_exemption(
        &ctx.accounts.settlement_authority,
        &ctx.accounts.room_vault.to_account_info(),
        &ctx.accounts.system_program,
    )?;

    let clock = Clock::get()?;
    let room = &mut ctx.accounts.room;

    room.room_id = room_id;
    room.creator = ctx.accounts.settlement_authority.key();
    room.status = RoomStatus::Open;
    room.entry_fee = entry_fee;
    room.max_players = max_players;
    room.player_count = 0;
    room.locked_count = 0;
    room.total_locked = 0;
    room.prize_pool = 0;
    room.rake_amount = 0;
    room.distributed = 0;
    room.winners_paid = 0;
    // Snapshot the fee. A later config change must not alter the economics of
    // a room players have already paid into.
    room.fee_bps = ctx.accounts.config.fee_bps;
    room.created_at = clock.unix_timestamp;
    room.unlocked_at = 0;
    room.settled_at = 0;
    room.bump = ctx.bumps.room;
    room.vault_bump = ctx.bumps.room_vault;

    let config = &mut ctx.accounts.config;
    config.total_rooms = add(config.total_rooms, 1)?;

    emit!(RoomCreated {
        room: ctx.accounts.room.key(),
        room_id,
        creator: ctx.accounts.settlement_authority.key(),
        entry_fee,
        max_players,
        fee_bps: ctx.accounts.room.fee_bps,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// join_room
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct JoinRoom<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ ArenaError::ProgramPaused
    )]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [ROOM_SEED, room.room_id.as_ref()], bump = room.bump)]
    pub room: Account<'info, Room>,

    /// Creating this account IS the idempotency guard: a second join for the
    /// same (room, player) fails because the address is already initialised.
    #[account(
        init,
        payer = player,
        space = 8 + RoomPlayer::INIT_SPACE,
        seeds = [ROOM_PLAYER_SEED, room.key().as_ref(), player.key().as_ref()],
        bump
    )]
    pub room_player: Account<'info, RoomPlayer>,

    #[account(
        mut,
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump = player_account.bump,
        constraint = player_account.owner == player.key() @ ArenaError::PlayerOwnerMismatch
    )]
    pub player_account: Account<'info, PlayerAccount>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn join_room(ctx: Context<JoinRoom>) -> Result<()> {
    let room = &mut ctx.accounts.room;

    require!(room.status == RoomStatus::Open, ArenaError::RoomNotOpen);
    require!(room.player_count < room.max_players, ArenaError::RoomFull);

    // Checked up front so a player cannot take a seat they can never pay for,
    // blocking it from someone who can.
    require!(
        ctx.accounts.player_account.balance >= room.entry_fee,
        ArenaError::InsufficientBalance
    );

    let clock = Clock::get()?;
    let room_player = &mut ctx.accounts.room_player;
    room_player.room = room.key();
    room_player.player = ctx.accounts.player.key();
    room_player.locked_amount = 0;
    room_player.payout = 0;
    room_player.joined_at = clock.unix_timestamp;
    room_player.state = PlayerRoomState::Joined;
    room_player.bump = ctx.bumps.room_player;

    room.player_count = room
        .player_count
        .checked_add(1)
        .ok_or(ArenaError::Overflow)?;

    let player_account = &mut ctx.accounts.player_account;
    player_account.rooms_joined = player_account
        .rooms_joined
        .checked_add(1)
        .ok_or(ArenaError::Overflow)?;

    emit!(PlayerJoined {
        room: room.key(),
        player: ctx.accounts.player.key(),
        player_count: room.player_count,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// lock_entry_fee
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct LockEntryFee<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ ArenaError::ProgramPaused
    )]
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

    /// CHECK: Seed-validated custody vault.
    #[account(mut, seeds = [POOL_SEED], bump = config.pool_bump)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: Seed-validated escrow vault for this room.
    #[account(mut, seeds = [ROOM_VAULT_SEED, room.room_id.as_ref()], bump = room.vault_bump)]
    pub room_vault: UncheckedAccount<'info>,

    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Moves the entry fee out of the player's spendable balance and into the
/// room's escrow vault, so the same lamports cannot be wagered in two rooms.
pub fn lock_entry_fee(ctx: Context<LockEntryFee>) -> Result<()> {
    let entry_fee = ctx.accounts.room.entry_fee;

    require!(
        ctx.accounts.room.status == RoomStatus::Open,
        ArenaError::RoomNotOpen
    );
    require!(
        ctx.accounts.room_player.state == PlayerRoomState::Joined,
        ArenaError::EntryFeeAlreadyLocked
    );
    require!(
        ctx.accounts.player_account.balance >= entry_fee,
        ArenaError::InsufficientBalance
    );

    // Bookkeeping first, then the vault-to-vault move.
    let player_account = &mut ctx.accounts.player_account;
    player_account.balance = sub(player_account.balance, entry_fee)?;
    player_account.total_wagered = add(player_account.total_wagered, entry_fee)?;

    let room_player = &mut ctx.accounts.room_player;
    room_player.locked_amount = entry_fee;
    room_player.state = PlayerRoomState::Locked;

    let room = &mut ctx.accounts.room;
    room.total_locked = add(room.total_locked, entry_fee)?;
    room.locked_count = room
        .locked_count
        .checked_add(1)
        .ok_or(ArenaError::Overflow)?;

    let pool_bump = ctx.accounts.config.pool_bump;
    let bump_seed = [pool_bump];
    let seeds: &[&[u8]] = &[POOL_SEED, &bump_seed];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    transfer_from_vault(
        &ctx.accounts.pool.to_account_info(),
        &ctx.accounts.room_vault.to_account_info(),
        entry_fee,
        &ctx.accounts.system_program,
        signer_seeds,
    )?;

    emit!(EntryFeeLocked {
        room: room.key(),
        player: ctx.accounts.player.key(),
        amount: entry_fee,
        total_locked: room.total_locked,
        locked_count: room.locked_count,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// start_room
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct StartRoom<'info> {
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

/// Closes joining. Without this step a player could join after results were
/// computed off-chain and dilute a prize pool that was already decided.
pub fn start_room(ctx: Context<StartRoom>) -> Result<()> {
    let room = &mut ctx.accounts.room;

    require!(room.status == RoomStatus::Open, ArenaError::RoomNotOpen);
    // Every seated player must have escrowed, or the pot would not match the
    // participant list the settlement authority is about to score.
    require!(
        room.locked_count == room.player_count,
        ArenaError::EntryFeesNotLocked
    );
    require!(
        room.locked_count >= MIN_PLAYERS_PER_ROOM,
        ArenaError::InvalidRoomCapacity
    );

    room.status = RoomStatus::InProgress;

    emit!(RoomStarted {
        room: room.key(),
        player_count: room.player_count,
        total_locked: room.total_locked,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// enter_room
// ---------------------------------------------------------------------------

/// Takes a seat and escrows the entry fee in one player-signed transaction.
///
/// Replaces `join_room` + `lock_entry_fee` for the direct-entry model, where
/// there is no custody balance to draw on. Those two exist because entry used
/// to be funded from a shared pool the player had deposited into beforehand:
/// join reserved the seat, lock moved lamports pool -> room vault. With no
/// pool, both steps collapse into a single transfer from the player's own
/// wallet into this match's vault.
///
/// One transaction matters beyond convenience. Split across two, a player can
/// hold a seat they never pay for — and every other player waits on a lobby
/// that will not reach its minimum because one of its entrants is a placeholder.
/// Here the seat and the money are the same operation, so a seat always has a
/// funded player behind it.
#[derive(Accounts)]
pub struct EnterRoom<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ ArenaError::ProgramPaused
    )]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [ROOM_SEED, room.room_id.as_ref()], bump = room.bump)]
    pub room: Account<'info, Room>,

    /// Creating this account IS the idempotency guard: a second entry for the
    /// same (room, player) fails because the address is already initialised, so
    /// a double-clicked join cannot pay twice.
    #[account(
        init,
        payer = player,
        space = 8 + RoomPlayer::INIT_SPACE,
        seeds = [ROOM_PLAYER_SEED, room.key().as_ref(), player.key().as_ref()],
        bump
    )]
    pub room_player: Account<'info, RoomPlayer>,

    /// CHECK: System-owned lamport vault for this room. Validated by seeds and
    /// never deserialised, which is what keeps it System-owned so the transfer
    /// below is an ordinary CPI.
    #[account(mut, seeds = [ROOM_VAULT_SEED, room.room_id.as_ref()], bump = room.vault_bump)]
    pub room_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn enter_room(ctx: Context<EnterRoom>) -> Result<()> {
    let entry_fee = ctx.accounts.room.entry_fee;

    require!(
        ctx.accounts.room.status == RoomStatus::Open,
        ArenaError::RoomNotOpen
    );
    require!(
        ctx.accounts.room.player_count < ctx.accounts.room.max_players,
        ArenaError::RoomFull
    );

    // The fee is read from the room rather than taken as an argument. A client
    // cannot enter a five-SOL room for one lamport by asking nicely.
    transfer_to_vault(
        &ctx.accounts.player,
        &ctx.accounts.room_vault.to_account_info(),
        entry_fee,
        &ctx.accounts.system_program,
    )?;

    let clock = Clock::get()?;
    let room_player = &mut ctx.accounts.room_player;
    room_player.room = ctx.accounts.room.key();
    room_player.player = ctx.accounts.player.key();
    room_player.locked_amount = entry_fee;
    room_player.payout = 0;
    room_player.joined_at = clock.unix_timestamp;
    // Straight to Locked: the money is already in the vault, so there is no
    // intermediate state in which a seat is held but unfunded.
    room_player.state = PlayerRoomState::Locked;
    room_player.bump = ctx.bumps.room_player;

    let room = &mut ctx.accounts.room;
    room.player_count = room
        .player_count
        .checked_add(1)
        .ok_or(ArenaError::Overflow)?;
    room.locked_count = room
        .locked_count
        .checked_add(1)
        .ok_or(ArenaError::Overflow)?;
    room.total_locked = add(room.total_locked, entry_fee)?;

    emit!(PlayerJoined {
        room: room.key(),
        player: ctx.accounts.player.key(),
        player_count: room.player_count,
    });
    emit!(EntryFeeLocked {
        room: room.key(),
        player: ctx.accounts.player.key(),
        amount: entry_fee,
        total_locked: room.total_locked,
        locked_count: room.locked_count,
    });

    Ok(())
}
