import { readFileSync } from 'node:fs';
import { MODEL, createToolRuntime } from './helper-policy.mjs';
import { projectReplyStream, projectStreamProgress } from './reply-stream.mjs';

export const name = 'codex-supervisor-guard';
export const inject = ['tools', 'llm'];

const object = (properties, required = []) => ({type:'object', properties, required, additionalProperties:false});
const string = {type:'string'};
const schemas = {
  helper_list_files: ['List the immutable files selected by your supervisor. File IDs are used by the other read tools.', object({})],
  helper_read_file: ['Read numbered lines from one supplied file snapshot. No live filesystem access. Cite file ID and line numbers in findings.', object({file:string,startLine:{type:'integer',minimum:1},lineCount:{type:'integer',minimum:1,maximum:300}},['file'])],
  helper_search_text: ['Search a literal string across supplied snapshots, or one file ID. Returns at most 60 source locations.', object({query:string,file:string},['query'])],
  helper_write_artifact: ['Save a NEW candidate code, patch, test or document in the isolated run artifact directory. It is never executed or applied. Use a different flat filename for revisions.', object({name:string,content:string},['name','content'])],
};

export function apply(ctx) {
  const policy = JSON.parse(readFileSync(process.env.CODEX_HELPER_POLICY, 'utf8'));
  const emit = (event, data = {}) => process.stderr.write('CODEX_HELPER_CONTROL ' + JSON.stringify({nonce:policy.nonce,event,...data}) + '\n');
  const runtime = createToolRuntime(policy, data => emit('tool', data));
  const definitions = new Map();
  for (const tool of runtime.allowed) {
    const [description,parameters] = schemas[tool];
    const definition = {
      name:tool, description, parameters,
      output:{schema:{},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
      async execute(args, execution) {
        execution.signal?.throwIfAborted();
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k=>!Object.hasOwn(parameters.properties,k))) throw new Error('Unexpected tool arguments.');
        return runtime.execute(tool,args);
      },
    };
    definitions.set(tool,definition);
    ctx.tools.register(definition);
  }
  ctx.tools.guard(execution => {
    if (!definitions.has(execution.name) || ctx.tools.get(execution.name,execution.agent) !== definitions.get(execution.name)) {
      emit('violation',{tool:execution.name});
      return 'This invocation permits only the supervisor-provided helper tools. Return missing needs to the supervisor.';
    }
  });
  ctx.on('agent/created', ({agent}) => agent.ctx.tools.restrict({allow:runtime.allowed}));
  ctx.on('agent/assistant-stream', ({agent,frame}) => {
    for (const event of projectReplyStream(agent?.id, frame)) emit('reply_stream', event);
    for (const event of projectStreamProgress(agent?.id, frame)) emit('progress_stream', event);
  });
  ctx.on('system-prompt/assemble', async (_assembly,_context,next) => {
    const assembled = await next();
    return {...assembled, tools:assembled.tools.filter(tool=>runtime.allowed.includes(tool.name))};
  });
  ctx.on('llm/stream', (options,next) => {
    if ((options.tools??[]).some(tool=>!runtime.allowed.includes(tool.name))) {
      emit('violation',{reason:'unexpected_tool_schema'});
      throw new Error('Unexpected tool schema in delegated request.');
    }
    if (Object.keys(MODEL).some(key=>options[key] !== MODEL[key])) {
      emit('violation',{reason:'model_selection_mismatch'});
      throw new Error('Expected DeepSeek-V41-Flash / Max; no automatic fallback is allowed.');
    }
    emit('model',MODEL);
    return next();
  });
  ctx.provide('codexSupervisorGuard',Object.freeze({version:2,mode:policy.mode}));
  emit('active',{version:2,mode:policy.mode,allowedTools:runtime.allowed});
}
