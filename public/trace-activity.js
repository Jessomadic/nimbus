// Presentation only: describe the recorded action without changing or replaying it.
export const traceToolName = step => step.tool || String(step.text || '').match(/^([\w.:-]+)\(/)?.[1] || '';
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const clip = (value, limit = 115) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > limit ? text.slice(0, limit - 1).trimEnd() + '…' : text;
};
const pretty = value => String(value || '').replace(/^mcp__/, '').replace(/__/g, ' · ').replace(/_/g, ' ');

export function traceInput(step) {
  if (record(step.input)) return step.input;
  if (record(step.args)) return step.args;
  const text = String(step.text || ''), start = text.indexOf('(');
  if (start < 0) return {};
  const source = text.slice(start + 1, text.endsWith(')') ? -1 : undefined);
  try { const value = JSON.parse(source); return record(value) ? value : {}; } catch {}
  // Retained traces cut arguments at 120 characters. Read only successive,
  // top-level scalar fields, never a property embedded inside a task string.
  const input = {};
  let rest = source.trimStart();
  if (!rest.startsWith('{')) return input;
  rest = rest.slice(1).trimStart();
  while (rest) {
    const key = rest.match(/^("(?:[^"\\]|\\.)*")\s*:\s*/);
    if (!key) break;
    let name;
    try { name = JSON.parse(key[1]); } catch { break; }
    rest = rest.slice(key[0].length);
    const scalar = rest.match(/^("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)\s*([,}])/);
    if (scalar) {
      try { Object.defineProperty(input, name, {value: JSON.parse(scalar[1]), enumerable: true, configurable: true}); } catch { break; }
      if (scalar[2] === '}') break;
      rest = rest.slice(scalar[0].length).trimStart();
      continue;
    }
    if (rest.startsWith('"')) {
      // A partial final string is useful context, but keep its ellipsis explicit.
      const partial = rest.match(/^"((?:[^"\\]|\\.)*)/)[1];
      for (let trim = 0; trim <= Math.min(6, partial.length); trim++) {
        try {
          const value = JSON.parse('"' + partial.slice(0, partial.length - trim) + '"');
          Object.defineProperty(input, name, {value: value + '…', enumerable: true, configurable: true});
          break;
        } catch {}
      }
    }
    break;
  }
  return input;
}

export function describeTraceStep(step) {
  const tool = traceToolName(step), input = traceInput(step);
  const detail = value => { const text = clip(value); return text ? ': ' + text : ''; };
  const task = Number.isSafeInteger(Number(input.runId)) && Number(input.runId) > 0 ? 'task #' + input.runId : 'the delegated task';
  const path = input.path || input.file_path || input.repoPath;
  switch (tool) {
    case 'team_status': return 'Checking team progress' + (input.includeRecent ? ' and recent work' : '');
    case 'task_history': return input.callId ? 'Retrieving saved tool evidence' + (input.runId ? ' for ' + task : '') : input.runId ? 'Reviewing ' + task + '’s history' : 'Reviewing recent task history';
    case 'tool_catalog': return 'Finding available tools' + detail(pretty(input.query));
    case 'ask_worker': return 'Handing off work' + detail(input.task);
    case 'worker_result': return (step.state === 'waiting' && step.waitReason !== 'approval' ? 'Waiting for ' + task : 'Checking ' + task + '’s progress and result');
    case 'update_plan': return 'Updating the work plan' + detail((Array.isArray(input.steps) ? input.steps.find(item => item?.status === 'in_progress')?.step : '') || input.explanation);
    case 'self_update': return (Object.hasOwn(updateActions, input.action) ? updateActions[input.action] : 'Managing a Nimbus update');
    case 'read_file': return 'Reading a file' + detail(path);
    case 'write_file': return 'Writing a file' + detail(path);
    case 'list_files': return 'Listing files' + detail(path);
    case 'apply_patch': return 'Applying code changes' + detail(input.edits?.[0]?.path);
    case 'shell': case 'exec_command': return 'Running a command' + detail(input.command || input.cmd);
    case 'write_stdin': return (input.terminate ? 'Stopping a command' : input.chars ? 'Sending input to a command' : 'Collecting command output');
    case 'view_image': return 'Inspecting an image' + detail(path);
    case 'skills': return 'Finding available skills';
    case 'capabilities': return 'Checking available capabilities';
    case 'connector_inventory': return 'Checking connected apps and tools';
    case 'shared_note': return (Object.hasOwn(input, 'content') ? 'Saving shared project notes' : 'Reading shared project notes') + detail(input.key);
    case 'request_tool': return 'Requesting a new capability' + detail(input.title || input.toolName);
    case 'tool_request_status': return 'Checking capability development progress';
    case 'request_user_input': return 'Resolving a question' + detail(input.questions?.[0]?.title || input.questions?.[0]?.question);
    case 'browser': return (Object.hasOwn(browserActions, input.action) ? browserActions[input.action] : 'Using the browser') + detail(input.url || input.name || input.key);
  }
  if (Object.hasOwn(descriptions, tool)) return descriptions[tool] + detail(input.query || input.url || path || input.name || input.script);
  if (!tool) return String(step.text || 'Working');
  // New and connector tools remain inspectable without inventing their purpose.
  return 'Using ' + pretty(tool) + detail(input.title || input.query || input.url || path);
}

const updateActions = {status: 'Checking Nimbus update status', snapshot: 'Saving a Nimbus source snapshot', validate: 'Validating the Nimbus update', apply: 'Scheduling the Nimbus update after active tasks finish'};
const browserActions = {open: 'Opening a web page', navigate: 'Navigating to a web page', tabs: 'Checking browser tabs', snapshot: 'Reading a web page', click: 'Clicking a page control', fill: 'Filling a page field', press: 'Pressing a key', select: 'Selecting a page option', back: 'Going back a page', screenshot: 'Capturing a page screenshot', close: 'Closing a browser tab'};
const descriptions = {
    code_search: 'Searching project code', project_map: 'Inspecting the project structure', dependency_graph: 'Mapping project dependencies', change_impact: 'Checking which code a change affects',
    test_discover: 'Finding project checks', run_checks: 'Running project checks', security_scan: 'Checking code for security issues',
    git_inspect: 'Checking repository status', git_diff: 'Reviewing code changes', git_commit_plan: 'Preparing a commit plan', git_sync_plan: 'Checking repository sync status', git_push_preflight: 'Checking whether changes are ready to push',
    github_pr_inspect: 'Inspecting a pull request', github_actions_inspect: 'Inspecting build and test results',
    host_snapshot: 'Checking system resources', process_inspect: 'Inspecting running processes', service_inspect: 'Checking service status', health_probe: 'Checking service health', log_read: 'Reading a log', file_manifest: 'Checking files and integrity', artifact_inventory: 'Finding saved artifacts',
    research_search: 'Searching sources', research_fetch: 'Reading a source', scholar_search: 'Searching research papers', knowledge_search: 'Searching saved knowledge', evidence_audit: 'Checking claims against evidence', document_compare: 'Comparing documents', check_links: 'Checking source links', citation_format: 'Formatting source citations'
};

export function traceTechnicalDetails(step) {
  const input = record(step.input) ? step.input : record(step.args) ? step.args : null;
  return input ? traceToolName(step) + '(' + JSON.stringify(input, null, 2) + ')' : String(step.text || traceToolName(step));
}
