// Project only public reply text from DSH's process-local assistant stream.
// Never copy complete frames/chunks: they may contain private reasoning,
// provider replay state, or tool arguments.
export const MAX_REPLY_TEXT_CHARS = 8000;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;

function splitText(text) {
  const parts = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + MAX_REPLY_TEXT_CHARS, text.length);
    // Keep UTF-16 surrogate pairs in one event so each part renders correctly.
    const before = text.charCodeAt(end - 1), after = text.charCodeAt(end);
    if (end < text.length && before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

/** Return new allowlisted observer events; unsupported/malformed input yields []. */
export function projectReplyStream(sessionId, frame) {
  if (!identity(sessionId) || !record(frame) || !identity(frame.attemptId) || !integer(frame.revision, 1)) return [];
  const base = {sessionId, attemptId:frame.attemptId, revision:frame.revision};
  if (frame.type === 'start') {
    if (!integer(frame.turn, 1) || !integer(frame.step, 1)) return [];
    return [{type:'start', ...base, turn:frame.turn, step:frame.step}];
  }
  if (frame.type === 'chunk') {
    const chunk = frame.chunk;
    // Check the discriminator before ever reading any content field.
    if (!record(chunk) || chunk.type !== 'text-delta') return [];
    if (!integer(frame.index) || !integer(frame.time) || !integer(chunk.index) || typeof chunk.text !== 'string') return [];
    const parts = splitText(chunk.text);
    return parts.map((text, part) => ({type:'text_delta', ...base, index:frame.index, blockIndex:chunk.index, time:frame.time, part, parts:parts.length, text}));
  }
  if (frame.type === 'end') {
    if (!integer(frame.index) || !record(frame.outcome)) return [];
    const outcome = frame.outcome;
    if (outcome.kind === 'abandoned') return [{type:'end', ...base, index:frame.index, outcome:{kind:'abandoned'}}];
    if (outcome.kind !== 'committed' || !['assistant/message', 'assistant/attempt'].includes(outcome.eventType) || !integer(outcome.seq)) return [];
    return [{type:'end', ...base, index:frame.index, outcome:{kind:'committed', eventType:outcome.eventType, seq:outcome.seq}}];
  }
  return [];
}
