/**
 * Render every email template to HTML files you can open in a browser.
 *
 *   pnpm mail:preview              writes to ./email-preview
 *   pnpm mail:preview -- --out /tmp/mail
 *
 * Email is the one surface with no staging environment: once it is sent it
 * is sent, and the only way to know a template looks right is to look at it.
 * Sample payloads live here rather than in the database so this runs without
 * one — on a fresh clone, before any migration.
 *
 * It does NOT send anything. For that, `pnpm mail:sink` writes each delivered
 * message to disk as it arrives, HTML included.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadEnv } from '../src/config/load-env.js';

loadEnv();

const { renderNotificationHtml } = await import('../src/notifications/email-content.js');
// The VALIDATED env, not process.env. `INVOICE_VENDOR_ADDRESS` is stored with
// escaped newlines because dotenv truncates a real multi-line value, and the
// schema is what turns them back — read the raw variable and the preview
// prints a literal backslash-n where the address should be.
const { env } = await import('../src/config/env.js');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const OUT = arg('out') ?? 'email-preview';
mkdirSync(OUT, { recursive: true });

const INVOICE_URL =
  'http://localhost:4000/api/v1/subscription-invoices/3be2ae9d-8acd-4503-8bb4-9e053668633e.pdf' +
  '?token=eyJpIjoiM2JlMmFlOWQtOGFjZC00NTAzLThiYjQtOWUwNTM2Njg2MzNlIiwidCI6Ijk3ZmM2';

// A hospital name with an ampersand, on purpose: it is the shortest way to
// catch an escaping mistake that would otherwise break the markup in
// production and nowhere else.
const HOSPITAL = 'St Mary & Sons School Clinic';

const SAMPLES: Array<{ key: string; subject: string; payload: Record<string, unknown> }> = [
  {
    key: 'subscription_invoice_issued',
    subject: 'Invoice SUB-2026-0005 — TZS 750,000 due 08 Nov 2026',
    payload: {
      invoiceNumber: 'SUB-2026-0005', hospitalName: HOSPITAL, tier: 'standard',
      amount: 'TZS 750,000', dueDate: '08 Nov 2026',
      periodStart: '30 Sept 2026', periodEnd: '30 Oct 2026', invoiceUrl: INVOICE_URL,
    },
  },
  {
    key: 'subscription_payment_received',
    subject: 'Payment received — TZS 200,000 against SUB-2026-0005',
    payload: {
      invoiceNumber: 'SUB-2026-0005', hospitalName: HOSPITAL, amount: 'TZS 200,000',
      method: 'mobile money', reference: 'QGH7X2P1LM', receivedOn: '06 Oct 2026',
      balance: 'TZS 550,000', dueDate: '08 Nov 2026', invoiceUrl: INVOICE_URL,
    },
  },
  {
    key: 'subscription_invoice_settled',
    subject: 'Invoice SUB-2026-0005 paid in full — thank you',
    payload: {
      invoiceNumber: 'SUB-2026-0005', hospitalName: HOSPITAL, amount: 'TZS 750,000',
      method: 'bank transfer', reference: 'CRDB-558812', receivedOn: '07 Oct 2026',
      balance: 'TZS 0', dueDate: '08 Nov 2026', invoiceUrl: INVOICE_URL,
    },
  },
  {
    key: 'subscription_payment_voided',
    subject: 'Correction: TZS 200,000 reversed on SUB-2026-0005',
    payload: {
      invoiceNumber: 'SUB-2026-0005', hospitalName: HOSPITAL, amount: 'TZS 200,000',
      reason: 'Entered against the wrong invoice', balance: 'TZS 750,000',
      dueDate: '08 Nov 2026', invoiceUrl: INVOICE_URL,
    },
  },
  {
    key: 'staff_invitation',
    subject: 'You have been invited',
    payload: {
      fullName: 'Neema Mushi',
      inviteUrl: 'http://localhost:3000/accept-invitation?token=dfwqo_9yTuc4QpXmA2',
    },
  },
  {
    key: 'password_reset',
    subject: 'Reset your password',
    payload: { resetUrl: 'http://localhost:3000/reset-password?token=sLstfUnK8cgSVJaA24' },
  },
  {
    key: 'appointment_reminder',
    subject: 'Your upcoming appointment',
    payload: {
      appointmentDate: 'Tuesday 14 October', appointmentTime: '09:30am',
      providerName: 'Dr Ada Okafor', locationName: 'Mercy General - Main',
    },
  },
  {
    key: 'appointment_confirmation',
    subject: 'Appointment confirmed',
    payload: {
      appointmentDate: 'Tuesday 14 October', appointmentTime: '09:30am',
      providerName: 'Dr Ada Okafor', locationName: 'Mercy General - Main',
    },
  },
];

const links: string[] = [];

for (const sample of SAMPLES) {
  const html = renderNotificationHtml({
    templateKey: sample.key,
    payload: sample.payload,
    subject: sample.subject,
    text: 'Plain-text fallback for this message.',
    tenantName: 'Mercy General Hospital',
    vendorName: env.INVOICE_VENDOR_NAME,
    vendorAddress: env.INVOICE_VENDOR_ADDRESS,
    isTenantOverride: false,
  });

  writeFileSync(`${OUT}/${sample.key}.html`, html);
  links.push(`<li><a href="${sample.key}.html">${sample.key}</a> — ${sample.subject}</li>`);
}

// The fallback path matters as much as the designed ones: it is what a
// hospital's own override of a template renders through.
const fallback = renderNotificationHtml({
  templateKey: 'some_tenant_override',
  payload: {},
  subject: 'A message from the clinic',
  text: 'We have moved to a new building.\n\nThe new address is 4th Floor, Masaki Ikon Building.\n\nDetails: https://example.org/our-new-home',
  tenantName: 'Mercy General Hospital',
  vendorName: env.INVOICE_VENDOR_NAME,
  vendorAddress: env.INVOICE_VENDOR_ADDRESS,
  isTenantOverride: true,
});
writeFileSync(`${OUT}/_fallback.html`, fallback);
links.push('<li><a href="_fallback.html">_fallback</a> — a hospital’s own wording</li>');

writeFileSync(
  `${OUT}/index.html`,
  `<!doctype html><meta charset="utf-8"><title>Email previews</title>
  <body style="font:15px system-ui;padding:32px;max-width:640px;margin:auto;">
  <h1>Email previews</h1><ul style="line-height:2">${links.join('')}</ul></body>`,
);

process.stdout.write(`wrote ${SAMPLES.length + 2} files to ${OUT}/ — open ${OUT}/index.html\n`);
