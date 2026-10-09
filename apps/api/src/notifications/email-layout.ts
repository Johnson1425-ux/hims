/**
 * The HTML shell every outgoing email is poured into.
 *
 * EMAIL HTML IS NOT WEB HTML, and almost everything here is a concession to
 * that rather than a preference:
 *
 *   - Layout is tables with `role="presentation"`, not flex or grid. Outlook
 *     on Windows renders through Word, which has no support for either.
 *   - Every style is inline. Gmail strips <style> in several configurations,
 *     most reliably when a non-Gmail account is read in the Gmail app, and a
 *     stylesheet that vanishes takes the whole design with it. The <style>
 *     block here carries only the dark-mode hints, which are a bonus if they
 *     survive and no loss if they do not.
 *   - The call to action is a table cell with a padded <a> inside it, plus a
 *     VML rectangle for Outlook, which ignores padding on an anchor and would
 *     otherwise render the button as a bare line of text.
 *   - Nothing is fetched. No web fonts, no images, not even a logo: images
 *     are blocked by default in most clients, so a logo-as-image is a broken
 *     icon on first read, and a tracking pixel is not something a hospital
 *     system should be teaching people to accept.
 *
 * The width is 600px because that is what the Outlook reading pane has
 * historically given, and it degrades to full width on a phone.
 */
const BRAND = '#1c5cab';
const INK = '#0d1117';
const INK_SOFT = '#495261';
const INK_MUTED = '#5b6472';
const PAGE = '#f4f6fa';
const CARD = '#ffffff';
const PANEL = '#f6f8fb';
const LINE = '#dfe4ec';

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/**
 * Escape before interpolation, always.
 *
 * These values are hospital names, references off a bank statement and
 * operator-typed reasons. "St Mary & Sons" would otherwise end the attribute
 * it sits in, and a reason containing a < would swallow the rest of the
 * message.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Only http(s) may reach an href.
 *
 * Every URL here is minted by this system, so this is a belt-and-braces
 * guard rather than a live threat — but an href is the one place in an email
 * where a `javascript:` or `data:` value would be worth someone's time.
 */
export function safeUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? escapeHtml(value) : '#';
}

export type EmailBlock =
  | { kind: 'paragraph'; html: string }
  | { kind: 'facts'; rows: Array<{ label: string; value: string; strong?: boolean }> }
  | { kind: 'button'; label: string; href: string }
  | { kind: 'note'; html: string };

function paragraph(html: string): string {
  return `<tr><td style="padding:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:24px;color:${INK_SOFT};">${html}</td></tr>`;
}

function note(html: string): string {
  return `<tr><td style="padding:4px 0 16px 0;font-family:${FONT};font-size:13px;line-height:21px;color:${INK_MUTED};">${html}</td></tr>`;
}

/**
 * The figures an invoice email is actually read for.
 *
 * A reader scanning on a phone wants the amount and the date, and will not
 * find either in a paragraph. Rendered as rows rather than a bordered grid
 * so that a client which drops the background still leaves something
 * legible.
 */
function facts(rows: Array<{ label: string; value: string; strong?: boolean }>): string {
  const cells = rows
    .map(
      (row, index) => `
          <tr>
            <td style="padding:${index === 0 ? '0' : '8px'} 0 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:${INK_MUTED};" width="45%">${escapeHtml(row.label)}</td>
            <td style="padding:${index === 0 ? '0' : '8px'} 0 0 0;font-family:${FONT};font-size:${row.strong ? '16px' : '14px'};line-height:20px;color:${INK};font-weight:${row.strong ? '700' : '600'};" align="right">${escapeHtml(row.value)}</td>
          </tr>`,
    )
    .join('');

  return `<tr><td style="padding:4px 0 20px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PANEL};border:1px solid ${LINE};border-radius:8px;">
      <tr><td style="padding:16px 18px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${cells}</table>
      </td></tr>
    </table>
  </td></tr>`;
}

/**
 * A button that survives Outlook.
 *
 * The VML rectangle needs a fixed pixel width, so it is estimated from the
 * label. Too narrow clips the text in Outlook and nowhere else, which is the
 * sort of thing nobody notices for a year, so the estimate is generous.
 */
