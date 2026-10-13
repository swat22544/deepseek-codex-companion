import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main, delegate as harnessDelegate } from './supervised-runner.mjs';
import { validateRequest } from './helper-policy.mjs';

export async function delegate(raw) {
  const request = validateRequest(raw);
  if (request.backend === 'harness') return harnessDelegate(request);
  const { delegate: openCodeDelegate } = await import('./opencode-runner.mjs');
  return openCodeDelegate(request);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(delegate).catch(error => { console.error(error.message); process.exitCode = 1; });
