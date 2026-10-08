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

/**
 * One payment applied to the invoice, as the customer should see it.
 *
 * Deliberately NOT the console's richer row: that one carries the operator
 * who keyed it in and their internal note, and neither belongs on a document
 * sent to the customer.
 */
export interface InvoicePayment {
  amount_cents: string | number;
  received_on: string | Date;
  method: string;
  reference: string | null;
  voided_at: string | Date | null;
  void_reason: string | null;
}

/**
 * The payments query for the two CUSTOMER-FACING routes.
 *
 * Held here beside the document contract so the hospital's copy of an
 * invoice and the copy reached from an emailed link cannot drift apart, and
 * so neither accidentally grows a column the customer should not see. The
 * console's own loader selects more — who keyed the payment in, and the
 * internal note — because an operator is allowed to see that and a customer
 * is not.
 *
 * Oldest first: this is a history, and a history reads forwards. (The
 * console lists newest first, where the job is "what just happened".)
 */
export const CUSTOMER_INVOICE_PAYMENTS_SQL = `
  SELECT amount_cents, received_on, method, reference, voided_at, void_reason
    FROM subscription_payments
   WHERE invoice_id = $1
   ORDER BY received_on ASC, created_at ASC
`;

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
  /**
   * Every payment recorded against this invoice, voided ones included.
   * Absent means "not loaded", which renders no section — NOT "none were
   * made", which would be a different and much worse document.
   */
  payments?: InvoicePayment[];
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

/** `bank_transfer` is a column name; "Bank transfer" is what a clerk reads. */
const METHOD_LABELS: Record<string, string> = {
  bank_transfer: 'Bank transfer',
  mobile_money: 'Mobile money',
  card: 'Card',
  cheque: 'Cheque',
  cash: 'Cash',
  other: 'Other',
};

