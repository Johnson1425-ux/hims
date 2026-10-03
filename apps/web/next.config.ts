import type { NextConfig } from 'next';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // A shared clinical workstation must not serve the previous user's
          // chart out of the back-forward cache.
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          {
            key: 'Permissions-Policy',
            value: 'geolocation=(), microphone=(), camera=(), payment=()',
          },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Next injects inline hydration scripts; 'unsafe-inline' is
              // scoped to scripts only and should be replaced with a nonce in
              // production via middleware.
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self'",
              `connect-src 'self' ${apiBase}`,
              "frame-ancestors 'none'",
              "base-uri 'none'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default config;
