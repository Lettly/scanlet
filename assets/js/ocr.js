/* Scanlet — OCR, on top of Tesseract.js.
 *
 * The engine, its worker and its WASM core all come from `vendor/`, so OCR works
 * with no network at all. The one bulky part is a language's trained data:
 * `node tools/vendor.mjs --langs eng,ita` fetches more, and vendor/MANIFEST.json
 * records which ones are on disk. A language that is not vendored falls back to
 * the public CDN, so nothing breaks — it just needs the network once.
 */

const VENDOR = new URL('../../vendor/', import.meta.url);
const TESSERACT_JS = new URL('tesseract/tesseract.min.js', VENDOR).toString();
const LOCAL = {
  workerPath: new URL('tesseract/worker.min.js', VENDOR).toString(),
  // The SIMD core is the one modern browsers use; the plain core sits alongside
  // it only if `tools/vendor.mjs --with-fallback-core` was run.
  corePath: new URL('tesseract/tesseract-core-simd.wasm.js', VENDOR).toString(),
  langPath: new URL('tessdata/', VENDOR).toString(),
  gzip: true,
};
const REMOTE = {
  workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
  corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd.wasm.js',
  langPath: 'https://tessdata.projectnaptha.com/4.0.0',
  gzip: true,
};

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
    script.onerror = () => reject(new Error('Could not load the OCR engine.'));
    document.head.append(script);
  });
}

export async function loadOcr() {
  if (window.Tesseract) return window.Tesseract;
  if (!loaderPromise) loaderPromise = loadScript(TESSERACT_JS).then(() => window.Tesseract);
  return loaderPromise;
}

/** Languages actually present in vendor/, as recorded by tools/vendor.mjs. */
let vendoredLanguages = null;
async function localLanguages() {
  if (vendoredLanguages) return vendoredLanguages;
  try {
    const response = await fetch(new URL('MANIFEST.json', VENDOR));
    const manifest = response.ok ? await response.json() : null;
    vendoredLanguages = new Set(Array.isArray(manifest?.languages) ? manifest.languages : []);
  } catch {
    vendoredLanguages = new Set();
  }
  return vendoredLanguages;
}

/** `eng+ita` is local only when every part of it is. */
async function isLocalLanguage(lang) {
  const available = await localLanguages();
  if (!available.size) return false;
  return lang.split('+').every((code) => available.has(code));
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

  const paths = (await isLocalLanguage(lang)) ? LOCAL : REMOTE;
  try {
    holder.worker = await Tesseract.createWorker(lang, 1, {
      ...paths,
      logger: (message) => workerCache.get(lang)?.onProgress?.(message),
    });
  } catch (error) {
    workerCache.delete(lang);
    if (paths === LOCAL) {
      // Vendored engine but a language that is not on disk: try the CDN once.
      try {
        holder.worker = await Tesseract.createWorker(lang, 1, {
          ...REMOTE,
          logger: (message) => workerCache.get(lang)?.onProgress?.(message),
        });
        workerCache.set(lang, holder);
        return holder.worker;
      } catch {
        throw new Error('Could not start the OCR engine for this language.');
      }
    }
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
