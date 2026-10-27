const MAX_INPUT_CODE_UNITS = 1_000_000;

const tool = {
  type: 'function',
  function: {
    name: 'text_statistics',
    description: 'Return bounded Unicode-aware word, character, and logical line counts for inline text.',
    parameters: { type: 'object', properties: { text: { type: 'string', maxLength: MAX_INPUT_CODE_UNITS, description: 'Inline text to count.' } }, required: ['text'], additionalProperties: false }
  }
};

export const tools = [tool];
export const roleTools = { builder: ['text_statistics'] };

function validate(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('text_statistics input must be an object');
  if (typeof args.text !== 'string') throw new Error('text_statistics text must be a string');
  if (args.text.length > MAX_INPUT_CODE_UNITS) throw new Error(`text_statistics text exceeds ${MAX_INPUT_CODE_UNITS} code units`);
  if (Object.keys(args).some(key => key !== 'text')) throw new Error('text_statistics input contains unsupported properties');
  return args.text;
}

export function execute(name, args) {
  if (name !== 'text_statistics') throw new Error(`Unknown generated tool: ${name}`);
  const text = validate(args);
  if (text.length === 0) return { words: 0, characters: 0, lines: 0 };
  return { words: (text.match(/\S+/gu) || []).length, characters: Array.from(text).length, lines: text.split(/\r\n|\r|\n/u).length };
}
