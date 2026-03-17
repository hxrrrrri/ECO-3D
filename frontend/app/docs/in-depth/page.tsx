import Link from "next/link";

export default function InDepthDocumentationPage() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-background-dark text-slate-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(13,242,242,0.12),transparent_35%),radial-gradient(circle_at_85%_30%,rgba(13,242,242,0.06),transparent_45%)]" />
      <div className="pointer-events-none absolute inset-0 grid-overlay" />

      <header className="sticky top-0 z-20 border-b border-primary/10 bg-background-dark/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between px-4 py-3 sm:px-6">
          <div>
            <h1 className="text-sm font-bold uppercase tracking-[0.14em] text-primary">ECO-3D Documentation</h1>
            <p className="text-xs text-slate-400">In-depth technical reference</p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/docs"
              className="glass-panel rounded-sm border border-primary/20 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-100 transition hover:border-primary/40"
            >
              Documentation
            </Link>
            <Link
              href="/"
              className="bg-primary px-4 py-2 text-[11px] font-bold uppercase tracking-[0.12em] text-background-dark transition hover:opacity-90"
            >
              Home
            </Link>
          </div>
        </div>
      </header>

      <section className="relative z-10 mx-auto w-full max-w-[1400px] px-2 py-2 sm:px-4 sm:py-4">
        <div className="neon-border rounded-md bg-[#080b0b]/80 p-2">
          <iframe
            src="/docs/eco3d_full_documentation.html"
            title="ECO-3D In-depth Documentation"
            className="h-[calc(100vh-118px)] w-full rounded-[6px] border border-primary/15 bg-background-dark"
          />
        </div>
      </section>
    </main>
  );
}