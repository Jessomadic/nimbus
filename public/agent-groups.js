// Display metadata only. These groups never define delegation or permissions.
export const DISPLAY_GROUPS = Object.freeze([
  Object.freeze({id:'engineering',label:'Engineering'}),
  Object.freeze({id:'quality',label:'Quality & Security'}),
  Object.freeze({id:'research',label:'Research & Knowledge'}),
  Object.freeze({id:'operations',label:'Operations'}),
  Object.freeze({id:'github',label:'GitHub'}),
  Object.freeze({id:'',label:'Other agents'}),
]);
const knownGroups=new Set(DISPLAY_GROUPS.map(group=>group.id));
const defaults={
  architect:'engineering',builder:'engineering','frontend-designer':'engineering',
  reviewer:'quality','qa-engineer':'quality','security-reviewer':'quality',
  researcher:'research','data-analyst':'research','knowledge-curator':'research','technical-writer':'research',
  'windows-operator':'operations','automation-engineer':'operations','browser-operator':'operations','office-assistant':'operations',
};
export function defaultDisplayGroup(template){
  if(typeof template!=='string')return'';
  if(template.startsWith('github-'))return'github';
  return Object.hasOwn(defaults,template)?defaults[template]:'';
}
export function validateDisplayGroup(value){
  if(typeof value!=='string'||!knownGroups.has(value))throw new Error('Invalid display group; choose a known group or Other agents');
  return value;
}
