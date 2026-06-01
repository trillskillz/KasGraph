import { DemoPreview } from '@/components/DemoPreview';
import { PageHero } from '@/components/PageHero';
import { ProofOfLife } from '@/components/ProofOfLife';

export default function DemoPage() {
  return (
    <main>
      <PageHero
        eyebrow="demo"
        title="Demo preview for indexed Kaspa state."
        description="KasGraph does not advertise a public hosted endpoint yet. This page shows the expected local-first query and output shape without claiming production readiness."
      />
      <DemoPreview />
      <ProofOfLife />
    </main>
  );
}
