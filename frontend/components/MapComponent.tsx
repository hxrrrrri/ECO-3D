"use client";

import { useEffect, useRef } from "react";

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

  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;

    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css";
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }
    if (!document.getElementById("geosearch-css")) {
      const gLink = document.createElement("link");
      gLink.id = "geosearch-css";
      gLink.rel = "stylesheet";
      gLink.href = "https://unpkg.com/leaflet-geosearch@3.11.1/dist/geosearch.css";
      document.head.appendChild(gLink);
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
          center: [20, 0],
          zoom: 3,
          zoomControl: false,
        });

        L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          { attribution: "Tiles © Esri", maxZoom: 19 }
        ).addTo(map);

        L.tileLayer(
          "https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png",
          { opacity: 0.7, maxZoom: 19 }
        ).addTo(map);

        // Zoom control bottom-right
        L.control.zoom({ position: "bottomright" }).addTo(map);

        // GeoSearch — positioned top-center, uses PhotonProvider (no CORS issues)
        import("leaflet-geosearch").then(({ GeoSearchControl, PhotonProvider }) => {
          try {
            // @ts-ignore
            const provider = new PhotonProvider();
            // @ts-ignore
            const searchControl = new GeoSearchControl({
              provider,
              position: "topleft",
              style: "bar",
              showMarker: false,
              showPopup: false,
              autoClose: true,
              retainZoomLevel: false,
              animateZoom: true,
              keepResult: true,
              searchLabel: "Search location (city, address, landmark)...",
            });
            map.addControl(searchControl);

            map.on("geosearch/showlocation", (result: any) => {
              const lat = result.location.y;
              const lng = result.location.x;
              placeMarker(L, map, lat, lng);
              onLocationSelect(lat, lng);
            });
          } catch (e) {
            console.warn("GeoSearch init failed:", e);
          }
        }).catch((e) => console.warn("GeoSearch import failed:", e));

        // Map click handler
        map.on("click", (e: any) => {
          const { lat, lng } = e.latlng;
          placeMarker(L, map, lat, lng);
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

  function placeMarker(L: any, map: any, lat: number, lng: number) {
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

  useEffect(() => {
    if (mapRef.current && selectedLat != null && selectedLon != null) {
      mapRef.current.setView([selectedLat, selectedLon], 16, { animate: true });
    }
  }, [selectedLat, selectedLon]);

  useEffect(() => {
    if (!mapRef.current) return;
    import("leaflet").then((L) => {
      if (polygonRef.current) {
        polygonRef.current.remove();
        polygonRef.current = null;
      }
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
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", minHeight: "500px", background: "#0a1a1a" }}
      />

      {/* Satellite Active HUD badge */}
      <div style={{
        position: "absolute", bottom: 16, left: 16, zIndex: 1000, pointerEvents: "none",
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

        /* ── Leaflet z-index reset so our overlays win ── */
        .leaflet-map-pane      { z-index: 0   !important; }
        .leaflet-tile-pane     { z-index: 200 !important; }
        .leaflet-overlay-pane  { z-index: 400 !important; }
        .leaflet-shadow-pane   { z-index: 500 !important; }
        .leaflet-marker-pane   { z-index: 600 !important; }
        .leaflet-tooltip-pane  { z-index: 650 !important; }
        .leaflet-popup-pane    { z-index: 700 !important; }
        .leaflet-control       { z-index: 800 !important; }
        .leaflet-top, .leaflet-bottom { z-index: 800 !important; }
        .leaflet-tile-pane     { filter: brightness(0.88) saturate(0.72); }
        .leaflet-container     { background: #080e0e !important; }

        /* Zoom buttons */
        .leaflet-control-zoom a {
          background: rgba(10,26,26,0.95) !important;
          color: #0df2f2 !important;
          border-color: rgba(13,242,242,0.25) !important;
        }
        .leaflet-control-zoom a:hover {
          background: rgba(13,242,242,0.12) !important;
        }

        /* GeoSearch bar — dark themed */
        .leaflet-control-geosearch        { z-index: 800 !important; }
        .leaflet-control-geosearch.bar    { width: 320px !important; }
        .leaflet-control-geosearch form   {
          background: rgba(8,18,18,0.97) !important;
          border: 1px solid rgba(13,242,242,0.3) !important;
          border-radius: 10px !important;
          box-shadow: 0 4px 20px rgba(0,0,0,0.6) !important;
          overflow: visible !important;
        }
        .leaflet-control-geosearch form input {
          background: transparent !important;
          color: #e2e8f0 !important;
          font-size: 13px !important;
          border: none !important;
          outline: none !important;
          height: 38px !important;
        }
        .leaflet-control-geosearch form input::placeholder { color: rgba(148,163,184,0.55) !important; }
        .leaflet-control-geosearch form .glass-btn,
        .leaflet-control-geosearch form button {
          background: transparent !important;
          color: #0df2f2 !important;
          border: none !important;
        }
        .leaflet-control-geosearch .results {
          background: rgba(8,18,18,0.98) !important;
          border: 1px solid rgba(13,242,242,0.2) !important;
          border-top: none !important;
          border-radius: 0 0 10px 10px !important;
          color: #e2e8f0 !important;
          max-height: 220px !important;
          overflow-y: auto !important;
        }
        .leaflet-control-geosearch .results > * {
          padding: 9px 14px !important;
          border-bottom: 1px solid rgba(13,242,242,0.06) !important;
          font-size: 12px !important;
          cursor: pointer !important;
        }
        .leaflet-control-geosearch .results > *:hover,
        .leaflet-control-geosearch .results > *.active {
          background: rgba(13,242,242,0.1) !important;
          color: #0df2f2 !important;
        }
      `}</style>
    </div>
  );
}
