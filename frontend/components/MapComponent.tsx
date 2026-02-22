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

  // Custom search bar state
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Photon geocoding search (no CORS issues, no API key)
  const doSearch = useCallback(async (q: string) => {
    if (!q.trim() || q.length < 2) { setResults([]); setShowResults(false); return; }
    setSearching(true);
    try {
      const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en`);
      const data = await res.json();
      const items = (data.features ?? []).map((f: any) => ({
        name: [f.properties.name, f.properties.city, f.properties.country].filter(Boolean).join(", "),
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
      }));
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
    searchTimer.current = setTimeout(() => doSearch(v), 350);
  };

  const handleSelectResult = (item: { name: string; lat: number; lon: number }) => {
    setQuery(item.name);
    setResults([]);
    setShowResults(false);
    if (mapRef.current) {
      mapRef.current.setView([item.lat, item.lon], 16, { animate: true });
    }
    placeMarkerGlobal(item.lat, item.lon);
    onLocationSelect(item.lat, item.lon);
  };

  const handleSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && query.trim()) { doSearch(query); }
    if (e.key === "Escape") { setShowResults(false); }
  };

  // Store placeMarker fn in ref so we can call it from search result handler
  const placeMarkerFnRef = useRef<((lat: number, lon: number) => void) | null>(null);

  const placeMarkerGlobal = (lat: number, lon: number) => {
    if (placeMarkerFnRef.current) placeMarkerFnRef.current(lat, lon);
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

        delete (L.Icon.Default.prototype as any)._getIconUrl;
        L.Icon.Default.mergeOptions({
          iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
          iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
          shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
        });

        const map = L.map(containerRef.current!, {
          center: [20, 0], zoom: 3, zoomControl: false,
        });

        // Satellite imagery
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

        // Define placeMarker function
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
          if (markerRef.current) {
            markerRef.current.setLatLng([lat, lng]);
          } else {
            markerRef.current = L.marker([lat, lng], { icon }).addTo(map);
          }
        }

        // Register global fn ref
        placeMarkerFnRef.current = placeMarker;

        // Click handler
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
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markerRef.current = null;
        polygonRef.current = null;
        placeMarkerFnRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync view to selected lat/lon
  useEffect(() => {
    if (mapRef.current && selectedLat != null && selectedLon != null) {
      mapRef.current.setView([selectedLat, selectedLon], 16, { animate: true });
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
        fillColor: "#0df2f2", fillOpacity: 0.08, dashArray: "6 4",
      }).addTo(mapRef.current);
      mapRef.current.fitBounds(polygonRef.current.getBounds(), { padding: [50, 50] });
    });
  }, [plotBoundary]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* The Leaflet map */}
      <div ref={containerRef} style={{ width: "100%", height: "100%", minHeight: "500px", background: "#0a1a1a" }} />

      {/* Custom search bar — always visible above map */}
      <div style={{
        position: "absolute", top: 14, left: "50%", transform: "translateX(-50%)",
        zIndex: 2000, width: "clamp(280px, 38vw, 500px)", pointerEvents: "auto",
      }}>
        <div style={{
          background: "rgba(8,18,18,0.97)", border: "1px solid rgba(13,242,242,0.3)",
          borderRadius: 10, backdropFilter: "blur(20px)", boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
          overflow: "visible",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(13,242,242,0.7)" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={handleSearchInput}
              onKeyDown={handleSearchKey}
              placeholder="Search any location — city, address, landmark..."
              style={{
                flex: 1, background: "transparent", border: "none", outline: "none",
                color: "white", fontSize: 13, fontFamily: "'Space Grotesk', sans-serif",
              }}
            />
            {searching && (
              <div style={{ width: 14, height: 14, border: "2px solid rgba(13,242,242,0.3)", borderTop: "2px solid #0df2f2", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            )}
            {query && (
              <button onClick={() => { setQuery(""); setResults([]); setShowResults(false); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#475569", padding: 0, fontSize: 16, lineHeight: 1 }}>×</button>
            )}
          </div>

          {/* Results dropdown */}
          {showResults && results.length > 0 && (
            <div style={{ borderTop: "1px solid rgba(13,242,242,0.1)", maxHeight: 240, overflowY: "auto" }}>
              {results.map((item, i) => (
                <button key={i} onClick={() => handleSelectResult(item)} style={{
                  width: "100%", display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 14px",
                  background: "transparent", border: "none", cursor: "pointer", textAlign: "left",
                  borderBottom: i < results.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
                  transition: "background 0.15s",
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
          {showResults && results.length === 0 && !searching && query.length > 1 && (
            <div style={{ padding: "10px 14px", borderTop: "1px solid rgba(13,242,242,0.1)", color: "#475569", fontSize: 12, fontFamily: "monospace" }}>No results found</div>
          )}
        </div>
      </div>

      {/* Satellite Active badge */}
      <div style={{
        position: "absolute", bottom: 16, left: 16, zIndex: 1000, pointerEvents: "none",
        background: "rgba(10,26,26,0.88)", backdropFilter: "blur(12px)",
        border: "1px solid rgba(13,242,242,0.2)", borderRadius: 8,
        padding: "6px 14px", display: "flex", alignItems: "center", gap: 8,
      }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#0df2f2", boxShadow: "0 0 6px #0df2f2" }} />
        <span style={{ color: "#0df2f2", fontSize: 10, fontFamily: "monospace", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
          Satellite View Active
        </span>
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
