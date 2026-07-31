import type { PrismaClient } from '@arena/db';
import { UserStatus } from '@arena/db';
import type { RedisClient } from '@arena/redis';
import { redisKeys } from '@arena/redis';
import { buildAuthMessage, verifySignature } from '@arena/solana';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { AppError, forbidden, unauthorized } from '../lib/errors.js';

/**
 * Wallet sign-in, token issuance and rotation.
 *
 * Three properties this file exists to guarantee:
 *
 *  1. **A signature proves ownership.** The server rebuilds the signed message
 *     from its own stored nonce; it never verifies a client-supplied string.
 *     Otherwise a caller signs "hello" and presents it as proof of anything.
 *
 *  2. **Nothing replays.** The nonce is consumed with `GETDEL`, which is
 *     atomic. Refresh tokens are single-use, and presenting a spent one is
 *     treated as theft rather than as a retry.
 *
 *  3. **Revocation takes effect immediately.** A short access-token TTL alone
 *     leaves a window in which a banned player keeps playing; the jti denylist
 *     closes it.
 */

/** How long a wallet has to sign the message before the nonce expires. */
export const NONCE_TTL_SECONDS = 300;

/** Refresh tokens are long-lived but single-use. */
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface AuthDeps {
  prisma: PrismaClient;
  redis: RedisClient;
  jwtSign: (payload: AccessTokenClaims, options: { expiresIn: string }) => string;
  accessTtlSeconds: number;
  domain: string;
  /** Injectable so tests need no wall clock. */
  now?: () => Date;
}

export interface AccessTokenClaims {
  sub: string;
  wallet: string;
  role: 'PLAYER' | 'MODERATOR' | 'ADMIN';
  jti: string;
  /**
   * The player's chosen name, for display in game.
   *
   * Carried in the token because the matchmaker mints realtime tickets and has
   * no database to look a name up in. Without it the ticket fell back to the
   * player's UUID, so the leaderboard and the label above every snake read as a
   * fragment like `c8ea7d36-ac66-46` — players could not tell each other apart,
   * let alone recognise themselves.
   */
  nickname?: string | undefined;
}

export interface IssuedSession {
  player: {
    id: string;
    wallet: string;
    nickname: string | null;
    role: 'PLAYER' | 'MODERATOR' | 'ADMIN';
    createdAt: string;
  };
  tokens: { accessToken: string; refreshToken: string; expiresIn: number };
}

/* ---- Hashing ----------------------------------------------------------- */

/**
 * Refresh tokens are stored hashed, never in plaintext.
 *
 * A database dump then yields no usable credentials. Plain SHA-256 rather than
 * a password KDF is right here and would be wrong for a password: the token is
 * 256 bits of CSPRNG output, so there is no dictionary to attack and the
 * slowness of bcrypt would buy nothing while costing a hash on every refresh.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Salted so the audit trail cannot be reversed by enumerating the IPv4 space. */
export function hashIp(ip: string | undefined, salt: string): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`ip:${salt}:${ip}`).digest('hex').slice(0, 64);
}

/* ---- Nonce issue and consume ------------------------------------------- */

export interface NonceRecord {
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export interface IssuedNonce extends NonceRecord {
  message: string;
}

/**
 * Issues a nonce and the exact message to sign.
 *
 * Keyed by wallet, so requesting a second nonce invalidates the first. That is
 * deliberate: it bounds an attacker to one outstanding challenge per wallet
 * rather than letting them farm a pile of valid nonces to use later.
 */
export async function issueNonce(deps: AuthDeps, wallet: string): Promise<IssuedNonce> {
  const now = (deps.now ?? (() => new Date()))();

  // 256 bits from the CSPRNG. Predictable nonces would let an attacker
  // pre-compute a signature request for a wallet they are phishing.
  const nonce = randomBytes(32).toString('base64url');
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + NONCE_TTL_SECONDS * 1000).toISOString();

  const record: NonceRecord = { nonce, issuedAt, expiresAt };

  await deps.redis.set(
    redisKeys.authNonce(wallet),
    JSON.stringify(record),
    'EX',
    NONCE_TTL_SECONDS,
  );

  return {
    ...record,
    message: buildAuthMessage({ domain: deps.domain, wallet, nonce, issuedAt, expiresAt }),
  };
}

