"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Notifications } from "@/components/Notifications";

// ── Shared animated background elements ──────────────────────────────────────
function Scanline() {
    return (
        <div className="absolute inset-0 overflow-hidden pointer-events-none rounded-xl">
            <div className="absolute left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" style={{ animation: "scanline 4s linear infinite" }} />
        </div>
    );
}

function GlowBlob({ className }: { className?: string }) {
    return <div className={`absolute rounded-full blur-3xl pointer-events-none ${className}`} style={{ animation: "blobPulse 8s ease-in-out infinite" }} />;
}

// ── Shared Header ────────────────────────────────────────────────────────────
function Header() {
    const [menuOpen, setMenuOpen] = useState(false);
    const [scrolled, setScrolled] = useState(false);
    const pathname = usePathname();

    useEffect(() => {
        const onScroll = () => setScrolled(window.scrollY > 20);
        window.addEventListener("scroll", onScroll);
        return () => window.removeEventListener("scroll", onScroll);
    }, []);

    const navLinks = [
        { name: "Product", href: "/product" },
        { name: "Solutions", href: "/solutions" },
        { name: "Registry", href: "/registry" },
        { name: "Insights", href: "/insights" },
    ];

    return (
        <nav className={`border-b border-primary/10 px-6 lg:px-12 py-5 flex items-center justify-between sticky top-0 z-50 transition-all duration-300 ${scrolled ? "glass-panel shadow-lg shadow-primary/5" : "bg-transparent"}`}>
            <Link href="/" className="flex items-center gap-3">
                <div className="text-primary relative">
                    <span className="material-symbols-outlined text-3xl">deployed_code</span>
                    <span className="absolute inset-0 text-primary opacity-30 blur-sm material-symbols-outlined text-3xl">deployed_code</span>
                </div>
                <span className="text-xl font-bold tracking-tighter uppercase neon-glow">ECO-3D</span>
            </Link>

            <div className="hidden md:flex items-center gap-10">
                {navLinks.map((item) => (
                    <Link key={item.name} href={item.href} className={`text-xs uppercase tracking-widest font-medium transition-colors relative group ${pathname === item.href ? "text-primary font-bold" : "hover:text-primary"}`}>
                        {item.name}
                        <span className={`absolute -bottom-1 left-0 h-px bg-primary transition-all duration-300 ${pathname === item.href ? "w-full" : "w-0 group-hover:w-full"}`} />
                    </Link>
                ))}
            </div>

            <div className="flex items-center gap-6">
                <Notifications />
                <Link href="/login" className="hidden sm:block text-xs uppercase tracking-widest font-bold border-b border-primary/40 pb-1 hover:border-primary transition-all hover:text-primary">Login</Link>
                <Link href="/map" className="bg-primary text-background-dark px-6 py-2.5 rounded-sm font-bold text-xs uppercase tracking-widest hover:brightness-110 hover:shadow-[0_0_20px_rgba(13,242,242,0.4)] transition-all duration-300 animate-glow">
                    Map
                </Link>
                <button className="md:hidden text-primary" onClick={() => setMenuOpen(!menuOpen)}>
                    <span className="material-symbols-outlined">{menuOpen ? "close" : "menu"}</span>
                </button>
            </div>

            {menuOpen && (
                <div className="absolute top-full left-0 right-0 glass-panel border-b border-primary/10 px-6 py-4 flex flex-col gap-4 z-40 md:hidden bg-background-dark/95 backdrop-blur-md">
                    {navLinks.map((item) => (
                        <Link key={item.name} href={item.href} className="text-xs uppercase tracking-widest font-medium hover:text-primary transition-colors" onClick={() => setMenuOpen(false)}>
                            {item.name}
                        </Link>
                    ))}
                </div>
            )}
        </nav>
    );
}

