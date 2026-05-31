// `kasgraph codegen` — generate TypeScript types from a
// subgraph's `schema.graphql` + `subgraph.yaml`.
//
// Outputs under <cwd>/src/generated/:
//
//   entities.ts   one interface per object type in schema.graphql.
//                 Field types map GraphQL scalars to TS:
//                   String  → string
//                   Int     → number
//                   Float   → number
//                   Boolean → boolean
//                   ID      → string
//                   BigInt  → bigint
//                   Bytes   → string  (hex)
//                   JSON    → unknown
//                 Non-null wraps stay required; nullable wraps
//                 become `T | null`. Lists become `Array<T>`.
//                 Object-type references stay as the referenced
//                 interface name (foreign-key-style).
//
//   events.ts     one interface per event name in the manifest,
//                 carrying a `block: { hash, daaScore, blueScore }`
//                 plus a `tx: { hash, index }` envelope. The payload
//                 is typed per detector pattern: each `pattern:`
//                 selector that maps to a registered detector emits a
//                 `<Kind>State` interface (covenant-state fields, all
//                 hex `string`, discriminated on `detectorKind`, with
//                 optional `covenantId` for the stable KIP-20 lineage
//                 id), and an event's payload is the union of its data
//                 source's detector states. Pattern-less sources (krc721
//                 `collection`, utxo `addresses`) and unregistered
//                 selectors leave the state `unknown`. A `CovenantSpent`
//                 event on a `covenant_id` source additionally wraps its
//                 payload in `{ spend: CovenantSpend; state: … }`, where
//                 `CovenantSpend` is the protocol-level spend envelope
//                 (covenant id, operation, consumed value, lineage
//                 successor). The detector schema is sourced from
//                 `./detector-schema.ts`.

import { parse, Kind, type DocumentNode, type TypeNode } from 'graphql';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { CliIo } from './index.js';
import { DETECTOR_SCHEMA_BY_KIND } from './detector-schema.js';

interface SubgraphDataSource {
  name: string;
  // One of the documented data-source kinds (covenant_id, krc20,
  // krc721, address, utxo). Covenant spends carry the typed spend
  // envelope only on `covenant_id` sources.
  kind?: string;
  source?: {
    // covenant_id sources carry an `ids` list whose entries are
    // either a literal id string or a `{ pattern: <DetectorKind> }`
    // selector. Other kinds (krc721 `collection`, utxo `addresses`)
    // carry no detector patterns, so their payloads stay `unknown`.
    ids?: Array<{ pattern?: string } | string>;
  };
  mapping: {
    handlers: Array<{ event: string; handler: string }>;
  };
}

interface SubgraphManifest {
  name: string;
  dataSources: SubgraphDataSource[];
}

export interface CodegenResult {
  generatedFiles: string[];
  entityCount: number;
  handlerCount: number;
}