/**
 * Consumes the nonce for a wallet, atomically.
 *
 * `GETDEL` rather than GET-then-DEL: with two concurrent requests the read and
 * the delete would interleave and both would observe the nonce as unused. That
 * race is the replay this whole mechanism exists to prevent, and it is exactly
 * the kind that only shows up under load.
 */
export async function consumeNonce(deps: AuthDeps, wallet: string): Promise<NonceRecord | null> {
  const raw = await deps.redis.getdel(redisKeys.authNonce(wallet));
  if (raw === null) return null;

  try {
    return JSON.parse(raw) as NonceRecord;
  } catch {
    // A corrupt value is indistinguishable from an attack; treat as absent.
    return null;
  }
}

/* ---- Sign-in ----------------------------------------------------------- */

export interface VerifyParams {
  wallet: string;
  signature: string;
  nonce: string;
  userAgent?: string | undefined;
  ip?: string | undefined;
  ipSalt: string;
}

/**
 * Verifies a signed nonce and issues a session.
 *
 * Order matters. The nonce is consumed *before* the signature is checked, so a
 * failed verification still burns it — otherwise an attacker with a captured
 * message could brute-force signatures against a nonce that stays alive for its
 * full five minutes.
 */
export async function verifyWalletSignature(
  deps: AuthDeps,
  params: VerifyParams,
): Promise<IssuedSession> {
  const now = (deps.now ?? (() => new Date()))();

  const record = await consumeNonce(deps, params.wallet);
  if (!record) {
    throw unauthorized('Nonce is unknown, expired or already used');
  }

  // The client echoes back which nonce it signed. A mismatch means it signed a
  // stale challenge, which is what a replayed capture looks like.
  if (record.nonce !== params.nonce) {
    throw unauthorized('Nonce does not match the outstanding challenge');
  }

  if (new Date(record.expiresAt) < now) {
    throw unauthorized('Nonce has expired');
  }

  // Rebuilt from server state. Never from anything the client sent.
  const message = buildAuthMessage({
    domain: deps.domain,
    wallet: params.wallet,
    nonce: record.nonce,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
  });

  if (!verifySignature({ message, signature: params.signature, wallet: params.wallet })) {
    throw unauthorized('Signature does not match the wallet');
  }

  const user = await upsertWalletOwner(deps, params.wallet, now);

  if (user.status === UserStatus.BANNED || user.status === UserStatus.CLOSED) {
    // Refused at the door rather than by every downstream endpoint. Note this
    // is 403: the signature was valid, so telling them to re-authenticate
    // would send them round a loop that cannot succeed.
    throw forbidden('This account is not permitted to sign in');
  }

  return issueSession(deps, user, {
    userAgent: params.userAgent,
    ipHash: hashIp(params.ip, params.ipSalt),
    now,
  });
}

/**
 * Starts a session from a connected wallet and a nickname, with no signature.
 *
 * The signature flow above proves the caller controls the wallet before issuing
 * anything. This one does not, and that is a deliberate trade the product makes:
 * the game asks for a nickname and a wallet connection, then drops the player
 * straight into the room list. A signature prompt at that point is a modal
 * asking people to approve something they have not been given a reason for yet.
 *
 * What keeps the *money* safe is that a session is not a claim on funds. Every
 * lamport that moves is moved by a transaction the player's wallet signs — the
 * entry fee leaves their wallet under their own signature, and the prize is
 * paid to the winner's wallet address, which is recorded on chain rather than
 * taken from a session.
 *
 * So the exposure is impersonation, not theft: someone could claim another
 * player's address and appear under their name. They would have to fund that
 * player's entries out of their own pocket, and any winnings would go to the
 * real owner's wallet. Worth stating plainly, because it is a real weakening
 * relative to signing in — it is just not one that lets anybody take money.
 */
