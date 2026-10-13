import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

// This module only checks saved evidence. It never loads the runner or monitor,
// invokes a model, reads candidate files, applies edits, or executes candidates.
const MODEL = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' });
const OPENCODE_MODEL = Object.freeze({ ...MODEL, provider: 'deepseek' });
const TYPES = new Set(['array', 'object', 'string', 'number', 'integer', 'boolean', 'null']);
const CONTRACT_KEYS = new Set(['format', 'type', 'requiredKeys', 'allowedKeys', 'uniqueItems', 'expected']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const owns = (value, key) => Object.hasOwn(value, key);
const issue = (code, path, message) => ({ code, path, message });
const jsonValue = (value, seen = new Set()) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  seen.add(value);
  const okay = Array.isArray(value)
    ? Object.keys(value).length === value.length && Array.from(value).every(item => jsonValue(item, seen))
    : Object.values(value).every(item => jsonValue(item, seen));
  seen.delete(value);
  return okay;
};
const matchesType = (value, type) => type === 'null' ? value === null
  : type === 'array' ? Array.isArray(value)
  : type === 'object' ? record(value)
  : type === 'integer' ? Number.isInteger(value)
  : typeof value === type;
// JSON normalizes object prototypes and negative zero; key order is irrelevant,
// while array order and all JSON value types remain significant.
const equalJson = (left, right) => isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));

export function validateContract(contract) {
  const issues = [];
  if (!record(contract) || !jsonValue(contract)) return [issue('contract_shape', '$contract', 'Contract must be a finite, acyclic JSON object.')];
  for (const key of Object.keys(contract)) if (!CONTRACT_KEYS.has(key)) issues.push(issue('contract_unknown_key', `$contract.${key}`, 'Unknown contract option; this is not JSON Schema.'));
  if (contract.format !== 'json') issues.push(issue('contract_format', '$contract.format', 'Only format "json" is supported.'));
  if (!TYPES.has(contract.type)) issues.push(issue('contract_type', '$contract.type', 'An explicit supported JSON type is required.'));
  for (const key of ['requiredKeys', 'allowedKeys']) if (owns(contract, key)) {
    if (contract.type !== 'object' || !Array.isArray(contract[key]) || contract[key].some(item => typeof item !== 'string') || new Set(contract[key]).size !== contract[key].length) {
      issues.push(issue('contract_keys', `$contract.${key}`, 'Key constraints require type "object" and an array of unique strings.'));
    }
  }
  if (Array.isArray(contract.requiredKeys) && Array.isArray(contract.allowedKeys) && contract.requiredKeys.some(key => !contract.allowedKeys.includes(key))) {
    issues.push(issue('contract_inconsistent_keys', '$contract.requiredKeys', 'Every required key must also be allowed when allowedKeys is supplied.'));
  }
  if (owns(contract, 'uniqueItems') && (contract.type !== 'array' || typeof contract.uniqueItems !== 'boolean')) issues.push(issue('contract_unique', '$contract.uniqueItems', 'uniqueItems requires type "array" and a boolean.'));
  if (owns(contract, 'expected') && TYPES.has(contract.type) && !matchesType(contract.expected, contract.type)) issues.push(issue('contract_expected_type', '$contract.expected', 'Expected value must match the declared type.'));
  if (!issues.length && owns(contract, 'expected')) {
    const inconsistent = checkValue(contract.expected, contract).filter(entry => entry.code !== 'expected_mismatch');
    if (inconsistent.length) issues.push(issue('contract_expected_constraints', '$contract.expected', 'Expected value contradicts the declared key or uniqueness constraints.'));
  }
  return issues;
}

