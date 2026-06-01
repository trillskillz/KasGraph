const layers: Array<[string, string]> = [
  ['Kaspa RPC / wRPC', 'multi-source failover and continuous notifications'],
  ['KasGraph Node', 'ingest, detect, map, persist, reload'],
  ['Detectors / Mappings / POI', 'covenant fingerprints, WASM handlers, hash chain'],
  ['PostgreSQL', 'registry, typed entities, lineage, checkpoints'],
  ['GraphQL / MCP / KasStream / WebSocket', 'query, agent, stream, and push interfaces'],
  ['Apps / Wallets / Dashboards / Agents', 'developer-facing consumers'],
];

export function ArchitectureDiagram() {
  return (
    <div className="panel rounded-lg p-4 sm:p-6">
      <div className="grid gap-4">
        {layers.map(([title, body], index) => (
          <div key={title}>
            <div className="rounded-lg border border-[#70C7BA]/22 bg-black/24 p-4">
              <div className="mono text-xs uppercase tracking-[0.2em] text-[#49EACB]">
                layer {String(index + 1).padStart(2, '0')}
              </div>
              <div className="mt-2 text-lg font-semibold text-[#eefefa]">{title}</div>
              <p className="mt-2 text-sm leading-6 text-[#a9bbb7]">{body}</p>
            </div>
            {index < layers.length - 1 ? <div className="node-line mx-auto h-8 w-px" /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
