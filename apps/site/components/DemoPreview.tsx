import Link from 'next/link';
import { CodeBlock } from '@/components/CodeBlock';

const query = `query CovenantLineage($covenantId: String!) {
  covenant(id: $covenantId) {
    id
    createdAtDaaScore
    transactions {
      hash
      daaScore
      acceptedAt
      spendPath
    }
    currentUtxos {
      txid
      index
      amount
      address
    }
  }
}`;

const response = `{
  "data": {
    "covenant": {
      "id": "cov_8fa4b21...",
      "createdAtDaaScore": 467579632,
      "transactions": [
        {
          "hash": "3b2f9c...",
          "daaScore": 467579812,
          "acceptedAt": "2026-05-18T16:04:22Z",
          "spendPath": "verifier_release"
        }
      ],
      "currentUtxos": [
        {
          "txid": "9ac41e...",
          "index": 0,
          "amount": "1250000000",
          "address": "kaspatest:q..."
        }
      ]
    }
  }
}`;

export function DemoPreview() {
  return (
    <section className="section py-16" id="demo">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">demo preview</p>
            <span className="mono rounded-full border border-[#70C7BA]/22 bg-black/25 px-3 py-1 text-xs uppercase tracking-[0.16em] text-[#a9bbb7]">
              Preview
            </span>
            <span className="mono rounded-full border border-[#70C7BA]/22 bg-black/25 px-3 py-1 text-xs uppercase tracking-[0.16em] text-[#a9bbb7]">
              Local-first
            </span>
          </div>
          <h2 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight text-[#f3fffc]">
            See KasGraph query indexed Kaspa state.
          </h2>
          <p className="mt-4 max-w-4xl text-lg leading-8 text-[#b7c9c5]">
            No public hosted endpoint is advertised yet. This is a static preview of the intended
            GraphQL shape until the hosted node, playground, and testnet soak are validated.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link className="rounded-md border border-[#49EACB]/35 px-4 py-2 text-sm font-semibold text-[#dffcf6]" href="/playground">
            Playground Coming Soon
          </Link>
          <Link className="rounded-md bg-[#49EACB] px-4 py-2 text-sm font-semibold text-[#021110]" href="/docs/tutorial">
            Run Locally
          </Link>
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <CodeBlock code={query} title="graphql preview" />
        <CodeBlock code={response} title="json preview output" />
      </div>
    </section>
  );
}
