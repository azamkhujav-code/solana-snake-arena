/**
 * Lamport formatting.
 *
 * Every one of these takes a decimal **string** and does its arithmetic in
 * bigint. The obvious implementation — `Number(lamports) / 1e9` — is wrong
 * above about 9M SOL, where a lamport count exceeds `Number.MAX_SAFE_INTEGER`
 * and the division silently rounds. On a treasury page that shows a balance and
 * a drift figure side by side, a rounding error of a few lamports is
 * indistinguishable from the ledger bug the page exists to detect.
 *
 * Nothing here throws on malformed input: a dashboard cell that renders an
 * em-dash is a far better outcome than a component tree that unmounts because
 * one row had a null.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;
const DECIMALS = 9;

/** Parses a lamport string, tolerating null and junk. */
export function parseLamports(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  if (!/^-?\d+$/.test(value)) return null;

  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Renders lamports as SOL with exact decimal arithmetic.
 *
 * @param maxDecimals trailing zeros are trimmed, so 1 SOL reads "1" not
 * "1.000000000" — a column of nine-decimal figures is unreadable, and the
 * decimals that matter are the ones that are non-zero.
 */
export function formatSol(
  value: string | bigint | null | undefined,
  options: { maxDecimals?: number; sign?: boolean } = {},
): string {
  const { maxDecimals = 4, sign = false } = options;
  const lamports = typeof value === 'bigint' ? value : parseLamports(value);
  if (lamports === null) return '—';

  const negative = lamports < 0n;
  const absolute = negative ? -lamports : lamports;

  const whole = absolute / LAMPORTS_PER_SOL;
  const remainder = absolute % LAMPORTS_PER_SOL;

  // Pad to nine places first, then truncate. Truncating rather than rounding is
  // deliberate: an operator comparing a displayed figure against the chain
  // should never see a number larger than what is actually there.
  const fractionalDigits = remainder.toString().padStart(DECIMALS, '0').slice(0, maxDecimals);
  const trimmed = fractionalDigits.replace(/0+$/, '');

  const magnitude = `${formatThousands(whole)}${trimmed ? `.${trimmed}` : ''}`;
  const prefix = negative ? '-' : sign && lamports > 0n ? '+' : '';

  return `${prefix}${magnitude}`;
}

/** Groups digits for readability. `Intl` would need a Number, so it is out. */
function formatThousands(value: bigint): string {
  const digits = value.toString();
  let out = '';

  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }

  return out;
}

/** Exact lamport count with separators, for when the precise figure matters. */
export function formatLamports(value: string | bigint | null | undefined): string {
  const lamports = typeof value === 'bigint' ? value : parseLamports(value);
  if (lamports === null) return '—';

  const negative = lamports < 0n;
  return `${negative ? '-' : ''}${formatThousands(negative ? -lamports : lamports)}`;
}

/** Whether a figure should be styled as a problem. Zero is not a problem. */
export function isNonZero(value: string | null | undefined): boolean {
  const parsed = parseLamports(value);
  return parsed !== null && parsed !== 0n;
}

/** Sums a column of lamport strings without going through Number. */
export function sumLamports(values: readonly (string | null | undefined)[]): bigint {
  return values.reduce<bigint>((total, value) => total + (parseLamports(value) ?? 0n), 0n);
}

const RELATIVE_UNITS: [limit: number, seconds: number, unit: Intl.RelativeTimeFormatUnit][] = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86_400, 3600, 'hour'],
  [604_800, 86_400, 'day'],
  [2_629_800, 604_800, 'week'],
  [31_557_600, 2_629_800, 'month'],
  [Infinity, 31_557_600, 'year'],
];

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * "3 minutes ago", for log and ledger timestamps.
 *
 * `now` is a parameter rather than a `Date.now()` call so the function stays
 * pure — a component calling `Date.now()` during render is impure and makes the
 * output untestable.
 */
export function formatRelativeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return '—';

  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return '—';

  const deltaSeconds = (timestamp - now) / 1000;
  const magnitude = Math.abs(deltaSeconds);

  for (const [limit, divisor, unit] of RELATIVE_UNITS) {
    if (magnitude < limit) {
      return relative.format(Math.round(deltaSeconds / divisor), unit);
    }
  }

  return '—';
}

/** Absolute UTC timestamp — what you quote in an incident report. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  return date.toISOString().replace('T', ' ').slice(0, 19);
}