// ── Shared Footer ────────────────────────────────────────────────────────────
function Footer() {
    return (
        <footer className="border-t border-primary/10 px-6 lg:px-12 py-12 glass-panel mt-auto relative z-10 text-white">
            <div className="max-w-screen-2xl mx-auto w-full flex flex-col md:flex-row justify-between items-center gap-8">
                <Link href="/" className="flex items-center gap-3 opacity-50 hover:opacity-100 transition-opacity">
                    <span className="material-symbols-outlined text-primary">deployed_code</span>
                    <span className="text-sm font-bold tracking-tighter uppercase">ECO-3D</span>
                </Link>
                <div className="flex gap-8 text-[10px] uppercase tracking-[0.2em] font-medium text-slate-500">
                    <a href="#" className="hover:text-primary transition-colors">Privacy</a>
                    <a href="#" className="hover:text-primary transition-colors">Terms</a>
                    <a href="#" className="hover:text-primary transition-colors">Status</a>
                </div>
                <div className="text-[10px] uppercase tracking-[0.2em] font-medium text-slate-600">
                    © {new Date().getFullYear()} ECO-3D SPATIAL INTELLIGENCE
                </div>
            </div>
        </footer>
    );
}

// ── INSIGHTS PAGE ────────────────────────────────────────────────────────────
export default function InsightsPage() {
    return (
        <div className="min-h-screen flex flex-col bg-background-dark text-white font-sans relative overflow-hidden">
            <style jsx global>{`
        @keyframes blobPulse { 0%,100%{transform:scale(1) rotate(0deg);opacity:0.15;} 50%{transform:scale(1.2) rotate(180deg);opacity:0.25;} }
        @keyframes scanline { 0%{top:-2px;} 100%{top:100%;} }
      `}</style>

            <div className="fixed inset-0 grid-overlay pointer-events-none z-0" />
            <GlowBlob className="w-80 h-80 bg-purple-500/10 top-1/3 right-1/4" />

            <Header />

            <main className="flex-grow flex flex-col relative z-10 pt-16">
                <section className="px-6 lg:px-12 py-12 max-w-screen-2xl mx-auto w-full">
                    <div className="mb-16 opacity-0 animate-fade-up" style={{ animationDelay: "150ms", animationFillMode: "forwards" }}>
                        <h1 className="text-5xl md:text-8xl font-black uppercase tracking-tighter">
                            Research &amp; <span className="text-primary italic">Intelligence</span>
                        </h1>
                        <p className="text-slate-400 font-light max-w-2xl mt-6 text-lg">
                            Explore global data trends, spatial modeling techniques, and the latest ESG methodologies emerging from the AI architecture landscape.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 pb-20">
                        {[
                            { img: "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&q=80&w=2070", cat: "Urban Architecture", title: "Micro-climates in AI Generated Maps", date: "NOV 12, 2026", d: 300 },
                            { img: "https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&q=80&w=2072", cat: "Space & Satellite", title: "DeepLabV3 optimizations for SAR imagery", date: "FEB 04, 2026", d: 450 },
                            { img: "https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&q=80&w=2069", cat: "ESG Economics", title: "Automated carbon offset modeling", date: "JAN 21, 2026", d: 600 }
                        ].map((article, i) => (
                            <a href="#" key={i} className="group flex flex-col gap-4 opacity-0 animate-fade-up" style={{ animationDelay: `${article.d}ms`, animationFillMode: "forwards" }}>
                                <div className="w-full aspect-video rounded-xl overflow-hidden glass-panel border border-primary/10 relative">
                                    <img src={article.img} className="w-full h-full object-cover mix-blend-luminosity group-hover:scale-105 group-hover:mix-blend-normal transition-all duration-700" alt={article.title} />
                                    <div className="absolute inset-0 bg-primary/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                                </div>
                                <div>
                                    <div className="flex justify-between items-center mb-2">
                                        <span className="text-[10px] uppercase tracking-widest font-bold text-primary">{article.cat}</span>
                                        <span className="text-[10px] font-mono text-slate-500">{article.date}</span>
                                    </div>
                                    <h3 className="text-xl font-bold uppercase tracking-wide group-hover:text-primary transition-colors">{article.title}</h3>
                                </div>
                            </a>
                        ))}
                    </div>
                </section>
            </main>

            <Footer />
        </div>
    );
}
