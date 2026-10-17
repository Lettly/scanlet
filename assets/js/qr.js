/* Scanlet — QR codes, for handing a session from one device to another.
 *
 * Rendering uses `qrcode-generator` from a CDN, loaded on demand like the other
 * libraries. Reading a code uses the built-in BarcodeDetector where the browser
 * has one (Chrome on Android, for instance); elsewhere we say so and let the
 * user paste the link instead.
 */

const CDN = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';

let loader = null;

async function loadQrLib() {
  if (window.qrcode) return window.qrcode;
  if (!loader) {
    loader = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = CDN;
      script.async = true;
      script.onload = () => resolve(window.qrcode);
      script.onerror = () => reject(new Error('Could not load the QR code library.'));
      document.head.append(script);
    });
  }
  return loader;
}

/**
 * Render `text` as a QR code image.
 * @returns {Promise<{dataUrl:string, modules:number}>}
 */
export async function renderQr(text, { size = 240, ecc = 'M' } = {}) {
  const qrcode = await loadQrLib();
  const qr = qrcode(0, ecc); // 0 = pick the smallest version that fits
  qr.addData(text);
  qr.make();
  const modules = qr.getModuleCount();
  const cellSize = Math.max(2, Math.floor((size - 8) / modules));
  return { dataUrl: qr.createDataURL(cellSize, 2), modules };
}

export const qrReadingSupported = () =>
  typeof window !== 'undefined' && 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);

/**
 * Point the camera at a QR code and return its contents.
 * Resolves with the decoded text, or rejects if nothing is found in time.
 */
export async function readQr({ timeout = 30_000, onFrame } = {}) {
  if (!qrReadingSupported()) throw new Error('This browser cannot read QR codes from the camera.');
  const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
  });
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  await video.play().catch(() => {});

  try {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const found = await detector.detect(video).catch(() => []);
      onFrame?.(found[0]?.rawValue || null);
      if (found.length && found[0].rawValue) return found[0].rawValue;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 180));
    }
    throw new Error('No QR code found. Hold the code steady in the frame and try again.');
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}
