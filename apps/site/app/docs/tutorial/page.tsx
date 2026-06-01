import { CodeBlock } from '@/components/CodeBlock';
import { PageHero } from '@/components/PageHero';

const install = `git clone https://github.com/trillskillz/KasGraph
cd KasGraph
npm install
npm run typecheck
npm test`;

const init = `npx kasgraph init krc20-tracker
cd krc20-tracker`;

const schema = `type Token @entity {
  id: ID!
  ticker: String!
  totalSupply: BigInt!
  holdersCount: Int!
}

type Holder @entity {
  id: ID!
  token: Token!
  balance: BigInt!
}

type Transfer @entity {
  id: ID!
  token: Token!
  from: String
  to: String
  amount: BigInt!
  txHash: String!
}`;

const mapping = `// Preview mapping shape. Adjust handler names to match your manifest.
export function handleTransfer(event: Krc20Transfer): void {
  const token = Token.load(event.ticker) ?? new Token(event.ticker);
  token.ticker = event.ticker;

  const from = event.from ? loadHolder(event.ticker, event.from) : null;
  const to = loadHolder(event.ticker, event.to);

  if (from) from.balance = from.balance.minus(event.amount);
  to.balance = to.balance.plus(event.amount);

  token.save();
  from?.save();
  to.save();
}`;

const build = `npx kasgraph codegen
npx kasgraph build`;

const deploy = `# Direct local registry write, requires Postgres.
npx kasgraph deploy --database-url "$DATABASE_URL"
npx kasgraph status krc20-tracker`;

const indexer = `DATABASE_URL="$DATABASE_URL" \\
KASGRAPH_INGEST_MODE=continuous \\
KASGRAPH_NOTIFICATION_WS_URL=wss://your-kaspa-node/wrpc/json \\
KASGRAPH_RELOAD_INTERVAL_SECS=30 \\
  cargo run -p kasgraph-node`;

const query = `query {
  tokens(first: 10) {
    id
    ticker
    holdersCount
    totalSupply
  }
}`;

const poi = `# POI inspection is implemented in the core verifier/checkpoint path.
# Latest checkpoint inspection is available against Postgres.
npx kasgraph poi latest --database-url "$DATABASE_URL"
npx kasgraph db stats --database-url "$DATABASE_URL" --json
npx kasgraph health --node http://localhost:4000`;

const steps: Array<[string, string, string]> = [
  ['Step 1 - Install repo dependencies', 'The CLI package is in this monorepo. Until npm publishing is confirmed, use the repo-local toolchain.', install],
  ['Step 2 - Initialize a subgraph', 'This command is implemented and scaffolds manifest, schema, mapping, and README files.', init],
  ['Step 3 - Define entities', 'Edit schema.graphql to model the application data you want to query.', schema],
  ['Step 4 - Add a mapping', 'The scaffolded mapping is editable. This transfer handler is a tutorial preview, not a copied production handler.', mapping],
  ['Step 5 - Build', 'Generate TypeScript types and compile the AssemblyScript mapping to WASM.', build],
  ['Step 6 - Deploy locally', 'Direct database deployment is implemented. Hosted-node deployment also exists behind --node once a node is available.', deploy],
  ['Step 7 - Run the indexer node', 'There is no implemented kasgraph index CLI command yet; run the Rust node with the documented environment variables.', indexer],
  ['Step 8 - Query with GraphQL', 'Run the API/gateway against the same Postgres-backed registry, then query the generated schema.', query],
  ['Step 9 - Inspect status and checkpoints', 'Use the operational CLI for public API status, latest POI checkpoint, and database counts. Range verification remains pending.', poi],
];

export default function TutorialPage() {
  return (
    <main>
      <PageHero
        eyebrow="tutorial"
        title="Build your first KasGraph subgraph."
        description="A local-first walkthrough for defining, building, deploying, indexing, and querying a simple KRC-style subgraph without pretending hosted commands exist before validation."
      />
      <section className="section grid gap-8">
        {steps.map(([title, description, code]) => (
          <article className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr] lg:items-start" key={title}>
            <div className="panel rounded-lg p-5">
              <h2 className="text-2xl font-semibold text-[#f3fffc]">{title}</h2>
              <p className="mt-3 leading-7 text-[#b7c9c5]">{description}</p>
            </div>
            <CodeBlock code={code} title={title.toLowerCase()} />
          </article>
        ))}
      </section>
    </main>
  );
}
