/**
 * What each email says, as structure rather than as a paragraph of text.
 *
 * The plain-text body in `notification_templates` stays the canonical
 * wording and the fallback that goes in the multipart alternative. This file
 * is the same message expressed as blocks, so the figures can sit in a panel
 * and the link can be a button instead of eighty characters of signed token
 * in the middle of a sentence — which is both unreadable and exactly what a
 * phishing mail looks like.
 *
 * A template with no entry here still sends. It falls back to its plain text
 * poured into the same shell, so a hospital's own override of a template, or
 * any template added later, is never worse off than it was.
 */
import { renderEmail, escapeHtml, type EmailBlock } from './email-layout.js';

/** Whose name is at the top: the software vendor, or the hospital. */
type Brand = 'vendor' | 'tenant';

interface EmailDefinition {
  brand: Brand;
  /** Shown beside the subject in the inbox list. */
  preheader: (p: Payload) => string;
  heading: (p: Payload) => string;
  blocks: (p: Payload) => EmailBlock[];
  footerNote?: string;
}

type Payload = Record<string, unknown>;

/** Reads a payload value as a string, escaped and ready to sit in markup. */
function v(payload: Payload, key: string): string {
  const value = payload[key];
  return value === undefined || value === null ? '' : escapeHtml(String(value));
}

/** The same, unescaped — for an href, which `safeUrl` handles separately. */
function raw(payload: Payload, key: string): string {
  const value = payload[key];
  return value === undefined || value === null ? '' : String(value);
}

const DEFINITIONS: Record<string, EmailDefinition> = {
  /* ---- The vendor billing a hospital ---------------------------------- */

  subscription_invoice_issued: {
    brand: 'vendor',
    preheader: (p) => `${v(p, 'amount')} due ${v(p, 'dueDate')} for ${v(p, 'hospitalName')}.`,
    heading: (p) => `Invoice ${v(p, 'invoiceNumber')}`,
    blocks: (p) => [
      {
        kind: 'paragraph',
        html: `Here is your invoice for ${v(p, 'hospitalName')}, covering the ${v(p, 'tier')} subscription from ${v(p, 'periodStart')} to ${v(p, 'periodEnd')}.`,
      },
      {
        kind: 'facts',
        rows: [
          { label: 'Invoice', value: String(p.invoiceNumber ?? '') },
          { label: 'Period', value: `${String(p.periodStart ?? '')} — ${String(p.periodEnd ?? '')}` },
          { label: 'Due', value: String(p.dueDate ?? '') },
          { label: 'Amount due', value: String(p.amount ?? ''), strong: true },
        ],
      },
      { kind: 'button', label: 'View invoice', href: raw(p, 'invoiceUrl') },
      {
        kind: 'note',
        html: 'The button opens the PDF without signing in, so treat it as you would the invoice itself. It stops working after 90 days — ask us for a new one if you need it after that.',
      },
      {
        kind: 'paragraph',
        html: 'If you have already paid, thank you. A payment can take a day or two to be recorded against your account.',
      },
    ],
  },

  subscription_payment_received: {
    brand: 'vendor',
    preheader: (p) =>
      `${v(p, 'amount')} recorded against ${v(p, 'invoiceNumber')}. ${v(p, 'balance')} still outstanding.`,
    heading: () => 'Payment received',
    blocks: (p) => [
      {
        kind: 'paragraph',
        html: `We have recorded your payment against invoice ${v(p, 'invoiceNumber')} for ${v(p, 'hospitalName')}.`,
      },
      {
        kind: 'facts',
        rows: [
          { label: 'Amount received', value: String(p.amount ?? ''), strong: true },
          { label: 'Received', value: String(p.receivedOn ?? '') },
          { label: 'Method', value: String(p.method ?? '') },
          { label: 'Your reference', value: String(p.reference ?? '') },
          { label: 'Still outstanding', value: `${String(p.balance ?? '')} — due ${String(p.dueDate ?? '')}` },
        ],
      },
      { kind: 'button', label: 'View the invoice', href: raw(p, 'invoiceUrl') },
      {
        kind: 'note',
        html: 'The invoice shows every payment recorded against it. If this does not match your records, reply to this message and we will look into it before anything else happens on the account.',
      },
    ],
  },

  subscription_invoice_settled: {
    brand: 'vendor',
    preheader: (p) => `Invoice ${v(p, 'invoiceNumber')} is paid in full. Nothing further is due.`,
    heading: () => 'Paid in full — thank you',
    blocks: (p) => [
      {
        kind: 'paragraph',
        html: `Invoice ${v(p, 'invoiceNumber')} for ${v(p, 'hospitalName')} is now settled in full.`,
      },
      {
        kind: 'facts',
        rows: [
          { label: 'Amount received', value: String(p.amount ?? ''), strong: true },
          { label: 'Received', value: String(p.receivedOn ?? '') },
          { label: 'Method', value: String(p.method ?? '') },
          { label: 'Your reference', value: String(p.reference ?? '') },
        ],
      },
      { kind: 'button', label: 'Download the receipt', href: raw(p, 'invoiceUrl') },
      {
        kind: 'note',
        html: 'The receipted copy shows every payment against this invoice. If it does not match your records, reply and we will look into it.',
      },
    ],
  },

  subscription_payment_voided: {
    brand: 'vendor',
    preheader: (p) =>
      `${v(p, 'amount')} has been reversed on ${v(p, 'invoiceNumber')}. ${v(p, 'balance')} is now outstanding.`,
    heading: () => 'A payment has been reversed',
    blocks: (p) => [
      {
        kind: 'paragraph',
        html: `A payment recorded against invoice ${v(p, 'invoiceNumber')} for ${v(p, 'hospitalName')} has been taken back off.`,
      },
      {
        kind: 'facts',
        rows: [
          { label: 'Amount reversed', value: String(p.amount ?? ''), strong: true },
          { label: 'Reason', value: String(p.reason ?? '') },
          { label: 'Now outstanding', value: `${String(p.balance ?? '')} — due ${String(p.dueDate ?? '')}` },
        ],
      },
      { kind: 'button', label: 'View the invoice', href: raw(p, 'invoiceUrl') },
      {
        kind: 'note',
        html: 'This usually means a payment was entered incorrectly and is being recorded again correctly. If you were not expecting it, reply to this message before paying anything further.',
      },
    ],
  },

  /* ---- A hospital writing to its own people ---------------------------- */

  staff_invitation: {
    brand: 'tenant',
    preheader: () => 'An account has been created for you. Choose a password to finish setting it up.',
    heading: () => 'You have been invited',
    blocks: (p) => [
      { kind: 'paragraph', html: `Hello ${v(p, 'fullName')},` },
      {
        kind: 'paragraph',
        html: 'An account has been created for you. Choose a password and it is ready to use.',
      },
      { kind: 'button', label: 'Set your password', href: raw(p, 'inviteUrl') },
      { kind: 'note', html: 'The link expires in 7 days and can be used once.' },
    ],
    footerNote:
      'You are receiving this because somebody at your organisation created an account for you. If you were not expecting it, you can ignore this message.',
  },

  password_reset: {
    brand: 'tenant',
    preheader: () => 'Use the button to set a new password. The link expires in one hour.',
    heading: () => 'Reset your password',
    blocks: (p) => [
      { kind: 'paragraph', html: 'Use the button below to set a new password.' },
      { kind: 'button', label: 'Set a new password', href: raw(p, 'resetUrl') },
      {
        kind: 'note',
        html: 'The link expires in one hour and can be used once. If you did not request this, you can ignore this message and your password will stay as it is.',
      },
    ],
  },

  appointment_reminder: {
    brand: 'tenant',
    preheader: (p) => `${v(p, 'appointmentDate')} at ${v(p, 'appointmentTime')}, ${v(p, 'locationName')}.`,
    heading: () => 'Your upcoming appointment',
    blocks: (p) => [
      {
        kind: 'facts',
        rows: [
          { label: 'When', value: `${String(p.appointmentDate ?? '')}, ${String(p.appointmentTime ?? '')}`, strong: true },
          { label: 'With', value: String(p.providerName ?? '') },
          { label: 'Where', value: String(p.locationName ?? '') },
        ],
      },
      {
        kind: 'paragraph',
        html: 'If you can no longer attend, please let us know as early as you can so the slot can be offered to someone else.',
      },
    ],
  },

  appointment_confirmation: {
    brand: 'tenant',
    preheader: (p) => `Confirmed for ${v(p, 'appointmentDate')} at ${v(p, 'appointmentTime')}.`,
    heading: () => 'Appointment confirmed',
    blocks: (p) => [
      {
        kind: 'facts',
        rows: [
          { label: 'When', value: `${String(p.appointmentDate ?? '')}, ${String(p.appointmentTime ?? '')}`, strong: true },
          { label: 'With', value: String(p.providerName ?? '') },
          { label: 'Where', value: String(p.locationName ?? '') },
        ],
      },
    ],
  },
};

