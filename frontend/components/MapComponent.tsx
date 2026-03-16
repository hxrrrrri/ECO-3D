"use client";

import { useEffect, useRef, useState, useCallback } from "react";

interface MapComponentProps {
  onLocationSelect: (lat: number, lon: number) => void;
  plotBoundary?: number[][] | null;
  selectedLat?: number | null;
  selectedLon?: number | null;
}

export default function MapComponent({
  onLocationSelect, plotBoundary, selectedLat, selectedLon,
}: MapComponentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const polygonRef = useRef<any>(null);
  const LRef = useRef<any>(null);

  // Custom search bar state
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Multi-provider geocoding: Photon (primary, better India/Kerala coverage) + Nominatim fallback
  const doSearch = useCallback(async (q: string) => {
    if (!q.trim() || q.length < 2) { setResults([]); setShowResults(false); return; }
    setSearching(true);
    try {
      // 1. Photon by Komoot — free, no token, much better coverage for Indian colleges/places
      const photonRes = await fetch(
        `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=en`,
        { headers: { "User-Agent": "eco3d-platform/2.0" } }
      );
      let items: { name: string; lat: number; lon: number }[] = [];
      if (photonRes.ok) {
        const photonData = await photonRes.json();
        items = (photonData.features ?? []).map((f: any) => {
          const p = f.properties ?? {};
          const parts = [p.name, p.district, p.city, p.state, p.country].filter(Boolean);
          return {
            name: parts.join(", "),
            lat: f.geometry.coordinates[1] as number,
            lon: f.geometry.coordinates[0] as number,
          };
        });
      }

      // 2. Nominatim fallback — if Photon returns nothing, try OSM Nominatim
      if (items.length === 0) {
        const nomParams = new URLSearchParams({
          q, format: "json", limit: "8",
          "accept-language": "en", addressdetails: "1", dedupe: "1",
        });
        const nomRes = await fetch(
          `https://nominatim.openstreetmap.org/search?${nomParams}`,
          { headers: { "Accept-Language": "en", "User-Agent": "eco3d-platform/2.0" } }
        );
        if (nomRes.ok) {
          const nomData: any[] = await nomRes.json();
          items = nomData.map((r) => ({
            name: r.display_name as string,
            lat: parseFloat(r.lat),
            lon: parseFloat(r.lon),
          }));
        }
      }

      setResults(items);
      setShowResults(true);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const handleSearchInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setQuery(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (v.length >= 2) searchTimer.current = setTimeout(() => doSearch(v), 400);
    else { setResults([]); setShowResults(false); }
  };

  // On result click: ONLY fly map to location, do NOT call onLocationSelect.
  // User must click the exact spot on the map to trigger plot selection.
  const handleSelectResult = (item: { name: string; lat: number; lon: number }) => {
    setQuery(item.name);
    setResults([]);
    setShowResults(false);
    if (mapRef.current) {
      mapRef.current.setView([item.lat, item.lon], 16, { animate: true, duration: 1.2 });
    }
    // ❌ Do NOT call onLocationSelect here — user clicks the exact spot they want
  };

  const handleSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && query.trim()) doSearch(query);
    if (e.key === "Escape") { setShowResults(false); }
  };

  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;

    // Load Leaflet CSS
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css"; link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }

    const timer = setTimeout(() => {
      import("leaflet").then((L) => {
        if (mapRef.current || !containerRef.current) return;
        LRef.current = L;

        delete (L.Icon.Default.prototype as any)._getIconUrl;
        L.Icon.Default.mergeOptions({
          iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
          iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
          shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
        });

        const map = L.map(containerRef.current!, {
          center: [20, 0], zoom: 3, zoomControl: false,
        });

        // Satellite imagery layer
        L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          { attribution: "Tiles © Esri", maxZoom: 19 }
        ).addTo(map);

        // Dark label overlay
        L.tileLayer(
          "https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png",
          { opacity: 0.7, maxZoom: 19 }
        ).addTo(map);

        L.control.zoom({ position: "bottomright" }).addTo(map);

        function placeMarker(lat: number, lng: number) {
          const icon = L.divIcon({
            className: "",
            iconSize: [32, 32],
            iconAnchor: [16, 16],
            html: `
              <div style="position:relative;width:32px;height:32px;">
                <div style="position:absolute;inset:0;border-radius:50%;background:rgba(13,242,242,0.35);animation:eco-ping 1.2s cubic-bezier(0,0,0.2,1) infinite;"></div>
                <div style="position:absolute;inset:6px;border-radius:50%;background:#0df2f2;box-shadow:0 0 14px 4px rgba(13,242,242,0.7);"></div>
              </div>
              <style>@keyframes eco-ping{0%{transform:scale(1);opacity:.75}100%{transform:scale(2.2);opacity:0}}</style>
            `,
          });
          if (markerRef.current) markerRef.current.setLatLng([lat, lng]);
          else markerRef.current = L.marker([lat, lng], { icon }).addTo(map);
        }

        // ✅ Only map clicks trigger onLocationSelect
        map.on("click", (e: any) => {
          const { lat, lng } = e.latlng;
          placeMarker(lat, lng);
          onLocationSelect(lat, lng);
        });

        mapRef.current = map;
      });
    }, 50);

    return () => {
      clearTimeout(timer);
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; markerRef.current = null; polygonRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync view when selectedLat/Lon changes externally
  useEffect(() => {
    if (mapRef.current && selectedLat != null && selectedLon != null) {
      mapRef.current.setView([selectedLat, selectedLon], 17, { animate: true });
    }
  }, [selectedLat, selectedLon]);

  // Draw plot boundary polygon
  useEffect(() => {
    if (!mapRef.current) return;
    import("leaflet").then((L) => {
      if (polygonRef.current) { polygonRef.current.remove(); polygonRef.current = null; }
      if (!plotBoundary || plotBoundary.length < 3) return;
      const latlngs = plotBoundary.map(([lon, lat]) => [lat, lon] as [number, number]);
      polygonRef.current = L.polygon(latlngs, {
        color: "#0df2f2", weight: 2, opacity: 0.9,
        fillColor: "#0df2f2", fillOpacity: 0.1, dashArray: "6 4",
      }).addTo(mapRef.current);
      // Fit with padding but don't over-zoom
      const bounds = polygonRef.current.getBounds();
      mapRef.current.fitBounds(bounds, { padding: [60, 60], maxZoom: 18 });
    });
  }, [plotBoundary]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Leaflet map */}
      <div ref={containerRef} style={{ width: "100%", height: "100%", minHeight: "500px", background: "#0a1a1a" }} />

      {/* Custom search bar — centered top, always above map */}
      <div style={{
        position: "absolute", top: 14, left: "50%", transform: "translateX(-50%)",
        zIndex: 2000, width: "clamp(300px, 40vw, 520px)", pointerEvents: "auto",
      }}>
        <div style={{
          background: "rgba(8,18,18,0.97)", border: "1px solid rgba(13,242,242,0.3)",
          borderRadius: showResults && results.length > 0 ? "10px 10px 0 0" : 10,
          backdropFilter: "blur(20px)", boxShadow: "0 4px 32px rgba(0,0,0,0.6)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(13,242,242,0.65)" strokeWidth="2.2">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={handleSearchInput}
              onKeyDown={handleSearchKey}
              onFocus={() => results.length > 0 && setShowResults(true)}
              placeholder="Search city, address or landmark — then click your exact spot on the map"
              style={{
                flex: 1, background: "transparent", border: "none", outline: "none",
                color: "white", fontSize: 12.5, fontFamily: "'Space Grotesk', sans-serif",
              }}
            />
            {searching && (
              <div style={{ width: 14, height: 14, border: "2px solid rgba(13,242,242,0.2)", borderTop: "2px solid #0df2f2", borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
            )}
            {query && !searching && (
              <button onClick={() => { setQuery(""); setResults([]); setShowResults(false); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#475569", padding: "0 2px", fontSize: 18, lineHeight: 1, flexShrink: 0 }}>×</button>
            )}
          </div>
        </div>

        {/* Results dropdown */}
        {showResults && results.length > 0 && (
          <div style={{
            background: "rgba(8,18,18,0.99)", border: "1px solid rgba(13,242,242,0.2)", borderTop: "none",
            borderRadius: "0 0 10px 10px", maxHeight: 260, overflowY: "auto",
            boxShadow: "0 8px 32px rgba(0,0,0,0.7)",
          }}>
            <div style={{ padding: "6px 16px 4px", fontSize: 9, color: "rgba(13,242,242,0.45)", textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "monospace" }}>
              Results — click to navigate, then click your exact spot on the map
            </div>
            {results.map((item, i) => (
              <button key={i} onClick={() => handleSelectResult(item)} style={{
                width: "100%", display: "flex", alignItems: "flex-start", gap: 10,
                padding: "9px 16px", background: "transparent", border: "none", cursor: "pointer",
                textAlign: "left", borderBottom: i < results.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
              }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(13,242,242,0.07)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(13,242,242,0.5)" strokeWidth="2" style={{ flexShrink: 0, marginTop: 2 }}>
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />
                </svg>
                <span style={{ color: "#cbd5e1", fontSize: 12, fontFamily: "'Space Grotesk', sans-serif", lineHeight: 1.4 }}>{item.name}</span>
              </button>
            ))}
          </div>
        )}

        {showResults && results.length === 0 && !searching && query.length > 2 && (
          <div style={{ background: "rgba(8,18,18,0.99)", border: "1px solid rgba(13,242,242,0.2)", borderTop: "none", borderRadius: "0 0 10px 10px", padding: "12px 16px", color: "#475569", fontSize: 12, fontFamily: "monospace" }}>
            No results found for "{query}"
          </div>
        )}
      </div>

      {/* Satellite badge */}
      <div style={{
        position: "absolute", bottom: 16, left: 16, zIndex: 1000, pointerEvents: "none",
        background: "rgba(10,26,26,0.88)", backdropFilter: "blur(12px)",
        border: "1px solid rgba(13,242,242,0.2)", borderRadius: 8,
        padding: "6px 14px", display: "flex", alignItems: "center", gap: 8,
      }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#0df2f2", boxShadow: "0 0 6px #0df2f2" }} />
        <span style={{ color: "#0df2f2", fontSize: 10, fontFamily: "monospace", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>Satellite View Active</span>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .leaflet-container { background: #0a1a1a !important; }
        .leaflet-control-zoom { border: 1px solid rgba(13,242,242,0.2) !important; border-radius: 8px !important; overflow: hidden; }
        .leaflet-control-zoom a { background: rgba(8,18,18,0.95) !important; color: #0df2f2 !important; border-bottom-color: rgba(13,242,242,0.15) !important; font-size: 16px !important; }
        .leaflet-control-zoom a:hover { background: rgba(13,242,242,0.12) !important; }
        .leaflet-control-attribution { background: rgba(8,18,18,0.85) !important; color: #334155 !important; font-size: 10px !important; }
        .leaflet-control-attribution a { color: #475569 !important; }
      `}</style>
    </div>
  );
}
