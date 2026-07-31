/**
 * Anchor integration tests.
 *
 * Run against a local validator before every devnet deploy:
 *   pnpm anchor:test
 *
 * The cases that matter most are the adversarial ones. A happy-path test only
 * proves the program works when nobody is attacking it; the value is in
 * asserting that under-paying, double-settling, impersonating the settlement
 * authority and crediting an unrelated account all fail with the *specific*
 * error they are supposed to.
 */
import * as anchor from '@coral-xyz/anchor';
import { BN } from '@coral-xyz/anchor';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  type ArenaProgram,
  configPda,
  expectAnchorError,
  fundedKeypair,
  MIN_DEPOSIT,
  playerPda,
  poolPda,
  roomId,
  roomPda,
  roomPlayerPda,
  roomVaultPda,
  treasuryPda,
} from './helpers.js';

const ENTRY_FEE = new BN(0.1 * LAMPORTS_PER_SOL);
const FEE_BPS = 500; // 5%

describe('arena program', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Arena as unknown as ArenaProgram;
  const connection = provider.connection;
  const programId = program.programId;

  let admin: Keypair;
  let settlement: Keypair;
  let alice: Keypair;
  let bob: Keypair;
  let mallory: Keypair;

  const config = configPda(programId);
  const pool = poolPda(programId);
  const treasury = treasuryPda(programId);

  before(async () => {
    admin = await fundedKeypair(connection, 50);
    settlement = await fundedKeypair(connection, 50);
    alice = await fundedKeypair(connection, 20);
    bob = await fundedKeypair(connection, 20);
    mallory = await fundedKeypair(connection, 20);
  });

  // -------------------------------------------------------------------------
  describe('initialize', () => {
    it('rejects a fee above the hard cap', async () => {
      await expectAnchorError(
        program.methods
          .initialize(settlement.publicKey, 1_001)
          .accounts({
            config,
            pool,
            treasury,
            admin: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc(),
        'FeeTooHigh',
      );
    });

    it('initializes config and funds both vaults to rent exemption', async () => {
      await program.methods
        .initialize(settlement.publicKey, FEE_BPS)
        .accounts({
          config,
          pool,
          treasury,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const state = await program.account.config.fetch(config);
      assert.equal(state.admin.toBase58(), admin.publicKey.toBase58());
      assert.equal(state.settlementAuthority.toBase58(), settlement.publicKey.toBase58());
      assert.equal(state.feeBps, FEE_BPS);
      assert.equal(state.paused, false);
      assert.equal(state.pendingAdmin, null);

      const rentExempt = await connection.getMinimumBalanceForRentExemption(0);
      assert.ok((await connection.getBalance(pool)) >= rentExempt);
      assert.ok((await connection.getBalance(treasury)) >= rentExempt);
    });

    it('cannot be initialized twice', async () => {
      await assert.rejects(
        program.methods
          .initialize(settlement.publicKey, FEE_BPS)
          .accounts({
            config,
            pool,
            treasury,
            admin: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc(),
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('admin authority', () => {
    it('rejects config updates from a non-admin', async () => {
      await expectAnchorError(
        program.methods
          .updateConfig(600, null, null)
          .accounts({ config, admin: mallory.publicKey })
          .signers([mallory])
          .rpc(),
        'UnauthorizedAdmin',
      );
    });

    it('rejects raising the fee above the cap', async () => {
      await expectAnchorError(
        program.methods
          .updateConfig(2_000, null, null)
          .accounts({ config, admin: admin.publicKey })
          .signers([admin])
          .rpc(),
        'FeeTooHigh',
      );
    });

    it('applies a partial update without disturbing other fields', async () => {
      await program.methods
        .updateConfig(null, null, true)
        .accounts({ config, admin: admin.publicKey })
        .signers([admin])
        .rpc();

      let state = await program.account.config.fetch(config);
      assert.equal(state.paused, true);
      assert.equal(state.feeBps, FEE_BPS, 'fee must be untouched by a paused-only update');

      await program.methods
        .updateConfig(null, null, false)
        .accounts({ config, admin: admin.publicKey })
        .signers([admin])
        .rpc();

      state = await program.account.config.fetch(config);
      assert.equal(state.paused, false);
    });

    it('requires the nominee to accept an admin transfer', async () => {
      const newAdmin = await fundedKeypair(connection, 5);

      await program.methods
        .transferAdmin(newAdmin.publicKey)
        .accounts({ config, admin: admin.publicKey })
        .signers([admin])
        .rpc();

      // Still the old admin until accepted.
      let state = await program.account.config.fetch(config);
      assert.equal(state.admin.toBase58(), admin.publicKey.toBase58());

      await expectAnchorError(
        program.methods
          .acceptAdmin()
          .accounts({ config, newAdmin: mallory.publicKey })
          .signers([mallory])
          .rpc(),
        'NotPendingAdmin',
      );

      await program.methods
        .acceptAdmin()
        .accounts({ config, newAdmin: newAdmin.publicKey })
        .signers([newAdmin])
        .rpc();

      state = await program.account.config.fetch(config);
      assert.equal(state.admin.toBase58(), newAdmin.publicKey.toBase58());
      assert.equal(state.pendingAdmin, null);

      // Hand it back so later tests keep using `admin`.
      await program.methods
        .transferAdmin(admin.publicKey)
        .accounts({ config, admin: newAdmin.publicKey })
        .signers([newAdmin])
        .rpc();
      await program.methods
        .acceptAdmin()
        .accounts({ config, newAdmin: admin.publicKey })
        .signers([admin])
        .rpc();
    });
  });

  // -------------------------------------------------------------------------
  describe('custody', () => {
    it('rejects a dust deposit', async () => {
      await expectAnchorError(
        program.methods
          .deposit(new BN(MIN_DEPOSIT - 1))
          .accounts({
            config,
            playerAccount: playerPda(programId, alice.publicKey),
            pool,
            player: alice.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([alice])
          .rpc(),
        'DepositTooSmall',
      );
    });

    it('creates the custody account on first deposit and credits it', async () => {
      const amount = new BN(2 * LAMPORTS_PER_SOL);
      const poolBefore = await connection.getBalance(pool);

      await program.methods
        .deposit(amount)
        .accounts({
          config,
          playerAccount: playerPda(programId, alice.publicKey),
          pool,
          player: alice.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();

      const account = await program.account.playerAccount.fetch(
        playerPda(programId, alice.publicKey),
      );
      assert.equal(account.owner.toBase58(), alice.publicKey.toBase58());
      assert.equal(account.balance.toString(), amount.toString());
      assert.equal(account.totalDeposited.toString(), amount.toString());

      const poolAfter = await connection.getBalance(pool);
      assert.equal(poolAfter - poolBefore, amount.toNumber(), 'lamports must land in the vault');
    });

    it('rejects withdrawing more than the balance', async () => {
      await expectAnchorError(
        program.methods
          .withdraw(new BN(100 * LAMPORTS_PER_SOL))
          .accounts({
            config,
            playerAccount: playerPda(programId, alice.publicKey),
            pool,
            player: alice.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([alice])
          .rpc(),
        'InsufficientBalance',
      );
    });

    it('rejects withdrawing against someone else custody account', async () => {
      await expectAnchorError(
        program.methods
          .withdraw(new BN(LAMPORTS_PER_SOL))
          .accounts({
            config,
            playerAccount: playerPda(programId, alice.publicKey),
            pool,
            player: mallory.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([mallory])
          .rpc(),
        'ConstraintSeeds',
      );
    });

    it('withdraws and debits the balance', async () => {
      const amount = new BN(0.5 * LAMPORTS_PER_SOL);
      const before = await program.account.playerAccount.fetch(
        playerPda(programId, alice.publicKey),
      );

      await program.methods
        .withdraw(amount)
        .accounts({
          config,
          playerAccount: playerPda(programId, alice.publicKey),
          pool,
          player: alice.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();

      const after = await program.account.playerAccount.fetch(
        playerPda(programId, alice.publicKey),
      );
      assert.equal(after.balance.toString(), before.balance.sub(amount).toString());
    });

    it('still allows withdrawals while the program is paused', async () => {
      await program.methods
        .updateConfig(null, null, true)
        .accounts({ config, admin: admin.publicKey })
        .signers([admin])
        .rpc();

      // A pause stops new risk; it must never trap funds players already own.
      await program.methods
        .withdraw(new BN(MIN_DEPOSIT))
        .accounts({
          config,
          playerAccount: playerPda(programId, alice.publicKey),
          pool,
          player: alice.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();

      await expectAnchorError(
        program.methods
          .deposit(new BN(LAMPORTS_PER_SOL))
          .accounts({
            config,
            playerAccount: playerPda(programId, alice.publicKey),
            pool,
            player: alice.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([alice])
          .rpc(),
        'ProgramPaused',
      );

      await program.methods
        .updateConfig(null, null, false)
        .accounts({ config, admin: admin.publicKey })
        .signers([admin])
        .rpc();
    });
  });

  // -------------------------------------------------------------------------
  describe('room lifecycle and settlement', () => {
    const id = roomId('room-happy');
    let room: PublicKey;
    let vault: PublicKey;

    before(async () => {
      room = roomPda(programId, id);
      vault = roomVaultPda(programId, id);

      for (const player of [bob, mallory]) {
        await program.methods
          .deposit(new BN(3 * LAMPORTS_PER_SOL))
          .accounts({
            config,
            playerAccount: playerPda(programId, player.publicKey),
            pool,
            player: player.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([player])
          .rpc();
      }
    });

    it('rejects room creation by a non-settlement authority', async () => {
      await expectAnchorError(
        program.methods
          .createRoom([...id], ENTRY_FEE, 8)
          .accounts({
            config,
            room,
            roomVault: vault,
            settlementAuthority: mallory.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([mallory])
          .rpc(),
        'UnauthorizedSettlement',
      );
    });

    it('rejects an out-of-range capacity', async () => {
      const badId = roomId('room-bad-cap');
      await expectAnchorError(
        program.methods
          .createRoom([...badId], ENTRY_FEE, 1)
          .accounts({
            config,
            room: roomPda(programId, badId),
            roomVault: roomVaultPda(programId, badId),
            settlementAuthority: settlement.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([settlement])
          .rpc(),
        'InvalidRoomCapacity',
      );
    });

    it('creates a room and snapshots the fee', async () => {
      await program.methods
        .createRoom([...id], ENTRY_FEE, 8)
        .accounts({
          config,
          room,
          roomVault: vault,
          settlementAuthority: settlement.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([settlement])
        .rpc();

      const state = await program.account.room.fetch(room);
      assert.equal(state.entryFee.toString(), ENTRY_FEE.toString());
      assert.equal(state.maxPlayers, 8);
      assert.equal(state.feeBps, FEE_BPS);
      assert.deepEqual(state.status, { open: {} });
    });

    it('lets players join and rejects a duplicate join', async () => {
      for (const player of [alice, bob]) {
        await program.methods
          .joinRoom()
          .accounts({
            config,
            room,
            roomPlayer: roomPlayerPda(programId, room, player.publicKey),
            playerAccount: playerPda(programId, player.publicKey),
            player: player.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([player])
          .rpc();
      }

      const state = await program.account.room.fetch(room);
      assert.equal(state.playerCount, 2);

      // The RoomPlayer PDA already exists, so the second join cannot succeed.
      await assert.rejects(
        program.methods
          .joinRoom()
          .accounts({
            config,
            room,
            roomPlayer: roomPlayerPda(programId, room, alice.publicKey),
            playerAccount: playerPda(programId, alice.publicKey),
            player: alice.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([alice])
          .rpc(),
      );
    });

    it('locks entry fees into the room vault and rejects a double lock', async () => {
      const vaultBefore = await connection.getBalance(vault);

      for (const player of [alice, bob]) {
        await program.methods
          .lockEntryFee()
          .accounts({
            config,
            room,
            roomPlayer: roomPlayerPda(programId, room, player.publicKey),
            playerAccount: playerPda(programId, player.publicKey),
            pool,
            roomVault: vault,
            player: player.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([player])
          .rpc();
      }

      const vaultAfter = await connection.getBalance(vault);
      assert.equal(vaultAfter - vaultBefore, ENTRY_FEE.toNumber() * 2);

      const state = await program.account.room.fetch(room);
      assert.equal(state.lockedCount, 2);
      assert.equal(state.totalLocked.toString(), ENTRY_FEE.muln(2).toString());

      await expectAnchorError(
        program.methods
          .lockEntryFee()
          .accounts({
            config,
            room,
            roomPlayer: roomPlayerPda(programId, room, alice.publicKey),
            playerAccount: playerPda(programId, alice.publicKey),
            pool,
            roomVault: vault,
            player: alice.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([alice])
          .rpc(),
        'EntryFeeAlreadyLocked',
      );
    });

    it('starts the room and closes joining', async () => {
      await program.methods
        .startRoom()
        .accounts({ config, room, settlementAuthority: settlement.publicKey })
        .signers([settlement])
        .rpc();

      const state = await program.account.room.fetch(room);
      assert.deepEqual(state.status, { inProgress: {} });

      await expectAnchorError(
        program.methods
          .joinRoom()
          .accounts({
            config,
            room,
            roomPlayer: roomPlayerPda(programId, room, mallory.publicKey),
            playerAccount: playerPda(programId, mallory.publicKey),
            player: mallory.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([mallory])
          .rpc(),
        'RoomNotOpen',
      );
    });

    it('rejects unlocking by anyone but the settlement authority', async () => {
      await expectAnchorError(
        program.methods
          .unlockPrize()
          .accounts({ config, room, settlementAuthority: mallory.publicKey })
          .signers([mallory])
          .rpc(),
        'UnauthorizedSettlement',
      );
    });

    it('unlocks the prize with the room fee snapshot', async () => {
      await program.methods
        .unlockPrize()
        .accounts({ config, room, settlementAuthority: settlement.publicKey })
        .signers([settlement])
        .rpc();

      const state = await program.account.room.fetch(room);
      const totalLocked = ENTRY_FEE.muln(2);
      const expectedRake = totalLocked.muln(FEE_BPS).divn(10_000);

      assert.deepEqual(state.status, { unlocked: {} });
      assert.equal(state.rakeAmount.toString(), expectedRake.toString());
      assert.equal(state.prizePool.toString(), totalLocked.sub(expectedRake).toString());
    });

    it('rejects payouts that do not sum to the prize pool', async () => {
      const state = await program.account.room.fetch(room);
      const short = state.prizePool.subn(1);

      await expectAnchorError(
        program.methods
          .distributeWinnings([short])
          .accounts({
            config,
            room,
            roomVault: vault,
            pool,
            treasury,
            settlementAuthority: settlement.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            {
              pubkey: roomPlayerPda(programId, room, alice.publicKey),
              isWritable: true,
              isSigner: false,
            },
            { pubkey: playerPda(programId, alice.publicKey), isWritable: true, isSigner: false },
          ])
          .signers([settlement])
          .rpc(),
        'PayoutMismatch',
      );
    });

    it('rejects a duplicated winner', async () => {
      const state = await program.account.room.fetch(room);
      const half = state.prizePool.divn(2);
      const rest = state.prizePool.sub(half);

      await expectAnchorError(
        program.methods
          .distributeWinnings([half, rest])
          .accounts({
            config,
            room,
            roomVault: vault,
            pool,
            treasury,
            settlementAuthority: settlement.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            {
              pubkey: roomPlayerPda(programId, room, alice.publicKey),
              isWritable: true,
              isSigner: false,
            },
            { pubkey: playerPda(programId, alice.publicKey), isWritable: true, isSigner: false },
            {
              pubkey: roomPlayerPda(programId, room, alice.publicKey),
              isWritable: true,
              isSigner: false,
            },
            { pubkey: playerPda(programId, alice.publicKey), isWritable: true, isSigner: false },
          ])
          .signers([settlement])
          .rpc(),
        'DuplicateWinner',
      );
    });

    it('rejects crediting a custody account that did not wager', async () => {
      const state = await program.account.room.fetch(room);

      // alice's room record paired with mallory's custody account.
      await expectAnchorError(
        program.methods
          .distributeWinnings([state.prizePool])
          .accounts({
            config,
            room,
            roomVault: vault,
            pool,
            treasury,
            settlementAuthority: settlement.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            {
              pubkey: roomPlayerPda(programId, room, alice.publicKey),
              isWritable: true,
              isSigner: false,
            },
            { pubkey: playerPda(programId, mallory.publicKey), isWritable: true, isSigner: false },
          ])
          .signers([settlement])
          .rpc(),
        'PlayerOwnerMismatch',
      );
    });

    it('distributes winnings, sweeps rake, and marks the room settled', async () => {
      const state = await program.account.room.fetch(room);
      const aliceShare = state.prizePool.muln(70).divn(100);
      const bobShare = state.prizePool.sub(aliceShare);

      const aliceBefore = await program.account.playerAccount.fetch(
        playerPda(programId, alice.publicKey),
      );
      const treasuryBefore = await connection.getBalance(treasury);

      await program.methods
        .distributeWinnings([aliceShare, bobShare])
        .accounts({
          config,
          room,
          roomVault: vault,
          pool,
          treasury,
          settlementAuthority: settlement.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          {
            pubkey: roomPlayerPda(programId, room, alice.publicKey),
            isWritable: true,
            isSigner: false,
          },
          { pubkey: playerPda(programId, alice.publicKey), isWritable: true, isSigner: false },
          {
            pubkey: roomPlayerPda(programId, room, bob.publicKey),
            isWritable: true,
            isSigner: false,
          },
          { pubkey: playerPda(programId, bob.publicKey), isWritable: true, isSigner: false },
        ])
        .signers([settlement])
        .rpc();

      const aliceAfter = await program.account.playerAccount.fetch(
        playerPda(programId, alice.publicKey),
      );
      assert.equal(aliceAfter.balance.toString(), aliceBefore.balance.add(aliceShare).toString());
      assert.equal(aliceAfter.totalWinnings.toString(), aliceShare.toString());

      const treasuryAfter = await connection.getBalance(treasury);
      assert.equal(treasuryAfter - treasuryBefore, state.rakeAmount.toNumber());

      const settled = await program.account.room.fetch(room);
      assert.deepEqual(settled.status, { settled: {} });
      assert.equal(settled.winnersPaid, 2);
      assert.equal(settled.distributed.toString(), state.prizePool.toString());

      // The escrow vault keeps only its rent.
      const rentExempt = await connection.getMinimumBalanceForRentExemption(0);
      assert.equal(await connection.getBalance(vault), rentExempt);
    });

    it('cannot settle the same room twice', async () => {
      const state = await program.account.room.fetch(room);
      await expectAnchorError(
        program.methods
          .distributeWinnings([state.prizePool])
          .accounts({
            config,
            room,
            roomVault: vault,
            pool,
            treasury,
            settlementAuthority: settlement.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            {
              pubkey: roomPlayerPda(programId, room, alice.publicKey),
              isWritable: true,
              isSigner: false,
            },
            { pubkey: playerPda(programId, alice.publicKey), isWritable: true, isSigner: false },
          ])
          .signers([settlement])
          .rpc(),
        'PrizeNotUnlocked',
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('cancellation and refunds', () => {
    const id = roomId('room-cancel');
    let room: PublicKey;
    let vault: PublicKey;

    before(async () => {
      room = roomPda(programId, id);
      vault = roomVaultPda(programId, id);

      await program.methods
        .createRoom([...id], ENTRY_FEE, 4)
        .accounts({
          config,
          room,
          roomVault: vault,
          settlementAuthority: settlement.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([settlement])
        .rpc();

      await program.methods
        .joinRoom()
        .accounts({
          config,
          room,
          roomPlayer: roomPlayerPda(programId, room, bob.publicKey),
          playerAccount: playerPda(programId, bob.publicKey),
          player: bob.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([bob])
        .rpc();

      await program.methods
        .lockEntryFee()
        .accounts({
          config,
          room,
          roomPlayer: roomPlayerPda(programId, room, bob.publicKey),
          playerAccount: playerPda(programId, bob.publicKey),
          pool,
          roomVault: vault,
          player: bob.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([bob])
        .rpc();
    });

    it('rejects a permissionless cancel before the delay elapses', async () => {
      await expectAnchorError(
        program.methods
          .cancelRoom()
          .accounts({ config, room, signer: mallory.publicKey })
          .signers([mallory])
          .rpc(),
        'CancelDelayNotElapsed',
      );
    });

    it('lets the settlement authority cancel immediately', async () => {
      await program.methods
        .cancelRoom()
        .accounts({ config, room, signer: settlement.publicKey })
        .signers([settlement])
        .rpc();

      const state = await program.account.room.fetch(room);
      assert.deepEqual(state.status, { cancelled: {} });
    });

    it('refunds the locked entry fee back to custody', async () => {
      const before = await program.account.playerAccount.fetch(playerPda(programId, bob.publicKey));

      // Crankable by anyone — the funds can only reach bob's own account.
      await program.methods
        .claimRefund()
        .accounts({
          config,
          room,
          roomPlayer: roomPlayerPda(programId, room, bob.publicKey),
          playerAccount: playerPda(programId, bob.publicKey),
          roomVault: vault,
          pool,
          player: bob.publicKey,
          claimant: mallory.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([mallory])
        .rpc();

      const after = await program.account.playerAccount.fetch(playerPda(programId, bob.publicKey));
      assert.equal(after.balance.toString(), before.balance.add(ENTRY_FEE).toString());

      const roomPlayer = await program.account.roomPlayer.fetch(
        roomPlayerPda(programId, room, bob.publicKey),
      );
      assert.deepEqual(roomPlayer.state, { refunded: {} });
    });

    it('rejects a second refund claim', async () => {
      await expectAnchorError(
        program.methods
          .claimRefund()
          .accounts({
            config,
            room,
            roomPlayer: roomPlayerPda(programId, room, bob.publicKey),
            playerAccount: playerPda(programId, bob.publicKey),
            roomVault: vault,
            pool,
            player: bob.publicKey,
            claimant: mallory.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([mallory])
          .rpc(),
        'EntryFeeNotLocked',
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('treasury', () => {
    it('rejects a treasury withdrawal by a non-admin', async () => {
      await expectAnchorError(
        program.methods
          .withdrawTreasury(new BN(1_000))
          .accounts({
            config,
            treasury,
            destination: mallory.publicKey,
            admin: mallory.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([mallory])
          .rpc(),
        'UnauthorizedAdmin',
      );
    });

    it('refuses to drain the vault below rent exemption', async () => {
      const balance = await connection.getBalance(treasury);
      await expectAnchorError(
        program.methods
          .withdrawTreasury(new BN(balance))
          .accounts({
            config,
            treasury,
            destination: admin.publicKey,
            admin: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc(),
        'WouldBreakRentExemption',
      );
    });

    it('withdraws accumulated rake to the admin', async () => {
      const rentExempt = await connection.getMinimumBalanceForRentExemption(0);
      const balance = await connection.getBalance(treasury);
      const amount = balance - rentExempt;
      assert.ok(amount > 0, 'rake should have accumulated from the settled room');

      const destination = Keypair.generate().publicKey;
      await program.methods
        .withdrawTreasury(new BN(amount))
        .accounts({
          config,
          treasury,
          destination,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      assert.equal(await connection.getBalance(destination), amount);
      assert.equal(await connection.getBalance(treasury), rentExempt);
    });
  });

  after(() => {
    // Nothing to tear down: the local validator is discarded by `anchor test`.
  });
});
