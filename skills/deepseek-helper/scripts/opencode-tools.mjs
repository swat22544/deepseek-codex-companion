import { appendFile, readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODES, TOOL_NAMES, createToolRuntime } from './helper-policy.mjs';

export const MAX_LINE_BYTES = 1024 * 1024;
const protocolVersions = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const objectSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const definitions = {
  helper_list_files: {
    description: 'List immutable supervisor-selected snapshots. Use file IDs in read and search calls.',
    inputSchema: objectSchema({}),
  },
  helper_read_file: {
    description: 'Read numbered lines from a supplied snapshot; no live filesystem access. Cite file ID and line numbers.',
    inputSchema: objectSchema({ file: string, startLine: { type: 'integer', minimum: 1 }, lineCount: { type: 'integer', minimum: 1, maximum: 300 } }, ['file']),
  },
  helper_search_text: {
    description: 'Search literal text across supplied snapshots, or one file ID. Returns at most 60 locations.',
    inputSchema: objectSchema({ query: { type: 'string', minLength: 1, maxLength: 200 }, file: string }, ['query']),
  },
  helper_write_artifact: {
    description: 'Save a NEW candidate in the isolated artifact directory. It is never applied or executed. Use a new flat filename for revisions.',
    inputSchema: objectSchema({ name: string, content: string }, ['name', 'content']),
  },
};
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validatePolicy(policy) {
  if (!plainObject(policy) || !MODES.has(policy.mode)
    || !Number.isInteger(policy.maxToolCalls) || policy.maxToolCalls < 1 || policy.maxToolCalls > 80
    || !Number.isSafeInteger(policy.deadline) || policy.deadline < 0
    || typeof policy.nonce !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(policy.nonce)
    || !Array.isArray(policy.files) || policy.files.length > 80
    || (policy.mode === 'text' && policy.files.length)
    || typeof policy.artifactDir !== 'string' || !isAbsolute(policy.artifactDir)) {
    throw new Error('INVALID_POLICY');
  }
  const ids = new Set();
  let bytes = 0;
  for (const file of policy.files) {
    if (!plainObject(file) || typeof file.id !== 'string' || !/^f[1-9][0-9]*$/.test(file.id) || ids.has(file.id)
      || typeof file.name !== 'string' || !file.name || /[\\/\0]/.test(file.name)
      || typeof file.content !== 'string' || file.content.includes('\0')
      || !Number.isInteger(file.bytes) || file.bytes < 0 || file.bytes > 256 * 1024 || Buffer.byteLength(file.content) > 256 * 1024
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('INVALID_POLICY');
    ids.add(file.id);
    bytes += Math.max(file.bytes, Buffer.byteLength(file.content));
  }
  if (bytes > 2 * 1024 * 1024) throw new Error('INVALID_POLICY');
}

const jsonError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const jsonResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const toolError = (id, code) => jsonResult(id, {
  content: [{ type: 'text', text: JSON.stringify({ error: { code } }) }],
  isError: true,
});
function errorClass(error) {
  const message = error?.message;
  if (message === 'Tool-call budget exceeded. Return current findings to the supervisor.') return 'TOOL_BUDGET_EXCEEDED';
  if (message === 'Invocation deadline exceeded.') return 'DEADLINE_EXCEEDED';
  if (message === 'Unknown file ID; only supervisor-provided snapshots are accessible.') return 'UNKNOWN_FILE_ID';
  if (message === 'Artifact budget exceeded.') return 'ARTIFACT_BUDGET_EXCEEDED';
  if (message === 'Artifact name already used; choose a new revision filename.') return 'ARTIFACT_ALREADY_EXISTS';
  if (new Set([
    'Use a positive startLine and 1–300 lineCount.',
    'query must be a nonempty literal string up to 200 characters.',
    'Use a safe flat artifact filename.',
    'Unsupported candidate artifact extension.',
    'Artifact content must be text.',
  ]).has(message)) return 'INVALID_TOOL_ARGUMENTS';
  return 'TOOL_EXECUTION_FAILED';
}

function validArguments(args, schema) {
  if (!plainObject(args) || Object.keys(args).some(key => !Object.hasOwn(schema.properties, key))) return false;
  if (schema.required.some(key => !Object.hasOwn(args, key))) return false;
  return Object.entries(args).every(([key, value]) => {
    const rule = schema.properties[key];
    if (rule.type === 'string') return typeof value === 'string' && (rule.minLength === undefined || value.length >= rule.minLength) && (rule.maxLength === undefined || value.length <= rule.maxLength);
    return Number.isInteger(value) && value >= rule.minimum && (rule.maximum === undefined || value <= rule.maximum);
  });
}

// The queue covers the audit AND execution: even concurrent callers cannot reorder
// tool_start/tool_end records or run candidates after an audit failure.
export async function createMcpHandler(policy, { audit = async () => {} } = {}) {
  validatePolicy(policy);
  const privatePolicy = structuredClone(policy);
  const runtime = createToolRuntime(privatePolicy);
  const emit = record => audit({ nonce: privatePolicy.nonce, ...record });
  try { await emit({ event: 'active', pid: process.pid, mode: privatePolicy.mode, allowedTools: [...runtime.allowed] }); }
  catch { throw new Error('AUDIT_UNAVAILABLE'); }
  let queue = Promise.resolve(), auditFailed = false, toolAttempts = 0;

  async function dispatch(message) {
    if (!plainObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
      || (Object.hasOwn(message, 'id') && !((typeof message.id === 'string' && message.id.length <= 256) || (typeof message.id === 'number' && Number.isFinite(message.id))))) {
      return jsonError(null, -32600, 'Invalid Request');
    }
    // Notifications must not be allowed to create unacknowledged tool side effects.
    if (!Object.hasOwn(message, 'id')) return null;
    const id = message.id;
    if (auditFailed) return jsonError(id, -32603, 'Audit unavailable');
    const params = message.params ?? {};
    if (!plainObject(params)) return jsonError(id, -32602, 'Invalid params');
    if (message.method === 'initialize') {
      return jsonResult(id, {
        protocolVersion: protocolVersions.has(params.protocolVersion) ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'codex-deepseek-helper', version: '1.0.0' },
        instructions: 'Only supervisor-selected snapshots and isolated candidate artifacts are accessible. Candidate files require independent supervisor review.',
      });
    }
    if (message.method === 'ping') return jsonResult(id, {});
    if (message.method === 'tools/list') return jsonResult(id, { tools: runtime.allowed.map(name => ({ name, ...definitions[name] })) });
    if (message.method !== 'tools/call') return jsonError(id, -32601, 'Method not found');
    const tool = params.name;
    if (typeof tool !== 'string' || !TOOL_NAMES.includes(tool) || !runtime.allowed.includes(tool)) return toolError(id, 'TOOL_NOT_AUTHORIZED');
    const callId = randomUUID();
    try { await emit({ event: 'tool_start', callId, tool }); }
    catch { auditFailed = true; return jsonError(id, -32603, 'Audit unavailable'); }
    let result, code;
    const args = params.arguments ?? {};
    if (++toolAttempts > privatePolicy.maxToolCalls) code = 'TOOL_BUDGET_EXCEEDED';
    else if (Date.now() > privatePolicy.deadline) code = 'DEADLINE_EXCEEDED';
    else if (!validArguments(args, definitions[tool].inputSchema)) code = 'INVALID_TOOL_ARGUMENTS';
    else {
      try { result = await runtime.execute(tool, args); }
      catch (error) { code = errorClass(error); }
    }
    try { await emit({ event: 'tool_end', callId, tool, status: code ? 'error' : 'completed', ...(code ? { errorCode: code } : {}) }); }
    catch { auditFailed = true; return jsonError(id, -32603, 'Audit unavailable'); }
    return code ? toolError(id, code) : jsonResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
  }
  return message => {
    const response = queue.then(() => dispatch(message));
    queue = response.catch(() => {});
    return response;
  };
}

