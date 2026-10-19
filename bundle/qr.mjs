// qr.mjs — bundles the `qrcode` lib to render an SVG QR string (for 2FA setup).
import QRCode from 'qrcode';

export function qrSvg(text, opts) {
  return QRCode.toString(String(text), Object.assign({ type: 'svg', margin: 1, width: 180 }, opts || {}));
}
