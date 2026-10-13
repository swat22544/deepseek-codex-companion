import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTimeoutOptions, resolveTimeoutPolicy, createProgressClock } from '../scripts/timeout-policy.mjs';

const minute = 60 * 1000;
const base = { instruction: 'review', input: '', mode: 'text' };

test('auto budgets classify small text, inspection, and proposal tasks', () => {
  assert.deepEqual(resolveTimeoutPolicy(base), {
    taskSize: 'small', sizeSource: 'auto', totalTimeoutMs: 5 * minute, idleTimeoutMs: 3 * minute,
    totalSource: 'auto', idleSource: 'auto', inputBytes: 6, fileCount: 0, snapshotBytes: 0,
  });
  for (const mode of ['inspect', 'propose']) {
    const policy = resolveTimeoutPolicy({ ...base, mode });
    assert.equal(policy.taskSize, 'medium');
    assert.equal(policy.totalTimeoutMs, 15 * minute);
    assert.equal(policy.idleTimeoutMs, 7 * minute);
  }
});

test('byte and file thresholds are inclusive and count UTF-8 plus feedback', () => {
  assert.equal(resolveTimeoutPolicy({ input: 'a'.repeat(16383) }).taskSize, 'small');
  assert.equal(resolveTimeoutPolicy({ input: 'a'.repeat(16384) }).taskSize, 'medium');
  assert.equal(resolveTimeoutPolicy({ input: 'a'.repeat(131071) }).taskSize, 'medium');
  assert.equal(resolveTimeoutPolicy({ input: 'a'.repeat(131072) }).taskSize, 'large');
  const unicode = resolveTimeoutPolicy({ instruction: '中', input: '🙂', feedback: '文' }, [{ bytes: 16374 }]);
  assert.equal(unicode.inputBytes, 10);
  assert.equal(unicode.snapshotBytes, 16374);
  assert.equal(unicode.taskSize, 'medium');
  assert.equal(resolveTimeoutPolicy(base, Array.from({ length: 7 }, () => ({ bytes: 1 }))).taskSize, 'small');
  const large = resolveTimeoutPolicy(base, Array.from({ length: 8 }, () => ({ bytes: 1 })));
  assert.equal(large.taskSize, 'large');
  assert.equal(large.fileCount, 8);
  assert.equal(large.totalTimeoutMs, 30 * minute);
  assert.equal(large.idleTimeoutMs, 10 * minute);
});

test('explicit task size changes defaults while explicit timings and legacy alias are preserved', () => {
  const request = Object.freeze({ ...base, taskSize: 'large' });
  assert.equal(validateTimeoutOptions(request), request);
  assert.equal(Object.hasOwn(request, 'totalTimeoutMs'), false);
  assert.equal(resolveTimeoutPolicy(request).sizeSource, 'explicit');
  assert.equal(resolveTimeoutPolicy({ ...base, taskSize: 'small' }, [{ bytes: 200000 }]).taskSize, 'small');
  const explicit = resolveTimeoutPolicy({ ...request, totalTimeoutMs: 3600000, idleTimeoutMs: 1200000 });
  assert.equal(explicit.totalTimeoutMs, 3600000);
  assert.equal(explicit.idleTimeoutMs, 1200000);
  assert.equal(explicit.totalSource, 'explicit');
  assert.equal(explicit.idleSource, 'explicit');
  const legacy = resolveTimeoutPolicy({ ...base, timeoutMs: 1000, totalTimeoutMs: 1000 });
  assert.equal(legacy.totalTimeoutMs, 1000);
  assert.equal(legacy.idleTimeoutMs, 1000);
  assert.equal(legacy.idleSource, 'auto');
  assert.equal(resolveTimeoutPolicy({ ...base, taskSize: 'auto' }).sizeSource, 'auto');
});

test('malformed, contradictory, and over-limit options fail closed', () => {
  for (const field of ['timeoutMs', 'totalTimeoutMs', 'idleTimeoutMs']) {
    for (const value of [null, undefined, '1000', NaN, Infinity, -Infinity, true, 999, 3600001, 1000.5, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => validateTimeoutOptions({ ...base, [field]: value }), field + ':' + String(value));
    }
  }
  for (const taskSize of [null, undefined, 'huge', 1, false]) assert.throws(() => validateTimeoutOptions({ ...base, taskSize }));
  for (const invalid of [null, undefined, [], 'text']) assert.throws(() => validateTimeoutOptions(invalid));
  assert.throws(() => validateTimeoutOptions({ timeoutMs: 1000, totalTimeoutMs: 2000 }));
  assert.throws(() => validateTimeoutOptions({ totalTimeoutMs: 1000, idleTimeoutMs: 2000 }));
  assert.throws(() => resolveTimeoutPolicy({ ...base, idleTimeoutMs: 6 * minute }));
});

test('invalid byte counts or task text cannot silently distort sizing', () => {
  for (const bytes of [undefined, null, '1', -1, 1.5, Infinity, NaN]) assert.throws(() => resolveTimeoutPolicy(base, [{ bytes }]));
  assert.throws(() => resolveTimeoutPolicy(base, null));
  assert.throws(() => resolveTimeoutPolicy(base, [null]));
  assert.throws(() => resolveTimeoutPolicy(base, [{ bytes: Number.MAX_SAFE_INTEGER }, { bytes: 1 }]));
  for (const field of ['instruction', 'input', 'feedback']) assert.throws(() => resolveTimeoutPolicy({ ...base, [field]: null }));
});

