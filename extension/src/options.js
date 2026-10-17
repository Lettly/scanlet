/* Scanlet bridge — options page. */

import { COMMON_SUBNETS, hostsInSubnet, localSubnets, sweep } from './discovery.js';

const NETWORK_ORIGINS = ['http://*/*', 'https://*/*'];

const $ = (id) => document.getElementById(id);

function setStatus(state, text) {
  $('perm-dot').className = `dot ${state}`;
  $('perm-text').textContent = text;
}

async function refreshPermission() {
  const granted = await chrome.permissions.contains({ origins: NETWORK_ORIGINS });
  if (granted) setStatus('ok', 'Granted');
  else setStatus('bad', 'Not granted');
  $('grant').disabled = granted;
  $('revoke').disabled = !granted;
  $('find').disabled = !granted;
}

async function loadSettings() {
  const { subnets } = await chrome.storage.local.get('subnets');
  if (Array.isArray(subnets) && subnets.length) $('subnets').value = subnets.join(', ');

  const detected = await localSubnets();
  $('detected').textContent = detected?.length
    ? `This computer appears to be on ${detected.join(', ')}.0/24.`
    : 'This browser does not expose the local network interfaces, so the prefixes above are used as-is.';
  if (!detected && !$('subnets').value) {
    $('subnets').placeholder = COMMON_SUBNETS.join(', ');
  }
}

function readSubnets() {
  return $('subnets')
    .value.split(/[\s,]+/)
    .map((entry) => entry.trim().replace(/\.\d+$/, '').replace(/\.$/, ''))
    .filter((entry) => /^\d+\.\d+\.\d+$/.test(entry));
}

$('grant').addEventListener('click', async () => {
  const granted = await chrome.permissions.request({ origins: NETWORK_ORIGINS });
  if (!granted) setStatus('bad', 'Not granted');
  await refreshPermission();
});

$('revoke').addEventListener('click', async () => {
  await chrome.permissions.remove({ origins: NETWORK_ORIGINS });
  await refreshPermission();
});

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ subnets: readSubnets() });
  $('progress').textContent = 'Saved.';
  setTimeout(() => {
    $('progress').textContent = '';
  }, 1500);
});

$('find').addEventListener('click', async () => {
  const prefixes = readSubnets();
  const effective = prefixes.length ? prefixes : (await localSubnets()) || COMMON_SUBNETS.slice(0, 2);
  const hosts = effective.flatMap((prefix) => hostsInSubnet(prefix));

  $('found').textContent = '';
  $('find').disabled = true;
  $('progress').textContent = `Asking ${hosts.length} addresses…`;

  try {
    const found = await sweep(hosts, {
      concurrency: 48,
      timeout: 600,
      onFound: (printer) => {
        const item = document.createElement('li');
        item.textContent = `${printer.address}:${printer.port}${printer.path || ''} — eSCL`;
        $('found').append(item);
      },
      onProgress: (done, total) => {
        $('progress').textContent = `Asking ${hosts.length} addresses… ${Math.round((done / total) * 100)}%`;
      },
    });
    $('progress').textContent = found.length
      ? `${found.length} printer${found.length === 1 ? '' : 's'} found.`
      : 'Nothing answered. Check the prefixes, or add the printer by address in Scanlet.';
  } catch (error) {
    $('progress').textContent = error.message;
  } finally {
    $('find').disabled = false;
  }
});

refreshPermission().catch(() => setStatus('bad', 'No permission'));
loadSettings().catch(() => {});
