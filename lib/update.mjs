import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Compare npm's semver releases without adding a runtime dependency.
function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  const pre = match[4]?.split('.') ?? [];
  if (pre.some((part) => !part || (/^\d+$/.test(part) && part.length > 1 && part[0] === '0'))) return null;
  return { core: match.slice(1, 4).map(BigInt), pre };
}

export function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  }
  if (!a.pre.length || !b.pre.length) return !a.pre.length && !!b.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return y === undefined && x !== undefined;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y);
    if (xn !== yn) return !xn;
    return x > y;
  }
  return false;
}

export async function latestVersion(current) {
  try {
    const { stdout } = await execFileAsync('npm', ['view', 'ghqcd@latest', 'version', '--fetch-retries=0', '--fetch-timeout=1500'], {
      timeout: 2500, maxBuffer: 4096, windowsHide: true,
    });
    const latest = stdout.trim();
    return isNewer(latest, current) ? latest : null;
  } catch {
    // Offline, missing npm, malformed registry response: launch normally.
    return null;
  }
}

export function installUpdate(version) {
  return spawnSync('npm', ['install', '--global', `ghqcd@${version}`, '--ignore-scripts'], {
    stdio: ['inherit', 2, 2],
  });
}
