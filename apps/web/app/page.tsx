import { NewCrawlForm } from "@/components/NewCrawlForm";
import { LayersIcon, LinkIcon, NetworkIcon } from "@/components/Icons";
import { Card } from "@/components/ui";

const STEPS = [
  { icon: LinkIcon, title: "Enter a website", text: "Pick how many hops deep to follow. We stay on the site you enter." },
  { icon: LayersIcon, title: "Pages are crawled in parallel", text: "Every page is its own job on a queue, so big sites finish fast and nothing is lost if a worker dies." },
  { icon: NetworkIcon, title: "Explore the result", text: "See each page as a tree, with the share of its links that stay on the site." },
];

export default function Home() {
  return (
    <div className="relative">
      <div aria-hidden className="pointer-events-none absolute left-1/2 -top-10 -z-10 h-[420px] w-screen -translate-x-1/2 overflow-hidden">
        <div className="bg-dots absolute inset-0" />
        <div className="absolute left-1/2 top-0 h-72 w-[46rem] -translate-x-1/2 rounded-full blur-3xl" style={{ background: "var(--glow-1)" }} />
        <div className="absolute right-0 top-24 h-56 w-[28rem] rounded-full blur-3xl" style={{ background: "var(--glow-2)" }} />
      </div>

      <section className="animate-fade-up mx-auto max-w-2xl pt-6 text-center sm:pt-12">
        <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/80 px-3 py-1 text-xs font-medium text-muted shadow-sm backdrop-blur">
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
          Domain Link Ratio crawler
        </span>
        <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
          Map any website, <span className="text-gradient">link by link.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-pretty text-lg text-muted">
          Enter a URL. We follow its internal links and report, for every page, how many of its links stay on the site.
        </p>
      </section>

      <Card className="animate-fade-up mx-auto mt-9 max-w-2xl p-5 sm:p-7" style={{ animationDelay: "80ms" }}>
        <NewCrawlForm />
      </Card>

      <section aria-label="How it works" className="mx-auto mt-14 grid max-w-3xl gap-4 sm:grid-cols-3">
        {STEPS.map(({ icon: Icon, title, text }, index) => (
          <div key={title} className="animate-fade-up px-1" style={{ animationDelay: `${160 + index * 70}ms` }}>
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-soft text-primary-ink">
              <Icon size={18} />
            </span>
            <h2 className="mt-3 text-sm font-semibold">{title}</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">{text}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
