import { readFile, lstat, realpath, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateTimeoutOptions } from './timeout-policy.mjs';

export const MODEL = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' });
export const MODES = new Set(['text', 'inspect', 'propose']);
const TASKS = new Set(['extract', 'classify', 'format', 'draft', 'analyze', 'review', 'debug', 'plan', 'implement', 'test-design']);
export const TOOL_NAMES = ['helper_list_files', 'helper_read_file', 'helper_search_text', 'helper_write_artifact'];
export const hash = value => createHash('sha256').update(value).digest('hex');

export function validateRequest(request) {
  if (!request || !TASKS.has(request.taskType)) throw new Error('Unsupported taskType. See references/request.md.');
  if (typeof request.instruction !== 'string' || !request.instruction.trim() || typeof request.input !== 'string') throw new Error('instruction and input must be strings; instruction must not be empty.');
  const mode = request.mode ?? 'text';
  if (!MODES.has(mode)) throw new Error('mode must be text, inspect, or propose.');
  const feedback = request.feedback ?? '';
  if (typeof feedback !== 'string' || Buffer.byteLength(request.instruction + request.input + feedback) > 96000) throw new Error('Task text and feedback must fit within 96 KB.');
  validateTimeoutOptions(request);
  const maxToolCalls = request.maxToolCalls ?? 24;
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 80) throw new Error('maxToolCalls must be 1–80.');
  const files = request.files ?? [];
  if (!Array.isArray(files) || files.length > 80 || files.some(p => typeof p !== 'string' || !isAbsolute(p))) throw new Error('files must contain at most 80 absolute file paths.');
  if (mode === 'text' && files.length) throw new Error('Use inspect or propose mode to supply files.');
  return { ...request, mode, feedback, maxToolCalls, files };
}

function sensitivePath(path) {
  const parts = path.replaceAll('\\', '/').toLowerCase().split('/');
  const file = parts.at(-1);
  return parts.some(p => ['.ssh', '.gnupg', '.git'].includes(p))
    || (/^\.env(?:\.|$)/.test(file) && !/\.(example|sample|template)$/.test(file))
    || /^(?:\.credentials\.(?:yaml|yml|json)|credentials(?:\.(?:yaml|yml|json))?|id_rsa|id_ed25519|cookies|login data)$/.test(file)
    || /\.(?:pem|key|p12|pfx|kdbx)$/.test(file);
}

