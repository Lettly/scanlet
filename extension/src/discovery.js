/* Scanlet bridge — finding printers on the local network.
 *
 * No mDNS here: an extension has no multicast socket, and `chrome.system.network`
 * is not available everywhere. So we probe, which host permissions make possible.
 * `fetch` against a local address with no CORS headers is exactly what a page is
 * forbidden to do and an extension is allowed to do.
 */

import { ESCL_PATHS, printerId, capabilities } from './escl.js';

/** Subnets worth sweeping when we cannot learn our own address. */
export const COMMON_SUBNETS = ['192.168.1', '192.168.0', '192.168.178', '10.0.0', '192.168.2'];

/** The /24 hosts of a subnet, as `192.168.1.x`. */
export function hostsInSubnet(prefix, { skip = [1], limit = 254 } = {}) {
  const hosts = [];
  for (let i = 1; i <= limit; i++) {
    if (skip.includes(i)) continue;
    hosts.push(`${prefix}.${i}`);
  }
  return hosts;
}

/**
 * Ask one host whether it is an eSCL scanner.
 * @returns {Promise<{printer:object, caps:object}|null>}
 */
export async function probeHost(address, { port = 80, signal, timeout = 700 } = {}) {
  for (const path of ESCL_PATHS) {
    const printer = { address, port, path, secure: false };
    try {
      // eslint-disable-next-line no-await-in-loop
      const caps = await capabilities(printer, { signal, timeout });
      return {
        printer: {
          ...printer,
          id: printerId(address, port, path),
          name: `eSCL device at ${address}`,
          found: true,
        },
        caps,
      };
    } catch {
      /* not this path — not a printer, or not answering */
    }
  }
  return null;
}

/**
 * Probe many hosts with bounded concurrency.
 * `onFound` is called with each hit so the UI can fill up as it goes.
 */
export async function sweep(hosts, { concurrency = 40, port = 80, signal, onFound, onProgress } = {}) {
  const queue = hosts.slice();
  const found = [];
  const total = queue.length;
  let done = 0;

  const worker = async () => {
    while (queue.length && !signal?.aborted) {
      const host = queue.shift();
      // eslint-disable-next-line no-await-in-loop
      const hit = await probeHost(host, { port, signal }).catch(() => null);
      done += 1;
      if (hit) {
        found.push(hit.printer);
        onFound?.(hit.printer, hit.caps);
      }
      onProgress?.(done, total);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total || 1)) }, worker));
  return found;
}

/**
 * The address we are on, when the browser will tell us. Returns null on builds
 * where `chrome.system.network` does not exist.
 */
export async function localSubnets() {
  try {
    const interfaces = await chrome.system.network.getNetworkInterfaces();
    const prefixes = new Set();
    for (const iface of interfaces || []) {
      if (!iface.address || iface.address.includes(':')) continue; // IPv4 only
      const parts = iface.address.split('.');
      if (parts.length !== 4) continue;
      prefixes.add(parts.slice(0, 3).join('.'));
    }
    return [...prefixes];
  } catch {
    return null;
  }
}
