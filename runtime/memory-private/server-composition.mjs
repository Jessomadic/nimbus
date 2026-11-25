import {createSessionAdapter} from './session-adapter.mjs';
import {createMemoryRequestHandler} from './http-route.mjs';
export function composeMemoryRoute(options){
 const adapter=createSessionAdapter(options);
 return createMemoryRequestHandler({...adapter,ownerId:options.ownerId,pins:options.pins});
}
