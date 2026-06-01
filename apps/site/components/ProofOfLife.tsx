import { CodeBlock } from '@/components/CodeBlock';

const panels: Array<[string, string]> = [
  [
    'CLI workflow - example output',
    `kasgraph init my-subgraph
cd my-subgraph
kasgraph build
kasgraph deploy
# planned hosted command:
kasgraph index --network testnet-10`,
  ],
  [
    'Indexer log - preview output',
    `Indexer: running
Network: kaspa-testnet-10
RPC: connected
DAA score: 467579632
Indexed blocks: 1,204,882
Reorg handler: active
POI checkpoint: 0x8fa4b21...`,
  ],
  [
    'MCP tool call - example output',
    `{
  "tool": "get_covenant_lineage",
  "arguments": {
    "covenantId": "cov_8fa4b21..."
  }
}`,
  ],
  [
    'GraphQL response - preview output',
    `{
  "data": {
    "network": "kaspa-testnet-10",
    "indexedDaaScore": 467579632,
    "poiCheckpoint": "0x8fa4b21..."
  }
}`,
  ],
];

export function ProofOfLife() {
  return (
    <section className="section py-16">
      <div className="mb-8 max-w-4xl">
        <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">proof of life</p>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight text-[#f3fffc]">Proof of life.</h2>
        <p className="mt-4 text-lg leading-8 text-[#b7c9c5]">
          These panels show the current developer surfaces and expected local/hosted output shape.
          They are labeled as example or preview output until real public captures are published.
        </p>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        {panels.map(([title, code]) => (
          <CodeBlock code={code} key={title} title={title} />
        ))}
      </div>
    </section>
  );
}
