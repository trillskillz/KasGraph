import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="section py-24">
      <div className="panel rounded-lg p-8">
        <p className="mono text-sm uppercase tracking-[0.24em] text-[#49EACB]">404</p>
        <h1 className="mt-4 text-3xl font-semibold">Page not found</h1>
        <p className="mt-3 max-w-2xl text-[#a9bbb7]">
          This route is not part of the KasGraph site yet.
        </p>
        <Link
          className="mt-8 inline-flex rounded-md border border-[#49EACB]/40 px-4 py-2 text-sm font-medium text-[#dffcf6]"
          href="/"
        >
          Back to home
        </Link>
      </div>
    </main>
  );
}