export async function connectWallet(
  deps: AuthDeps,
  params: {
    wallet: string;
    nickname?: string | undefined;
    userAgent?: string | undefined;
    ip?: string | undefined;
    ipSalt: string;
  },
): Promise<IssuedSession> {
  const now = (deps.now ?? (() => new Date()))();

  const user = await upsertWalletOwner(deps, params.wallet, now);

  if (user.status === UserStatus.BANNED || user.status === UserStatus.CLOSED) {
    throw forbidden('This account is not permitted to play');
  }

  /**
   * The nickname goes in `displayName`, not `username`.
   *
   * `username` is unique. Writing a chosen name there means the first player to
   * type "Snake" owns it forever, and every player after them silently ends up
   * with no name at all — the insert fails the unique constraint and there is
   * nothing sensible to do about it mid-join. That is exactly what happened in
   * testing: the second player through got a null nickname and no explanation.
   *
   * A nickname in this game is a label over a snake, not an identity. Two
   * players called "Snake" is a normal Tuesday, and the wallet address is what
   * actually distinguishes them. `displayName` carries no unique constraint,
   * which is the correct shape for that.
   *
   * The updated row replaces `user` rather than being discarded, because the
   * session response carries the nickname back and issuing from the pre-update
   * object would return the name they had *before* they typed one.
   */
  const owner =
    params.nickname !== undefined && params.nickname !== user.displayName
      ? await deps.prisma.user.update({
          where: { id: user.id },
          data: { displayName: params.nickname },
        })
      : user;

  return issueSession(deps, owner, {
    userAgent: params.userAgent,
    ipHash: hashIp(params.ip, params.ipSalt),
    now,
  });
}

/**
 * Finds or creates the user behind a wallet.
 *
 * The wallet address is globally unique, so the address *is* the identity —
 * there is no separate registration step. `verifiedAt` is stamped here because
 * reaching this point means a signature has just been checked.
 */
async function upsertWalletOwner(deps: AuthDeps, address: string, now: Date) {
  const existing = await deps.prisma.wallet.findUnique({
    where: { address },
    include: { user: true },
  });

  if (existing) {
    await deps.prisma.$transaction([
      deps.prisma.wallet.update({ where: { id: existing.id }, data: { verifiedAt: now } }),
      deps.prisma.user.update({ where: { id: existing.userId }, data: { lastSeenAt: now } }),
    ]);
    return existing.user;
  }

  return deps.prisma.user.create({
    data: {
      lastSeenAt: now,
      wallets: {
        create: { address, isPrimary: true, verifiedAt: now },
      },
    },
  });
}

/* ---- Token issuance and rotation --------------------------------------- */

interface SessionContext {
  userAgent?: string | undefined;
  ipHash: string | null;
  now: Date;
  /** Continues an existing family on rotation; a new one on fresh sign-in. */
  familyId?: string;
}

async function issueSession(
  deps: AuthDeps,
  user: {
    id: string;
    username: string | null;
    displayName: string | null;
    role: string;
    createdAt: Date;
  },
  context: SessionContext,
): Promise<IssuedSession> {
  const wallet = await deps.prisma.wallet.findFirst({
    where: { userId: user.id, verifiedAt: { not: null } },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    select: { address: true },
  });

  const jti = randomUUID();
  const accessToken = deps.jwtSign(
    {
      sub: user.id,
      nickname: user.displayName ?? user.username ?? undefined,
      wallet: wallet?.address ?? '',
      role: user.role as AccessTokenClaims['role'],
      jti,
    },
    { expiresIn: `${deps.accessTtlSeconds}s` },
  );

  const refreshToken = randomBytes(32).toString('base64url');
  const familyId = context.familyId ?? randomUUID();

  await deps.prisma.refreshToken.create({
    data: {
      userId: user.id,
      familyId,
      tokenHash: hashToken(refreshToken),
      userAgent: context.userAgent?.slice(0, 256) ?? null,
      ipHash: context.ipHash,
      expiresAt: new Date(context.now.getTime() + REFRESH_TTL_SECONDS * 1000),
    },
  });

  return {
    player: {
      id: user.id,
      wallet: wallet?.address ?? '',
      // `displayName` is the chosen nickname; `username` is a unique handle
      // that this flow never sets.
      nickname: user.displayName ?? user.username,
      role: user.role as AccessTokenClaims['role'],
      createdAt: user.createdAt.toISOString(),
    },
    tokens: { accessToken, refreshToken, expiresIn: deps.accessTtlSeconds },
  };
}

/**
 * Rotates a refresh token.
 *
 * Single use. Presenting one that has already been rotated is not a retry — it
 * means two parties hold the same token, and only one of them is the legitimate
 * owner. Since there is no way to tell which, the whole family is revoked and
 * both are forced to sign in again. Logging the user out is a far cheaper
 * mistake than leaving a thief with a live session.
 */