function button(label: string, href: string): string {
  const url = safeUrl(href);
  const text = escapeHtml(label);
  const width = Math.max(180, label.length * 10 + 56);

  return `<tr><td style="padding:4px 0 24px 0;">
    <!--[if mso]>
    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
      href="${url}" style="height:46px;v-text-anchor:middle;width:${width}px;" arcsize="14%" stroke="f" fillcolor="${BRAND}">
      <w:anchorlock/>
      <center style="color:#ffffff;font-family:${FONT};font-size:15px;font-weight:bold;">${text}</center>
    </v:roundrect>
    <![endif]-->
    <!--[if !mso]><!-- -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr><td align="center" style="background:${BRAND};border-radius:6px;">
        <a href="${url}" style="display:inline-block;padding:13px 28px;font-family:${FONT};font-size:15px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:6px;">${text}</a>
      </td></tr>
    </table>
    <!--<![endif]-->
  </td></tr>`;
}

function renderBlock(block: EmailBlock): string {
  switch (block.kind) {
    case 'paragraph':
      return paragraph(block.html);
    case 'note':
      return note(block.html);
    case 'facts':
      return facts(block.rows);
    case 'button':
      return button(block.label, block.href);
  }
}

/**
 * Wrap the blocks in the shell.
 *
 * `brandName` is who the mail is FROM as the reader understands it — the
 * vendor for a subscription invoice, the hospital for a shift invitation or
 * an appointment reminder. Getting this wrong is not cosmetic: a patient
 * receiving an appointment reminder footed with the software vendor's name
 * has been told something false about who holds their appointment.
 */
export function renderEmail(args: {
  brandName: string;
  preheader: string;
  heading: string;
  blocks: EmailBlock[];
  footerNote?: string;
  /**
   * Who signs off at the bottom. A hospital's own message must not close
   * with the software vendor's postal address as though the vendor sent
   * it — the reader's relationship is with the hospital.
   */
  footerLines: string[];
}): string {
  const body = args.blocks.map(renderBlock).join('\n');

  // Pads the inbox preview so the first line of the body does not spill into
  // it after the preheader. Zero-width non-joiners, which render as nothing.
  const preheaderPad = '&#847;&zwnj;&nbsp;'.repeat(60);

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<!--
  Pinned to light rather than offering a dark palette. Clients that invert
  do it to the whole message with their own algorithm, and a design that
  half-survives that is worse than one that reads the same everywhere.
-->
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(args.heading)}</title>
<!--[if mso]>
<xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
<![endif]-->
<style>
  /* Progressive enhancement only — nothing above depends on this surviving. */
  @media only screen and (max-width:620px) {
    .hims-card { padding:24px 20px !important; }
    .hims-shell { padding:16px 8px !important; }
  }
  a { color:${BRAND}; }
</style>
</head>
<body style="margin:0;padding:0;background:${PAGE};-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">${escapeHtml(args.preheader)}${preheaderPad}</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PAGE};">
  <tr>
    <td align="center" class="hims-shell" style="padding:32px 16px;">
      <!--
        PERCENTAGE WIDTH WITH A MAX, not a fixed 600. A fixed width does not
        shrink, and on a 380px phone the message simply ran off the side —
        which is most of the audience. Outlook ignores max-width, so it gets
        a fixed-width wrapper of its own through the conditional below.
      -->
      <!--[if mso]>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" align="center"><tr><td>
      <![endif]-->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;max-width:600px;">

        <tr>
          <td style="padding:0 0 16px 4px;font-family:${FONT};font-size:14px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${INK_MUTED};">
            ${escapeHtml(args.brandName)}
          </td>
        </tr>

        <tr>
          <td class="hims-card" style="background:${CARD};border:1px solid ${LINE};border-radius:12px;padding:32px 32px 24px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                <td style="padding:0 0 18px 0;font-family:${FONT};font-size:21px;line-height:29px;font-weight:700;color:${INK};">
                  ${escapeHtml(args.heading)}
                </td>
              </tr>
              ${body}
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:20px 4px 0 4px;font-family:${FONT};font-size:12px;line-height:19px;color:${INK_MUTED};">
            ${args.footerNote ? `${args.footerNote}<br /><br />` : ''}
            ${args.footerLines.map((line) => escapeHtml(line)).join('<br />')}
          </td>
        </tr>

      </table>
      <!--[if mso]>
      </td></tr></table>
      <![endif]-->
    </td>
  </tr>
</table>
</body>
</html>`;
}
