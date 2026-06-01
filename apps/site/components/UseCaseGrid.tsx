const useCases: Array<[string, string, string, string]> = [
  [
    'KRC-20 dashboard',
    'Token dashboards need supply, holders, transfers, and activity without custom inscription parsers.',
    'Indexed KRC entities, transfer history, holder counts, and GraphQL queries.',
    'tokens(first: 10) { ticker holdersCount totalSupply }',
  ],
  [
    'KRC-721 explorer',
    'NFT explorers need ownership, transfers, collections, and metadata timelines.',
    'Collection and token entity schemas backed by KRC-721 detectors and mappings.',
    'collections { id tokenCount ownersCount }',
  ],
  [
    'Covenant lineage explorer',
    'Covenant apps need to follow spend paths, state transitions, and UTXO lineage.',
    'Covenant ID indexing, lineage queries, and BlockDAG-aware history.',
    'covenant(id: $id) { transactions { spendPath } currentUtxos { txid } }',
  ],
  [
    'KasBonds verifier dashboard',
    'Verifier dashboards need SLA bonds, signatures, deadlines, releases, and slashes.',
    'App-specific subgraphs with typed entities and POI-backed checkpoints.',
    'bonds(where: { status: ACTIVE }) { id deadline verifier }',
  ],
  [
    'AI agent state reader',
    'Agents should not scrape explorers or infer raw RPC responses.',
    'MCP tools for schema discovery, query execution, pattern search, and lineage reads.',
    'get_covenant_lineage({ covenantId: "cov_..." })',
  ],
  [
    'Wallet asset indexer',
    'Wallets need fast access to balances, token holdings, activity, and app state.',
    'Indexed wallet-facing entities, asset balances, transfer history, and subscriptions.',
    'wallet(address: $addr) { assets { id balance } transfers { hash } }',
  ],
];

export function UseCaseGrid() {
  return (
    <section className="section py-16" id="use-cases">
      <div className="mb-8 max-w-4xl">
        <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">example apps</p>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight text-[#f3fffc]">
          Example apps powered by KasGraph.
        </h2>
        <p className="mt-4 text-lg leading-8 text-[#b7c9c5]">
          These are concrete integration targets for the indexing layer, not claims of existing
          production deployments.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {useCases.map(([title, problem, provides, example]) => (
          <article className="panel rounded-lg p-5" key={title}>
            <h3 className="text-xl font-semibold text-[#eefefa]">{title}</h3>
            <div className="mt-5 grid gap-4 text-sm leading-6 text-[#a9bbb7]">
              <p><span className="font-semibold text-[#dffcf6]">Problem:</span> {problem}</p>
              <p><span className="font-semibold text-[#dffcf6]">KasGraph provides:</span> {provides}</p>
              <div>
                <div className="mono mb-2 text-xs uppercase tracking-[0.16em] text-[#70C7BA]">example query/output</div>
                <code className="block overflow-x-auto rounded-md border border-[#70C7BA]/18 bg-black/25 p-3 text-xs text-[#d8fff7]">
                  {example}
                </code>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