export async function snapshotFiles(paths) {
  let total = 0;
  const files = [];
  const seen = new Set();
  for (const source of paths) {
    if (sensitivePath(source)) throw new Error(`Refusing credential-like input: ${basename(source)}`);
    const canonical = await realpath(source);
    if (sensitivePath(canonical)) throw new Error('Snapshot target resolves to a credential-like path.');
    const stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Snapshot input must be a regular file: ${source}`);
    if (stat.size > 256 * 1024) throw new Error(`Snapshot file exceeds 256 KiB: ${basename(source)}`);
    if (seen.has(canonical.toLowerCase())) continue;
    seen.add(canonical.toLowerCase());
    const bytes = await readFile(canonical);
    total += bytes.length;
    if (bytes.length > 256 * 1024 || total > 2 * 1024 * 1024) throw new Error('Snapshot size limit exceeded (256 KiB/file, 2 MiB total).');
    if (bytes.includes(0)) throw new Error(`Binary input rejected: ${basename(source)}`);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    files.push({ id: `f${files.length + 1}`, name: basename(source), source: canonical, bytes: bytes.length, sha256: hash(bytes), content });
  }
  return files;
}

export function publicManifest(files) {
  return files.map(({id,name,bytes,sha256}) => ({id,name,bytes,sha256}));
}

export function createToolRuntime(policy, audit = () => {}) {
  if (!MODES.has(policy.mode) || !Array.isArray(policy.files) || !Number.isInteger(policy.maxToolCalls)) throw new Error('Invalid invocation policy.');
  const allowed = policy.mode === 'text' ? [] : TOOL_NAMES.slice(0, policy.mode === 'propose' ? 4 : 3);
  let calls = 0, artifactBytes = 0;
  const artifacts = new Map();
  const source = id => {
    const match = policy.files.find(f => f.id === id);
    if (!match) throw new Error('Unknown file ID; only supervisor-provided snapshots are accessible.');
    return match;
  };
  async function execute(name, args) {
    if (!allowed.includes(name)) throw new Error('Tool is not authorized for this invocation.');
    if (++calls > policy.maxToolCalls) throw new Error('Tool-call budget exceeded. Return current findings to the supervisor.');
    if (Date.now() > policy.deadline) throw new Error('Invocation deadline exceeded.');
    args ??= {};
    let result;
    if (name === 'helper_list_files') result = publicManifest(policy.files);
    if (name === 'helper_read_file') {
      const file = source(args.file);
      const start = args.startLine ?? 1, count = args.lineCount ?? 160;
      if (!Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1 || count > 300) throw new Error('Use a positive startLine and 1–300 lineCount.');
      const lines = file.content.split(/\r?\n/);
      const selected = [], truncatedLines = []; let size = 0;
      for (let i = start - 1; i < Math.min(lines.length, start - 1 + count); i++) {
        const raw = lines[i];
        const line = `${i + 1}: ${raw.slice(0,6000)}`;
        if (raw.length > 6000) truncatedLines.push(i+1);
        if (size + Buffer.byteLength(line) > 32000) break;
        selected.push(line); size += Buffer.byteLength(line);
      }
      result = { file: file.id, name: file.name, sha256: file.sha256, totalLines: lines.length, text: selected.join('\n'), truncatedLines, nextLine: start - 1 + selected.length < lines.length ? start + selected.length : null };
    }
    if (name === 'helper_search_text') {
      if (typeof args.query !== 'string' || !args.query || args.query.length > 200) throw new Error('query must be a nonempty literal string up to 200 characters.');
      const files = args.file ? [source(args.file)] : policy.files;
      const matches = [];
      for (const file of files) {
        const lines = file.content.split(/\r?\n/);
        for (let i=0; i<lines.length && matches.length<60; i++) if (lines[i].includes(args.query)) matches.push({file:file.id,line:i+1,text:lines[i].slice(0,400)});
      }
      result = {matches,limit:60};
    }
    if (name === 'helper_write_artifact') {
      const file = args.name;
      // Flat, portable names only; no traversal, alternate streams, devices, or executable launchers.
      if (typeof file !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(file) || /[. ]$/.test(file) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file)) throw new Error('Use a safe flat artifact filename.');
      if (!/\.(txt|md|json|patch|diff|py|js|mjs|cjs|ts|tsx|jsx|html|css|svg|yml|yaml|toml|csv|sql|rs|go|java|c|h|cpp|cs|sh|ps1)$/i.test(file)) throw new Error('Unsupported candidate artifact extension.');
      if (typeof args.content !== 'string' || args.content.includes('\0')) throw new Error('Artifact content must be text.');
      const bytes = Buffer.byteLength(args.content);
      if (artifacts.has(file)) throw new Error('Artifact name already used; choose a new revision filename.');
      if (bytes > 256 * 1024 || artifactBytes + bytes > 1024 * 1024 || artifacts.size >= 12) throw new Error('Artifact budget exceeded.');
      result = {name:file,bytes,sha256:hash(args.content),status:'candidate_requires_supervisor_review'};
      artifactBytes += bytes;
      artifacts.set(file,result);
      try {
        await mkdir(policy.artifactDir, {recursive:true});
        const target = join(policy.artifactDir, file);
        // Exclusive create prevents following an existing symlink or replacing other files.
        await writeFile(target,args.content,{encoding:'utf8',flag:'wx'});
      } catch(error) {artifactBytes-=bytes;artifacts.delete(file);throw error;}
    }
    audit({tool:name});
    return result;
  }
  return {allowed,execute};
}
