/* Scanlet bridge — an eSCL client for the extension.
 *
 * Deliberately free of any `chrome.*` dependency, so it can also run (and be
 * tested) in a plain Node or worker context. It uses `fetch`, which is why it
 * only works inside the extension: the extension's host permissions are what
 * let a request to a printer escape the page's CORS rules.
 */

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

/** Where eSCL devices tend to live. Tried in order. */
export const ESCL_PATHS = ['/eSCL', ''];

/** Build the id we use for a device — it encodes everything we need later. */
export function printerId(address, port = 80, path = '/eSCL', secure = false) {
  return `escl://${address}:${port}${path || ''}${secure ? '?tls=1' : ''}`;
}

export function parsePrinterId(id) {
  const url = new URL(id);
  if (url.protocol !== 'escl:') throw new Error('Not a printer address.');
  return {
    address: url.hostname,
    port: Number(url.port) || (url.searchParams.get('tls') === '1' ? 443 : 80),
    path: url.pathname === '/' ? '' : url.pathname,
    secure: url.searchParams.get('tls') === '1',
  };
}

export function baseUrl(printer) {
  return `${printer.secure ? 'https' : 'http'}://${printer.address}:${printer.port}${printer.path || '/eSCL'}`;
}

export function normaliseAddress(input) {
  const cleaned = String(input || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  if (!cleaned) throw new Error('Enter an address such as 192.168.1.42 or 192.168.1.42:8080.');
  const [host, portPart] = cleaned.split('/')[0].split(':');
  if (!host) throw new Error('That does not look like an address.');
  return { address: host, port: Number(portPart) || 80 };
}

async function request(url, { method = 'GET', body = null, contentType = null, signal, timeout = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      method,
      body,
      signal: controller.signal,
      headers: contentType ? { 'content-type': contentType } : undefined,
    });
    return response;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function numericTag(xml, tag) {
  const match = new RegExp(`<[^>]*${tag}[^>]*>\\s*(\\d+)\\s*<`, 'i').exec(xml);
  return match ? Number(match[1]) : null;
}

function allOfTag(xml, tag) {
  return [...xml.matchAll(new RegExp(`<[^>]*${tag}[^>]*>\\s*(\\d+)\\s*<`, 'gi'))].map((m) => Number(m[1]));
}

/**
 * Maximum page extent per input source, in eSCL's 1/300-inch units.
 * A device usually allows a longer sheet in the feeder than on the glass, and
 * asking for a region bigger than the source supports gets the job rejected.
 */
function sourceMaxima(xml) {
  const maxima = {};
  const read = (tag, key) => {
    const section = new RegExp(`<[^>]*${tag}[\\s>][\\s\\S]*?</[^>]*${tag}>`, 'i').exec(xml);
    if (!section) return;
    const width = numericTag(section[0], 'MaxWidth');
    const height = numericTag(section[0], 'MaxHeight');
    if (width || height) maxima[key] = { maxWidth: width, maxHeight: height };
  };
  read('Platen', 'Platen');
  read('Adf', 'Feeder');
  return maxima;
}

/** Read ScannerCapabilities, normalised to what the UI needs. */
export async function capabilities(printer, { signal, timeout = 12000 } = {}) {
  const response = await request(`${baseUrl(printer)}/ScannerCapabilities`, { signal, timeout });
  if (!response.ok) throw new Error(`The scanner refused to describe itself (HTTP ${response.status}).`);
  const xml = await response.text();

  const sources = [];
  if (/<[^>]*InputSource[^>]*>\s*Platen\s*</i.test(xml) || /PlatenInputCaps/i.test(xml)) sources.push('Platen');
  if (/<[^>]*InputSource[^>]*>\s*Feeder\s*</i.test(xml) || /AdfInputCaps/i.test(xml)) sources.push('Feeder');

  const unique = (list) => [...new Set(list)];
  const colorModes = unique([...xml.matchAll(/<[^>]*ColorMode[^>]*>\s*([A-Za-z0-9]+)\s*</g)].map((m) => m[1]));
  const formats = unique([...xml.matchAll(/<[^>]*DocumentFormat[^>]*>\s*([^\s<]+)\s*</g)].map((m) => m[1]));
  const resolutions = unique(
    [...xml.matchAll(/<[^>]*XResolution[^>]*>\s*(\d+)\s*</g)].map((m) => Number(m[1])),
  )
    .filter(Boolean)
    .sort((a, b) => a - b);

  return {
    sources: sources.length ? sources : ['Platen'],
    colorModes: colorModes.length ? colorModes : ['RGB24', 'Grayscale8'],
    formats: formats.length ? formats : ['image/jpeg'],
    resolutions,
    duplex: /<[^>]*Duplex[^>]*>\s*true\s*</i.test(xml),
    maxima: sourceMaxima(xml),
    maxWidth: Math.max(2550, ...allOfTag(xml, 'MaxWidth')),
    maxHeight: Math.max(3300, ...allOfTag(xml, 'MaxHeight')),
  };
}

export function scanSettingsXml(options, caps = {}) {
  const resolution = Number(options.resolution) || 200;
  const inputSource = options.inputSource === 'Feeder' ? 'Feeder' : 'Platen';
  const colorMode = options.colorMode || 'RGB24';
  const format = options.format || 'image/jpeg';
  const duplex = options.duplex === true || options.duplex === 'true' ? 'true' : 'false';

  // eSCL measures the region in 1/300-inch units whatever the resolution is, so
  // the device's own maximum is passed through untouched. When no maximum is
  // known we send no region at all and let the device use its default page.
  const source = caps.maxima?.[inputSource];
  const width = source?.maxWidth || caps.maxWidth;
  const height = source?.maxHeight || caps.maxHeight;
  const regions =
    source?.maxWidth && source?.maxHeight
      ? `  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
      <pwg:Width>${Math.round(width)}</pwg:Width>
      <pwg:Height>${Math.round(height)}</pwg:Height>
      <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
`
      : '';

  return `${XML_HEADER}
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.0</pwg:Version>
${regions}  <pwg:InputSource>${inputSource}</pwg:InputSource>
  <scan:ColorMode>${colorMode}</scan:ColorMode>
  <scan:XResolution>${resolution}</scan:XResolution>
  <scan:YResolution>${resolution}</scan:YResolution>
  <pwg:DocumentFormat>${format}</pwg:DocumentFormat>
  <scan:DocumentFormatExt>${format}</scan:DocumentFormatExt>
  <scan:Duplex>${duplex}</scan:Duplex>
</scan:ScanSettings>`;
}

/**
 * Run a scan, yielding each page as it arrives — an ADF can return many.
 * `onPage({bytes, mime, index})` is called once per sheet, in order.
 */
export async function scan(printer, options = {}, { onPage, caps, signal } = {}) {
  const xml = scanSettingsXml(options, caps);
  const created = await request(`${baseUrl(printer)}/ScanJobs`, {
    method: 'POST',
    body: xml,
    contentType: 'text/xml',
    timeout: 30000,
    signal,
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(`The scanner rejected the job (HTTP ${created.status}).`);
  }
  const location = created.headers.get('location');
  if (!location) throw new Error('The scanner did not return a job location.');
  const jobUrl = new URL(location, `${baseUrl(printer)}/`).toString();

  let index = 0;
  for (; index < 200; index++) {
    const document = await request(`${jobUrl}/NextDocument`, { timeout: 120000, signal });
    if (document.status === 404 || document.status === 204) break;
    if (!document.ok) {
      if (!index) throw new Error(`The scanner returned no image (HTTP ${document.status}).`);
      break;
    }
    const bytes = new Uint8Array(await document.arrayBuffer());
    if (!bytes.length) break;
    const mime = (document.headers.get('content-type') || 'image/jpeg').split(';')[0];
    await onPage?.({ bytes, mime, index });
  }
  if (!index) throw new Error('The scanner produced no pages.');
  return index;
}

/** Try the usual eSCL locations and return the first that answers. */
export async function probeAddress(input, { signal, timeout = 4000 } = {}) {
  const { address, port } = normaliseAddress(input);
  for (const path of ESCL_PATHS) {
    const printer = { address, port, path, secure: false };
    try {
      const caps = await capabilities(printer, { signal, timeout });
      return { printer: { ...printer, id: printerId(address, port, path), name: address }, caps };
    } catch {
      /* try the next path */
    }
  }
  throw new Error(`No eSCL scanner answered at ${address}.`);
}

export function base64FromBytes(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
