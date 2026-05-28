// `kasgraph init <name>` — scaffolds a new subgraph directory.
//
// Layout:
//   <name>/
//     subgraph.yaml         manifest matching @kasgraph/sdk's SubgraphManifest
//     schema.graphql        canonical entity (KasBonds-style placeholder)
//     src/mapping.ts        handler stubs
//     package.json          minimal SDK + AssemblyScript-ready entry
//     .gitignore            ignores dist/ + cache
//
// Errors with a clear message + non-zero exit code if:
//   - no name passed
//   - name is empty / not a valid dir name
//   - target directory already exists (we never clobber)

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { CliIo } from './index.js';

/** Imperative entry shared by tests + the cli bin. */
export async function runInit(args: string[], io: CliIo): Promise<number> {
  const positional = args.filter((a) => !a.startsWith('-'));
  const name = positional[0];

  if (name === undefined || name.length === 0) {
    io.stderr.write('kasgraph init: missing required positional <name>\n');
    io.stderr.write('  usage: kasgraph init <name>\n');
    return 64; // EX_USAGE
  }

  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    io.stderr.write(
      `kasgraph init: <name> must be a lowercase letter/digit followed by 0-63 of [a-z0-9_-] (got: ${name})\n`,
    );
    return 64;
  }

  const target = path.resolve(io.cwd, name);
  if (existsSync(target)) {
    io.stderr.write(`kasgraph init: refusing to clobber existing path ${target}\n`);
    return 73; // EX_CANTCREAT
  }

  await mkdir(target, { recursive: false });
  await mkdir(path.join(target, 'src'), { recursive: false });

  const files: Array<[string, string]> = [
    ['subgraph.yaml', SUBGRAPH_YAML(name)],
    ['schema.graphql', SCHEMA_GRAPHQL],
    ['src/mapping.ts', MAPPING_TS],
    ['package.json', PACKAGE_JSON(name)],
    ['.gitignore', GITIGNORE],
    ['README.md', README_MD(name)],
  ];

  for (const [rel, body] of files) {
    await writeFile(path.join(target, rel), body, 'utf8');
  }

  io.stdout.write(
    [
      `Scaffolded subgraph at ${target}`,
      '',
      'Next steps:',
      `  cd ${name}`,
      '  npm install              # once dependencies are released',
      '  kasgraph codegen         # generate types from schema.graphql',
      '  kasgraph build           # compile mappings to WASM',
      '  kasgraph deploy --node http://localhost:4000',
      '',
    ].join('\n'),
  );
  return 0;
}

// ----------------------------------------------------------------
// Template strings. Kept inline to avoid shipping a binary
// `templates/` directory alongside dist/ — generated files are
// tiny and a single search lands you on the source of truth.
// ----------------------------------------------------------------

function SUBGRAPH_YAML(name: string): string {
  return `specVersion: 0.1.0
name: ${name}
description: ${name} subgraph scaffolded by \`kasgraph init\`.
schema:
  file: ./schema.graphql
dataSources:
  - name: ${name}-source
    network: kaspa-testnet-12
    kind: covenant_id
    source:
      # Replace with a literal id list or a pattern selector once
      # you know which covenants you are indexing. See
      # docs/references/KIP20_COVENANT_ID_QUERIES.md.
      ids: []
    mapping:
      kind: typescript
      file: ./src/mapping.ts
      entities:
        - Bond
      handlers:
        - event: CovenantLocked
          handler: handleCovenantLocked
        - event: CovenantSpent
          handler: handleCovenantSpent
`;
}

const SCHEMA_GRAPHQL = `# Canonical KasGraph schema for this subgraph.
# Edit freely — \`kasgraph codegen\` regenerates the TypeScript
# types under src/generated/ from this file.

type Bond @entity {
  id: ID!
  covenantId: String!
  issuer: String!
  faceValueSompi: BigInt!
  issuedAtDaa: BigInt!
  matures: BigInt
}
`;

const MAPPING_TS = `// Subgraph mapping handlers. The named exports must match the
// \`handlers\` block in subgraph.yaml.
//
// The mapping runtime invokes one handler per matched event.
// Production handlers should be deterministic — same input bytes
// → same entity writes.

import type { CovenantLockedEvent, CovenantSpentEvent } from './generated/events.js';

export async function handleCovenantLocked(event: CovenantLockedEvent): Promise<void> {
  // TODO: persist a new Bond entity here.
  // Example (pseudo-code):
  //   const bond = new Bond(event.covenantId);
  //   bond.covenantId = event.covenantId;
  //   bond.issuer = event.issuer;
  //   bond.faceValueSompi = event.amount;
  //   bond.issuedAtDaa = event.block.daaScore;
  //   await bond.save();
  return;
}

export async function handleCovenantSpent(_event: CovenantSpentEvent): Promise<void> {
  // TODO: mark the Bond entity as redeemed / matured.
  return;
}
`;

function PACKAGE_JSON(name: string): string {
  return `${JSON.stringify(
    {
      name,
      version: '0.0.1',
      private: true,
      type: 'module',
      scripts: {
        codegen: 'kasgraph codegen',
        build: 'kasgraph build',
        deploy: 'kasgraph deploy --node http://localhost:4000',
      },
      dependencies: {
        '@kasgraph/sdk': '^0.1.0',
      },
    },
    null,
    2,
  )}\n`;
}

const GITIGNORE = `dist/
build/
.cache/
node_modules/
src/generated/
*.log
`;

function README_MD(name: string): string {
  return `# ${name}

Scaffolded by \`kasgraph init\`.

## Files

- \`subgraph.yaml\` — manifest. Edit \`dataSources[].source\` to point
  at the covenant ids / patterns you want to index.
- \`schema.graphql\` — entity definitions. Drives codegen.
- \`src/mapping.ts\` — handler implementations.

## Build + deploy

\`\`\`bash
kasgraph codegen
kasgraph build
kasgraph deploy --node http://localhost:4000
\`\`\`
`;
}
