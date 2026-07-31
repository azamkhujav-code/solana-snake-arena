import { describe, expect, it } from 'vitest';

import {
  CLUSTER_IDS,
  explorerTxUrl,
  formatSol,
  GENESIS_HASHES,
  getCluster,
  isMainnet,
  LAMPORTS_PER_SOL,
  shortenAddress,
} from './cluster';

describe('formatSol', () => {
  it('formats whole SOL without a decimal point', () => {
    expect(formatSol(0n)).toBe('0');
    expect(formatSol(LAMPORTS_PER_SOL)).toBe('1');
    expect(formatSol(LAMPORTS_PER_SOL * 42n)).toBe('42');
  });

  it('preserves leading zeros in the fraction', () => {
    // 0.05 must not render as 0.5 — the classic padStart bug.
    expect(formatSol(50_000_000n)).toBe('0.05');
    expect(formatSol(5_000_000n)).toBe('0.005');
    expect(formatSol(500_000_000n)).toBe('0.5');
  });

  it('trims trailing zeros', () => {
    expect(formatSol(1_500_000_000n)).toBe('1.5');
    expect(formatSol(1_100_000_000n)).toBe('1.1');
  });

  it('truncates to the requested precision', () => {
    expect(formatSol(1_234_567_890n, 4)).toBe('1.2345');
    expect(formatSol(1_234_567_890n, 9)).toBe('1.23456789');
  });

  it('handles negative amounts, as used for spend rows in history', () => {
    expect(formatSol(-LAMPORTS_PER_SOL)).toBe('-1');
    expect(formatSol(-50_000_000n)).toBe('-0.05');
  });

  it('rounds dust below the display precision down to zero', () => {
    expect(formatSol(1n)).toBe('0');
    expect(formatSol(1n, 9)).toBe('0.000000001');
  });

  it('stays exact for amounts beyond Number.MAX_SAFE_INTEGER', () => {
    // ~10M SOL. A float-based implementation loses precision here.
    const huge = 10_000_000n * LAMPORTS_PER_SOL;
    expect(formatSol(huge)).toBe('10000000');
  });
});

describe('shortenAddress', () => {
  it('truncates the middle', () => {
    expect(shortenAddress('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')).toBe('7xKX…gAsU');
  });

  it('leaves short strings alone rather than producing nonsense', () => {
    expect(shortenAddress('abc')).toBe('abc');
  });

  it('honours a custom character count', () => {
    expect(shortenAddress('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 6)).toBe('7xKXtg…osgAsU');
  });
});

describe('cluster config', () => {
  it('exposes every cluster id', () => {
    expect(CLUSTER_IDS).toEqual(
      expect.arrayContaining(['devnet', 'testnet', 'mainnet-beta', 'localnet']),
    );
  });

  it('pins the well-known genesis hashes', () => {
    expect(getCluster('devnet').genesisHash).toBe(GENESIS_HASHES.devnet);
    expect(getCluster('mainnet-beta').genesisHash).toBe(GENESIS_HASHES['mainnet-beta']);
  });

  it('has no genesis hash for localnet', () => {
    // A fresh validator regenerates it, so there is nothing to compare against.
    expect(getCluster('localnet').genesisHash).toBeNull();
  });

  it('identifies mainnet, and only mainnet, as real money', () => {
    expect(isMainnet('mainnet-beta')).toBe(true);
    expect(isMainnet('devnet')).toBe(false);
    expect(isMainnet('testnet')).toBe(false);
  });

  it('builds explorer links with the right cluster parameter', () => {
    expect(explorerTxUrl('SIG', 'devnet')).toBe(
      'https://explorer.solana.com/tx/SIG?cluster=devnet',
    );
    // Localnet needs the custom endpoint passed through.
    expect(explorerTxUrl('SIG', 'localnet')).toContain('cluster=custom&customUrl=');
  });
});