test('only recognized progress resets idle time; heartbeats do not count', () => {
  let time = 0;
  const clock = createProgressClock({ totalTimeoutMs: 10000, idleTimeoutMs: 2000 }, { now: () => time });
  assert.equal(clock.snapshot().lastProgressKind, null);
  time = 500;
  assert.equal(clock.markProgress('model_start'), true);
  time = 2000;
  assert.equal(clock.markProgress('heartbeat'), false);
  assert.equal(clock.markProgress('status'), false);
  assert.equal(clock.markProgress(''), false);
  assert.equal(clock.snapshot().idleElapsedMs, 1500);
  assert.equal(clock.snapshot().totalElapsedMs, 2000);
  assert.equal(clock.expired(), null);
  time = 2500;
  assert.equal(clock.expired().kind, 'idle');
  assert.equal(clock.expired().limitMs, 2000);
  assert.equal(clock.markProgress('model_output'), false);
  assert.equal(clock.expired().kind, 'idle');
});

test('each supported activity is counted without extending the absolute total deadline', () => {
  let time = 100;
  const clock = createProgressClock({ totalTimeoutMs: 6000, idleTimeoutMs: 2000 }, { now: () => time });
  for (const kind of ['model_start', 'model_output', 'tool_start', 'tool_completed', 'final']) {
    time += 1000;
    assert.equal(clock.markProgress(kind), true);
    assert.equal(clock.snapshot().idleElapsedMs, 0);
    assert.equal(clock.snapshot().lastProgressKind, kind);
  }
  time = 6100;
  assert.equal(clock.expired().kind, 'total');
  assert.equal(clock.expired().elapsedMs, 6000);
  assert.equal(clock.snapshot().idleElapsedMs, 1000);
  assert.equal(clock.markProgress('model_output'), false);
});

test('total expiry takes precedence and remaining times never become negative', () => {
  let time = 0;
  const clock = createProgressClock({ totalTimeoutMs: 2000, idleTimeoutMs: 2000 }, { now: () => time });
  time = 2000;
  assert.equal(clock.expired().kind, 'total');
  time = 10000;
  assert.equal(clock.snapshot().totalRemainingMs, 0);
  assert.equal(clock.snapshot().idleRemainingMs, 0);
  assert.equal(clock.expired().elapsedMs, 10000);
  assert.doesNotThrow(() => JSON.stringify(clock.expired()));
});

test('backwards injected clocks and later policy mutation cannot replenish budgets', () => {
  let time = 1000;
  const policy = { totalTimeoutMs: 5000, idleTimeoutMs: 2000 };
  const clock = createProgressClock(policy, { now: () => time });
  time = 2000;
  assert.equal(clock.snapshot().totalRemainingMs, 4000);
  time = 1500;
  assert.equal(clock.snapshot().totalRemainingMs, 4000);
  assert.equal(clock.snapshot().idleRemainingMs, 1000);
  policy.idleTimeoutMs = 10000;
  time = 3000;
  assert.equal(clock.expired().kind, 'idle');
});

test('invalid clock budgets and nonfinite injected times are rejected', () => {
  for (const policy of [null, {}, { totalTimeoutMs: 1000, idleTimeoutMs: 2000 }, { totalTimeoutMs: Infinity, idleTimeoutMs: 1000 }]) {
    assert.throws(() => createProgressClock(policy));
  }
  assert.throws(() => createProgressClock({ totalTimeoutMs: 1000, idleTimeoutMs: 1000 }, { now: null }));
  for (const value of [NaN, Infinity, '0']) assert.throws(() => createProgressClock({ totalTimeoutMs: 1000, idleTimeoutMs: 1000 }, { now: () => value }));
});

test('a thirty-minute task progresses beyond ten minutes but still expires at its total budget', () => {
  let time = 0;
  const policy = resolveTimeoutPolicy({ ...base, taskSize: 'large' });
  const clock = createProgressClock(policy, { now: () => time });
  for (let elapsedMinutes = 5; elapsedMinutes <= 25; elapsedMinutes += 5) {
    time = elapsedMinutes * minute;
    assert.equal(clock.expired(), null);
    assert.equal(clock.markProgress('model_output'), true);
    assert.equal(clock.snapshot().totalRemainingMs, (30 - elapsedMinutes) * minute);
    assert.equal(clock.snapshot().idleRemainingMs, 10 * minute);
  }
  time = 30 * minute;
  const timeout = clock.expired();
  assert.equal(timeout.kind, 'total');
  assert.equal(timeout.limitMs, 30 * minute);
  assert.equal(timeout.elapsedMs, 30 * minute);
  assert.equal(timeout.idleElapsedMs, 5 * minute);
  assert.equal(clock.markProgress('model_output'), false);
});

test('an explicit sixty-minute budget can progress until its fixed deadline without real waiting', () => {
  let time = 0;
  const policy = resolveTimeoutPolicy({ ...base, taskSize: 'large', totalTimeoutMs: 60 * minute, idleTimeoutMs: 15 * minute });
  const clock = createProgressClock(policy, { now: () => time });
  for (let elapsedMinutes = 10; elapsedMinutes <= 50; elapsedMinutes += 10) {
    time = elapsedMinutes * minute;
    assert.equal(clock.expired(), null);
    assert.equal(clock.markProgress('tool_completed'), true);
  }
  time = 60 * minute;
  assert.equal(clock.expired().kind, 'total');
  assert.equal(clock.expired().limitMs, 60 * minute);
  assert.equal(clock.snapshot().idleRemainingMs, 5 * minute);
  assert.equal(clock.snapshot().totalRemainingMs, 0);
});
