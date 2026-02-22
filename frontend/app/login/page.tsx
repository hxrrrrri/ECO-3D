"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

function Scanline() {
    return (
        <div className="absolute inset-0 overflow-hidden pointer-events-none rounded-xl">
            <div className="absolute left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" style={{ animation: "scanline 4s linear infinite" }} />
        </div>
    );
}

export default function LoginPage() {
    const router = useRouter();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError("");

        try {
            const res = await fetch("http://localhost:8000/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password }),
            });

            if (!res.ok) {
                throw new Error("Invalid credentials");
            }

            const data = await res.json();
            localStorage.setItem("token", data.access_token);
            localStorage.setItem("user", JSON.stringify(data.user));

            router.push("/map");
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-background-dark text-white font-sans relative overflow-hidden">
            <style jsx global>{`
        @keyframes scanline { 0%{top:-2px;} 100%{top:100%;} }
        @keyframes blobPulse { 0%,100%{transform:scale(1) rotate(0deg);opacity:0.15;} 50%{transform:scale(1.2) rotate(180deg);opacity:0.25;} }
      `}</style>

            <div className="fixed inset-0 grid-overlay pointer-events-none z-0" />
            <div className="absolute rounded-full blur-3xl pointer-events-none w-96 h-96 bg-primary/10 top-1/4 left-1/2 -translate-x-1/2" style={{ animation: "blobPulse 8s ease-in-out infinite" }} />

            <Link href="/" className="absolute top-8 left-8 flex items-center gap-3 opacity-50 hover:opacity-100 transition-opacity z-20">
                <span className="material-symbols-outlined text-primary">arrow_back</span>
                <span className="text-sm font-bold tracking-tighter uppercase">Back to Platform</span>
            </Link>

            <div className="w-full max-w-md relative z-10 opacity-0 animate-fade-up" style={{ animationDelay: "100ms", animationFillMode: "forwards" }}>
                <div className="glass-panel border border-primary/20 rounded-2xl p-8 relative overflow-hidden neon-border">
                    <Scanline />

                    <div className="relative z-10">
                        <div className="flex justify-center mb-8">
                            <div className="text-primary relative group">
                                <span className="material-symbols-outlined text-5xl">deployed_code</span>
                                <span className="absolute inset-0 text-primary opacity-50 blur-md material-symbols-outlined text-5xl group-hover:opacity-100 transition-opacity">deployed_code</span>
                            </div>
                        </div>

                        <h1 className="text-2xl font-black uppercase tracking-widest text-center mb-2">Connect to Node</h1>
                        <p className="text-slate-400 text-xs uppercase tracking-widest text-center mb-8">Secure Authentication Required</p>

                        {error && (
                            <div className="bg-red-500/10 border border-red-500/50 text-red-400 text-xs p-3 rounded mb-6 text-center uppercase tracking-wide">
                                {error}
                            </div>
                        )}

                        <form onSubmit={handleLogin} className="flex flex-col gap-5">
                            <div className="flex flex-col gap-1.5">
                                <label className="text-[10px] uppercase font-bold tracking-widest text-primary ml-1">Operator ID (Email)</label>
                                <input
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className="bg-background-dark/50 border border-primary/20 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all text-white"
                                    placeholder="operator@eco3d.io"
                                    required
                                />
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <label className="text-[10px] uppercase font-bold tracking-widest text-primary ml-1">Access Key</label>
                                <input
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="bg-background-dark/50 border border-primary/20 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all text-white"
                                    placeholder="••••••••"
                                    required
                                />
                            </div>

                            <button
                                type="submit"
                                disabled={loading}
                                className="mt-4 bg-primary text-background-dark py-3 rounded-lg font-bold text-xs uppercase tracking-widest hover:brightness-110 hover:shadow-[0_0_20px_rgba(13,242,242,0.4)] transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed animate-glow"
                            >
                                {loading ? "Authenticating..." : "Initialize Session"}
                            </button>
                        </form>

                        <div className="mt-8 text-center">
                            <span className="text-slate-500 text-xs">Unregistered node?</span>{" "}
                            <Link href="/signup" className="text-primary text-xs font-bold hover:underline transition-all">
                                Request Access
                            </Link>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
