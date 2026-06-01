import { PageHero } from '@/components/PageHero';
import { UseCaseGrid } from '@/components/UseCaseGrid';

export default function UseCasesPage() {
  return (
    <main>
      <PageHero
        eyebrow="use cases"
        title="Kaspa application data without rebuilding the indexing layer."
        description="Concrete product surfaces that can use KasGraph once their subgraphs, mappings, and hosted data paths are validated."
      />
      <UseCaseGrid />
    </main>
  );
}
