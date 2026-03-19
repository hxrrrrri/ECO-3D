import Link from "next/link";

export default function DatasetsPage() {
  return (
    <div className="min-h-screen bg-background-dark text-slate-100">
      <div className="fixed inset-0 grid-overlay pointer-events-none z-0" />

      <header className="relative z-10 border-b border-primary/10 glass-panel sticky top-0">
        <div className="max-w-screen-2xl mx-auto px-6 lg:px-12 py-4 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-3 text-white">
            <span className="material-symbols-outlined text-primary text-2xl">deployed_code</span>
            <div>
              <p className="text-sm font-bold tracking-tight uppercase">ECO-3D Datasets</p>
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Live API Inspector</p>
            </div>
          </Link>

          <div className="flex items-center gap-3">
            <Link
              href="/map"
              className="bg-primary text-background-dark px-4 py-2 rounded-sm font-bold text-[11px] uppercase tracking-widest hover:brightness-110 transition-all"
            >
              Launch App
            </Link>
            <Link
              href="/"
              className="border border-primary/20 px-4 py-2 rounded-sm text-[11px] uppercase tracking-widest text-slate-200 hover:border-primary/40 hover:text-primary transition-all"
            >
              Back Home
            </Link>
          </div>
        </div>
      </header>

      <main className="relative z-10 max-w-screen-2xl mx-auto px-6 lg:px-12 py-8">
        <div className="glass-panel rounded-xl border border-primary/15 p-4 md:p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-xl md:text-2xl font-bold uppercase tracking-tight">Datasets Inspector</h1>
            <a
              href="/datasets/eco3d_viewer.html"
              target="_blank"
              rel="noreferrer"
              className="text-[11px] uppercase tracking-widest text-primary hover:underline"
            >
              Open Fullscreen
            </a>
          </div>

          <iframe
            src="/datasets/eco3d_viewer.html"
            title="ECO-3D Datasets Viewer"
            className="w-full h-[80vh] rounded-lg border border-primary/15 bg-[#080808]"
          />
        </div>
      </main>

      <link
        href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200"
        rel="stylesheet"
      />
    </div>
  );
}
