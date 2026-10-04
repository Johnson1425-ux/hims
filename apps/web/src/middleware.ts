import { NextResponse, type NextRequest } from 'next/server';

/**
 * The Content-Security-Policy, set per request.
 *
 * It lives here rather than in next.config.ts because the production policy
 * carries a per-response nonce, and a static header cannot. Next reads the
 * nonce out of the CSP on the incoming request and stamps it onto the script
 * tags it emits itself, which is what lets `script-src` drop 'unsafe-inline'
 * — the directive that otherwise makes the whole policy close to decorative,
 * since an injected inline <script> is exactly what it is meant to stop.
 *
 * Development is deliberately looser. React Refresh evaluates module code
 * with eval(), so hot reloading cannot work under a policy without
 * 'unsafe-eval'; webpack's dev runtime also injects inline scripts Next does
 * not nonce. Rather than weaken one policy to cover both, development gets no
 * nonce and the two 'unsafe-*' sources, and production gets the strict one.
 * The asymmetry is the point, so it is asserted in both directions by
 * scripts/check-csp.mjs.
 */
const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';
const isProduction = process.env.NODE_ENV === 'production';

function policy(nonce: string | null): string {
  const scriptSrc = nonce
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`
    : // Hot reloading needs both. Never reached in production.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

  return [
    "default-src 'self'",
    scriptSrc,
    // Inline styles stay allowed: the framework and the design tokens both
    // emit them, and a style injection cannot execute.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    // ws: covers the dev server's hot-reload socket; 'self' alone is accepted
    // for same-origin websockets by current browsers but not by all of them.
    isProduction
      ? `connect-src 'self' ${apiBase}`
      : `connect-src 'self' ${apiBase} ws: wss:`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

export function middleware(request: NextRequest): NextResponse {
  const nonce = isProduction ? crypto.randomUUID().replace(/-/g, '') : null;
  const csp = policy(nonce);

  // Next looks for the nonce on the REQUEST, so it must be set here and not
  // only on the response. x-nonce carries it to the root layout, which has one
  // inline script of its own to apply the stored theme before first paint.
  const headers = new Headers(request.headers);
  headers.set('content-security-policy', csp);
  if (nonce) headers.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // Static assets and images are served straight from disk and carry no
  // scripts, so a per-request policy on them would only cost latency.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
