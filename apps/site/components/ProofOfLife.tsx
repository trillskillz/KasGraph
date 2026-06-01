import Link from 'next/link';
import { CodeBlock } from '@/components/CodeBlock';

const panels: Array<[string, string]> = [
  [
    'Soak command - prepared, not run',
    `SOAK_DURATION_SECONDS=86400 \\
KASGRAPH_ENVIRONMENT=testnet \\
KASGRAPH_NETWORK=kaspa-testnet-10 \\
bash scripts/soak/run-testnet-soak.sh`,
  ],
  [
    'API health artifact - pending',
    `{
  "ts": "N/A",
  "status": null,
  "healthz": null,
  "note": "No sustained testnet run has published health snapshots yet."
}`,
  ],
  [
    'POI checkpoint artifact - pending',
    `{
  "ts": "N/A",
  "checkpoint": null,
  "note": "No public POI checkpoint sample has been captured from a 24h soak yet."
}`,
  ],
  [
    'Restart recovery - required note shape',
    `Pre-restart DAA: N/A
Pre-restart POI: N/A
Post-restart DAA: N/A
Post-restart POI: N/A
Recovery duration: Not measured
Verdict: Incomplete until controlled restart is executed`,
  ],
];

export function ProofOfLife() {
  return (
    <section className="section py-16">
      <div className="mb-8 max-w-4xl">
        <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">proof of life</p>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight text-[#f3fffc]">Proof of life.</h2>
        <p className="mt-4 text-lg leading-8 text-[#b7c9c5]">
          Real sustained-run captures are not published yet. These panels now show the prepared
          soak harness and the exact artifact slots that must be filled by a real testnet run.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link className="rounded-md bg-[#49EACB] px-4 py-2 text-sm font-semibold text-[#021110]" href="/testnet-soak">
            View Testnet Soak Status
          </Link>
          <Link className="rounded-md border border-[#49EACB]/35 px-4 py-2 text-sm font-semibold text-[#dffcf6]" href="/testnet-soak/live">
            Live Soak Dashboard
          </Link>
          <a className="rounded-md border border-[#49EACB]/35 px-4 py-2 text-sm font-semibold text-[#dffcf6]" href="https://github.com/trillskillz/KasGraph/blob/main/docs/testnet-soak-report.md">
            Read Soak Report
          </a>
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        {panels.map(([title, code]) => (
          <CodeBlock code={code} key={title} title={title} />
        ))}
      </div>
    </section>
  );
}
