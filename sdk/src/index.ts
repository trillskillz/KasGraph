// @kasgraph/sdk — shared types + client surface for KasGraph consumers.
//
// Per PLAN.md Phase 4.1:
//   - @kasgraph/sdk for shared TypeScript types (this package)
//   - @kasgraph/cli is the developer CLI (separate workspace)
//   - @kasgraph/migrate handles The-Graph→KasGraph migration (future)

/**
 * One configured Kaspa RPC endpoint as the SDK describes it for the
 * `kasgraph deploy --node <url>` flow.
 */
export interface RpcEndpoint {
  label: string;
  url: string;
  timeoutMs: number;
}

/**
 * Subgraph manifest data-source kinds — Kaspa-native primitives.
 * Mirrors PLAN.md's `kind: covenant_id | krc20 | krc721 | address | utxo`.
 */
export type SubgraphDataSourceKind =
  | 'covenant_id'
  | 'krc20'
  | 'krc721'
  | 'address'
  | 'utxo';

export interface SubgraphDataSource {
  name: string;
  network: 'kaspa-mainnet' | 'kaspa-testnet-12' | 'kaspa-devnet';
  kind: SubgraphDataSourceKind;
  /**
   * Source-specific identity. For `covenant_id`, either a literal id
   * list or a `pattern:` selector resolved by the OpenSilver pattern
   * detector. See PLAN.md "Manifest" section for examples.
   */
  source: Record<string, unknown>;
  startBlock?: number;
  mapping: {
    kind: 'typescript';
    file: string;
    entities: string[];
    handlers: Array<{ event: string; handler: string }>;
  };
}

export interface SubgraphManifest {
  specVersion: string;
  name: string;
  description?: string;
  schema: { file: string };
  dataSources: SubgraphDataSource[];
}

/**
 * KasGraph version that ships in the SDK. Bumped per release.
 */
export const KASGRAPH_SDK_VERSION = '0.1.0';
