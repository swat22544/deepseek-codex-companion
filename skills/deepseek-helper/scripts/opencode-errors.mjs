// OpenCode 2.0.28 SessionError/toSessionError categories. Provider text is
// inspected only in memory: no original message, body, headers or URL survives.
export const ERROR_TYPES=Object.freeze(['unknown','aborted','permission.rejected','tool.execution','provider.rate-limit','provider.auth','provider.quota','provider.content-filter','provider.transport','provider.internal','provider.invalid-output','provider.invalid-request','provider.unsupported-operation','provider.no-route','provider.unknown','provider.timeout']);
export const ERROR_REASONS=Object.freeze(['connection_reset','connection_refused','dns_failure','tls_failure','stream_interrupted','request_timeout','rate_limited','quota_exceeded','context_length_exceeded','missing_reasoning_content','invalid_tool_call','invalid_api_key','permission_denied','cancelled','provider_unavailable']);
const types=new Set(ERROR_TYPES),sources=new Set(['cli','http','session']);
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
  const text=[value?.message,value?.response?.body].filter(v=>typeof v==='string').map(v=>v.slice(0,8192)).join('\n');
  const reason=reasons.find(([,pattern])=>pattern.test(text))?.[0]??null;
  return {type,httpStatus,source,reason};
}
export function hasUsefulDiagnostic(value) {return !!value&&(value.type!=='unknown'||value.httpStatus!==null||value.reason!==null);}

export function isRecoveryEligible({failed,timeout,auditError,policyActive,mcpActive,modelRequests,sessionID,verifiedSessionID,cleanup,cliErrorSeen,exitCode}={}) {
  return !!failed&&!timeout&&!auditError&&policyActive===true&&mcpActive===true
    &&Number.isInteger(modelRequests)&&modelRequests>0&&typeof sessionID==='string'&&sessionID===verifiedSessionID
    &&cleanup?.incomplete===false&&(cliErrorSeen===true||(Number.isInteger(exitCode)&&exitCode!==0));
}

const timeoutError=()=>Object.assign(new Error('Diagnostic lookup timed out.'),{diagnosticTimeout:true});
// Query each operation with its own remaining limit. The race bounds test or
// transport implementations that never settle; the production query additionally
// kills only its own short-lived read-only CLI process tree at this limit.
async function boundedQuery(query,operation,params,deadline,now) {
  const remaining=deadline-now();if(remaining<=0)throw timeoutError();
  let timer;
  try{return await Promise.race([query(operation,params,remaining),new Promise((_,reject)=>{timer=setTimeout(()=>reject(timeoutError()),remaining);})]);}
  finally{clearTimeout(timer);}
}

export async function recoverErrorDiagnostic({failed,eligible,details,sessionID,agent,model,location,query,timeoutMs=5000,maxPages=3,pageSize=20,now=Date.now}={}) {
  const result=(status,checkedMessages=0,errorDetails=details??null)=>({errorDetails,diagnosticRecovery:{status,checkedMessages}});
  if(!failed||hasUsefulDiagnostic(details))return result('not_needed');
  if(!eligible||typeof sessionID!=='string'||!/^ses_[A-Za-z0-9_-]+$/.test(sessionID)||typeof query!=='function')return result('skipped');
  const deadline=now()+Math.min(Math.max(1,timeoutMs),5000);let checked=0;
  const normalize=value=>typeof value==='string'?value.replaceAll('\\','/').replace(/\/+$/,'').toLowerCase():null;
  try {
    const session=(await boundedQuery(query,'session.get',{sessionID},deadline,now))?.data;
    if(session?.id!==sessionID||session.agent!==agent||session.model?.providerID!==model?.providerID||session.model?.id!==model?.id||session.model?.variant!==model?.variant||normalize(session.location?.directory)!==normalize(location)||!normalize(location))return result('failed',checked);
    const seen=new Set(),ids=new Set();let cursor;
    for(let page=0;page<Math.min(maxPages,3);page++) {
      const response=await boundedQuery(query,'session.message.list',{sessionID,limit:Math.min(pageSize,20),...(cursor?{cursor}:{order:'desc'})},deadline,now);
      if(!Array.isArray(response?.data)||response.data.length>Math.min(pageSize,20))return result('failed',checked);
      // The API scopes messages by path; message rows have no sessionID field.
      // Validate the owning session above, and any explicit identity if supplied.
      for(const message of response.data) {
        checked++;
        if(typeof message?.id!=='string'||ids.has(message.id)||(message.sessionID!==undefined&&message.sessionID!==sessionID))return result('failed',checked);
        ids.add(message.id);
        if(message.type==='assistant') {
          if(message.agent!==agent||message.model?.providerID!==model.providerID||message.model?.id!==model.id||message.model?.variant!==model.variant)return result('failed',checked);
          // Only a terminal assistant error is eligible. Retry errors describe
          // earlier attempts and must never be assigned to the current failure.
          if(message.error) {
            const recovered=classifyError(message.error,'session');
            return hasUsefulDiagnostic(recovered)?result('recovered',checked,recovered):result('unavailable',checked);
          }
          // A newer unfinished or successful assistant prevents reusing an old
          // attempt's failure from a previous page or earlier request.
          return result('unavailable',checked);
        }
        if(message.type==='idle') {
          if(message.outcome!=='failed'||!message.error)return result('unavailable',checked);
          const recovered=classifyError(message.error,'session');
          return hasUsefulDiagnostic(recovered)?result('recovered',checked,recovered):result('unavailable',checked);
        }
      }
      const next=response.cursor?.next;if(!next)return result('unavailable',checked);
      if(typeof next!=='string'||seen.has(next))return result('failed',checked);
      seen.add(next);cursor=next;
    }
    return result('unavailable',checked);
  } catch(error) {
    return result(error?.diagnosticTimeout===true?'timed_out':'failed',checked);
  }
}
