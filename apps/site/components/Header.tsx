import Link from 'next/link';
import { navItems, site } from '@/lib/site';

export function Header() {
  return (
    <header className="section flex items-center justify-between py-5">
      <Link className="flex items-center gap-3" href="/" aria-label="KasGraph home">
        <span className="grid h-9 w-9 place-items-center rounded-lg border border-[#49EACB]/30 bg-[#49EACB]/10">
          <span className="mono text-sm font-bold text-[#49EACB]">KG</span>
        </span>
        <span className="text-sm font-semibold tracking-wide text-[#e7fbf7]">KasGraph</span>
      </Link>
      <nav className="hidden items-center gap-7 text-sm text-[#a9bbb7] md:flex">
        {navItems.map((item) => (
          <Link className="transition hover:text-[#49EACB]" href={item.href} key={item.href}>
            {item.label}
          </Link>
        ))}
      </nav>
      <Link
        className="rounded-md border border-[#49EACB]/35 px-3 py-2 text-sm font-medium text-[#dffcf6] transition hover:border-[#49EACB]/70 hover:bg-[#49EACB]/10"
        href={site.github}
      >
        GitHub
      </Link>
    </header>
  );
}
