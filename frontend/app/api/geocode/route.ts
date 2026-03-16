import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q");
  if (!q || q.trim().length < 2) {
    return NextResponse.json({ features: [] });
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=7&addressdetails=1&accept-language=en`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "eco3d-platform/1.0 (contact@eco3d.app)",
        "Accept-Language": "en",
      },
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      return NextResponse.json({ features: [] }, { status: res.status });
    }

    const data = await res.json();

    const features = (data as any[]).map((item) => ({
      name: item.display_name as string,
      lat: parseFloat(item.lat),
      lon: parseFloat(item.lon),
    }));

    return NextResponse.json({ features });
  } catch {
    return NextResponse.json({ features: [] }, { status: 500 });
  }
}
