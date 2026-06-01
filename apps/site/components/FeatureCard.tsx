type FeatureCardProps = {
  title: string;
  description: string;
  label?: string;
};

export function FeatureCard({ title, description, label }: Readonly<FeatureCardProps>) {
  return (
    <article className="panel rounded-lg p-5">
      {label ? (
        <div className="mono mb-5 text-xs uppercase tracking-[0.2em] text-[#49EACB]">{label}</div>
      ) : null}
      <h3 className="text-lg font-semibold text-[#eefefa]">{title}</h3>
      <p className="mt-3 text-sm leading-6 text-[#a9bbb7]">{description}</p>
    </article>
  );
}
