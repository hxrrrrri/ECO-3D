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

// ── REGISTRY PAGE ────────────────────────────────────────────────────────────
export default function RegistryPage() {
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    return (
        <div className="min-h-screen flex flex-col bg-background-dark text-white font-sans relative overflow-hidden">
            <style jsx global>{`
        @keyframes blobPulse { 0%,100%{transform:scale(1) rotate(0deg);opacity:0.15;} 50%{transform:scale(1.2) rotate(180deg);opacity:0.25;} }
        @keyframes scanline { 0%{top:-2px;} 100%{top:100%;} }
        @keyframes scrollLedger { 0% { transform: translateY(0); } 100% { transform: translateY(-50%); } }
        .ledger-scroll { animation: scrollLedger 20s linear infinite; }
      `}</style>
            <div className="fixed inset-0 grid-overlay pointer-events-none z-0" />
            <GlowBlob className="w-[500px] h-[500px] bg-primary/10 top-0 left-1/4" />

            <Header />

            <main className="flex-grow flex flex-col relative z-10 pt-16">
                <section className="px-6 lg:px-12 py-12 max-w-screen-2xl mx-auto w-full flex flex-col items-center">
                    <h1 className="text-4xl md:text-5xl lg:text-7xl font-black uppercase tracking-tighter text-center opacity-0 animate-fade-up" style={{ animationDelay: "150ms", animationFillMode: "forwards" }}>
                        The Global <br />
                        <span className="text-primary italic">Land Ledger</span>
                    </h1>
                    <p className="text-slate-400 font-light leading-relaxed max-w-2xl text-center mt-6 mb-16 opacity-0 animate-fade-up" style={{ animationDelay: "250ms", animationFillMode: "forwards" }}>
                        An immutable, globally accessible database of verified spatial analyses and environmental compliance certifications protecting the planet's ecosystems.
                    </p>

                    <div className="w-full glass-panel border border-primary/20 rounded-xl overflow-hidden h-96 relative opacity-0 animate-fade-up neon-border" style={{ animationDelay: "400ms", animationFillMode: "forwards" }}>
                        <div className="absolute top-0 left-0 right-0 bg-background-dark/90 backdrop-blur-md border-b border-primary/10 px-6 py-3 z-20 flex justify-between items-center">
                            <span className="text-xs uppercase font-bold tracking-widest text-primary flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-primary animate-pulse" /> Live Nodes Feed
                            </span>
                            <span className="text-[10px] font-mono text-slate-500">24/7 SYNC ENABLED</span>
                        </div>

                        <div className="absolute inset-0 pt-12 overflow-hidden">
                            <div className="ledger-scroll flex flex-col gap-2 p-6 font-mono text-xs text-slate-400">
                                {/* Simulated Ledger Items */}
                                {mounted && Array.from({ length: 20 }).map((_, i) => {
                                    const hash = Math.random().toString(36).substring(2, 18).toUpperCase();
                                    const lat = (Math.random() * 180 - 90).toFixed(4);
                                    const lon = (Math.random() * 360 - 180).toFixed(4);
                                    return (
                                        <div key={i} className="flex flex-wrap items-center justify-between border-b border-slate-800 pb-2">
                                            <span className="text-primary w-24">TX-{hash.slice(0, 6)}</span>
                                            <span className="text-emerald-500 hidden sm:inline-block w-40">CERT_VERIFIED</span>
                                            <span className="text-white w-32">{lat}°, {lon}°</span>
                                            <span className="text-slate-500 hidden md:inline-block">HASH: {hash}</span>
                                            <span className="text-slate-300 w-20 text-right">#{Math.floor(Math.random() * 9000) + 1000}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                        <Scanline />
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 w-full mt-10 opacity-0 animate-fade-up" style={{ animationDelay: "550ms", animationFillMode: "forwards" }}>
                        {[{ l: "Active Nodes", v: "14,204" }, { l: "Blocks Minted", v: "2.4M" }, { l: "Uptime", v: "99.99%" }, { l: "Total Hectares", v: "84M" }].map((s, i) => (
                            <div key={i} className="glass-panel p-4 text-center rounded-lg border border-primary/5">
                                <span className="block text-xl md:text-2xl font-black text-primary font-mono mb-1">{s.v}</span>
                                <span className="text-[10px] uppercase font-bold tracking-widest text-slate-500">{s.l}</span>
                            </div>
                        ))}
                    </div>
                </section>
            </main>

            <Footer />
        </div>
    );
}
