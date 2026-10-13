import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main } from './supervised-runner.mjs';
export { delegate } from './supervised-runner.mjs';
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
