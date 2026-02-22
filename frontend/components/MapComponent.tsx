"use client";

import { useEffect, useRef } from "react";
// NOTE: leaflet CSS is injected at runtime — do NOT import it statically here.

interface MapComponentProps {
  onLocationSelect: (lat: number, lon: number) => void;
  plotBoundary?: number[][] | null;
  selectedLat?: number | null;
  selectedLon?: number | null;
}

export default function MapComponent({
  onLocationSelect,
  plotBoundary,
  selectedLat,
  selectedLon,
}: MapComponentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const polygonRef = useRef<any>(null);

  // ── Init map once ────────────────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;

    // Inject Leaflet CSS at runtime (avoids Next.js SSR CSS issues)
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css";
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }

    // Small delay to let CSS load before map init
    const timer = setTimeout(() => {
      import("leaflet").then((L) => {
        if (mapRef.current || !containerRef.current) return;

        // Fix broken default icon paths (Next.js webpack issue)
        delete (L.Icon.Default.prototype as any)._getIconUrl;
        L.Icon.Default.mergeOptions({
          iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
          iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
          shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
        });

        const map = L.map(containerRef.current!, {
          center: [20, 0],
          zoom: 3,
          zoomControl: false,
        });

        // Satellite tiles (ESRI — no API key needed)
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

        map.on("click", (e: any) => {
          const { lat, lng } = e.latlng;

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
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Pan when location changes from outside ────────────────────────────────
  useEffect(() => {
    if (mapRef.current && selectedLat != null && selectedLon != null) {
      mapRef.current.setView([selectedLat, selectedLon], 16, { animate: true });
    }
  }, [selectedLat, selectedLon]);

  // ── Draw plot boundary polygon ────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current) return;
    import("leaflet").then((L) => {
      if (polygonRef.current) {
        polygonRef.current.remove();
        polygonRef.current = null;
      }
      if (!plotBoundary || plotBoundary.length < 3) return;

      // Overpass returns [lon, lat] — Leaflet needs [lat, lng]
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
      {/* Explicit height required — Leaflet will not render without it */}
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", minHeight: "500px", background: "#0a1a1a" }}
      />

      {/* HUD */}
      <div style={{
        position: "absolute", top: 16, left: 16, zIndex: 500, pointerEvents: "none",
        background: "rgba(10,26,26,0.88)", backdropFilter: "blur(12px)",
        border: "1px solid rgba(13,242,242,0.2)", borderRadius: 8,
        padding: "6px 14px", display: "flex", alignItems: "center", gap: 8,
      }}>
        <span style={{
          width: 7, height: 7, borderRadius: "50%", display: "inline-block",
          background: "#0df2f2", animation: "hud-pulse 2s infinite",
        }} />
        <span style={{
          fontSize: 10, fontFamily: "monospace", color: "#0df2f2",
          letterSpacing: "0.15em", textTransform: "uppercase",
        }}>Satellite View Active</span>
      </div>

      <style>{`
        @keyframes hud-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
      `}</style>

    </div>
  );
}
