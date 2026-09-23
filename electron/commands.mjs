export const commands = [
  ['help', 'Browse commands, skills, and protocols'],
  ['skills', 'Browse skills and protocols for this folder'],
  ['model', 'Choose a model, or /model <model ID>'],
  ['effort', 'Set reasoning effort with /effort <level>'],
  ['mcp', 'Show this task’s MCP connections and tools'],
  ['connections', 'Show this task’s connections and project details'],
  ['status', 'Show task times and details'],
  ['stop', 'Interrupt the current turn'],
  ['exit', 'Close this task; keep its conversation'],
  ['archive', 'Move this task to the archive'],
  ['clear', 'Start fresh; archive this conversation for later'],
  ['rename', 'Rename this task with /rename <name>'],
  ['pin', 'Keep this task at the top of your sidebar'],
  ['unpin', 'Remove this task from pinned tasks'],
  ['delete', 'Delete this task after confirmation'],
].map(([name, description]) => ({ name, description, kind: 'haven' }));

const aliases = { quit: 'exit', close: 'exit', new: 'clear', commands: 'help' };
export function parseCommand(text) {
  const trimmed = text.trim();
  if (trimmed === '/') return { name: 'help', args: '' };
  const match = trimmed.match(/^\/([\p{L}][\p{L}\p{N}\p{M}_:-]*)(?:\s+([\s\S]*))?$/u);
  return match ? { name: Object.hasOwn(aliases, match[1]) ? aliases[match[1]] : match[1], args: match[2]?.trim() || '' } : null;
}

export function mergeCommands(provider) {
  const reserved = new Set([...commands.map(c => c.name), ...Object.keys(aliases)]);
  const unique = provider.filter((c, i) => provider.findIndex(other => other.name === c.name) === i);
  const used = new Set(reserved);
  return [...commands, ...unique.map(c => {
    let name = reserved.has(c.name) ? `skill:${c.name}` : c.name;
    while (used.has(name)) name = `skill:${name}`;
    used.add(name); return { ...c, invocation: c.name, name };
  }).sort((a, b) => a.name.localeCompare(b.name))];
}
