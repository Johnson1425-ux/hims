/**
 * Assert the Content-Security-Policy a running server actually sends.
 *
 * The policy is deliberately different in the two modes — a nonce in
 * production, 'unsafe-inline' and 'unsafe-eval' in development so that hot
 * reloading works — and that asymmetry is easy to get wrong in the direction
 * that matters: a development convenience left in the production policy is
 * invisible, because the page works either way.
 *
 * Usage:
 *   node scripts/check-csp.mjs http://localhost:3000 development
 *   node scripts/check-csp.mjs http://localhost:3000 production
 */
const [, , url = 'http://localhost:3000', mode = 'production'] = process.argv;

if (mode !== 'development' && mode !== 'production') {
  console.error(`unknown mode "${mode}" — expected development or production`);
  process.exit(2);
}

const response = await fetch(url, { redirect: 'manual' });
const header = response.headers.get('content-security-policy');

if (!header) {
  console.error(`no Content-Security-Policy on ${url} (status ${response.status})`);
  process.exit(1);
}

// Headers.get() joins repeated headers with ", ", and no directive in this
// policy contains a comma — so one here means two CSP headers are being sent.
// Both are enforced, with the strictest reading of each directive winning,
// which breaks the page in a way that looks nothing like a duplicate header.
if (header.includes(',')) {
  console.error('more than one Content-Security-Policy header is being sent:');
  console.error(`  ${header}`);
  process.exit(1);
}

const directives = new Map(
  header.split(';').map((part) => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values];
  }),
);

const scriptSrc = directives.get('script-src') ?? [];
const failures = [];

const has = (token) => scriptSrc.some((value) => value === token);
const hasNonce = scriptSrc.some((value) => value.startsWith("'nonce-"));

if (mode === 'production') {
  if (!hasNonce) failures.push("script-src carries no nonce");
  if (has("'unsafe-inline'")) failures.push("script-src still allows 'unsafe-inline'");
  if (has("'unsafe-eval'")) failures.push("script-src still allows 'unsafe-eval'");
} else {
  // Without these, React Refresh cannot evaluate a module and the dev server
  // reports a CSP violation instead of reloading.
  if (!has("'unsafe-eval'")) failures.push("script-src lacks 'unsafe-eval', so hot reloading will fail");
  if (!has("'unsafe-inline'")) failures.push("script-src lacks 'unsafe-inline'");
}

for (const [name, expected] of [
  ['default-src', "'self'"],
  ['object-src', "'none'"],
  ['frame-ancestors', "'none'"],
  ['base-uri', "'none'"],
  ['form-action', "'self'"],
]) {
  const actual = directives.get(name);
  if (!actual || !actual.includes(expected)) {
    failures.push(`${name} is "${actual?.join(' ') ?? '(absent)'}", expected ${expected}`);
  }
}

if (failures.length > 0) {
  console.error(`CSP check FAILED for ${mode} at ${url}\n`);
  for (const failure of failures) console.error(`  • ${failure}`);
  console.error(`\n  header: ${header}\n`);
  process.exit(1);
}

console.log(`CSP check passed for ${mode} at ${url}`);
console.log(`  script-src ${scriptSrc.join(' ')}`);
