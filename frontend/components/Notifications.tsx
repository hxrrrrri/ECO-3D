"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Notification {
    id: string;
    title: string;
    message: string;
    type: string;
    is_read: boolean;
    created_at: string;
}

export function Notifications() {
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        fetchNotifications();
        const interval = setInterval(fetchNotifications, 30000); // Check every 30s
        return () => clearInterval(interval);
    }, []);

    const fetchNotifications = async () => {
        try {
            const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
            const res = await fetch(`${apiBase}/notifications`);
            if (res.ok) {
                const data = await res.json();
                setNotifications(data);
            }
        } catch (err) {
            console.error("Failed to fetch notifications", err);
        }
    };

    const markAsRead = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            const _apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
            await fetch(`${_apiBase}/notifications/${id}/read`, {
                method: "POST"
            });
            setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
        } catch (err) {
            console.error("Failed to mark read", err);
        }
    };

    if (!mounted) return null;

    const unreadCount = notifications.filter(n => !n.is_read).length;

    return (
        <div className="relative">
            <button
                className="text-primary hover:text-white transition-colors relative flex items-center justify-center w-10 h-10 rounded-full bg-primary/5 hover:bg-primary/20 border border-primary/20"
                onClick={() => setIsOpen(!isOpen)}
                aria-label="Notifications"
            >
                <span className="material-symbols-outlined text-xl">
                    {unreadCount > 0 ? "notifications_active" : "notifications"}
                </span>

                {unreadCount > 0 && (
                    <span className="absolute top-0 right-0 w-3 h-3 bg-red-500 rounded-full border-2 border-background-dark animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.8)]" />
                )}
            </button>

            {isOpen && (
                <div className="absolute right-0 top-14 w-80 glass-panel border border-primary/20 shadow-2xl shadow-primary/10 rounded-xl overflow-hidden z-50 animate-fade-up" style={{ animationDuration: "200ms" }}>
                    <div className="bg-background-dark/90 px-4 py-3 border-b border-primary/10 flex justify-between items-center">
                        <h3 className="text-sm font-bold uppercase tracking-widest text-white">System Alerts</h3>
                        <span className="text-[10px] text-primary bg-primary/10 px-2 py-0.5 rounded-full">{unreadCount} New</span>
                    </div>

                    <div className="max-h-96 overflow-y-auto">
                        {notifications.length === 0 ? (
                            <div className="p-6 text-center text-slate-500 text-xs">No active alerts</div>
                        ) : (
                            notifications.map((n) => (
                                <div key={n.id} className={`p-4 border-b border-white/5 transition-colors hover:bg-white/5 relative ${!n.is_read ? 'bg-primary/5' : ''}`}>
                                    {!n.is_read && <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary blur-[2px]" />}
                                    <div className="flex justify-between items-start mb-1">
                                        <h4 className={`text-xs font-bold ${!n.is_read ? 'text-white' : 'text-slate-400'}`}>{n.title}</h4>
                                        <span className="text-[9px] text-slate-500 font-mono">
                                            {new Date(n.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                    </div>
                                    <p className="text-[10px] text-slate-400 leading-relaxed mb-3">{n.message}</p>

                                    {!n.is_read && (
                                        <button
                                            onClick={(e) => markAsRead(n.id, e)}
                                            className="text-[9px] uppercase tracking-widest text-primary hover:text-white transition-colors"
                                        >
                                            Acknowledge
                                        </button>
                                    )}
                                </div>
                            ))
                        )}
                    </div>

                    <div className="bg-background-dark/90 px-4 py-2 border-t border-primary/10 text-center">
                        <Link href="/registry" className="text-[10px] uppercase tracking-widest text-slate-500 hover:text-primary transition-colors">
                            View Global Ledger
                        </Link>
                    </div>
                </div>
            )}
        </div>
    );
}
