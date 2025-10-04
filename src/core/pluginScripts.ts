import { pluginsScriptSources, ScriptPluginSource } from './TauriCommands';

interface LoadedScriptPlugin extends ScriptPluginSource { loaded: boolean; error?: string }

let loaded: LoadedScriptPlugin[] | null = null;

export async function loadScriptPluginsOnce(): Promise<LoadedScriptPlugin[]> {
  if (loaded) return loaded;
  try {
    const sources = await pluginsScriptSources();
    loaded = sources.map(s => ({ ...s, loaded: false }));
    for (const sp of loaded) {
      try {
        // Wrap code in an IIFE to avoid leaking accidental vars; provide a minimal context object
        const wrapper = `(function(plugin){try{\n${sp.code}\n}catch(e){console.error('[plugin:'+plugin.name+'] runtime error', e);} })(Object.freeze({name:${JSON.stringify(sp.name)},provider:${JSON.stringify(sp.provider||null)}}));`;
        // eslint-disable-next-line no-eval
        eval(wrapper);
        sp.loaded = true;
        console.info(`[plugins] Loaded script plugin: ${sp.name}`);
      } catch (e:any) {
        sp.error = String(e);
        console.error('[plugins] Failed executing script plugin', sp.name, e);
      }
    }
    return loaded;
  } catch (e:any) {
    console.error('[plugins] Failed loading script plugin sources', e);
    loaded = [];
    return loaded;
  }
}
