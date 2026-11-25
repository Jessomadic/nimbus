import fs from 'node:fs';
import {discoverSkills,importSkills,inspectSkillImport} from '../runtime/skills.js';
const [mode,source,destination,previous]=process.argv.slice(2);
if(!source||!['inspect','verify','import','update'].includes(mode)||(mode==='update'&&!previous))throw new Error('Usage: inspect ROOT | verify IMPORT | import SOURCE NEW_DEST | update SOURCE NEW_DEST PREVIOUS_IMPORT');
const result=mode==='inspect'?discoverSkills([source]):mode==='verify'?inspectSkillImport(source):importSkills(source,destination,{previous:mode==='update'?previous:undefined});
process.stdout.write(JSON.stringify(result,null,2)+'\n');
if(mode==='verify'&&!result.valid)process.exitCode=1;
