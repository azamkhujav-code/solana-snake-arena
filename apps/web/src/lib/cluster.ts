import { env } from './env';

export type ClusterId = 'devnet' | 'testnet' | 'mainnet-beta' | 'localnet';

export interface ClusterConfig {
  id: ClusterId;
  label: string;
  endpoint: string;
  /** Query-string value Solana Explorer expects. */
  explorerCluster: string;
  /**
   * Chain identity. An RPC URL is just a hostname — it cannot be trusted to
   * serve the cluster its name implies. Comparing the genesis hash is the only
   * way to actually confirm which chain you are talking to, and it catches the
   * classic "staging env pointed at mainnet" mistake before it costs anything.
   */
  genesisHash: string | null;
}

/** Well-known genesis hashes. Constants of the network, not of this app. */
export const GENESIS_HASHES = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
} as const;

/**
 * The clusters this app can talk to.
 *
 * The configured cluster's endpoint comes from env so a deployment can point at
 * a paid RPC; the others fall back to public endpoints, which are rate-limited
 * and only really usable for a quick manual switch.
 */
export const CLUSTERS: Readonly<Record<ClusterId, ClusterConfig>> = Object.freeze({
  devnet: {
    id: 'devnet',
    label: 'Devnet',
    endpoint: env.solanaCluster === 'devnet' ? env.solanaRpcUrl : 'https://api.devnet.solana.com',
    explorerCluster: 'devnet',
    genesisHash: GENESIS_HASHES.devnet,
  },
  testnet: {
    id: 'testnet',
    label: 'Testnet',
    endpoint: env.solanaCluster === 'testnet' ? env.solanaRpcUrl : 'https://api.testnet.solana.com',
    explorerCluster: 'testnet',
    genesisHash: GENESIS_HASHES.testnet,
  },
  'mainnet-beta': {
    id: 'mainnet-beta',
    label: 'Mainnet',
    endpoint:
      env.solanaCluster === 'mainnet-beta'
        ? env.solanaRpcUrl
        : 'https://api.mainnet-beta.solana.com',
    explorerCluster: 'mainnet-beta',
    genesisHash: GENESIS_HASHES['mainnet-beta'],
  },
  localnet: {
    id: 'localnet',
    label: 'Localnet',
    endpoint: env.solanaCluster === 'localnet' ? env.solanaRpcUrl : 'http://127.0.0.1:8899',
    explorerCluster: 'custom',
    // A fresh local validator generates a new genesis hash every reset, so
    // there is nothing stable to compare against.
    genesisHash: null,
  },
});

/** The cluster this build targets. Devnet unless the env says otherwise. */
export const DEFAULT_CLUSTER: ClusterId = env.solanaCluster;

export function getCluster(id: ClusterId): ClusterConfig {
  return CLUSTERS[id];
}

export const CLUSTER_IDS = Object.keys(CLUSTERS) as ClusterId[];

/** Clusters where real money is at stake. */
export function isMainnet(id: ClusterId): boolean {
  return id === 'mainnet-beta';
}

export function explorerAddressUrl(address: string, cluster: ClusterId): string {
  const config = getCluster(cluster);
  const suffix =
    config.explorerCluster === 'custom'
      ? `?cluster=custom&customUrl=${encodeURIComponent(config.endpoint)}`
      : `?cluster=${config.explorerCluster}`;
  return `https://explorer.solana.com/address/${address}${suffix}`;
}

export function explorerTxUrl(signature: string, cluster: ClusterId): string {
  const config = getCluster(cluster);
  const suffix =
    config.explorerCluster === 'custom'
      ? `?cluster=custom&customUrl=${encodeURIComponent(config.endpoint)}`
      : `?cluster=${config.explorerCluster}`;
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Formats lamports as SOL. Integer maths only — never parse money as a float. */
export function formatSol(lamports: bigint, decimals = 4): string {
  const negative = lamports < 0n;
  const absolute = negative ? -lamports : lamports;

  const whole = absolute / LAMPORTS_PER_SOL;
  const fraction = absolute % LAMPORTS_PER_SOL;

  const fractionStr = fraction.toString().padStart(9, '0').slice(0, decimals).replace(/0+$/, '');
  const body = fractionStr.length > 0 ? `${whole}.${fractionStr}` : whole.toString();

  return negative ? `-${body}` : body;
}

/** Truncates an address for display: `7xKX…gAsU`. */
export function shortenAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 1) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}
