#!/usr/bin/env node
/*
 * Find Scanlet bridges on this network.
 *
 *   node tools/find-bridge.mjs                 # human readable
 *   node tools/find-bridge.mjs --json          # for scripting
 *   node tools/find-bridge.mjs --timeout 5000
 *
 * Bridges advertise themselves with Bonjour (`_scanlet._tcp`), which is the one
 * form of discovery that can work at all: a browser cannot browse mDNS, but
 * anything running on the network can. This is what makes that advertisement
 * useful instead of aspirational — and it is the reliable way to get the address
 * for an iOS Shortcut or a `curl` one-liner without hunting through logs.
 *
 * Exit status is 1 when nothing is found, so it can gate a script.
 */

import { parseArgs } from 'node:util';
import { discoverBridges } from '../bridge/scanlet-bridge.mjs';

const { values } = parseArgs({
  options: {
    timeout: { type: 'string', default: '2500' },
    json: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const bridges = await discoverBridges({ timeout: Number(values.timeout) || 2500 });

if (values.json) {
  console.log(JSON.stringify({ bridges }, null, 2));
} else if (!bridges.length) {
  console.log('No Scanlet bridges answered.');
  console.log('');
  console.log('Start one with:');
  console.log('  node bridge/scanlet-bridge.mjs --lan');
  console.log('and it will advertise itself on this network.');
} else {
  for (const bridge of bridges) {
    console.log(`${bridge.name}${bridge.version ? ` (v${bridge.version})` : ''}`);
    console.log(`  address   ${bridge.address}:${bridge.port}`);
    console.log(`  open      ${bridge.url}`);
    console.log(`  service   ${bridge.instance}`);
    console.log('');
  }
  console.log('Open the address above in Scanlet — it needs no pairing code.');
}

process.exit(bridges.length ? 0 : 1);
