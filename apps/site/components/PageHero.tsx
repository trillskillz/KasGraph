type PageHeroProps = {
  eyebrow: string;
  title: string;
  description: string;
};

export function PageHero({ eyebrow, title, description }: Readonly<PageHeroProps>) {
  return (
    <section className="section py-16">
      <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">{eyebrow}</p>
      <h1 className="text-balance mt-5 max-w-4xl text-4xl font-semibold tracking-tight text-[#f3fffc] sm:text-6xl">
        {title}
      </h1>
      <p className="mt-5 max-w-3xl text-lg leading-8 text-[#b7c9c5]">{description}</p>
    </section>
  );
}
