"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Notifications } from "@/components/Notifications";

// ─── Animated counter hook ───────────────────────────────────────────────────
function useCountUp(target: number, duration = 2000, decimals = 0) {
  const [value, setValue] = useState(0);
  const ref = useRef<boolean>(false);

  useEffect(() => {
    if (ref.current) return;
    ref.current = true;
    const start = Date.now();
    const timer = setInterval(() => {
      const progress = Math.min((Date.now() - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(parseFloat((eased * target).toFixed(decimals)));
      if (progress === 1) clearInterval(timer);
    }, 16);
    return () => clearInterval(timer);
  }, [target, duration, decimals]);

  return value;
}

// ─── Scanline effect ─────────────────────────────────────────────────────────
function Scanline() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none rounded-xl">
      <div
        className="absolute left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent"
        style={{ animation: "scanline 4s linear infinite" }}
      />
      <style jsx>{`
        @keyframes scanline {
          0% { top: -2px; }
          100% { top: 100%; }
        }
      `}</style>
    </div>
  );
}

// ─── Animated blob ────────────────────────────────────────────────────────────
function GlowBlob({ className }: { className?: string }) {
  return (
    <div
      className={`absolute rounded-full blur-3xl pointer-events-none ${className}`}
      style={{ animation: "blobPulse 8s ease-in-out infinite" }}
    />
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────
function StatCard({
  icon,
  label,
  description,
  badge,
  delay,
}: {
  icon: string;
  label: string;
  description: string;
  badge: string;
  delay: number;
}) {
  return (
    <div
      className="p-8 lg:p-12 flex flex-col gap-4 group hover:bg-primary/5 transition-all duration-300 cursor-default opacity-0 animate-fade-up"
      style={{ animationDelay: `${delay}ms`, animationFillMode: "forwards" }}
    >
      <div className="flex justify-between items-start">
        <span className="material-symbols-outlined text-primary text-3xl">{icon}</span>
        <span className="text-xs font-mono text-primary">{badge}</span>
      </div>
      <div>
        <h3 className="text-sm font-bold uppercase tracking-widest mb-1">{label}</h3>
        <p className="text-xs text-slate-500 font-light">{description}</p>
      </div>
    </div>
  );
}

// ─── Feature card ─────────────────────────────────────────────────────────────
function FeatureCard({
  icon,
  title,
  description,
  active,
  delay,
}: {
  icon: string;
  title: string;
  description: string;
  active?: boolean;
  delay: number;
}) {
  return (
    <div
      className={`glass-panel p-8 rounded-lg border-l-2 hover:translate-x-1 transition-all duration-300 cursor-default opacity-0 animate-fade-up ${active ? "border-l-primary" : "border-l-primary/20 hover:border-l-primary"
        }`}
      style={{ animationDelay: `${delay}ms`, animationFillMode: "forwards" }}
    >
      <span className="material-symbols-outlined text-primary mb-4 block">{icon}</span>
      <h4 className="font-bold uppercase tracking-wider text-sm mb-2">{title}</h4>
      <p className="text-xs text-slate-500 leading-relaxed">{description}</p>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function HomePage() {
  const [mounted, setMounted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [contactSent, setContactSent] = useState(false);
  const [contactForm, setContactForm] = useState({ name: "", email: "", company: "", message: "" });
  const bioIntegrity = useCountUp(98.4, 2500, 1);

  useEffect(() => {
    setMounted(true);
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      <style jsx global>{`
        @keyframes blobPulse {
          0%, 100% { transform: scale(1) rotate(0deg); opacity: 0.15; }
          50% { transform: scale(1.2) rotate(180deg); opacity: 0.25; }
        }
        @keyframes ping-slow {
          0% { transform: scale(1); opacity: 0.75; }
          100% { transform: scale(2.5); opacity: 0; }
        }
        .ping-slow {
          animation: ping-slow 2s cubic-bezier(0, 0, 0.2, 1) infinite;
        }
        @keyframes coordScroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .coord-scroll {
          animation: coordScroll 12s linear infinite;
        }
      `}</style>

      {/* ── Background Grid ── */}
      <div className="fixed inset-0 grid-overlay pointer-events-none z-0" />

      {/* ── Ambient Glow Blobs ── */}
      <GlowBlob className="w-96 h-96 bg-primary/20 top-0 right-1/4" />
      <GlowBlob className="w-64 h-64 bg-cyan-500/10 bottom-1/4 left-1/4" />

      <div className="relative z-10 min-h-screen flex flex-col">

        {/* ══════════════════════ NAVIGATION ══════════════════════ */}
        <nav
          className={`border-b border-primary/10 px-6 lg:px-12 py-5 flex items-center justify-between sticky top-0 z-50 transition-all duration-300 ${scrolled ? "glass-panel shadow-lg shadow-primary/5" : "bg-transparent"
            }`}
        >
          <div className="flex items-center gap-3">
            <div className="text-primary relative">
              <span className="material-symbols-outlined text-3xl">deployed_code</span>
              <span className="absolute inset-0 text-primary opacity-30 blur-sm material-symbols-outlined text-3xl">
                deployed_code
              </span>
            </div>
            <span className="text-xl font-bold tracking-tighter uppercase neon-glow">ECO-3D</span>
          </div>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-10">
            {[
              { name: "Product", href: "/product" },
              { name: "Solutions", href: "/solutions" },
              { name: "Registry", href: "/registry" },
              { name: "Insights", href: "/insights" },
            ].map((item) => (
              <Link
                href={item.href}
                key={item.name}
                className="text-xs uppercase tracking-widest font-medium hover:text-primary transition-colors relative group"
              >
                {item.name}
                <span className="absolute -bottom-1 left-0 w-0 h-px bg-primary transition-all duration-300 group-hover:w-full" />
              </Link>
            ))}
          </div>

          <div className="flex items-center gap-6">
            <Notifications />
            <Link href="/login" className="hidden sm:block text-xs uppercase tracking-widest font-bold border-b border-primary/40 pb-1 hover:border-primary transition-all hover:text-primary">
              Login
            </Link>
            <Link
              href="/map"
              className="bg-primary text-background-dark px-6 py-2.5 rounded-sm font-bold text-xs uppercase tracking-widest hover:brightness-110 hover:shadow-[0_0_20px_rgba(13,242,242,0.4)] transition-all duration-300 animate-glow"
            >
              Connect
            </Link>
            {/* Mobile menu */}
            <button
              className="md:hidden text-primary"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <span className="material-symbols-outlined">{menuOpen ? "close" : "menu"}</span>
            </button>
          </div>
        </nav>

        {/* Mobile menu */}
        {menuOpen && (
          <div className="md:hidden glass-panel border-b border-primary/10 px-6 py-4 flex flex-col gap-4 z-40">
            {[
              { name: "Product", href: "/product" },
              { name: "Solutions", href: "/solutions" },
              { name: "Registry", href: "/registry" },
              { name: "Insights", href: "/insights" },
            ].map((item) => (
              <Link
                href={item.href}
                key={item.name}
                className="text-xs uppercase tracking-widest font-medium hover:text-primary transition-colors"
                onClick={() => setMenuOpen(false)}
              >
                {item.name}
              </Link>
            ))}
          </div>
        )}

        {/* ══════════════════════ HERO ══════════════════════ */}
        <main className="flex-grow flex flex-col">
          <section className="relative px-6 lg:px-12 pt-20 pb-12 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center max-w-screen-2xl mx-auto w-full">

            {/* ── Left: Content ── */}
            <div className="lg:col-span-6 flex flex-col gap-8 order-2 lg:order-1">

              {/* Live badge */}
              <div
                className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 w-fit opacity-0 animate-fade-up"
                style={{ animationDelay: "100ms", animationFillMode: "forwards" }}
              >
                <span className="relative flex h-2 w-2">
                  <span className="ping-slow absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
                </span>
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary">
                  v2.0 Global Deployment Live
                </span>
              </div>

              {/* Headline */}
              <h1
                className="text-5xl md:text-7xl font-bold leading-[0.9] tracking-tighter uppercase max-w-xl opacity-0 animate-fade-up"
                style={{ animationDelay: "200ms", animationFillMode: "forwards" }}
              >
                Architecting <br />
                the{" "}
                <span className="text-primary italic relative">
                  Future
                  <span className="absolute inset-0 text-primary/20 blur-md italic">Future</span>
                </span>{" "}
                of Earth
              </h1>

              {/* Subtext */}
              <p
                className="text-lg text-slate-400 max-w-md font-light leading-relaxed opacity-0 animate-fade-up"
                style={{ animationDelay: "350ms", animationFillMode: "forwards" }}
              >
                Harnessing AI-powered spatial intelligence to optimize sustainable land
                development across the globe. Precision data for a greener horizon.
              </p>

              {/* CTA buttons */}
              <div
                className="flex flex-wrap gap-4 pt-4 opacity-0 animate-fade-up"
                style={{ animationDelay: "500ms", animationFillMode: "forwards" }}
              >
                <Link
                  href="/map"
                  className="bg-primary text-background-dark px-10 py-5 rounded-sm font-bold text-sm uppercase tracking-[0.15em] hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 flex items-center gap-3 group hover:shadow-[0_0_30px_rgba(13,242,242,0.4)]"
                >
                  Explore Land
                  <span className="material-symbols-outlined text-sm group-hover:translate-x-1 transition-transform">
                    arrow_forward_ios
                  </span>
                </Link>
                <a
                  href="/docs"
                  className="glass-panel text-white px-10 py-5 rounded-sm font-bold text-sm uppercase tracking-[0.15em] hover:bg-white/5 transition-all duration-200 hover:border-primary/30"
                >
                  Documentation
                </a>
              </div>
            </div>

            {/* ── Right: Hero Visual ── */}
            <div className="lg:col-span-6 order-1 lg:order-2 relative group">
              {/* Glow effect behind image */}
              <div className="absolute -inset-4 bg-primary/20 blur-3xl opacity-20 rounded-full group-hover:opacity-40 transition-opacity duration-700" />

              {/* Image container */}
              <div
                className="relative aspect-square w-full rounded-xl overflow-hidden border border-primary/10 bg-neutral-dark/40 shadow-2xl shadow-primary/5 neon-border opacity-0 animate-fade-up"
                style={{ animationDelay: "300ms", animationFillMode: "forwards" }}
              >
                <img
                  src="https://lh3.googleusercontent.com/aida-public/AB6AXuDVFUNShhraJQj6yfcLMJCBhnuzsN48328ZoWF2i9cl8E92hxgsqZdpamMvp0TqejUAJTjwCG0HxkaVuHV3tx0lv-89xRJ2hpTDqUFplCKNjY0z-85BSitjv855JKL5svnQO0NQQmVyQg0YboNiqnellNldm-Dg_YsOMHEn5_CQwxODAI7tc2qAoNe2-_W9ofsmDlQKREuA2L1RAph8Gv6FMww03Kn-hENeZXAshSVvXuKtYCH1qtUvOZ8ePD0rvnnTj3FgKpg1b4mE"
                  alt="3D Sustainable Architecture"
                  className="w-full h-full object-cover mix-blend-luminosity group-hover:mix-blend-normal transition-all duration-700 scale-105 group-hover:scale-100"
                />

                {/* Scanline overlay */}
                <Scanline />

                {/* HUD: Bio-Integrity */}
                <div className="absolute top-6 left-6">
                  <div className="glass-panel p-3 rounded-lg flex items-center gap-3 backdrop-blur-md">
                    <span className="material-symbols-outlined text-primary text-sm">potted_plant</span>
                    <div className="flex flex-col">
                      <span className="text-[10px] text-slate-400 uppercase font-bold tracking-widest">
                        Bio-Integrity
                      </span>
                      <span className="text-xs font-mono text-white">
                        {mounted ? bioIntegrity.toFixed(1) : "98.4"}%
                      </span>
                    </div>
                  </div>
                </div>

                {/* HUD: Coordinates */}
                <div className="absolute bottom-6 right-6 left-6">
                  <div className="glass-panel px-4 py-2 rounded-full text-[10px] font-mono text-primary flex items-center gap-2 overflow-hidden">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0 animate-pulse" />
                    <div className="overflow-hidden">
                      <span className="whitespace-nowrap coord-scroll inline-block">
                        LIVE_SCANNING_COORDINATES: 34.0522 N, 118.2437 W &nbsp;&nbsp;&nbsp;&nbsp; LIVE_SCANNING_COORDINATES: 34.0522 N, 118.2437 W
                      </span>
                    </div>
                  </div>
                </div>

                {/* Corner decorations */}
                <div className="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 border-primary/60 rounded-tl-xl" />
                <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-primary/60 rounded-tr-xl" />
                <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-primary/60 rounded-bl-xl" />
                <div className="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 border-primary/60 rounded-br-xl" />
              </div>
            </div>
          </section>

          {/* ══════════════════════ STATS BAR ══════════════════════ */}
          <section className="mt-auto border-y border-primary/10 glass-panel">
            <div className="max-w-screen-2xl mx-auto w-full grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-primary/10">
              <StatCard
                icon="analytics"
                label="Data-Driven Insights"
                description="Real-time environmental spatial analysis powered by global neural networks."
                badge="+99%"
                delay={600}
              />
              <StatCard
                icon="eco"
                label="Sustainable Optimization"
                description="AI modeling for carbon neutrality and regenerative land use planning."
                badge="100%"
                delay={750}
              />
              <StatCard
                icon="database"
                label="Global Land Registry"
                description="Secure, decentralized access to the world's most critical land data points."
                badge="24/7"
                delay={900}
              />
            </div>
          </section>
        </main>

        {/* ══════════════════════ INTELLIGENCE GRID ══════════════════════ */}
        <section id="features" className="px-6 lg:px-12 py-24 max-w-screen-2xl mx-auto w-full">
          <div className="flex flex-col lg:flex-row gap-16">

            {/* Left text */}
            <div className="lg:w-1/3">
              <h2
                className="text-3xl font-bold uppercase tracking-tighter mb-6 opacity-0 animate-fade-up"
                style={{ animationDelay: "200ms", animationFillMode: "forwards" }}
              >
                AI-Powered <br /> Land Intelligence
              </h2>
              <p
                className="text-slate-400 font-light mb-8 opacity-0 animate-fade-up"
                style={{ animationDelay: "350ms", animationFillMode: "forwards" }}
              >
                Our platform provides precision-aligned data architecture for a visionary
                future. We map what&apos;s invisible to the human eye.
              </p>
              <div
                className="h-px w-24 bg-primary opacity-0 animate-fade-up"
                style={{ animationDelay: "500ms", animationFillMode: "forwards" }}
              />

              {/* Mini stats */}
              <div
                className="mt-10 flex flex-col gap-4 opacity-0 animate-fade-up"
                style={{ animationDelay: "600ms", animationFillMode: "forwards" }}
              >
                {[
                  { label: "Plots Analyzed", value: "12,847" },
                  { label: "Carbon Offset (tons)", value: "94,210" },
                  { label: "Countries", value: "47" },
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between items-center border-b border-primary/10 pb-3">
                    <span className="text-xs text-slate-500 uppercase tracking-widest">{label}</span>
                    <span className="text-sm font-mono text-primary font-bold">{value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Right: Feature cards */}
            <div className="lg:w-2/3 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FeatureCard
                icon="language"
                title="Global Scale"
                description="Processing terabytes of satellite imagery and IoT sensors across all seven continents daily."
                active
                delay={300}
              />
              <FeatureCard
                icon="security"
                title="Trustless Validation"
                description="Every hectare of land is validated through our immutable ledger for complete transparency."
                delay={400}
              />
              <FeatureCard
                icon="query_stats"
                title="Predictive Yield"
                description="Advanced forecasting models for carbon sequestration and agricultural potential."
                delay={500}
              />
              <FeatureCard
                icon="layers"
                title="Multi-Layer Intelligence"
                description="Stacked data views from subterranean mineral layers to atmospheric quality metrics."
                delay={600}
              />
            </div>
          </div>
        </section>

        {/* ══════════════════════ PIPELINE VISUALIZATION ══════════════════════ */}
        <section className="px-6 lg:px-12 py-16 border-t border-primary/10 max-w-screen-2xl mx-auto w-full">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold uppercase tracking-tighter mb-4">
              5-Layer AI Pipeline
            </h2>
            <p className="text-slate-400 text-sm max-w-xl mx-auto">
              Every analysis runs through our sequential intelligence stack — from raw satellite data to actionable 3D plans.
            </p>
          </div>

          <div className="flex flex-col md:flex-row gap-2 items-stretch">
            {[
              { num: "01", icon: "satellite_alt", title: "Segmentation", sub: "DeepLabV3 + YOLOv8" },
              { num: "02", icon: "eco", title: "Env. Features", sub: "NDVI / DEM / Rain" },
              { num: "03", icon: "water", title: "Flood Risk", sub: "XGBoost Model" },
              { num: "04", icon: "construction", title: "Buildability", sub: "MLP Neural Net" },
              { num: "05", icon: "architecture", title: "Floor Plan", sub: "Genetic Algorithm" },
            ].map((step, i) => (
              <div key={i} className="flex-1 relative group">
                <div className="glass-panel p-6 rounded-lg h-full flex flex-col gap-3 group-hover:bg-primary/5 transition-all duration-300 group-hover:translate-y-[-2px]">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-primary/60">{step.num}</span>
                    <div className="h-px flex-1 bg-primary/20" />
                  </div>
                  <span className="material-symbols-outlined text-primary text-2xl">{step.icon}</span>
                  <div>
                    <h4 className="text-xs font-bold uppercase tracking-wider">{step.title}</h4>
                    <p className="text-[10px] text-slate-500 mt-1">{step.sub}</p>
                  </div>
                </div>
                {/* Arrow connector */}
                {i < 4 && (
                  <div className="hidden md:flex absolute top-1/2 -right-3 z-10 -translate-y-1/2 w-6 h-6 items-center justify-center">
                    <span className="material-symbols-outlined text-primary/40 text-sm">chevron_right</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* ══════════════════════ CTA ══════════════════════ */}
        <section className="px-6 lg:px-12 py-24 border-t border-primary/10">
          <div className="max-w-screen-2xl mx-auto w-full glass-panel p-12 lg:p-20 rounded-xl overflow-hidden relative group text-center flex flex-col items-center neon-border">
            <div className="absolute inset-0 bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

            {/* Background pattern */}
            <div className="absolute inset-0 grid-overlay opacity-50" />

            <h2 className="text-4xl md:text-6xl font-bold uppercase tracking-tighter mb-6 relative z-10">
              Ready to architect <br /> the future?
            </h2>
            <p className="text-slate-400 max-w-lg mb-10 relative z-10">
              Join the global network of sustainable land development. Start your first
              spatial analysis session today.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 relative z-10">
              <Link
                href="/map"
                className="bg-primary text-background-dark px-12 py-4 rounded-sm font-bold text-sm uppercase tracking-widest hover:shadow-[0_0_30px_rgba(13,242,242,0.4)] hover:scale-[1.02] transition-all duration-200"
              >
                Get Started
              </Link>
              <button onClick={() => setContactOpen(true)} className="border border-slate-700 hover:border-primary/50 px-12 py-4 rounded-sm font-bold text-sm uppercase tracking-widest transition-all duration-200 hover:bg-primary/5">
                Contact Sales
              </button>
            </div>
          </div>
        </section>

        {/* ══════════════════════ FOOTER ══════════════════════ */}
        <footer className="border-t border-primary/10 px-6 lg:px-12 py-12 glass-panel mt-auto">
          <div className="max-w-screen-2xl mx-auto w-full flex flex-col md:flex-row justify-between items-center gap-8">
            <div className="flex items-center gap-3 opacity-50">
              <span className="material-symbols-outlined text-primary">deployed_code</span>
              <span className="text-sm font-bold tracking-tighter uppercase">ECO-3D</span>
            </div>
            <div className="flex gap-8 text-[10px] uppercase tracking-[0.2em] font-medium text-slate-500">
              <a href="#" className="hover:text-primary transition-colors">Privacy Policy</a>
              <a href="#" className="hover:text-primary transition-colors">Terms of Service</a>
              <a href="#" className="hover:text-primary transition-colors">System Status</a>
            </div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-medium text-slate-600">
              © 2024 ECO-3D SPATIAL INTELLIGENCE
            </div>
          </div>
        </footer>
      </div>

      {/* Contact Sales Modal */}
      {contactOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)" }}>
          <div className="glass-panel rounded-xl p-8 w-full max-w-md border border-primary/20 relative">
            <button onClick={() => { setContactOpen(false); setContactSent(false); }} className="absolute top-4 right-4 text-slate-400 hover:text-white">
              <span className="material-symbols-outlined">close</span>
            </button>
            {contactSent ? (
              <div className="text-center py-8">
                <span className="material-symbols-outlined text-primary text-5xl mb-4 block">check_circle</span>
                <h3 className="text-2xl font-bold text-white mb-2">Message Sent!</h3>
                <p className="text-slate-400 text-sm">Our sales team will reach out within 24 hours.</p>
                <button onClick={() => { setContactOpen(false); setContactSent(false); }} className="mt-6 bg-primary text-background-dark px-8 py-3 rounded-sm font-bold text-sm uppercase tracking-widest">
                  Close
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 mb-6">
                  <span className="material-symbols-outlined text-primary text-2xl">business</span>
                  <div>
                    <h3 className="text-xl font-bold text-white uppercase tracking-tight">Contact Sales</h3>
                    <p className="text-[11px] text-slate-500 uppercase tracking-widest">ECO-3D Enterprise</p>
                  </div>
                </div>
                <div className="flex flex-col gap-4">
                  {[
                    { label: "Full Name", key: "name", type: "text", placeholder: "Jane Smith" },
                    { label: "Work Email", key: "email", type: "email", placeholder: "jane@company.com" },
                    { label: "Company / Organization", key: "company", type: "text", placeholder: "Acme Architecture" },
                  ].map(({ label, key, type, placeholder }) => (
                    <div key={key}>
                      <label className="text-[11px] text-slate-400 uppercase tracking-widest block mb-1.5">{label}</label>
                      <input
                        type={type}
                        placeholder={placeholder}
                        value={(contactForm as any)[key]}
                        onChange={e => setContactForm(f => ({ ...f, [key]: e.target.value }))}
                        className="w-full rounded-lg px-4 py-3 text-[13px] text-white focus:outline-none focus:border-primary/50 transition-all"
                        style={{ background: "rgba(13,242,242,0.04)", border: "1px solid rgba(13,242,242,0.12)" }}
                      />
                    </div>
                  ))}
                  <div>
                    <label className="text-[11px] text-slate-400 uppercase tracking-widest block mb-1.5">Message</label>
                    <textarea
                      rows={3}
                      placeholder="Tell us about your project and requirements..."
                      value={contactForm.message}
                      onChange={e => setContactForm(f => ({ ...f, message: e.target.value }))}
                      className="w-full rounded-lg px-4 py-3 text-[13px] text-white focus:outline-none resize-none"
                      style={{ background: "rgba(13,242,242,0.04)", border: "1px solid rgba(13,242,242,0.12)" }}
                    />
                  </div>
                  <button
                    onClick={() => { if(contactForm.name && contactForm.email) setContactSent(true); }}
                    className="w-full py-3.5 bg-primary text-background-dark font-bold text-sm uppercase tracking-widest rounded-sm hover:brightness-110 transition-all"
                    style={{ boxShadow: "0 0 20px rgba(13,242,242,0.3)" }}>
                    Send Message
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Material Symbols */}
      <link
        href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200"
        rel="stylesheet"
      />
    </>
  );
}