// Read byte-bounded lines without readline's unbounded accumulation. A large line
// is discarded through its delimiter, then normal protocol handling resumes.
export async function serveStdio(handle, input = process.stdin, output = process.stdout) {
  // Writable reports failures both to its write callback and as an error event.
  // Handle the event too, so a closed client cannot cause an unredacted stack dump.
  const outputError = () => {};
  output.on('error', outputError);
  const write = response => new Promise((accept, reject) => {
    output.write(JSON.stringify(response) + '\n', error => error ? reject(new Error('OUTPUT_UNAVAILABLE')) : accept());
  });
  const line = Buffer.allocUnsafe(MAX_LINE_BYTES);
  let size = 0, oversized = false;
  async function finishLine() {
    if (oversized) await write(jsonError(null, -32600, 'Request line too large'));
    else if (size) {
      let message;
      try { message = JSON.parse(line.subarray(0, size).toString('utf8')); }
      catch { await write(jsonError(null, -32700, 'Parse error')); size = 0; return; }
      let response;
      try { response = await handle(message); }
      catch { response = jsonError(null, -32603, 'Internal error'); }
      if (response !== null) await write(response);
    }
    size = 0; oversized = false;
  }
  try {
    for await (const raw of input) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        const length = end - start;
        if (!oversized && size + length > MAX_LINE_BYTES) { oversized = true; size = 0; }
        if (!oversized && length) { chunk.copy(line, size, start, end); size += length; }
        if (newline >= 0) await finishLine();
        start = newline < 0 ? chunk.length : newline + 1;
      }
    }
    if (size || oversized) await finishLine();
  } finally { output.off('error', outputError); }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv.some(path => !isAbsolute(path))) throw new Error('INVALID_STARTUP_ARGUMENTS');
  const [policyPath, auditPath] = argv;
  if ((await stat(policyPath)).size > 8 * 1024 * 1024) throw new Error('INVALID_POLICY');
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  const handle = await createMcpHandler(policy, { audit: record => appendFile(auditPath, JSON.stringify(record) + '\n', { encoding: 'utf8' }) });
  await serveStdio(handle);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stderr.on('error', () => {});
  main().catch(() => { process.stderr.write('HELPER_MCP_FAILED\n'); process.exitCode = 1; });
}
