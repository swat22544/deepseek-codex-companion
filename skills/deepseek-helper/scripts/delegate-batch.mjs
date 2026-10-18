import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {isAbsolute, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {delegate} from './delegate.mjs';
import {snapshotFiles, validateRequest} from './helper-policy.mjs';
import {verifyResult} from './verify-result.mjs';

// A batch is exactly two supervisor-approved, independent packages, one per
// backend. It is not an autonomous planner, retry queue, or failover mechanism.
export function validateBatch(value) {
  if (!value || value.version !== 1 || value.independent !== true || !Array.isArray(value.tasks) || value.tasks.length !== 2) {
    throw new Error('Batch requires version: 1, independent: true, and exactly two tasks.');
  }
  const ids = new Set(), backends = new Set();
  const tasks = value.tasks.map(task => {
    if (!task || typeof task.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(task.id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|batch-plan|batch-result)$/i.test(task.id) || ids.has(task.id)) {
      throw new Error('Task ids must be unique, safe lowercase names (1–48 characters).');
    }
    // Legacy single requests may omit backend. New batches never infer it.
    if (!['harness', 'zcode'].includes(task.request?.backend) || backends.has(task.request.backend)) {
      throw new Error('Batch requires one explicit harness request and one explicit zcode request.');
    }
    ids.add(task.id); backends.add(task.request.backend);
    return {id: task.id, request: validateRequest(structuredClone(task.request))};
  });
  return {version: 1, independent: true, tasks};
}

const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
const failed = (backend, error) => ({
  backend, ok: false, trust: 'unverified_candidate', verificationRequired: true,
  phase: 'setup-or-result', policyActive: false, modelSelectionVerified: false,
  final: null, artifacts: [], error: error instanceof Error ? error.message : 'Backend invocation failed.'
});

export async function runBatch(value, {outputDir, signal, invoke = delegate} = {}) {
  const batch = validateBatch(value);
  if (typeof outputDir !== 'string' || !isAbsolute(outputDir)) throw new Error('outputDir must be an absolute, new directory.');
  signal?.throwIfAborted();
  // Fail the entire plan before spending model quota on a bad file selection.
  // Runners still establish their own immutable snapshots and verify policies.
  for (const task of batch.tasks) {await snapshotFiles(task.request.files); signal?.throwIfAborted();}
  await mkdir(outputDir); // Exclusive: never overwrite a prior batch's evidence.
  const startedAt = new Date().toISOString();
  await save(join(outputDir, 'batch-plan.json'), {
    version: 1, startedAt, independent: true,
    tasks: batch.tasks.map(({id, request}) => ({id, backend: request.backend, mode: request.mode}))
  });
  // Start both async operations before awaiting either one. Each runner retains
  // its own total/idle budgets, monitor, process ownership, and cleanup.
  const tasks = await Promise.all(batch.tasks.map(async ({id, request}) => {
    const start = new Date().toISOString(), resultPath = join(outputDir, id + '.json');
    let result;
    try {
      signal?.throwIfAborted(); result = await invoke(request, {signal});
      if (result === undefined) throw new Error('Backend returned no result record.');
    }
    catch (error) {result = failed(request.backend, error);}
    const verification = verifyResult(result);
    const mechanicalOk = result?.backend === request.backend && verification.mechanicalOk;
    let saved = true;
    try {await save(resultPath, result);}
    catch {saved = false;}
    return {
      id, backend: request.backend, startedAt: start, finishedAt: new Date().toISOString(),
      status: mechanicalOk && saved ? 'completed' : 'failed', mechanicalOk, saved, resultPath,
      ...(saved ? {} : {error: 'Unable to save this task result; do not treat the batch as complete.'})
    };
  }));
  const result = {
    version: 1, ok: tasks.every(task => task.status === 'completed'), startedAt,
    finishedAt: new Date().toISOString(), tasks,
    trust: 'unverified_candidate', verificationRequired: true, semanticAcceptance: false
  };
  await save(join(outputDir, 'batch-result.json'), result);
  return result;
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || args[0] === '--help') {
    console.log('Usage: node delegate-batch.mjs BATCH.json NEW_OUTPUT_DIRECTORY\nTwo independent tasks, explicit harness + zcode. Results still require independent review.');
    return;
  }
  if (args.length !== 2) throw new Error('Expected a batch JSON file and a new output directory.');
  const batch = JSON.parse((await readFile(resolve(args[0]), 'utf8')).replace(/^\uFEFF/, ''));
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('Batch cancelled by supervisor.'));
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const result = await runBatch(batch, {outputDir: resolve(args[1]), signal: abort.signal});
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {process.off('SIGINT', cancel); process.off('SIGTERM', cancel);}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {console.error(error.message); process.exitCode = 1;});
}
