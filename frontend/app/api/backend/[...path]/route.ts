import { NextRequest, NextResponse } from "next/server";

const backendUrl = (
  process.env.BACKEND_API_URL || process.env.NEXT_PUBLIC_API_URL || ""
).replace(/\/+$/, "");

type RouteContext = { params: { path: string[] } };

async function proxyRequest(request: NextRequest, context: RouteContext) {
  if (!backendUrl) {
    return NextResponse.json(
      { detail: "Backend API URL is not configured on the server." },
      { status: 503 },
    );
  }

  const path = context.params.path.join("/");
  const target = `${backendUrl}/${path}${request.nextUrl.search}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");

  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer(),
      cache: "no-store",
    });

    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") || "application/json",
      },
    });
  } catch (error) {
    console.error("Backend proxy request failed", error);
    return NextResponse.json(
      { detail: "The backend service is unavailable." },
      { status: 502 },
    );
  }
}

export const GET = proxyRequest;
export const POST = proxyRequest;
export const PUT = proxyRequest;
export const PATCH = proxyRequest;
export const DELETE = proxyRequest;