function checkValue(value, contract) {
  const issues = [];
  if (!matchesType(value, contract.type)) issues.push(issue('type_mismatch', 'final.text', `Parsed JSON must have type ${contract.type}.`));
  if (record(value) && contract.type === 'object') {
    if (contract.requiredKeys?.some(key => !owns(value, key))) issues.push(issue('missing_keys', 'final.text', 'At least one required top-level key is missing.'));
    if (contract.allowedKeys && Object.keys(value).some(key => !contract.allowedKeys.includes(key))) issues.push(issue('unexpected_keys', 'final.text', 'At least one top-level key is not allowed.'));
  }
  if (Array.isArray(value) && contract.uniqueItems === true && value.some((item, index) => value.slice(0, index).some(previous => equalJson(item, previous)))) {
    issues.push(issue('duplicate_items', 'final.text', 'The array contains duplicate JSON values.'));
  }
  if (owns(contract, 'expected') && !equalJson(value, contract.expected)) issues.push(issue('expected_mismatch', 'final.text', 'Parsed JSON differs from the independently supplied expected value.'));
  return issues;
}

export function verifyResult(input, contract) {
  // Evaluation fixtures wrap the raw runner output in .result; ordinary delegate
  // files contain the result directly. Never mask an explicit top-level failure.
  const result = record(input) && !owns(input, 'ok') && owns(input, 'result') ? input.result : input;
  const protocolIssues = [];
  const errors = [];
  const add = (code, path, message) => protocolIssues.push(issue(code, path, message));
  if (!record(result)) add('result_shape', '$', 'Result must be a JSON object, or an evaluation envelope containing a result object.');
  else {
    const backend=owns(result,'backend')?result.backend:'harness';
    if(!['harness','opencode'].includes(backend))add('backend_unsupported','backend','Backend must be harness or opencode; omitted legacy results use harness.');
    const expectedModel=backend==='opencode'?OPENCODE_MODEL:MODEL;
    if(backend==='opencode'&&result.runtimeEvidenceVerified!==true)add('runtime_evidence_unverified','runtimeEvidenceVerified','OpenCode model and permission evidence must explicitly be verified at runtime.');
    if (result.ok !== true) add('runner_not_ok', 'ok', 'Runner must explicitly report ok: true.');
    if (result.policyActive !== true) add('guard_unverified', 'policyActive', 'Supervisor guard activation is not confirmed.');
    if (result.modelSelectionVerified !== true) add('model_unverified', 'modelSelectionVerified', 'Live model selection is not recorded as verified.');
    if (!record(result.modelSelection) || Object.entries(expectedModel).some(([key, value]) => result.modelSelection[key] !== value)) add('model_mismatch', 'modelSelection', `Expected ${expectedModel.provider} / deepseek-flash / max.`);
    if (!Number.isInteger(result.modelRequests) || result.modelRequests < 1) add('model_requests', 'modelRequests', 'At least one verified model request is required.');
    if (result.exitCode !== 0) add('exit_code', 'exitCode', 'Runner exit code must be numeric zero.');
    if (result.stopReason?.kind !== 'completed') add('not_completed', 'stopReason.kind', 'The delegated turn must have completed.');
    if (!record(result.cleanup) || result.cleanup.incomplete !== false) add('cleanup_unverified', 'cleanup.incomplete', 'Cleanup must explicitly report incomplete: false.');
    if (result.cleanup?.requested === true && result.cleanup.treeKillConfirmed !== true) add('cleanup_unconfirmed', 'cleanup.treeKillConfirmed', 'Requested tree termination must be confirmed.');
    if (typeof result.sessionId !== 'string' || !result.sessionId.trim()) add('missing_session', 'sessionId', 'A nonempty recorded session ID is required.');
    if (result.error !== null && result.error !== undefined) add('runner_error', 'error', 'Runner reports an error.');
    if (result.trust !== 'unverified_candidate' || result.verificationRequired !== true) add('trust_contract', 'trust', 'Result must remain an unverified candidate requiring independent review.');
    if (result.final?.type !== 'final' || typeof result.final?.text !== 'string' || !result.final.text.trim()) add('missing_final', 'final', 'A nonempty final text response is required.');
    if (!Array.isArray(result.toolCalls) || !Array.isArray(result.toolResults)) add('tool_records', 'toolCalls/toolResults', 'Tool calls and results must both be arrays.');
    else {
      const calls = new Map();
      const completed = new Set();
      for (const [index, call] of result.toolCalls.entries()) {
        if (!record(call) || typeof call.callId !== 'string' || !call.callId || typeof call.tool !== 'string' || !call.tool || calls.has(call.callId)) add('tool_call_shape', `toolCalls[${index}]`, 'Malformed or duplicate tool call.');
        else calls.set(call.callId, call.tool);
      }
      for (const [index, entry] of result.toolResults.entries()) {
        if (!record(entry) || !calls.has(entry.callId) || completed.has(entry.callId) || !['completed', 'error'].includes(entry.status)) add('tool_result_shape', `toolResults[${index}]`, 'Malformed, duplicate or unmatched tool result.');
        else {
          completed.add(entry.callId);
          if (entry.status === 'error') errors.push({ callId: entry.callId, tool: calls.get(entry.callId), status: 'error' });
        }
      }
      if ([...calls.keys()].some(id => !completed.has(id))) add('tool_result_missing', 'toolResults', 'At least one tool call lacks a matching result.');
    }
  }
  let contractReport = { status: 'not_requested', issues: [] };
  if (contract !== undefined) {
    const invalid = validateContract(contract);
    if (invalid.length) contractReport = { status: 'invalid', issues: invalid };
    else {
      let value;
      let parseError = false;
      try {
        if (typeof result?.final?.text !== 'string') throw new Error('Missing text');
        value = JSON.parse(result.final.text);
        // JSON.parse can produce Infinity for an overflowing numeric literal.
        if (!jsonValue(value)) throw new Error('Non-finite number');
      } catch { parseError = true; }
      const issues = parseError ? [issue('strict_json', 'final.text', 'Entire final text must parse as one finite JSON value; no fences, trailing prose or extraction is allowed.')] : checkValue(value, contract);
      contractReport = { status: issues.length ? 'failed' : 'passed', issues };
    }
  }
  return {
    mechanicalOk: !protocolIssues.length && !errors.length && ['not_requested', 'passed'].includes(contractReport.status),
    protocol: { ok: !protocolIssues.length, issues: protocolIssues },
    contract: contractReport,
    tools: { ok: !errors.length, errors },
    trust: 'unverified_candidate',
    independentReviewRequired: true,
    semanticAcceptance: false,
    note: 'Checks recorded evidence and an optional local contract only. It cannot authenticate the record or validate factual claims, source citations, reasoning, candidates, tests, or outcomes not specified by the contract.',
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node verify-result.mjs RESULT.json [--contract CONTRACT.json]\nAccepts raw delegate output or an evaluation envelope with .result.\nExit codes: 0 mechanical checks passed; 1 check failed; 2 invalid CLI/file/contract.\nNo model calls, candidate execution, edits, output repair, or semantic acceptance.\nSee references/verification-contract.md.');
    return 0;
  }
  try {
    if (![1, 3].includes(args.length) || args[0].startsWith('--') || (args.length === 3 && (args[1] !== '--contract' || args[2].startsWith('--')))) throw new Error('Usage: node verify-result.mjs RESULT.json [--contract CONTRACT.json]');
    const readJson = async name => JSON.parse((await readFile(resolve(name), 'utf8')).replace(/^\uFEFF/, ''));
    const result = await readJson(args[0]);
    const contract = args.length === 3 ? await readJson(args[2]) : undefined;
    const report = verifyResult(result, contract);
    console.log(JSON.stringify(report, null, 2));
    return report.contract.status === 'invalid' ? 2 : report.mechanicalOk ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ mechanicalOk: false, inputError: error.message, independentReviewRequired: true, semanticAcceptance: false }));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
