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

/** The data-source kinds a manifest may declare (runtime mirror of
 * {@link SubgraphDataSourceKind}, so a validator can check `kind`). */
export const DATA_SOURCE_KINDS: readonly SubgraphDataSourceKind[] = [
  'covenant_id',
  'krc20',
  'krc721',
  'address',
  'utxo',
];

/** The networks a data source may target. */
export const SUBGRAPH_NETWORKS = [
  'kaspa-mainnet',
  'kaspa-testnet-12',
  'kaspa-devnet',
] as const;

/** One structural problem found in a manifest: where it is and what is
 * wrong. `path` is a dotted/indexed locator (e.g.
 * `dataSources[0].mapping.file`). */
export interface ManifestIssue {
  path: string;
  message: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkNonEmptyString(
  value: unknown,
  path: string,
  issues: ManifestIssue[],
): void {
  if (typeof value !== 'string' || value.length === 0) {
    issues.push({ path, message: 'expected a non-empty string' });
  }
}

function validateMapping(
  mapping: unknown,
  base: string,
  issues: ManifestIssue[],
): void {
  if (!isObject(mapping)) {
    issues.push({ path: base, message: 'expected an object' });
    return;
  }
  if (mapping.kind !== 'typescript') {
    issues.push({ path: `${base}.kind`, message: 'expected the literal "typescript"' });
  }
  checkNonEmptyString(mapping.file, `${base}.file`, issues);
  if (!Array.isArray(mapping.entities)) {
    issues.push({ path: `${base}.entities`, message: 'expected an array of entity-type names' });
  } else {
    mapping.entities.forEach((entity, i) => {
      checkNonEmptyString(entity, `${base}.entities[${i}]`, issues);
    });
  }
  if (!Array.isArray(mapping.handlers)) {
    issues.push({ path: `${base}.handlers`, message: 'expected an array of { event, handler }' });
    return;
  }
  mapping.handlers.forEach((handler, i) => {
    const hp = `${base}.handlers[${i}]`;
    if (!isObject(handler)) {
      issues.push({ path: hp, message: 'expected an object' });
      return;
    }
    checkNonEmptyString(handler.event, `${hp}.event`, issues);
    checkNonEmptyString(handler.handler, `${hp}.handler`, issues);
  });
}

function validateDataSource(
  source: unknown,
  base: string,
  issues: ManifestIssue[],
): void {
  if (!isObject(source)) {
    issues.push({ path: base, message: 'expected an object' });
    return;
  }
  checkNonEmptyString(source.name, `${base}.name`, issues);
  if (!SUBGRAPH_NETWORKS.includes(source.network as (typeof SUBGRAPH_NETWORKS)[number])) {
    issues.push({
      path: `${base}.network`,
      message: `expected one of ${SUBGRAPH_NETWORKS.join(', ')}`,
    });
  }
  if (!DATA_SOURCE_KINDS.includes(source.kind as SubgraphDataSourceKind)) {
    issues.push({
      path: `${base}.kind`,
      message: `expected one of ${DATA_SOURCE_KINDS.join(', ')}`,
    });
  }
  if (!isObject(source.source)) {
    issues.push({ path: `${base}.source`, message: 'expected an object' });
  }
  if (source.startBlock !== undefined && typeof source.startBlock !== 'number') {
    issues.push({ path: `${base}.startBlock`, message: 'expected a number when present' });
  }
  validateMapping(source.mapping, `${base}.mapping`, issues);
}

/**
 * Validate a parsed subgraph manifest (e.g. the result of parsing
 * `subgraph.yaml`) against the documented {@link SubgraphManifest}
 * structure. Returns one {@link ManifestIssue} per problem; an empty
 * array means the manifest is structurally valid.
 *
 * This checks the manifest contract only — required fields, types, and
 * the closed `kind` / `network` enums. It deliberately does NOT validate
 * kind-specific `source` contents (e.g. which selector a `covenant_id`
 * source uses) or that referenced files exist on disk; those are the
 * caller's concern (`kasgraph build` resolves files; codegen reads the
 * selectors).
 */
export function validateManifest(value: unknown): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  if (!isObject(value)) {
    return [{ path: '', message: 'manifest must be an object' }];
  }
  checkNonEmptyString(value.specVersion, 'specVersion', issues);
  checkNonEmptyString(value.name, 'name', issues);
  if (!isObject(value.schema)) {
    issues.push({ path: 'schema', message: 'expected an object with a `file`' });
  } else {
    checkNonEmptyString(value.schema.file, 'schema.file', issues);
  }
  if (!Array.isArray(value.dataSources)) {
    issues.push({ path: 'dataSources', message: 'expected a non-empty array' });
  } else if (value.dataSources.length === 0) {
    issues.push({ path: 'dataSources', message: 'a manifest must declare at least one data source' });
  } else {
    value.dataSources.forEach((source, i) => {
      validateDataSource(source, `dataSources[${i}]`, issues);
    });
  }
  return issues;
}

/**
 * KasGraph version that ships in the SDK. Bumped per release.
 */
export const KASGRAPH_SDK_VERSION = '0.1.0';
