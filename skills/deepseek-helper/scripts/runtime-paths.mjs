import {join, resolve, isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {readFileSync} from 'node:fs';

export const DEFAULT_HARNESS_HOME = 'D:/DeepSeek Harness';
export const DEFAULT_ZCODE_HOME = 'D:/Zcode';
const defaultConfigPath = new URL('../helper.config.json', import.meta.url);

export function resolveCodexHome({env=process.env, home=homedir()}={}) {
  return resolve(env.CODEX_HOME||join(home,'.codex'));
}

// Installation and runtime resolution must accept the same saved path shape.
// Callers can replace a known path before validation, without preserving other
// local fields or ever reading backend credentials.
export function validateConfiguredPaths(config) {
  if(!config||typeof config!=='object'||Array.isArray(config)||!['installation','zcodeInstallation'].some(key=>Object.hasOwn(config,key)))throw new Error('helper.config.json must contain an absolute installation or zcodeInstallation path.');
  const paths={};
  for(const key of ['installation','zcodeInstallation'])if(Object.hasOwn(config,key)){
    if(typeof config[key]!=='string'||!isAbsolute(config[key]))throw new Error('helper.config.json must contain absolute application paths.');
    paths[key]=config[key];
  }
  return paths;
}

function configuredPaths(configPath) {
  let text;
  try {text=readFileSync(configPath,'utf8');}
  catch(error) {if(error.code==='ENOENT')return {};throw error;}
  let config;
  try {config=JSON.parse(text.replace(/^\uFEFF/,''));}
  catch {throw new Error('helper.config.json must contain valid JSON.');}
  return validateConfiguredPaths(config);
}

// Resolve at invocation time, so launchers can supply environment overrides.
// The optional skill-local configuration contains only the application path;
// this function does not create profiles or read credentials.
export function resolveRuntimePaths({env=process.env, home=homedir(), configPath=defaultConfigPath}={}) {
  const installation=resolve(env.DEEPSEEK_HARNESS_HOME||configuredPaths(configPath).installation||DEFAULT_HARNESS_HOME);
  return {
    installation,
    executable:join(installation,'DeepSeek Harness.exe'),
    entrypoint:join(installation,'resources','app.asar','dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js'),
    codexHome:resolveCodexHome({env,home}),
    dshHome:resolve(env.DSH_HOME||join(home,'.dsh')),
  };
}

// Resolve the shipped ZCode CLI through the current Node runtime. This only
// selects installation paths; ZCode account and data locations are not inferred.
export function resolveZCodePaths({env=process.env, home=homedir(), configPath=defaultConfigPath}={}) {
  const installation=env.DEEPSEEK_ZCODE_HOME||configuredPaths(configPath).zcodeInstallation||DEFAULT_ZCODE_HOME;
  if(typeof installation!=='string'||!isAbsolute(installation))throw new Error('ZCode installation must be an absolute path.');
  const root=resolve(installation);
  return {installation:root,executable:process.execPath,entrypoint:join(root,'resources','glm','zcode.cjs'),codexHome:resolveCodexHome({env,home})};
}
