// Meaning search on its own thread. ORT's run() and the 1.2 GB model load never
// yield to the event loop, so on the window's main thread they held up every
// keystroke's name hits; here they hold up only themselves.
import { parentPort, workerData } from 'node:worker_threads';
import { meaningSearch } from './search-index.mjs';

const search = meaningSearch(workerData.env);
parentPort.on('message', async ({ id, query }) => {
  let hits = [];
  try { hits = await search(query); } catch { /* no vectors, no model: no meaning hits */ }
  parentPort.postMessage({ id, hits });
});
