// Regenerate cli/src/detector-schema.ts from the Rust detector registry.
//
//   cargo run -p kasgraph-detectors --bin dump-registry \
//     | node cli/scripts/gen-detector-schema.mjs > cli/src/detector-schema.ts
//
// Reads the dump-registry JSON on stdin and writes the TS module to
// stdout. Keeping the schema a committed artifact (rather than calling
// cargo at codegen time) means the published CLI has no Rust dependency;
// codegen tests pin specific detector shapes so drift is caught.

import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(0, 'utf8'));
const lines = [];

lines.push('// Detector field schema — mirrors crates/kasgraph-detectors registry.');
lines.push('//');
lines.push('// DO NOT EDIT BY HAND. Regenerate with:');
lines.push('//   cargo run -p kasgraph-detectors --bin dump-registry \\');
lines.push('//     | node cli/scripts/gen-detector-schema.mjs > cli/src/detector-schema.ts');
lines.push('//');
lines.push('// Every detector state field is hex-encoded at runtime, so each maps');
lines.push('// to a `string` in generated payload types.');
lines.push('');
lines.push('export interface DetectorFieldSchema {');
lines.push('  readonly name: string;');
lines.push('  readonly byteLen: number;');
lines.push('}');
lines.push('');
lines.push('export interface DetectorSchema {');
lines.push('  readonly kind: string;');
lines.push('  readonly fields: readonly DetectorFieldSchema[];');
lines.push('}');
lines.push('');
lines.push(`export const DETECTOR_SCHEMA_VERSION = ${JSON.stringify(data.version)};`);
lines.push('');
lines.push('export const DETECTOR_SCHEMA: readonly DetectorSchema[] = [');
for (const d of data.detectors) {
  lines.push('  {');
  lines.push(`    kind: ${JSON.stringify(d.kind)},`);
  lines.push('    fields: [');
  for (const f of d.fields) {
    lines.push(`      { name: ${JSON.stringify(f.name)}, byteLen: ${f.byte_len} },`);
  }
  lines.push('    ],');
  lines.push('  },');
}
lines.push('];');
lines.push('');
lines.push('export const DETECTOR_SCHEMA_BY_KIND: ReadonlyMap<string, DetectorSchema> =');
lines.push('  new Map(DETECTOR_SCHEMA.map((d) => [d.kind, d]));');
lines.push('');

process.stdout.write(lines.join('\n') + '\n');
