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

// ── SOLUTIONS PAGE ───────────────────────────────────────────────────────────
export default function SolutionsPage() {
    return (
        <div className="min-h-screen flex flex-col bg-background-dark text-white font-sans relative overflow-hidden">
            <style jsx global>{`
        @keyframes blobPulse { 0%,100%{transform:scale(1) rotate(0deg);opacity:0.15;} 50%{transform:scale(1.2) rotate(180deg);opacity:0.25;} }
        @keyframes scanline { 0%{top:-2px;} 100%{top:100%;} }
      `}</style>
            <div className="fixed inset-0 grid-overlay pointer-events-none z-0" />
            <GlowBlob className="w-80 h-80 bg-blue-500/10 top-1/4 left-1/4" />
            <GlowBlob className="w-96 h-96 bg-primary/20 bottom-1/4 right-0" />
            <Header />

            <main className="flex-grow flex flex-col relative z-10 pt-20">
                <section className="px-6 lg:px-12 py-12 max-w-screen-2xl mx-auto w-full grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
                    <div className="flex flex-col gap-6 order-2 lg:order-1 opacity-0 animate-fade-up" style={{ animationDelay: "150ms", animationFillMode: "forwards" }}>
                        <h1 className="text-4xl md:text-6xl font-black uppercase tracking-tighter">
                            Sector <span className="text-primary italic">Solutions</span>
                        </h1>
                        <p className="text-slate-400 font-light leading-relaxed max-w-lg">
                            Empowering urban planners, government officials, and conservationist engineers with autonomous spatial tools tailored for varying geographical risk domains.
                        </p>
                        <div className="flex gap-4 mt-6">
                            {[{ icon: "domain", p: "Urban Design" }, { icon: "gavel", p: "Govt Planning" }, { icon: "forest", p: "Agri/Conservation" }].map((chip, i) => (
                                <div key={i} className="px-4 py-2 rounded-full border border-primary/20 bg-primary/5 flex items-center gap-2">
                                    <span className="material-symbols-outlined text-[16px] text-primary">{chip.icon}</span>
                                    <span className="text-[10px] uppercase font-bold tracking-widest">{chip.p}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="order-1 lg:order-2 opacity-0 animate-fade-up relative" style={{ animationDelay: "300ms", animationFillMode: "forwards" }}>
                        <div className="aspect-video bg-black/50 border border-primary/20 overflow-hidden rounded-xl relative group neon-border">
                            <img src="https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?q=80&w=2070" className="w-full h-full object-cover mix-blend-luminosity opacity-40 group-hover:opacity-60 transition-opacity duration-700" alt="Urban planning city grid" />
                            <Scanline />
                            <div className="absolute inset-0 bg-gradient-to-t from-background-dark via-transparent to-transparent" />
                        </div>
                    </div>
                </section>

                <section className="px-6 lg:px-12 py-16 mt-12 bg-black/40 border-y border-primary/10">
                    <div className="max-w-screen-2xl mx-auto w-full grid grid-cols-1 md:grid-cols-3 gap-10">
                        {[
                            { label: "Real Estate Developers", desc: "Automate feasibility studies and plot yield forecasting down to the nearest centimeter, minimizing environmental impact while maximizing layout.", c: "text-amber-500", icon: "precision_manufacturing" },
                            { label: "Civil Engineering", desc: "Instantly cross-reference structural foundations against historical flood zones, 3D soil composition topographies, and wind loads.", c: "text-blue-500", icon: "engineering" },
                            { label: "Carbon Accounting", desc: "Leverage global baseline offsets and tree-canopy tracking to issue verifiable ESG credits automatically to builders.", c: "text-emerald-500", icon: "compost" }
                        ].map((sol, i) => (
                            <div key={i} className="flex flex-col gap-4 opacity-0 animate-fade-up group" style={{ animationDelay: `${400 + i * 150}ms`, animationFillMode: "forwards" }}>
                                <span className={`material-symbols-outlined text-4xl ${sol.c} drop-shadow-[0_0_10px_rgba(255,255,255,0.2)] group-hover:drop-shadow-[0_0_20px_rgba(13,242,242,0.4)] transition-all`}>{sol.icon}</span>
                                <h4 className="font-bold uppercase tracking-widest border-b border-primary/20 pb-3 mt-4">{sol.label}</h4>
                                <p className="text-slate-400 text-sm leading-relaxed">{sol.desc}</p>
                            </div>
                        ))}
                    </div>
                </section>
            </main>

            <Footer />
        </div>
    );
}