function methodLabel(method: string): string {
  return METHOD_LABELS[method] ?? method.replace(/_/g, ' ');
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
  const doc = new PDFDocument({
    size: 'A4',
    margin: 56,
    // Pages are buffered so the footer can be written onto every one of them
    // after the body is laid out — the only point at which the page count is
    // known. An invoice runs to a second page once its payment history is
    // long enough, and the two halves get separated.
    bufferPages: true,
    info: {
      Title: `Invoice ${invoice.invoice_number}`,
      Author: env.INVOICE_VENDOR_NAME,
      Subject: `Subscription ${day(invoice.period_start)} to ${day(invoice.period_end)}`,
    },
  });

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

  /**
   * Break the page when the next block will not fit.
   *
   * Everything below tracks `y` by hand, and a hand-tracked cursor does not
   * get pdfkit's automatic page breaks — it simply draws past the bottom
   * edge and the content is gone. An invoice settled in a dozen instalments
   * is not a hypothetical: that is what a hospital paying monthly against a
   * yearly invoice looks like.
   */
  const bottom = doc.page.height - doc.page.margins.bottom - 28;
  const ensureSpace = (needed: number): boolean => {
    if (y + needed <= bottom) return false;
    doc.addPage();
    y = doc.page.margins.top;
    return true;
  };

  // ---- Totals -------------------------------------------------------------
  const total = (label: string, value: string, emphasis = false) => {
    ensureSpace(emphasis ? 20 : 16);
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

  /* ---- Payments received --------------------------------------------------
   *
   * Itemised, between the total and the balance, because that is where the
   * arithmetic happens: the reader goes total, less these, equals what is
   * owed. A single "Paid" line asked them to take the figure on trust, which
   * is exactly backwards for the one document a customer checks against
   * their own bank statement — the reference on each row is what they match
   * on, and it is the thing they ring up about when it is missing.
   *
   * VOIDED PAYMENTS ARE LISTED, struck through and with their reason. A
   * payment that was applied and then reversed is something the hospital was
   * very likely told about; dropping it silently leaves them with a receipt
   * for money this invoice no longer admits to.
   */
  const payments = invoice.payments ?? [];

  if (payments.length > 0) {
    const dateX = left;
    const methodX = left + width * 0.22;
    const refX = left + width * 0.44;

    const paymentsHeader = (continued: boolean) => {
      doc.moveTo(left, y).lineTo(right, y).strokeColor(RULE).lineWidth(1).stroke();
      y += 10;

      doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED);
      doc.text(continued ? 'PAYMENTS RECEIVED (CONTINUED)' : 'PAYMENTS RECEIVED', dateX, y);
      doc.text('AMOUNT', left, y, { width, align: 'right' });
      y += 14;

      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED);
      doc.text('DATE', dateX, y);
      doc.text('METHOD', methodX, y);
      doc.text('REFERENCE', refX, y, { width: width * 0.3 });
      y += 12;

      doc.moveTo(left, y).lineTo(right, y).strokeColor(RULE).stroke();
      y += 8;
    };

    y += 10;
    // Room for the header and the first two rows, NOT for the whole table.
    // Demanding the lot meant a long history pushed itself wholesale onto a
    // fresh page and left the first one two-thirds empty; a table that does
    // not fit is supposed to flow, and the header repeats where it lands.
    ensureSpace(46 + 2 * 15);
    paymentsHeader(false);

    for (const payment of payments) {
      const voided = Boolean(payment.voided_at);
      if (ensureSpace(voided ? 26 : 15)) paymentsHeader(true);

      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor(voided ? MUTED : INK);

      doc.text(day(payment.received_on), dateX, y, { width: width * 0.2 });
      doc.text(methodLabel(payment.method), methodX, y, { width: width * 0.2 });
      doc.text(payment.reference ?? '—', refX, y, {
        width: width * 0.3,
        ellipsis: true,
        lineBreak: false,
      });

      const amount = money(payment.amount_cents, invoice.currency);
      doc.text(amount, left, y, { width, align: 'right' });

      // pdfkit has no text-decoration, so the rule is drawn. Measured from
      // the real string width rather than assumed, or it strikes thin air.
      if (voided) {
        const amountWidth = doc.widthOfString(amount);
        doc
          .moveTo(right - amountWidth, y + 5)
          .lineTo(right, y + 5)
          .strokeColor(MUTED)
          .lineWidth(0.75)
          .stroke();
        doc.lineWidth(1);

        y += 11;
        doc
          .fontSize(8)
          .fillColor(MUTED)
          .text(
            payment.void_reason ? `voided — ${payment.void_reason}` : 'voided',
            dateX,
            y,
            { width: width * 0.75 },
          );
      }

      y += 15;
    }

    doc.moveTo(left, y).lineTo(right, y).strokeColor(RULE).stroke();
    y += 10;
  }

  if (Number(invoice.amount_paid_cents) > 0) {
    // A plain hyphen, not U+2212 MINUS SIGN. pdfkit's built-in Helvetica is
    // WinAnsi-encoded and has no glyph for it, so it printed as a stray
    // double quote — on the one line of the document that says how much of
    // the bill has already been settled.
    total('Paid', `- ${money(invoice.amount_paid_cents, invoice.currency)}`);
    total('Balance due', money(invoice.balance_cents, invoice.currency), true);
  }

  // ---- How to pay ---------------------------------------------------------
  // Omitted entirely when settled: an invoice marked PAID that still carries
  // bank details invites a second payment.
  if (invoice.status !== 'paid' && invoice.status !== 'void' && env.INVOICE_PAYMENT_DETAILS) {
    y += 20;
    ensureSpace(72);
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

  // ---- Footer, on every page ----------------------------------------------
  // A loose second page has to say which invoice it belongs to, and a reader
  // holding one page has to be able to tell whether they are missing one.
  const pages = doc.bufferedPageRange();
  const generated = day(new Date());

  for (let i = 0; i < pages.count; i += 1) {
    doc.switchToPage(pages.start + i);

    const pageLabel = pages.count > 1 ? ` · page ${i + 1} of ${pages.count}` : '';

    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor(MUTED)
      .text(
        `${env.INVOICE_VENDOR_NAME} · ${invoice.invoice_number} · generated ${generated}${pageLabel}`,
        left,
        doc.page.height - doc.page.margins.bottom - 14,
        { width, align: 'center' },
      );
  }

  doc.flushPages();
  doc.end();
  return done;
}
