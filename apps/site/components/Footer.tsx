import Link from 'next/link';
import { navItems, site } from '@/lib/site';

export function Footer() {
  return (
    <footer className="section mt-24 border-t hairline py-10">
      <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-sm font-semibold text-[#e7fbf7]">KasGraph</div>
          <p className="mt-3 max-w-md text-sm leading-6 text-[#8aa29d]">
            Kaspa-native indexing infrastructure for GraphQL, MCP, KasStream, WebSocket
            subscriptions, Postgres entities, and Proof of Indexing.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-x-12 gap-y-3 text-sm text-[#a9bbb7] sm:grid-cols-3">
          {navItems.map((item) => (
            <Link className="transition hover:text-[#49EACB]" href={item.href} key={item.href}>
              {item.label}
            </Link>
          ))}
          <Link className="transition hover:text-[#49EACB]" href={site.github}>
            GitHub
          </Link>
        </div>
      </div>
      <div className="mt-10 flex flex-col gap-3 text-xs text-[#6f8580] sm:flex-row sm:items-center sm:justify-between">
        <span>Copyright 2026 KasGraph. {site.license} licensed.</span>
        <span>Core feature-complete. Hosted validation in progress.</span>
      </div>
    </footer>
  );
}
