import {join, resolve, isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {readFileSync} from 'node:fs';

export const DEFAULT_HARNESS_HOME = 'D:/DeepSeek Harness';
const defaultConfigPath = new URL('../helper.config.json', import.meta.url);

export function resolveCodexHome({env=process.env, home=homedir()}={}) {
  return resolve(env.CODEX_HOME||join(home,'.codex'));
}

function configuredInstallation(configPath) {
  let text;
  try {text=readFileSync(configPath,'utf8');}
  catch(error) {if(error.code==='ENOENT')return undefined;throw error;}
  let config;
  try {config=JSON.parse(text.replace(/^\uFEFF/,''));}
  catch {throw new Error('helper.config.json must contain valid JSON.');}
  if(!config||typeof config!=='object'||Array.isArray(config)||typeof config.installation!=='string'||!isAbsolute(config.installation))throw new Error('helper.config.json must contain an absolute installation path.');
  return config.installation;
}

// Resolve at invocation time, so launchers can supply environment overrides.
// The optional skill-local configuration contains only the application path;
// this function does not create profiles or read credentials.
export function resolveRuntimePaths({env=process.env, home=homedir(), configPath=defaultConfigPath}={}) {
  const installation=resolve(env.DEEPSEEK_HARNESS_HOME||configuredInstallation(configPath)||DEFAULT_HARNESS_HOME);
  return {
    installation,
    executable:join(installation,'DeepSeek Harness.exe'),
    entrypoint:join(installation,'resources','app.asar','dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js'),
    codexHome:resolveCodexHome({env,home}),
    dshHome:resolve(env.DSH_HOME||join(home,'.dsh')),
  };
}
