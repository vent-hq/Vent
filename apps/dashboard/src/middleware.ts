import { authkitMiddleware } from "@workos-inc/authkit-nextjs";
import { NextFetchEvent, NextRequest, NextResponse } from "next/server";

const middleware = authkitMiddleware({
  redirectUri: process.env["NEXT_PUBLIC_WORKOS_REDIRECT_URI"],
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: ["/", "/auth/callback", "/auth/device", "/backend/:path*"],
  },
});

export default async function wrappedMiddleware(request: NextRequest, event: NextFetchEvent) {
  console.log("[middleware] path:", request.nextUrl.pathname, "origin:", request.nextUrl.origin);
  // Auth not configured — serve the site without auth
  if (!process.env["WORKOS_CLIENT_ID"]) return NextResponse.next();
  const response = await middleware(request, event);
  if (response) {
    response.headers.set("x-pathname", request.nextUrl.pathname);
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health|backend/|.*\\.png$|.*\\.jpg$|.*\\.svg$|.*\\.ico$|.*\\.mp4$).*)",
  ],
};
