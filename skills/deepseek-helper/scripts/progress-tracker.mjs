// Recognize fresh, current-attempt output. The caller authenticates the control
// nonce first. This module receives counts and identities, never hidden text.
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const MAX_PENDING_ATTEMPTS = 256;

function metadata(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (!['start','output_delta','end'].includes(event.type)) return null;
  if (!identity(event.sessionId) || !identity(event.attemptId) || !integer(event.revision, 1)) return null;
  const base = {type:event.type,sessionId:event.sessionId,attemptId:event.attemptId,revision:event.revision};
  if (event.type === 'start') {
    if (!integer(event.turn, 1) || !integer(event.step, 1)) return null;
    return {...base,turn:event.turn};
  }
  if (!integer(event.index)) return null;
  if (event.type === 'output_delta') {
    if (!['text','reasoning'].includes(event.deltaKind) || !integer(event.charCount, 1) || !integer(event.blockIndex) || !integer(event.time)) return null;
    return {...base,index:event.index};
  }
  if (event.outcome?.kind !== 'abandoned' && !(event.outcome?.kind === 'committed' && ['assistant/message','assistant/attempt'].includes(event.outcome.eventType) && integer(event.outcome.seq))) return null;
  return {...base,index:event.index};
}

const state = () => ({attempts:new Set(),current:null,revision:0,output:false});
function apply(value, event) {
  if (event.revision <= value.revision) return false;
  if (event.type === 'start') {
    if (value.current || value.attempts.has(event.attemptId)) return false;
    value.attempts.add(event.attemptId);
    value.current = {id:event.attemptId,index:-1};
  } else {
    if (!value.current || event.attemptId !== value.current.id || event.index <= value.current.index) return false;
    if (event.type === 'end') value.current = null;
    else {value.current.index = event.index;value.output = true;}
  }
  value.revision = event.revision;
  return true;
}

export function createStreamProgressTracker(onProgress) {
  let session = null, turn = null, current = state(), pendingAttempts = 0;
  const pending = new Map();
  function accept(input) {
    const event = metadata(input);
    if (!event || (session && event.sessionId !== session)) return false;
    if (!session || turn === null) {
      // Validate the lifecycle as it arrives, then retain only its state and an
      // activity bit. Thousands of deltas cannot evict an end marker. Candidates
      // stay separate until stdout confirms the actual session and turn.
      let candidates = pending.get(event.sessionId);
      if (event.type === 'start') {
        if ((turn !== null && event.turn !== turn) || pendingAttempts >= MAX_PENDING_ATTEMPTS) return false;
        if ([...(candidates?.values() ?? [])].some(value=>value.attempts.has(event.attemptId))) return false;
        const candidate = candidates?.get(event.turn) ?? state();
        if (!apply(candidate,event)) return false;
        if (!candidates) pending.set(event.sessionId,candidates = new Map());
        candidates.set(event.turn,candidate);pendingAttempts++;
      } else {
        const candidate = [...(candidates?.values() ?? [])].find(value=>value.current?.id === event.attemptId);
        if (candidate) apply(candidate,event);
      }
      return false;
    }
    if ((event.type === 'start' && event.turn !== turn) || !apply(current,event)) return false;
    if (event.type === 'output_delta') {current.output = false;onProgress('model_output');return true;}
    return false;
  }
  function flush() {
    if (!session || turn === null) return;
    current = pending.get(session)?.get(turn) ?? current;
    pending.clear();pendingAttempts = 0;
    // Buffered activity all becomes known at this one instant. One idle-clock
    // update is sufficient; old frames are never replayed as future activity.
    if (current.output) {current.output = false;onProgress('model_output');}
  }
  function trimPending() {
    for (const [id,candidates] of pending) {
      for (const [number,candidate] of candidates) {
        if ((session && id !== session) || (turn !== null && number !== turn)) {
          pendingAttempts -= candidate.attempts.size;candidates.delete(number);
        }
      }
      if (!candidates.size) pending.delete(id);
    }
  }
  return {
    setSession(value) {
      if (!identity(value) || (session && session !== value)) return false;
      session = value; trimPending(); flush(); return true;
    },
    setTurn(value) {
      if (!integer(value, 1) || (turn !== null && turn !== value)) return false;
      turn = value; trimPending(); flush(); return true;
    },
    accept,
  };
}
