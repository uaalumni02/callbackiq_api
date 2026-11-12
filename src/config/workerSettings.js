import definitions from '../../config/worker-settings.json' with {type:'json'};
import {numericSetting} from './numericSettings.js';

export function workerSetting(name,env=process.env) {
 if(!Object.hasOwn(definitions,name))throw new Error(`Unknown worker setting ${name}`);
 return numericSetting(name,env);
}
export function validateWorkerSettings(env=process.env) {
 for(const name of Object.keys(definitions))workerSetting(name,env);
}
