import { performance } from 'node:perf_hooks';

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const SIZES = new Set(['auto', 'small', 'medium', 'large']);
const PROGRESS_KINDS = new Set(['model_start', 'model_output', 'tool_start', 'tool_completed', 'final']);
const DEFAULTS = Object.freeze({
  small: Object.freeze({ total: 5 * 60 * 1000, idle: 3 * 60 * 1000 }),
  medium: Object.freeze({ total: 15 * 60 * 1000, idle: 7 * 60 * 1000 }),
  large: Object.freeze({ total: 30 * 60 * 1000, idle: 10 * 60 * 1000 }),
});
const has = (object, key) => Object.hasOwn(object, key);

function validateDuration(value, name) {
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new Error(`${name} must be a safe integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} ms.`);
  }
}

/** Check request options without inserting defaults before snapshots are available. */
export function validateTimeoutOptions(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Timeout request must be an object.');
  if (has(request, 'taskSize') && !SIZES.has(request.taskSize)) throw new Error('taskSize must be auto, small, medium, or large.');
  for (const name of ['timeoutMs', 'totalTimeoutMs', 'idleTimeoutMs']) {
    if (has(request, name)) validateDuration(request[name], name);
  }
  if (has(request, 'timeoutMs') && has(request, 'totalTimeoutMs') && request.timeoutMs !== request.totalTimeoutMs) {
    throw new Error('timeoutMs and totalTimeoutMs must be equal when both are supplied.');
  }
  const total = has(request, 'totalTimeoutMs') ? request.totalTimeoutMs : request.timeoutMs;
  if (has(request, 'idleTimeoutMs') && total !== undefined && request.idleTimeoutMs > total) {
    throw new Error('idleTimeoutMs must not exceed the total task timeout.');
  }
  return request;
}

/** Use actual immutable snapshots, not the requested paths, to determine task size. */
export function resolveTimeoutPolicy(request, snapshots = []) {
  validateTimeoutOptions(request);
  if (!Array.isArray(snapshots)) throw new Error('snapshots must be an array.');
  let inputBytes = 0;
  for (const name of ['instruction', 'input', 'feedback']) {
    if (!has(request, name)) continue;
    if (typeof request[name] !== 'string') throw new Error(`${name} must be a string when supplied.`);
    inputBytes += Buffer.byteLength(request[name], 'utf8');
  }
  let snapshotBytes = 0;
  for (const snapshot of snapshots) {
    if (!snapshot || !Number.isSafeInteger(snapshot.bytes) || snapshot.bytes < 0) throw new Error('Each snapshot must have a nonnegative safe integer bytes count.');
    snapshotBytes += snapshot.bytes;
    if (!Number.isSafeInteger(snapshotBytes)) throw new Error('Snapshot byte count is too large.');
  }
  const totalBytes = inputBytes + snapshotBytes;
  if (!Number.isSafeInteger(totalBytes)) throw new Error('Task byte count is too large.');
  const fileCount = snapshots.length;
  const explicitSize = has(request, 'taskSize') && request.taskSize !== 'auto';
  const automaticSize = fileCount >= 8 || totalBytes >= 128 * 1024
    ? 'large'
    : request.mode === 'inspect' || request.mode === 'propose' || totalBytes >= 16 * 1024 ? 'medium' : 'small';
  const taskSize = explicitSize ? request.taskSize : automaticSize;
  const explicitTotal = has(request, 'totalTimeoutMs') || has(request, 'timeoutMs');
  const totalTimeoutMs = has(request, 'totalTimeoutMs') ? request.totalTimeoutMs
    : has(request, 'timeoutMs') ? request.timeoutMs : DEFAULTS[taskSize].total;
  const explicitIdle = has(request, 'idleTimeoutMs');
  const idleTimeoutMs = explicitIdle ? request.idleTimeoutMs : Math.min(DEFAULTS[taskSize].idle, totalTimeoutMs);
  if (idleTimeoutMs > totalTimeoutMs) throw new Error('idleTimeoutMs must not exceed the resolved total task timeout.');
  return {
    taskSize, sizeSource: explicitSize ? 'explicit' : 'auto',
    totalTimeoutMs, idleTimeoutMs,
    totalSource: explicitTotal ? 'explicit' : 'auto', idleSource: explicitIdle ? 'explicit' : 'auto',
    inputBytes, fileCount, snapshotBytes,
  };
}

/** Independent total and inactivity budgets; valid progress can never extend total time. */
export function createProgressClock(policy, { now = () => performance.now() } = {}) {
  if (!policy || typeof policy !== 'object') throw new Error('A resolved timeout policy is required.');
  const { totalTimeoutMs, idleTimeoutMs } = policy;
  validateDuration(totalTimeoutMs, 'totalTimeoutMs');
  validateDuration(idleTimeoutMs, 'idleTimeoutMs');
  if (idleTimeoutMs > totalTimeoutMs) throw new Error('idleTimeoutMs must not exceed totalTimeoutMs.');
  if (typeof now !== 'function') throw new Error('now must be a function.');
  let lastNow = -Infinity;
  const readTime = () => {
    const value = now();
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('now must return a finite number.');
    // A faulty/custom clock moving backwards cannot replenish either budget.
    lastNow = Math.max(lastNow, value);
    return lastNow;
  };
  const startedAt = readTime();
  let lastProgressAt = startedAt;
  let lastProgressKind = null;
  const stateAt = time => {
    const totalElapsedMs = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, time - startedAt));
    const idleElapsedMs = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, time - lastProgressAt));
    return {
      totalElapsedMs, idleElapsedMs,
      totalRemainingMs: Math.max(0, totalTimeoutMs - totalElapsedMs),
      idleRemainingMs: Math.max(0, idleTimeoutMs - idleElapsedMs),
      lastProgressKind,
    };
  };
  const expiredAt = state => {
    if (state.totalElapsedMs >= totalTimeoutMs) return { kind: 'total', limitMs: totalTimeoutMs, elapsedMs: state.totalElapsedMs, ...state };
    if (state.idleElapsedMs >= idleTimeoutMs) return { kind: 'idle', limitMs: idleTimeoutMs, elapsedMs: state.idleElapsedMs, ...state };
    return null;
  };
  return {
    markProgress(kind) {
      if (!PROGRESS_KINDS.has(kind)) return false;
      const time = readTime();
      // Late events must not revive work after an idle or total deadline.
      if (expiredAt(stateAt(time))) return false;
      lastProgressAt = time;
      lastProgressKind = kind;
      return true;
    },
    snapshot: () => stateAt(readTime()),
    expired: () => expiredAt(stateAt(readTime())),
  };
}
