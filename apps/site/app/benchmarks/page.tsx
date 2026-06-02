import { BenchmarksTable } from '@/components/BenchmarksTable';
import { PageHero } from '@/components/PageHero';
import { getLatestSoakSummary } from '@/lib/soak';

export default function BenchmarksPage() {
  const soak = getLatestSoakSummary();

  return (
    <main>
      <PageHero
        eyebrow="benchmarks"
        title="Performance results will be published only after validation."
        description={
          soak.hasSummary
            ? 'KasGraph has published a real testnet soak artifact. Throughput, latency, storage, and hosted endpoint benchmarks still require repeatable measurement.'
            : 'KasGraph has a public benchmark structure, but real throughput, latency, storage, and soak numbers are pending measurement. No production claims are made from placeholders.'
        }
      />
      <BenchmarksTable />
      <section className="section py-8">
        <div className="panel rounded-lg p-7">
          <h2 className="text-2xl font-semibold text-[#f3fffc]">Validation rule</h2>
          <p className="mt-4 leading-7 text-[#b7c9c5]">
            Production claims will only be added after sustained testnet/mainnet runs with repeatable
            methodology, hosted endpoint metrics, monitoring, logs, and published failure/recovery notes.
          </p>
        </div>
      </section>
    </main>
  );
}
