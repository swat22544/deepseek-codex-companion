import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main, delegate as harnessDelegate } from './supervised-runner.mjs';
import { validateRequest } from './helper-policy.mjs';

export async function delegate(raw, {signal} = {}) {
  signal?.throwIfAborted();
  const request = validateRequest(raw);
  if (request.backend === 'harness') return harnessDelegate(request, {signal});
  const { delegate: zcodeDelegate } = await import('./zcode-runner.mjs');
  return zcodeDelegate(request, {signal});
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(delegate).catch(error => { console.error(error.message); process.exitCode = 1; });