export async function runCodegen(_args: string[], io: CliIo): Promise<number> {
  const root = io.cwd;
  const manifestPath = path.join(root, 'subgraph.yaml');
  const schemaPath = path.join(root, 'schema.graphql');

  if (!existsSync(manifestPath)) {
    io.stderr.write(`kasgraph codegen: ${manifestPath} not found\n`);
    return 66; // EX_NOINPUT
  }
  if (!existsSync(schemaPath)) {
    io.stderr.write(`kasgraph codegen: ${schemaPath} not found\n`);
    return 66;
  }

  const manifestRaw = await readFile(manifestPath, 'utf8');
  const schemaRaw = await readFile(schemaPath, 'utf8');

  let manifest: SubgraphManifest;
  try {
    manifest = parseYaml(manifestRaw) as SubgraphManifest;
  } catch (err) {
    io.stderr.write(
      `kasgraph codegen: failed to parse subgraph.yaml: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 65; // EX_DATAERR
  }

  let doc: DocumentNode;
  try {
    doc = parse(schemaRaw);
  } catch (err) {
    io.stderr.write(
      `kasgraph codegen: failed to parse schema.graphql: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 65;
  }

  const entitiesSource = renderEntities(doc);
  const eventsSource = renderEvents(manifest);

  const outDir = path.join(root, 'src', 'generated');
  await mkdir(outDir, { recursive: true });
  const entitiesPath = path.join(outDir, 'entities.ts');
  const eventsPath = path.join(outDir, 'events.ts');
  await writeFile(entitiesPath, entitiesSource, 'utf8');
  await writeFile(eventsPath, eventsSource, 'utf8');

  const result: CodegenResult = {
    generatedFiles: [entitiesPath, eventsPath],
    entityCount: countEntities(doc),
    handlerCount: countHandlers(manifest),
  };

  io.stdout.write(
    [
      'Codegen complete:',
      `  ${result.entityCount} entit${result.entityCount === 1 ? 'y' : 'ies'}` +
        ` → ${entitiesPath}`,
      `  ${result.handlerCount} handler${result.handlerCount === 1 ? '' : 's'}` +
        ` → ${eventsPath}`,
      '',
    ].join('\n'),
  );
  return 0;
}

// ----------------------------------------------------------------
// Renderers
// ----------------------------------------------------------------

function renderEntities(doc: DocumentNode): string {
  const types = doc.definitions
    .filter(
      (def): def is import('graphql').ObjectTypeDefinitionNode =>
        def.kind === Kind.OBJECT_TYPE_DEFINITION && def.name.value !== 'Query' &&
        def.name.value !== 'Subscription' && def.name.value !== 'Mutation',
    )
    .map((typeDef) => {
      const fields = (typeDef.fields ?? []).map((field) => {
        const name = field.name.value;
        const tsType = mapType(field.type);
        const optional = isNullableLeaf(field.type) ? '?' : '';
        return `  ${name}${optional}: ${tsType};`;
      });
      return `export interface ${typeDef.name.value} {\n${fields.join('\n')}\n}`;
    });

  const banner = headerBanner('entities');
  if (types.length === 0) {
    return `${banner}\nexport {};\n`;
  }
  return `${banner}\n${types.join('\n\n')}\n`;
}

// KIP-20 covenant lifecycle event names. A `covenant_id` data source's
// spend event additionally carries the protocol-level spend envelope.
const COVENANT_KIND = 'covenant_id';
const COVENANT_SPEND_EVENT = 'CovenantSpent';

function renderEvents(manifest: SubgraphManifest): string {
  const sources = manifest.dataSources ?? [];

  // Map every event name to the union of detector kinds that can feed
  // it. A covenant_id dataSource's `pattern:` selectors apply to all
  // of that dataSource's handlers (a CovenantLocked / CovenantSpent on
  // that source can carry any of the patterns it watches). Only kinds
  // present in the detector schema contribute a typed state payload;
  // unknown selectors (e.g. ZK-aware patterns not yet registered) and
  // pattern-less sources (krc721 `collection`, utxo `addresses`) leave
  // the state `unknown`.
  const eventKinds = new Map<string, Set<string>>();
  const eventOrder: string[] = [];
  const allKinds = new Set<string>();
  // Event names that are a covenant spend on a `covenant_id` source.
  // These carry the protocol-level `CovenantSpend` envelope regardless
  // of whether the source watches a registered detector pattern, since
  // the spend operation / consumed value / lineage successor are
  // observable from the spend transaction, not the detector registry.
  const spendEvents = new Set<string>();

  for (const source of sources) {
    const kinds = detectorKindsForSource(source);
    for (const kind of kinds) allKinds.add(kind);
    const isCovenant = source.kind === COVENANT_KIND;
    for (const handler of source.mapping?.handlers ?? []) {
      if (!eventKinds.has(handler.event)) {
        eventKinds.set(handler.event, new Set());
        eventOrder.push(handler.event);
      }
      const set = eventKinds.get(handler.event)!;
      for (const kind of kinds) set.add(kind);
      if (isCovenant && handler.event === COVENANT_SPEND_EVENT) {
        spendEvents.add(handler.event);
      }
    }
  }

  const stateInterfaces = [...allKinds]
    .sort()
    .map((kind) => renderStateInterface(kind));

  const eventInterfaces = eventOrder.map((event) => {
    const kinds = [...(eventKinds.get(event) ?? [])].sort();
    const stateType =
      kinds.length === 0 ? 'unknown' : kinds.map((k) => `${k}State`).join(' | ');
    const isSpend = spendEvents.has(event);
    const payloadType = isSpend
      ? `{ spend: CovenantSpend; state: ${stateType} }`
      : stateType;
    const payloadDoc = isSpend
      ? `  /**
   * Covenant spend payload: the protocol-level \`spend\` envelope
   * (operation, consumed value, lineage successor) plus the lock-time
   * covenant \`state\` of the UTXO being spent. \`state\` is \`unknown\`
   * when the data source watches no registered detector pattern.
   */`
      : kinds.length === 0
        ? `  /**
   * Detector-specific payload. This event's data source watches no
   * registered detector pattern, so the payload is left \`unknown\`;
   * cast to a specific shape inside the handler.
   */`
        : `  /**
   * Detector covenant-state payload, discriminated on \`detectorKind\`.
   * Fields are the lock-time state windows, hex-encoded.
   */`;
    return `export interface ${event}Event {
  /** Logical event name, matches the manifest handler entry. */
  event: ${JSON.stringify(event)};
  /** Block envelope: identifies which block produced this event. */
  block: {
    hash: string;
    daaScore: bigint;
    blueScore: bigint;
  };
  /** Transaction envelope. */
  tx: {
    hash: string;
    index: number;
  };
${payloadDoc}
  payload: ${payloadType};
}`;
  });

  const banner = headerBanner('events');
  const spendInterface =
    spendEvents.size > 0 ? [renderCovenantSpendInterface()] : [];
  const blocks = [...stateInterfaces, ...spendInterface, ...eventInterfaces];
  if (blocks.length === 0) {
    return `${banner}\nexport {};\n`;
  }
  return `${banner}\n${blocks.join('\n\n')}\n`;
}

// Protocol-level covenant spend envelope, shared across every
// CovenantSpent event. These fields are observable from the spend
// transaction + the KIP-20 lineage tracker (Phase 2.4), independent of
// any detector pattern: the invoked spend path, the consumed output's
// value, and the continuation covenant id (or null for a terminal
// spend). Subgraph-specific quantities (transfer amount, new controller,
// coupon payout, …) are derived by the mapping from these primitives.
function renderCovenantSpendInterface(): string {
  return `export interface CovenantSpend {
  /** Stable KIP-20 covenant/lineage id being spent. */
  covenantId: string;
  /**
   * The covenant operation (spend path / method) this spend invoked,
   * observable from the revealed spend branch.
   */
  operation: string;
  /** Value of the consumed covenant output, in sompi (decimal string). */
  spentValueSompi: string;
  /**
   * Continuation covenant id when the spend produced a successor
   * covenant output; \`null\` for a terminal spend (redemption / burn).
   * Sourced from the KIP-20 lineage tracker.
   */
  successorCovenantId: string | null;
}`;
}

// Detector kinds referenced by a dataSource's `pattern:` selectors,
// filtered to those present in the registry schema.
function detectorKindsForSource(source: SubgraphDataSource): string[] {
  const ids = source.source?.ids ?? [];
  const kinds = new Set<string>();
  for (const entry of ids) {
    if (typeof entry === 'object' && entry !== null && typeof entry.pattern === 'string') {
      if (DETECTOR_SCHEMA_BY_KIND.has(entry.pattern)) {
        kinds.add(entry.pattern);
      }
    }
  }
  return [...kinds];
}

// Typed covenant-state interface for one detector kind. Every field
// is hex-encoded at runtime, so every field is a `string`.
function renderStateInterface(kind: string): string {
  const schema = DETECTOR_SCHEMA_BY_KIND.get(kind)!;
  const fields = schema.fields.map((f) => `  ${f.name}: string;`).join('\n');
  return `export interface ${kind}State {
  /** Discriminator — names the matched detector pattern. */
  detectorKind: ${JSON.stringify(kind)};
  /** Stable KIP-20 covenant/lineage id when available. */
  covenantId?: string;
${fields}
}`;
}

function headerBanner(kind: 'entities' | 'events'): string {
  return [
    '// Generated by `kasgraph codegen`.',
    `// File: src/generated/${kind}.ts`,
    '// DO NOT EDIT — regenerate by running `kasgraph codegen`.',
    '',
  ].join('\n');
}

function countEntities(doc: DocumentNode): number {
  return doc.definitions.filter(
    (def) =>
      def.kind === Kind.OBJECT_TYPE_DEFINITION &&
      def.name.value !== 'Query' &&
      def.name.value !== 'Subscription' &&
      def.name.value !== 'Mutation',
  ).length;
}

function countHandlers(manifest: SubgraphManifest): number {
  return (manifest.dataSources ?? []).reduce(
    (sum, src) => sum + (src.mapping?.handlers ?? []).length,
    0,
  );
}

// ----------------------------------------------------------------
// Type mapping
// ----------------------------------------------------------------

const SCALAR_MAP: Record<string, string> = {
  String: 'string',
  Int: 'number',
  Float: 'number',
  Boolean: 'boolean',
  ID: 'string',
  BigInt: 'bigint',
  Bytes: 'string',
  JSON: 'unknown',
};

function mapType(node: TypeNode): string {
  // Non-null wrapper just strips itself; the parent's required-or-
  // not is decided via isNullableLeaf below.
  if (node.kind === Kind.NON_NULL_TYPE) {
    return mapType(node.type);
  }
  if (node.kind === Kind.LIST_TYPE) {
    const inner = mapType(node.type);
    // Inner nullability collapses into `T | null` so the array
    // shape stays `Array<...>`.
    return `Array<${node.type.kind === Kind.NON_NULL_TYPE ? inner : `${inner} | null`}>`;
  }
  // NamedType — scalar or entity reference.
  const name = node.name.value;
  return SCALAR_MAP[name] ?? name;
}

function isNullableLeaf(node: TypeNode): boolean {
  return node.kind !== Kind.NON_NULL_TYPE;
}
