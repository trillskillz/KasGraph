const layers: Array<[string, string]> = [
  ['Kaspa Node / RPC / wRPC', 'Blocks, accepted transactions, virtual-chain changes, and continuous notifications.'],
  ['KasGraph Indexer', 'Ingests Kaspa activity, tracks progress, handles reorg-aware state transitions, and dispatches work.'],
  ['Detectors + Mappings', 'Recognizes KRC assets, Covenant IDs, app patterns, and runs deterministic mapping handlers.'],
  ['Proof of Indexing', 'Builds checkpoint hashes over indexed entity state so output can be independently compared.'],
  ['PostgreSQL Entity Store', 'Stores registry rows, schemas, lineage, checkpoints, and versioned application entities.'],
  ['GraphQL / SDK / CLI / MCP / WebSocket / KasStream', 'Serves query, developer, agent, subscription, and streaming interfaces.'],
  ['Wallets / Explorers / Dashboards / AI Agents / Covenant Apps', 'Consumes indexed state without every product rebuilding a parser.'],
];

export function ArchitectureDiagram() {
  return (
    <div className="panel rounded-lg p-4 sm:p-6">
      <div className="grid gap-3">
        {layers.map(([title, body], index) => (
          <div key={title}>
            <div className="rounded-lg border border-[#70C7BA]/22 bg-black/24 p-4 sm:grid sm:grid-cols-[9rem_1fr] sm:gap-4">
              <div className="mono text-xs uppercase tracking-[0.2em] text-[#49EACB]">
                stage {String(index + 1).padStart(2, '0')}
              </div>
              <div>
                <div className="text-lg font-semibold text-[#eefefa]">{title}</div>
                <p className="mt-2 text-sm leading-6 text-[#a9bbb7]">{body}</p>
              </div>
            </div>
            {index < layers.length - 1 ? <div className="node-line mx-auto h-8 w-px" /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
