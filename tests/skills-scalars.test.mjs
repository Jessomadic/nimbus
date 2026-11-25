import {test} from 'node:test';
import assert from 'node:assert/strict';
import {skillMetadata} from '../runtime/skills.js';
const parse=(h,s)=>skillMetadata(`---\nname: demo\ndescription: ${h}\n${s}\n---\n`);
for(const [h,s,want] of [
 ['|','  first\n  second','first\nsecond\n'],
 ['|+','  first\n','first\n\n'],
 ['|-','  first\n','first'],
 ['>-','  first\n\n  second','first\nsecond'],
 ['>2-','  first\n  second','first second'],
 ['|2-','  first\n  second','first\nsecond'],
 ['|-2','  first\n  second','first\nsecond'],
 ['>-','  first\n    code\n  second','first\n  code\nsecond'],
 ['>-','  first\n\n\n  second','first\n\nsecond'],
 ['|','', ''],
])test(`scalar ${h} ${JSON.stringify(s)}`,()=>assert.equal(parse(h,s).metadata.description,want));
for(const blanks of [1,2,3])for(const header of ['>-','>','>+','>2-','>-2'])test(`folded ${header} preserves ${blanks} blanks before indented text`,()=>{
 const source='  first'+'\n'.repeat(blanks+1)+'    code\n  second';
 const parsed=parse(header,source);
 assert.equal(parsed.metadata.description,'first'+'\n'.repeat(blanks+1)+'  code\nsecond'+(header.includes('-')?'':'\n'));
 assert.deepEqual(parsed.warnings,[]);
});
for(const header of ['>+','>2+','>+2','>','>-'])for(const blanks of [1,2,3])test(`folded ${header} retains ${blanks} trailing blanks according to chomping`,()=>{
 const parsed=parse(header,'  first'+'\n'.repeat(blanks));
 assert.equal(parsed.metadata.description,'first'+(header.includes('+')?'\n'.repeat(blanks+1):header.includes('-')?'':'\n'));
 assert.deepEqual(parsed.warnings,[]);
});
test('malformed indicators and underindentation explicitly warn',()=>{
 for(const [h,s] of [['|0','  value'],['|22','  value'],['|2-',' value']]){
 const p=parse(h,s);assert.ok(p.warnings.length);assert.equal(p.metadata.description,undefined);
 }
});
