/* Scanlet — camera capture.
 *
 * Uses getUserMedia for frames and the same edge detector as the editor to
 * suggest a page outline, slowly, while the preview is live.
 */

import { createCanvas, ctx2d, canvasToBlob, clamp } from './util.js';
import { detectDocumentCorners } from './imaging.js';

export class CameraCapture {
  constructor(video, { overlay = null } = {}) {
    this.video = video;
    this.overlay = overlay;
    this.stream = null;
    this.track = null;
    this.detectTimer = null;
    this.suggested = null;
    this.deviceId = null;
  }

  get active() {
    return Boolean(this.stream);
  }

  async listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput' && d.deviceId);
  }

  async start({ deviceId = null, idealWidth = 1920, facingMode = 'environment' } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot reach a camera over a secure context.');
    }
    this.stop();
    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: idealWidth }, height: { ideal: idealWidth } }
        : { facingMode: { ideal: facingMode }, width: { ideal: idealWidth }, height: { ideal: idealWidth } },
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (!deviceId) throw err;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: idealWidth }, height: { ideal: idealWidth } },
      });
    }
    this.stream = stream;
    this.track = stream.getVideoTracks()[0] || null;
    this.deviceId = this.track?.getSettings?.().deviceId || deviceId;
    this.video.srcObject = stream;
    await this.video.play().catch(() => {});
    await new Promise((resolve) => {
      if (this.video.videoWidth) return resolve();
      this.video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    });
    return this.track?.getSettings?.() || {};
  }

  stop() {
    this.stopDetection();
    this.suggested = null;
    this.clearOverlay();
    if (this.stream) for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
    this.track = null;
    this.video.srcObject = null;
  }

  /** Current frame as a canvas at native camera resolution. */
  grab() {
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (!width || !height) throw new Error('The camera has not produced a frame yet.');
    const canvas = createCanvas(width, height);
    const ctx = ctx2d(canvas);
    ctx.drawImage(this.video, 0, 0, width, height);
    return canvas;
  }

  /** Current frame downscaled — cheap enough to run on a timer. */
  grabSmall(maxEdge = 420) {
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (!width || !height) throw new Error('The camera has not produced a frame yet.');
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const canvas = createCanvas(width * scale, height * scale);
    const ctx = ctx2d(canvas);
    ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /** Capture, detecting the page outline when asked. */
  async shoot({ detectEdges = true, quality = 0.92 } = {}) {
    const canvas = this.grab();
    const quad = detectEdges ? detectDocumentCorners(canvas) : this.suggested;
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    return { canvas, blob, quad };
  }

  /* ── live outline suggestion ── */

  startDetection(intervalMs = 800) {
    if (this.detectTimer || !this.overlay) return;
    const tick = () => {
      if (!this.active) return;
      this.suggested = this._detectFromVideo();
      this.drawOverlay(this.suggested);
    };
    tick();
    this.detectTimer = setInterval(tick, intervalMs);
  }

  stopDetection() {
    clearInterval(this.detectTimer);
    this.detectTimer = null;
  }

  _detectFromVideo() {
    try {
      return detectDocumentCorners(this.grabSmall(400), { sensitivity: 34 });
    } catch {
      return null;
    }
  }

  clearOverlay() {
    if (this.overlay) ctx2d(this.overlay, { willReadFrequently: false }).clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  /** Draw the suggested quad on the overlay canvas, mapping from video pixels. */
  drawOverlay(quad) {
    const overlay = this.overlay;
    if (!overlay) return;
    const vw = this.video.videoWidth || 1;
    const vh = this.video.videoHeight || 1;
    const rect = this.video.getBoundingClientRect();
    if (!rect.width) return;
    if (overlay.width !== Math.round(rect.width) || overlay.height !== Math.round(rect.height)) {
      overlay.width = Math.round(rect.width);
      overlay.height = Math.round(rect.height);
    }
    const ctx = ctx2d(overlay, { willReadFrequently: false });
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!quad) return;

    // mirror the mapping the video element uses: object-fit contain
    const scale = Math.min(overlay.width / vw, overlay.height / vh);
    const padX = (overlay.width - vw * scale) / 2;
    const padY = (overlay.height - vh * scale) / 2;

    ctx.beginPath();
    quad.forEach((point, i) => {
      const x = clamp(point.x * scale + padX, 0, overlay.width);
      const y = clamp(point.y * scale + padY, 0, overlay.height);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.strokeStyle = 'rgba(108, 240, 255, .95)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = 'rgba(108, 240, 255, .12)';
    ctx.fill();
  }
}

export function cameraSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
}
