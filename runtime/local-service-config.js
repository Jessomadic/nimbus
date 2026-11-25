import {config,saveConfig} from './config.js';
import {startLocalService} from './local-service.js';
// Serialize async reconciliation with all config PUTs. Disable never closes a
// listener or unloads a shared model; admissions consult the live configuration.
export function createConfigUpdater({read=config,save=saveConfig,start=startLocalService}={}) {
  let pending=Promise.resolve();
  return patch=>{
    const result=pending.then(async()=>{
      const before=read();
      const next=save(patch);
      try{await start(next);}
      catch(error){
        // Never advertise a failed enable as available. Preserve other saved fields.
        save({local:{enabled:false}});
        error.statusCode=503;
        throw error;
      }
      return read();
    });
    pending=result.catch(()=>{});
    return result;
  };
}
export const updateRuntimeConfig=createConfigUpdater();
