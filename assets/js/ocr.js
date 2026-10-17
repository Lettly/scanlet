/* Scanlet — OCR, on top of Tesseract.js (loaded lazily from a CDN). */

const CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

export const OCR_LANGUAGES = [
  { code: 'eng', label: 'English' },
  { code: 'ita', label: 'Italian' },
  { code: 'deu', label: 'German' },
  { code: 'fra', label: 'French' },
  { code: 'spa', label: 'Spanish' },
  { code: 'por', label: 'Portuguese' },
  { code: 'nld', label: 'Dutch' },
  { code: 'pol', label: 'Polish' },
  { code: 'rus', label: 'Russian' },
  { code: 'ukr', label: 'Ukrainian' },
  { code: 'tur', label: 'Turkish' },
  { code: 'ara', label: 'Arabic' },
  { code: 'hin', label: 'Hindi' },
  { code: 'jpn', label: 'Japanese' },
  { code: 'kor', label: 'Korean' },
  { code: 'chi_sim', label: 'Chinese (simplified)' },
  { code: 'eng+ita', label: 'English + Italian' },
];

let loaderPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load the OCR engine. Check your connection.'));
    document.head.append(script);
  });
}

export async function loadOcr() {
  if (window.Tesseract) return window.Tesseract;
  if (!loaderPromise) loaderPromise = loadScript(CDN).then(() => window.Tesseract);
  return loaderPromise;
}

const workerCache = new Map(); // lang → { onProgress, worker }

async function getWorker(lang, onProgress) {
  const entry = workerCache.get(lang);
  if (entry?.worker) {
    entry.onProgress = onProgress;
    return entry.worker;
  }
  const Tesseract = await loadOcr();
  const holder = entry || { onProgress, worker: null };
  holder.onProgress = onProgress;
  workerCache.set(lang, holder);
  try {
    holder.worker = await Tesseract.createWorker(lang, 1, {
      logger: (message) => workerCache.get(lang)?.onProgress?.(message),
    });
  } catch (err) {
    workerCache.delete(lang);
    throw new Error('Could not start the OCR engine for this language.');
  }
  return holder.worker;
}

export async function terminateOcr() {
  for (const entry of workerCache.values()) await entry.worker?.terminate().catch(() => {});
  workerCache.clear();
}

function collectWords(data) {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const words = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node.words)) words.push(...node.words);
    for (const key of ['blocks', 'paragraphs', 'lines']) {
      if (Array.isArray(node[key])) node[key].forEach(walk);
    }
  };
  for (const key of ['blocks', 'paragraphs', 'lines']) {
    if (Array.isArray(data[key])) data[key].forEach(walk);
  }
  return words;
}

/**
 * Recognise one page.
 * @returns {{text:string, words:Array, imageWidth:number, imageHeight:number, lang:string}}
 */
export async function recognise(canvas, { lang = 'eng', onProgress } = {}) {
  const worker = await getWorker(lang, onProgress);
  const { data } = await worker.recognize(canvas);
  const words = collectWords(data)
    .map((word) => ({
      text: (word.text || '').trim(),
      confidence: word.confidence ?? 0,
      bbox: word.bbox || null,
    }))
    .filter((word) => word.text && word.bbox);

  return {
    text: (data.text || '').replace(/\n{3,}/g, '\n\n').trim(),
    words,
    imageWidth: canvas.width,
    imageHeight: canvas.height,
    lang,
  };
}

/** Turn Tesseract's progress messages into a 0..1 fraction with a label. */
export function progressFraction(message) {
  const status = message?.status || '';
  const progress = Number(message?.progress || 0);
  const labels = {
    'loading tesseract core': 'Loading OCR engine',
    'initializing tesseract': 'Starting OCR engine',
    'loading language traineddata': 'Downloading language data',
    'initializing api': 'Preparing language',
    'recognizing text': 'Recognising text',
  };
  return { fraction: Number.isFinite(progress) ? progress : 0, label: labels[status] || status };
}
