export function StatusBadge({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <span className="mono inline-flex items-center gap-2 rounded-full border border-[#49EACB]/30 bg-[#49EACB]/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-[#9ff4e4]">
      <span className="h-1.5 w-1.5 rounded-full bg-[#49EACB] shadow-[0_0_18px_rgba(73,234,203,0.9)]" />
      {children}
    </span>
  );
}
