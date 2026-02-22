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
        <footer className="border-t border-primary/10 px-6 lg:px-12 py-12 glass-panel mt-auto relative z-10">
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

// ── PRODUCT PAGE CONTENT ─────────────────────────────────────────────────────
export default function ProductPage() {
    return (
        <div className="min-h-screen flex flex-col bg-background-dark text-white font-sans relative overflow-hidden">
            <style jsx global>{`
        @keyframes blobPulse { 0%,100%{transform:scale(1) rotate(0deg);opacity:0.15;} 50%{transform:scale(1.2) rotate(180deg);opacity:0.25;} }
        @keyframes scanline { 0%{top:-2px;} 100%{top:100%;} }
        @keyframes float { 0%,100%{transform:translateY(0);} 50%{transform:translateY(-10px);} }
      `}</style>

            <div className="fixed inset-0 grid-overlay pointer-events-none z-0" />
            <GlowBlob className="w-96 h-96 bg-primary/20 top-20 right-1/4" />

            <Header />

            <main className="flex-grow flex flex-col relative z-10">
                <section className="px-6 lg:px-12 pt-24 pb-16 max-w-screen-xl mx-auto w-full text-center">
                    <h1 className="text-5xl md:text-7xl font-black uppercase tracking-tighter mb-6 opacity-0 animate-fade-up" style={{ animationDelay: "100ms", animationFillMode: "forwards" }}>
                        The Spatial <br className="hidden md:block" /> <span className="text-primary italic">Intelligence Engine</span>
                    </h1>
                    <p className="text-lg text-slate-400 max-w-2xl mx-auto font-light leading-relaxed opacity-0 animate-fade-up" style={{ animationDelay: "250ms", animationFillMode: "forwards" }}>
                        Transforming satellite imagery into actionable, generative architectural blueprints via our proprietary 5-layer neural pipeline.
                    </p>
                </section>

                <section className="px-6 lg:px-12 py-12 max-w-screen-2xl mx-auto w-full">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {[
                            { icon: "satellite_alt", title: "Terrain Mapping", desc: "Sub-meter resolution analysis of slope and soil density across 12 bands.", delay: 400 },
                            { icon: "water_drop", title: "Hydrological Forecasting", desc: "XGBoost-powered flood plain simulation adapting to changing climate vectors.", delay: 550 },
                            { icon: "architecture", title: "Generative Floor Plans", desc: "Genetic algorithms optimizing for solar gain, cross-ventilation, and tree preservation.", delay: 700 }
                        ].map((f, i) => (
                            <div key={i} className="glass-panel p-8 rounded-xl border border-primary/20 hover:border-primary/60 hover:shadow-[0_0_30px_rgba(13,242,242,0.15)] transition-all duration-500 opacity-0 animate-fade-up group" style={{ animationDelay: `${f.delay}ms`, animationFillMode: "forwards" }}>
                                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-500">
                                    <span className="material-symbols-outlined text-primary text-2xl">{f.icon}</span>
                                </div>
                                <h3 className="text-lg font-bold uppercase tracking-wider mb-3">{f.title}</h3>
                                <p className="text-sm text-slate-400 leading-relaxed">{f.desc}</p>
                            </div>
                        ))}
                    </div>
                </section>

                <section className="px-6 lg:px-12 py-24 mt-12 border-t border-primary/10">
                    <div className="max-w-4xl mx-auto text-center opacity-0 animate-fade-up" style={{ animationDelay: "300ms", animationFillMode: "forwards" }}>
                        <h2 className="text-3xl font-bold uppercase tracking-tighter mb-8">Deploy on any plot on Earth</h2>
                        <Link href="/map" className="inline-flex items-center justify-center bg-primary text-background-dark px-10 py-5 rounded-sm font-bold text-sm uppercase tracking-[0.15em] hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 gap-3 group hover:shadow-[0_0_30px_rgba(13,242,242,0.4)]">
                            Launch Interactive Map
                            <span className="material-symbols-outlined text-sm group-hover:translate-x-1 transition-transform">arrow_forward_ios</span>
                        </Link>
                    </div>
                </section>
            </main>

            <Footer />
        </div>
    );
}
