type CodeBlockProps = {
  code: string;
  title?: string;
};

export function CodeBlock({ code, title }: Readonly<CodeBlockProps>) {
  return (
    <div className="code-block rounded-lg">
      {title ? (
        <div className="flex items-center justify-between border-b border-[#70C7BA]/20 px-4 py-3">
          <span className="mono text-xs uppercase tracking-[0.18em] text-[#70C7BA]">{title}</span>
          <span className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[#49EACB]/40" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#70C7BA]/25" />
            <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          </span>
        </div>
      ) : null}
      <pre className="mono text-sm leading-7">
        <code>{code}</code>
      </pre>
    </div>
  );
}
