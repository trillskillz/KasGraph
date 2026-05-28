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
//   events.ts     one interface per (handler) in the manifest,
//                 carrying a `block: { hash, daaScore, blueScore }`
//                 plus a `tx: { hash, index }` envelope. Handler
//                 bodies decode the typed payload from there. The
//                 payload shape is detector-kind-specific and
//                 lands in a later slice; today the envelope is
//                 enough for the init-template handlers to type-check.

import { parse, Kind, type DocumentNode, type TypeNode } from 'graphql';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { CliIo } from './index.js';

interface SubgraphManifest {
  name: string;
  dataSources: Array<{
    name: string;
    mapping: {
      handlers: Array<{ event: string; handler: string }>;
    };
  }>;
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

function renderEvents(manifest: SubgraphManifest): string {
  const sources = manifest.dataSources ?? [];
  const interfaces = sources.flatMap((source) =>
    (source.mapping?.handlers ?? []).map((h) => {
      const eventInterfaceName = `${h.event}Event`;
      return `export interface ${eventInterfaceName} {
  /** Logical event name, matches the manifest handler entry. */
  event: ${JSON.stringify(h.event)};
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
  /**
   * Detector-specific payload. Stays \`unknown\` until per-detector
   * payload codegen lands; cast to a specific shape inside the
   * handler in the meantime.
   */
  payload: unknown;
}`;
    }),
  );

  const banner = headerBanner('events');
  if (interfaces.length === 0) {
    return `${banner}\nexport {};\n`;
  }
  return `${banner}\n${interfaces.join('\n\n')}\n`;
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
