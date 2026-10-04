import type { NextConfig } from 'next';

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
          // Content-Security-Policy is NOT here. The production policy carries a
          // per-response nonce, which a static header cannot, so it is built in
          // src/middleware.ts. Setting one here too would ship two CSP headers,
          // and a browser enforces the intersection of both — the strictest
          // reading of each directive — which breaks the page in ways that look
          // nothing like a duplicated header.
        ],
      },
    ];
  },
};

export default config;
