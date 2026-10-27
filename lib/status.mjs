// Window copy is independent of terminal width; the caller fits each line.
export const duration = (sec) => (sec < 90 ? `${Math.max(1, Math.round(sec))} s` : `${Math.round(sec / 60)} min`);

export function ago(at, now = Date.now()) {
  const min = Math.max(0, now - at) / 60000;
  return min < 1 ? 'just now' : min < 90 ? `${Math.round(min)} min ago`
    : min < 36 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
}

export function indexStatus(status, progress, { now = Date.now() } = {}) {
  const p = progress;
  if (p && !p.done) {
    if (p.total > 0 && Number.isFinite(p.completed)) {
      const ratio = Math.min(1, Math.max(0, p.completed / p.total));
      const filled = Math.round(ratio * 10);
      const phase = p.phase === 'embedding' ? 'vectors' : p.phase;
      const count = p.phase === 'download' ? '' : ` ${p.completed}/${p.total}`;
      const left = p.remainingSeconds > 0 ? ` · ~${duration(p.remainingSeconds)} left` : '';
      return `${phase} [${'#'.repeat(filled)}${'-'.repeat(10 - filled)}] ${Math.round(ratio * 100)}%${count}${left}`;
    }
    return `refreshing: ${p.text || 'starting'}`;
  }
  if (p?.failed) return `! indexing failed: ${p.text} · ctrl-r retries`;
  const age = status.textAt ? `updated ${ago(status.textAt, now)}` : 'not indexed yet';
  const receipt = p?.hint ?? (p?.done && now - p.at < 60000 ? p.text : '');
  return receipt ? `${age} · ${receipt}` : age;
}
