/**
 * The subscription invoice as a document.
 *
 * GENERATED ON DEMAND, not stored. A subscription invoice is a dozen fields
 * and renders in milliseconds, so keeping a blob in object storage would buy
 * nothing and cost a consistency problem: void an invoice or correct a
 * payment and the stored file is now a lie that someone has already
 * downloaded. Rendering from the row means the document and the ledger can
 * never disagree.
 *
 * It is also deliberately plain. An invoice is read by an accounts clerk
 * reconciling a bank statement and by nobody else, and the things that have
 * to be unmissable are the number, the amount, the due date and the bank
 * details. Everything else is furniture.
 */
import PDFDocument from 'pdfkit';
import { env } from '../../config/env.js';

export interface InvoiceDocument {
  invoice_number: string;
  tier: string;
  period_start: string | Date;
  period_end: string | Date;
  currency: string;
  amount_cents: string | number;
  tax_cents: string | number;
  total_cents: string | number;
  amount_paid_cents: string | number;
  balance_cents: string | number;
  status: string;
  issued_on: string | Date;
  due_on: string | Date;
  notes: string | null;
  tenant_name: string;
  tenant_slug: string;
}

/**
 * Currencies with no minor unit.
 *
 * The same table the UI works from: an amount is an integer of the smallest
 * unit, and for the shilling that unit IS the shilling. Printing
 * "TSh 7,500.00" for 750000 would be wrong by a factor of a hundred, which on
 * an invoice is not a formatting nit.
 */
const ZERO_DECIMAL = new Set(['TZS', 'UGX', 'RWF', 'BIF', 'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XOF', 'XAF']);