/**
 * Anything without a definition, or any template a hospital has overridden
 * with their own wording.
 *
 * Their text is the content; this only supplies the chrome. A bare URL in it
 * becomes a link rather than a button, because this cannot know which of
 * several links is the one being asked for.
 */
function fallbackBlocks(text: string): EmailBlock[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ({
      kind: 'paragraph' as const,
      html: escapeHtml(part)
        .replace(/\n/g, '<br />')
        .replace(
          /(https?:\/\/[^\s<]+)/g,
          (url) => `<a href="${url}" style="color:#1c5cab;word-break:break-all;">${url}</a>`,
        ),
    }));
}

export function renderNotificationHtml(args: {
  templateKey: string | null;
  payload: Record<string, unknown>;
  subject: string | null;
  /** The interpolated plain text, used when there is no structured version. */
  text: string;
  tenantName: string;
  vendorName: string;
  vendorAddress: string;
  /** True when the hospital has overridden this template with its own wording. */
  isTenantOverride: boolean;
}): string {
  const definition = args.templateKey ? DEFINITIONS[args.templateKey] : undefined;

  // A hospital that has written its own wording gets its own wording, not
  // this file's idea of what the message should say.
  const brand: Brand = definition && !args.isTenantOverride ? definition.brand : 'tenant';
  const brandName = brand === 'vendor' ? args.vendorName : args.tenantName || args.vendorName;

  /*
   * A VENDOR email closes with the vendor's registered address, because it
   * is an invoice from a company and that is what an invoice carries. A
   * HOSPITAL's email closes with the hospital, and notes the system it was
   * sent through — a staff invitation signed off with the software vendor's
   * postal address tells the reader their account belongs to the wrong
   * organisation.
   */
  const footerLines =
    brand === 'vendor'
      ? [args.vendorName, ...args.vendorAddress.split('\n').map((line) => line.trim())]
      : [brandName, `Sent via ${args.vendorName}`];

  if (!definition || args.isTenantOverride) {
    return renderEmail({
      brandName,
      preheader: args.subject ?? '',
      heading: args.subject ?? 'A message from your hospital',
      blocks: fallbackBlocks(args.text),
      footerLines,
    });
  }

  return renderEmail({
    brandName,
    preheader: definition.preheader(args.payload),
    heading: definition.heading(args.payload),
    blocks: definition.blocks(args.payload),
    footerNote: definition.footerNote,
    footerLines,
  });
}
