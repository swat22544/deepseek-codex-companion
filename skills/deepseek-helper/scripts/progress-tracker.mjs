// Recognize fresh, current-attempt output. The caller authenticates the control
// nonce first. This module receives counts and identities, never hidden text.
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;

export function createStreamProgressTracker(onProgress) {
  let session = null, turn = null, current = null, revision = 0;
  const attempts = new Set(), pending = [];
  function accept(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
    if (!['start','output_delta','end'].includes(event.type)) return false;
    if (!identity(event.sessionId) || !identity(event.attemptId) || !integer(event.revision, 1)) return false;
    if (!session || turn === null) {
      // stdout and stderr can be delivered in either order. Keep a bounded,
      // metadata-only prefix until the actual session and turn are confirmed.
      if (pending.length < 256) pending.push({type:event.type,sessionId:event.sessionId,attemptId:event.attemptId,revision:event.revision,
        turn:event.turn,step:event.step,index:event.index,blockIndex:event.blockIndex,time:event.time,deltaKind:event.deltaKind,charCount:event.charCount,
        ...(event.type==='end'?{outcome:{kind:event.outcome?.kind,eventType:event.outcome?.eventType,seq:event.outcome?.seq}}:{})});
      return false;
    }
    if (event.sessionId !== session || event.revision <= revision) return false;
    if (event.type === 'start') {
      if (current || attempts.has(event.attemptId) || event.turn !== turn || !integer(event.step, 1)) return false;
      attempts.add(event.attemptId); revision = event.revision;
      current = {id:event.attemptId, index:-1};
      return false;
    }
    if (!current || event.attemptId !== current.id || !integer(event.index) || event.index <= current.index) return false;
    if (event.type === 'output_delta') {
      if (!['text','reasoning'].includes(event.deltaKind) || !integer(event.charCount, 1) || !integer(event.blockIndex) || !integer(event.time)) return false;
      revision = event.revision; current.index = event.index;
      onProgress('model_output');
      return true;
    }
    if (event.type === 'end') {
      if (event.outcome?.kind !== 'abandoned' && !(event.outcome?.kind === 'committed' && ['assistant/message','assistant/attempt'].includes(event.outcome.eventType) && integer(event.outcome.seq))) return false;
      revision = event.revision; current = null;
    }
    return false;
  }
  function flush() { if (session && turn !== null) for (const event of pending.splice(0)) accept(event); }
  return {
    setSession(value) {
      if (!identity(value) || (session && session !== value)) return false;
      session = value; flush(); return true;
    },
    setTurn(value) {
      if (!integer(value, 1) || (turn !== null && turn !== value)) return false;
      turn = value; flush(); return true;
    },
    accept,
  };
}
