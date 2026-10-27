export function globToRe(glob) { return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'is'); }
export function ruleMatches(rule, tool, input = {}) {
  // Migrate old command rules at the matching boundary, not into provider code.
  const normalized = String(rule).replace(/^Bash(?=\(|$)/, 'shell');
  const match = normalized.match(/^([^(]+)\((.*)\)$/s);
  return match ? globToRe(match[1].trim()).test(tool) && globToRe(match[2]).test(String(input.command ?? input.path ?? input.url ?? input.action ?? JSON.stringify(input)))
    : globToRe(normalized.trim()).test(tool);
}
export function requiresApproval(bot, name, args) {
  // A new terminal tool must not bypass existing shell command approval rules.
  const policyName=name==='exec_command'||name==='run_checks'||name==='write_stdin'&&args.chars?'shell':name;
  const policyArgs=name==='write_stdin'?{...args,command:args.chars}:args;
  return bot.approval_rules.some(rule => ruleMatches(rule, name, args)||ruleMatches(rule,policyName,policyArgs)) && !bot.allow_rules.some(rule => ruleMatches(rule,name,args)||ruleMatches(rule,policyName,policyArgs));
}
