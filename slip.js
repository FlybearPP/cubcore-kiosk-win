// Pickup slip for thermal receipt printers (58 / 80 mm roll).
// Rendered as HTML in a hidden window and sent to the printer silently.

const QRCode = require('qrcode');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function formatTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleString('en-MY', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/**
 * @param {object} slip        payload from the kiosk page (see SlipData in kiosk/page.tsx)
 * @param {58|80} paperWidth   roll width in mm
 */
async function buildSlipHtml(slip, paperWidth = 80) {
  const printable = paperWidth === 58 ? 48 : 72; // printable width in mm
  const qr = slip.qrPayload
    ? await QRCode.toDataURL(slip.qrPayload, { errorCorrectionLevel: 'M', margin: 0, width: 360 })
    : null;

  const ids = (list) =>
    list.map((id) => `<div class="id">${esc(id)}</div>`).join('');

  const title = slip.kind === 'pre_arrival' ? 'NOMBOR PRA-KETIBAAN<br>PRE-ARRIVAL NO.' : 'NOMBOR GILIRAN<br>QUEUE NO.';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { margin: 0; size: ${paperWidth}mm auto; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { width: ${printable}mm; margin: 0 auto; padding: 3mm 0 6mm; font-family: Arial, Helvetica, sans-serif; color: #000; }
    .c { text-align: center; }
    .brand { font-size: ${paperWidth === 58 ? 15 : 18}px; font-weight: 800; }
    .meta { font-size: 11px; margin-top: 1mm; }
    .label { font-size: 11px; font-weight: 700; letter-spacing: 0.5px; margin-top: 4mm; line-height: 1.3; }
    .num { font-size: ${paperWidth === 58 ? 44 : 60}px; font-weight: 900; line-height: 1; margin-top: 1.5mm; }
    .ref { font-family: 'Courier New', monospace; font-size: 11px; margin-top: 1mm; }
    hr { border: 0; border-top: 1px dashed #000; margin: 3.5mm 0; }
    .h { font-size: 11px; font-weight: 800; margin-bottom: 1.5mm; }
    .id { font-family: 'Courier New', monospace; font-size: ${paperWidth === 58 ? 13 : 15}px; font-weight: 700; padding: 0.6mm 0; word-break: break-all; }
    .later { margin-top: 3mm; }
    .qr { margin-top: 1mm; }
    .qr img { width: ${paperWidth === 58 ? 34 : 42}mm; height: auto; image-rendering: pixelated; }
    .code { font-family: 'Courier New', monospace; font-size: 18px; font-weight: 900; letter-spacing: 3px; margin-top: 1.5mm; }
    .note { font-size: 11px; margin-top: 2mm; line-height: 1.35; }
  </style></head><body>
    <div class="c">
      <div class="brand">${esc(slip.tenantName)}</div>
      ${slip.siteName || slip.terminalName
        ? `<div class="meta">${esc([slip.siteName, slip.terminalName].filter(Boolean).join(' · '))}</div>`
        : ''}
      <div class="meta">${esc(formatTime(slip.createdAt))}</div>
      <div class="label">${title}</div>
      <div class="num">${esc(slip.queueNumber)}</div>
      ${slip.displayId ? `<div class="ref">${esc(slip.displayId)}</div>` : ''}
    </div>
    <hr>
    <div class="h">ID PESANAN / ORDER IDS (${slip.orderIds.length})</div>
    ${ids(slip.orderIds)}
    ${slip.laterQueueNumber
      ? `<div class="later"><div class="h">BELUM TIBA / NOT ARRIVED YET — ${esc(slip.laterQueueNumber)}</div>${ids(slip.laterOrderIds || [])}</div>`
      : ''}
    ${qr
      ? `<hr><div class="c">
          <div class="h">TUNJUK KEPADA STAF / SHOW TO STAFF</div>
          <div class="qr"><img src="${qr}"></div>
          <div class="code">${esc(slip.verificationCode || '')}</div>
        </div>`
      : ''}
    <hr>
    <div class="c note">
      ${slip.kind === 'pre_arrival'
        ? 'Staf akan memanggil anda bila bungkusan tiba.<br>Staff will call you when your parcel arrives.'
        : 'Sila tunggu nombor anda dipanggil.<br>Please wait for your number to be called.'}
    </div>
  </body></html>`;
}

module.exports = { buildSlipHtml };
