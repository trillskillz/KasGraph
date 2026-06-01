import { BenchmarksTable } from '@/components/BenchmarksTable';
import { PageHero } from '@/components/PageHero';

export default function BenchmarksPage() {
  return (
    <main>
      <PageHero
        eyebrow="benchmarks"
        title="Performance results will be published only after validation."
        description="KasGraph has a public benchmark structure, but real throughput, latency, storage, and soak numbers are pending measurement. No production claims are made from placeholders."
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
