import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900">
      <main className="mx-auto max-w-4xl px-6 py-16">
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
          <h1 className="text-3xl font-semibold tracking-tight">Web Crawl</h1>
          <p className="mt-3 text-zinc-600">
            Crawl a domain or sitemap, track discovered URLs, and inspect statuses, redirects, and canonicals.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              className="inline-flex h-11 items-center justify-center rounded-lg bg-zinc-900 px-5 text-sm font-medium text-white hover:bg-zinc-800"
              href="/crawl"
            >
              Start a crawl
            </Link>
            
          </div>

          
        </div>
      </main>
    </div>
  );
}
