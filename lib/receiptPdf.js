'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const LOGO_PATH = path.join(__dirname, '..', 'public', 'dist', 'img', 'gxpay-logo.png');

// Matches the brand palette in public/dist/css/gxpay-pos.css - sampled from
// the real GXPAY logo (navy wordmark + coral globe accent). Kept in sync
// manually since the PDF renderer (pdfkit) can't read CSS custom properties.
const COLORS = {
  ink: '#17123f',
  inkSoft: '#5b5680',
  line: '#d8d5e6',
  success: '#0e7c66',
  successTint: '#e4f5ef',
  danger: '#d6483f',
  dangerTint: '#fbeae8',
};

/**
 * Renders a receipt object (the same shape routes/payments.js builds and
 * sends to the browser) as a PDF and returns it as a Buffer.
 */
function renderReceiptPdf(receipt) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [300, 420], margin: 24 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const approved = receipt.status === 'approved';
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;

    // Logo. doc.image() does NOT auto-advance the text cursor the way
    // moveDown() assumes (a common pdfkit gotcha) - track position
    // explicitly here instead of relying on moveDown() after it.
    let y = doc.page.margins.top;
    const LOGO_ASPECT = 305 / 105; // source image is 305x105
    if (fs.existsSync(LOGO_PATH)) {
      const logoWidth = 84;
      const logoHeight = logoWidth / LOGO_ASPECT;
      doc.image(LOGO_PATH, left, y, { width: logoWidth });
      y += logoHeight + 18;
    } else {
      doc.font('Helvetica-Bold').fontSize(16).fillColor(COLORS.ink).text('GXPAY POS', left, y);
      y += 26;
    }

    // Status badge
    const badgeText = approved ? 'APPROVED' : receipt.status.toUpperCase();
    const badgeColor = approved ? COLORS.success : COLORS.danger;
    const badgeBg = approved ? COLORS.successTint : COLORS.dangerTint;
    doc.font('Helvetica-Bold').fontSize(10);
    const badgeWidth = doc.widthOfString(badgeText) + 16;
    const badgeHeight = 20;
    doc.roundedRect(left, y, badgeWidth, badgeHeight, 10).fill(badgeBg);
    doc.fillColor(badgeColor).text(badgeText, left, y + 5, { width: badgeWidth, align: 'center' });
    y += badgeHeight + 16;
    doc.y = y;

    // Row helper - label left, value right, dashed divider beneath
    const rows = [
      ['Merchant', receipt.merchant],
      ['Terminal', receipt.terminalId],
      ['Reference', receipt.reference],
      ['Amount', `${receipt.currency} ${receipt.amount}`],
      ['Card', `${receipt.cardScheme || ''} ${receipt.card}`.trim()],
      ['Entry Mode', receipt.entryMode],
      ['Auth Code', receipt.authCode || '-'],
      ['RRN', receipt.rrn || '-'],
      ['Gateway Ref', receipt.gatewayReference || '-'],
      ['Status', receipt.status.toUpperCase()],
      ['Message', receipt.responseMessage || '-'],
      ['Time', new Date(receipt.timestamp).toLocaleString()],
    ];

    doc.font('Courier').fontSize(9);
    rows.forEach(([label, value]) => {
      const y = doc.y;
      doc.fillColor(COLORS.inkSoft).text(label, doc.page.margins.left, y, { width: width * 0.4, continued: false });
      doc.fillColor(COLORS.ink).text(String(value), doc.page.margins.left + width * 0.4, y, {
        width: width * 0.6,
        align: 'right',
      });
      doc.moveDown(0.15);
      doc
        .strokeColor(COLORS.line)
        .dash(1, { space: 1.5 })
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .stroke();
      doc.undash();
      doc.moveDown(0.35);
    });

    doc.moveDown(1);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLORS.inkSoft)
      .text('GXPAY POS \u00b7 running on a Dspread CR100-SCRP', { align: 'center' });

    doc.end();
  });
}

module.exports = { renderReceiptPdf };
