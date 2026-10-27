// Fixed diagnostic categories shared by controlled backends. Provider text is
// inspected only in memory: no original message, body, headers or URL survives.
export const ERROR_TYPES=Object.freeze(['unknown','aborted','permission.rejected','tool.execution','provider.rate-limit','provider.auth','provider.quota','provider.content-filter','provider.transport','provider.internal','provider.invalid-output','provider.invalid-request','provider.unsupported-operation','provider.no-route','provider.unknown','provider.timeout','supervisor.output-limit','supervisor.invalid-stream']);
export const ERROR_REASONS=Object.freeze(['connection_reset','connection_refused','dns_failure','tls_failure','stream_interrupted','request_timeout','rate_limited','quota_exceeded','context_length_exceeded','missing_reasoning_content','invalid_tool_call','invalid_api_key','permission_denied','cancelled','provider_unavailable','stream_size_limit','stream_line_limit','public_output_limit','protocol_size_limit','invalid_stream','invalid_stream_utf8','stream_processing_failed']);
const types=new Set(ERROR_TYPES),sources=new Set(['cli','http','session','guard']);
const streamFailures=Object.freeze({
  ZCODE_STREAM_LIMIT:['supervisor.output-limit','stream_size_limit'],
  ZCODE_STREAM_LINE_LIMIT:['supervisor.output-limit','stream_line_limit'],
  ZCODE_PUBLIC_OUTPUT_LIMIT:['supervisor.output-limit','public_output_limit'],
  ZCODE_STREAM_INVALID:['supervisor.invalid-stream','invalid_stream'],
  ZCODE_STREAM_UTF8:['supervisor.invalid-stream','invalid_stream_utf8'],
  ZCODE_STREAM_INTERRUPTED:['unknown','stream_interrupted'],
  ZCODE_STREAM_FAILURE:['unknown','stream_processing_failed'],
});
export function classifyStreamError(code){
  if(typeof code!=='string'||!Object.hasOwn(streamFailures,code))throw new Error('Unknown ZCode stream failure code.');
  const [type,reason]=streamFailures[code];return {type,httpStatus:null,source:'guard',reason};
}
const reasons=[
  ['missing_reasoning_content',/(?:missing|absent|required|must.*(?:include|contain)).{0,120}reasoning_content|reasoning_content.{0,120}(?:missing|absent|required)/i],
  ['context_length_exceeded',/context[_ -]length[_ -]exceeded|maximum context length|context window.{0,40}(?:exceed|limit)|too many tokens/i],
  ['invalid_api_key',/invalid[_ -]api[_ -]key|incorrect api key|api key.{0,30}(?:invalid|expired)|authentication (?:failed|fails)/i],
  ['connection_reset',/\bECONNRESET\b|connection reset|socket hang up/i],
  ['connection_refused',/\bECONNREFUSED\b|connection refused/i],
  ['dns_failure',/\b(?:ENOTFOUND|EAI_AGAIN)\b|dns (?:lookup|resolution).{0,30}(?:failed|failure)|getaddrinfo/i],
  ['tls_failure',/\b(?:CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID)\b|certificate (?:verify|verification).{0,20}fail|TLS handshake.{0,20}fail/i],
  ['stream_interrupted',/provider response ended unexpectedly|stream (?:ended|closed|disconnected).{0,30}(?:unexpected|premature)|event stream disconnected|premature close/i],
  ['request_timeout',/\b(?:ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)\b|request timed out|connection timed out|timeout exceeded/i],
  ['rate_limited',/rate[_ -]limit|too many requests/i],
  ['quota_exceeded',/insufficient[_ -](?:quota|balance)|quota.{0,30}(?:exceed|exhaust)|balance.{0,30}(?:insufficient|exhaust)/i],
  ['invalid_tool_call',/invalid.{0,40}(?:tool.call|function.call|tool.arguments)|(?:tool.call|function.call).{0,40}(?:invalid|malformed)/i],
  ['permission_denied',/permission (?:denied|rejected)|access denied/i],
  ['cancelled',/\b(?:request|session|operation) (?:cancelled|canceled|aborted)\b/i],
  ['provider_unavailable',/service unavailable|server overloaded|overloaded_error|upstream unavailable/i],
];
export function classifyError(value,source) {
  if(!sources.has(source))throw new Error('Invalid diagnostic source.');
  const type=types.has(value?.type)?value.type:'unknown';
  const httpStatus=Number.isInteger(value?.status)&&value.status>=100&&value.status<=599?value.status:null;
  // ZCode wraps causes in these fixed fields. Inspect bounded strings in memory,
  // projecting only a known reason; arbitrary data/stack/headers are excluded.
  const text=[value?.message,value?.response?.body,value?.code,value?.detail,value?.underlyingErrorMessage,value?.underlyingErrorDetail].filter(v=>typeof v==='string').map(v=>v.slice(0,8192)).join('\n');
  const reason=reasons.find(([,pattern])=>pattern.test(text))?.[0]??null;
  return {type,httpStatus,source,reason};
}
export function hasUsefulDiagnostic(value) {return !!value&&(value.type!=='unknown'||value.httpStatus!==null||value.reason!==null);}