function money(minorUnits: string | number, currency: string): string {
  const value = Number(minorUnits);
  const digits = ZERO_DECIMAL.has(currency) ? 0 : 2;
  const amount = value / (digits === 0 ? 1 : 100);

  return `${currency} ${amount.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function day(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#d1d5db';

/**
 * Render to a Buffer.
 *
 * Buffered rather than streamed into the response because the documents are
 * a few kilobytes and buffering lets the route set Content-Length and, more
 * importantly, fail cleanly: a stream that throws halfway has already sent
 * a 200 and half a file.
 */
export async function renderInvoicePdf(invoice: InvoiceDocument): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 56, info: {
    Title: `Invoice ${invoice.invoice_number}`,
    Author: env.INVOICE_VENDOR_NAME,
    Subject: `Subscription ${day(invoice.period_start)} to ${day(invoice.period_end)}`,
  } });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  // ---- Masthead -----------------------------------------------------------
  doc.fillColor(INK).fontSize(20).font('Helvetica-Bold').text(env.INVOICE_VENDOR_NAME, left, 56);

  doc.fontSize(9).font('Helvetica').fillColor(MUTED);
  for (const line of env.INVOICE_VENDOR_ADDRESS.split('\n')) {
    doc.text(line.trim(), { width: width / 2 });
  }

  doc
    .fontSize(22)
    .font('Helvetica-Bold')
    .fillColor(INK)
    .text('INVOICE', left, 58, { width, align: 'right' });

  doc
    .fontSize(10)
    .font('Helvetica')
    .fillColor(MUTED)
    .text(invoice.invoice_number, { width, align: 'right' });

  // A void invoice must say so before anything else on the page, or someone
  // pays it.
  if (invoice.status === 'void') {
    doc
      .fontSize(13)
      .font('Helvetica-Bold')
      .fillColor('#b91c1c')
      .text('VOID — DO NOT PAY', { width, align: 'right' });
  } else if (invoice.status === 'paid') {
    doc
      .fontSize(13)
      .font('Helvetica-Bold')
      .fillColor('#047857')
      .text('PAID IN FULL', { width, align: 'right' });
  }

  doc.moveDown(2);
  const topOfBody = Math.max(doc.y, 150);

  // ---- Who, and when ------------------------------------------------------
  doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED).text('BILL TO', left, topOfBody);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(INK).text(invoice.tenant_name, left, doc.y + 2);
  doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(invoice.tenant_slug);

  const metaX = left + width / 2;
  let metaY = topOfBody;

  const meta = (label: string, value: string, bold = false) => {
    doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED).text(label, metaX, metaY);
    doc
      .fontSize(bold ? 11 : 10)
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fillColor(INK)
      .text(value, metaX, metaY + 10, { width: width / 2, align: 'left' });
    metaY += bold ? 30 : 28;
  };

  meta('ISSUED', day(invoice.issued_on));
  meta('DUE', day(invoice.due_on), invoice.status !== 'paid' && invoice.status !== 'void');

  // ---- The one line -------------------------------------------------------
  let y = Math.max(doc.y, metaY) + 24;

  doc.moveTo(left, y).lineTo(right, y).strokeColor(RULE).lineWidth(1).stroke();
  y += 10;

  doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED);
  doc.text('DESCRIPTION', left, y);
  doc.text('AMOUNT', left, y, { width, align: 'right' });
  y += 16;

  doc.moveTo(left, y).lineTo(right, y).strokeColor(RULE).stroke();
  y += 12;

  const tier = invoice.tier.charAt(0).toUpperCase() + invoice.tier.slice(1);
  doc.fontSize(10).font('Helvetica').fillColor(INK);
  doc.text(`${tier} subscription`, left, y, { width: width * 0.7 });
  doc.text(money(invoice.amount_cents, invoice.currency), left, y, { width, align: 'right' });
  y += 14;

  doc
    .fontSize(9)
    .fillColor(MUTED)
    .text(`${day(invoice.period_start)} — ${day(invoice.period_end)}`, left, y, {
      width: width * 0.7,
    });
  y += 24;

  doc.moveTo(left, y).lineTo(right, y).strokeColor(RULE).stroke();
  y += 12;

  // ---- Totals -------------------------------------------------------------
  const total = (label: string, value: string, emphasis = false) => {
    doc
      .fontSize(emphasis ? 11 : 10)
      .font(emphasis ? 'Helvetica-Bold' : 'Helvetica')
      .fillColor(emphasis ? INK : MUTED)
      .text(label, left + width * 0.5, y, { width: width * 0.25, align: 'right' });
    doc
      .fontSize(emphasis ? 12 : 10)
      .font(emphasis ? 'Helvetica-Bold' : 'Helvetica')
      .fillColor(INK)
      .text(value, left, y, { width, align: 'right' });
    y += emphasis ? 20 : 16;
  };

  total('Subtotal', money(invoice.amount_cents, invoice.currency));
  if (Number(invoice.tax_cents) > 0) total('Tax', money(invoice.tax_cents, invoice.currency));
  total('Total', money(invoice.total_cents, invoice.currency), true);

  if (Number(invoice.amount_paid_cents) > 0) {
    total('Paid', `− ${money(invoice.amount_paid_cents, invoice.currency)}`);
    total('Balance due', money(invoice.balance_cents, invoice.currency), true);
  }

  // ---- How to pay ---------------------------------------------------------
  // Omitted entirely when settled: an invoice marked PAID that still carries
  // bank details invites a second payment.
  if (invoice.status !== 'paid' && invoice.status !== 'void' && env.INVOICE_PAYMENT_DETAILS) {
    y += 20;
    doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED).text('HOW TO PAY', left, y);
    y += 12;
    doc.fontSize(9).font('Helvetica').fillColor(INK);

    for (const line of env.INVOICE_PAYMENT_DETAILS.split('\n')) {
      doc.text(line.trim(), left, y, { width });
      y = doc.y;
    }

    y += 6;
    doc
      .fontSize(9)
      .fillColor(MUTED)
      .text(`Please quote ${invoice.invoice_number} as the payment reference.`, left, y, { width });
  }

  if (invoice.notes) {
    doc.moveDown(1.5);
    doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED).text('NOTES', left, doc.y);
    doc.fontSize(9).font('Helvetica').fillColor(INK).text(invoice.notes, left, doc.y + 2, { width });
  }

  // ---- Footer -------------------------------------------------------------
  doc
    .fontSize(8)
    .font('Helvetica')
    .fillColor(MUTED)
    .text(
      `${env.INVOICE_VENDOR_NAME} · ${invoice.invoice_number} · generated ${day(new Date())}`,
      left,
      doc.page.height - doc.page.margins.bottom - 14,
      { width, align: 'center' },
    );

  doc.end();
  return done;
}