export async function rotateRefreshToken(
  deps: AuthDeps,
  params: {
    refreshToken: string;
    userAgent?: string | undefined;
    ip?: string | undefined;
    ipSalt: string;
  },
): Promise<IssuedSession> {
  const now = (deps.now ?? (() => new Date()))();
  const tokenHash = hashToken(params.refreshToken);

  const stored = await deps.prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!stored) throw unauthorized('Refresh token is not recognised');

  if (stored.revokedAt !== null) {
    // Reuse of a spent token. Burn the family, then refuse.
    await deps.prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: now },
    });
    throw new AppError(401, 'TOKEN_REUSE_DETECTED', 'Session revoked: refresh token was reused');
  }

  if (stored.expiresAt < now) {
    throw unauthorized('Refresh token has expired');
  }

  if (stored.user.status === UserStatus.BANNED || stored.user.status === UserStatus.CLOSED) {
    throw forbidden('This account is not permitted to sign in');
  }

  // Revoke first, issue second. If issuing fails the old token is already dead,
  // which fails closed — the alternative leaves two live tokens on a crash.
  await deps.prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: now },
  });

  return issueSession(deps, stored.user, {
    userAgent: params.userAgent,
    ipHash: hashIp(params.ip, params.ipSalt),
    now,
    familyId: stored.familyId,
  });
}

/* ---- Revocation -------------------------------------------------------- */

/**
 * Denylists an access token until its natural expiry.
 *
 * The TTL is the token's own remaining life, so the denylist stays bounded —
 * entries evict themselves exactly when they stop mattering. A denylist that
 * grows forever is a slow memory leak that only bites in production.
 */
export async function revokeAccessToken(
  deps: AuthDeps,
  jti: string,
  expiresAtSeconds: number,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const remaining = Math.ceil(expiresAtSeconds - now.getTime() / 1000);

  // Already expired: the token cannot be used, so an entry would be dead weight.
  if (remaining <= 0) return;

  await deps.redis.set(redisKeys.revokedToken(jti), '1', 'EX', remaining);
}

export async function isAccessTokenRevoked(redis: RedisClient, jti: string): Promise<boolean> {
  return (await redis.exists(redisKeys.revokedToken(jti))) === 1;
}

/** Ends one session: the refresh family dies and the access token is denylisted. */
export async function logout(
  deps: AuthDeps,
  params: { userId: string; jti: string; accessTokenExp: number },
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();

  await Promise.all([
    deps.prisma.refreshToken.updateMany({
      where: { userId: params.userId, revokedAt: null },
      data: { revokedAt: now },
    }),
    revokeAccessToken(deps, params.jti, params.accessTokenExp),
  ]);
}

/**
 * Revokes every session for a user. Called when an admin bans someone.
 *
 * Access tokens already minted cannot be enumerated — the jti is not stored —
 * so a user-level tombstone carries the cut-off instead: any token issued
 * before it is refused. This is what makes a ban take effect within the second
 * rather than within the access-token TTL.
 */
export async function revokeAllSessions(deps: AuthDeps, userId: string): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();

  await deps.prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  });

  await deps.redis.set(
    redisKeys.sessionCutoff(userId),
    Math.floor(now.getTime() / 1000).toString(),
    'EX',
    // Outlives any access token that could still be in flight.
    deps.accessTtlSeconds * 2,
  );
}

/**
 * Whether a token minted at `issuedAtSeconds` predates a revocation cut-off.
 *
 * Pure, so the comparison can be tested without Redis. The `<` is deliberate:
 * a token issued in the same second as the cut-off is kept, because JWT `iat`
 * has one-second resolution and rejecting on equality would log out the session
 * that the sign-in itself just created.
 */
export function isBeforeCutoff(
  issuedAtSeconds: number | undefined,
  cutoff: string | null,
): boolean {
  if (cutoff === null || issuedAtSeconds === undefined) return false;

  const cutoffSeconds = Number.parseInt(cutoff, 10);
  if (!Number.isFinite(cutoffSeconds)) return false;

  return issuedAtSeconds < cutoffSeconds;
}
