// Fresh-process checks using isolated data/config and no connector credentials.
import assert from 'node:assert/strict';
import {coreTools,executeTool,browsers,connectors,terminals} from './tools.js';
import {db} from '../db.js';
const [mode,name]=process.argv.slice(2);
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>262144)throw new Error('Probe input exceeds 256 KiB');}
try{
  const spec=coreTools.find(tool=>tool.function.name===name)?.function;
  if(mode==='inspect')console.log(JSON.stringify({found:Boolean(spec),spec:spec||null}));
  else if(mode==='verify'){
    if(!spec)throw new Error('The new tool is not present in the native registry');
    const verification=JSON.parse(input||'{}');
    if(!verification.args||typeof verification.args!=='object'||Array.isArray(verification.args)||!Array.isArray(verification.assertions)||verification.assertions.length<1||verification.assertions.length>30)throw new Error('QA must supply args and 1 to 30 representative assertions');
    const bot={id:1,name:'Isolated tool acceptance',tools:JSON.stringify([name]),approval_rules:[],allow_rules:[]};
    const result=await executeTool(bot,name,verification.args,{signal:AbortSignal.timeout(20000)});
    if(result?.error)throw new Error('Representative tool execution failed: '+result.error);
    for(const assertion of verification.assertions){
      if(typeof assertion.path!=='string'||!assertion.path||!Object.hasOwn(assertion,'equals'))throw new Error('Each assertion needs a result field path and equals');
      let actual=result;
      for(const key of assertion.path.split('.')){
        if(['__proto__','prototype','constructor'].includes(key)||actual===null||actual===undefined||!Object.hasOwn(Object(actual),key))throw new Error('Unknown representative result field: '+assertion.path);
        actual=actual[key];
      }
      assert.deepStrictEqual(actual,assertion.equals,'Representative result differs: '+assertion.path);
    }
    console.log(JSON.stringify({pass:true,tool:name,assertions:verification.assertions.length,result}));
  }else throw new Error('Choose inspect or verify');
}finally{await terminals.close();await connectors.close();await browsers.close();db.close();}
