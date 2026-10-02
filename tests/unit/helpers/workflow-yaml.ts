// A strict reader for the YAML GitHub workflows in this repo are written in: block mappings and
// sequences by indentation, plain and quoted scalars, `|` and `>` blocks, one-line flow lists,
// `{}`, and comments. Anything else (anchors, aliases, tags, multi-line flow, `? ` keys, several
// documents) is an error rather than a guess, so a test that reads a workflow through this
// either sees what GitHub sees or fails. No YAML package is in the tree, and a test of the
// release's shape should not add one.

export type Yaml = string | number | boolean | null | Yaml[] | { [key: string]: Yaml };

type Line = { indent: number; text: string; raw: string; at: number };

export function parseWorkflow(source: string): { [key: string]: Yaml } {
  if (source.includes('\t')) throw new Error('workflow yaml: tabs are not indentation');
  const lines: Line[] = source.split('\n').map((raw, at) => {
    const indent = raw.length - raw.trimStart().length;
    return { indent, text: stripComment(raw.trim()), raw, at: at + 1 };
  });
  const reader = { lines, next: 0 };
  skipBlank(reader);
  if (reader.lines[reader.next]?.text.startsWith('---')) throw new Error('workflow yaml: one document only');
  const root = block(reader, 0);
  skipBlank(reader);
  if (reader.next < reader.lines.length) throw new Error(`workflow yaml: line ${reader.lines[reader.next].at} is outside the document`);
  if (root === null || typeof root !== 'object' || Array.isArray(root)) throw new Error('workflow yaml: the document is not a mapping');
  return root;
}

type Reader = { lines: Line[]; next: number };

function skipBlank(reader: Reader): void {
  while (reader.next < reader.lines.length && reader.lines[reader.next].text === '') reader.next += 1;
}

/* A comment starts at a # that opens the line or follows a space, outside quotes. */
function stripComment(text: string): string {
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s:[,{-]/.test(text[i - 1])) quote = c;
    } else if (c === '#' && (i === 0 || text[i - 1] === ' ')) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text;
}

function block(reader: Reader, indent: number): Yaml {
  skipBlank(reader);
  const line = reader.lines[reader.next];
  if (!line || line.indent < indent) return null;
  return line.text.startsWith('- ') || line.text === '-' ? sequence(reader, line.indent) : mapping(reader, line.indent);
}

function mapping(reader: Reader, indent: number): { [key: string]: Yaml } {
  const out: { [key: string]: Yaml } = {};
  for (skipBlank(reader); reader.next < reader.lines.length; skipBlank(reader)) {
    const line = reader.lines[reader.next];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new Error(`workflow yaml: line ${line.at} is indented past its mapping`);
    if (line.text.startsWith('- ')) break;
    reader.next += 1;
    entry(reader, line, line.text, indent, out);
  }
  return out;
}

/* One `key: value` whose key sits at `indent`, read from `text` (the line, or what follows a
   sequence dash). */
function entry(reader: Reader, line: Line, text: string, indent: number, out: { [key: string]: Yaml }): void {
  const match = /^((?:"[^"]*"|'[^']*'|[^\s:'"?&*!|>{}[\],#][^:]*?)):(?:\s+(.*))?$/.exec(text);
  if (!match) throw new Error(`workflow yaml: line ${line.at} is not a key and a value: ${line.raw.trim()}`);
  const key = scalarText(match[1], line);
  if (Object.hasOwn(out, key)) throw new Error(`workflow yaml: line ${line.at} repeats the key ${key}`);
  const rest = match[2] ?? '';
  if (rest === '') {
    skipBlank(reader);
    const following = reader.lines[reader.next];
    const nested = following && (following.indent > indent || (following.indent === indent && following.text.startsWith('- ')));
    out[key] = nested ? block(reader, following.indent) : null;
  } else if (/^[|>][-+]?$/.test(rest)) {
    out[key] = blockScalar(reader, indent, rest);
  } else {
    out[key] = scalar(rest, line);
  }
}

function sequence(reader: Reader, indent: number): Yaml[] {
  const out: Yaml[] = [];
  for (skipBlank(reader); reader.next < reader.lines.length; skipBlank(reader)) {
    const line = reader.lines[reader.next];
    if (line.indent < indent) break;
    if (line.indent > indent || !(line.text.startsWith('- ') || line.text === '-')) {
      throw new Error(`workflow yaml: line ${line.at} breaks its sequence`);
    }
    reader.next += 1;
    const item = line.text === '-' ? '' : line.text.slice(2).trimStart();
    const itemIndent = line.indent + (line.raw.trimStart().length - line.raw.trimStart().slice(1).trimStart().length);
    if (item === '') {
      out.push(block(reader, indent + 1));
    } else if (/^((?:"[^"]*"|'[^']*'|[^\s:'"?&*!|>{}[\],#][^:]*?)):(\s|$)/.test(item)) {
      const map: { [key: string]: Yaml } = {};
      entry(reader, line, item, itemIndent, map);
      for (skipBlank(reader); reader.next < reader.lines.length; skipBlank(reader)) {
        const more = reader.lines[reader.next];
        if (more.indent !== itemIndent || more.text.startsWith('- ')) {
          if (more.indent > itemIndent) throw new Error(`workflow yaml: line ${more.at} is indented past its mapping`);
          break;
        }
        reader.next += 1;
        entry(reader, more, more.text, itemIndent, map);
      }
      out.push(map);
    } else {
      out.push(scalar(item, line));
    }
  }
  return out;
}

/* `|` keeps line breaks, `>` folds them; `-` drops the final break, `+` keeps every trailing one. */
function blockScalar(reader: Reader, parent: number, header: string): string {
  const body: string[] = [];
  let indent = -1;
  while (reader.next < reader.lines.length) {
    const line = reader.lines[reader.next];
    const blank = line.raw.trim() === '';
    if (!blank && line.indent <= parent) break;
    if (!blank && indent === -1) indent = line.indent;
    if (!blank && line.indent < indent) throw new Error(`workflow yaml: line ${line.at} is indented less than its block`);
    body.push(blank ? '' : line.raw.slice(indent));
    reader.next += 1;
  }
  let end = body.length;
  while (end > 0 && body[end - 1] === '') end -= 1;
  const kept = body.slice(0, end);
  const text = header.startsWith('>') ? kept.join('\n').replace(/([^\n])\n(?=[^\n ])/g, '$1 ') : kept.join('\n');
  if (header.endsWith('-')) return text;
  if (header.endsWith('+')) return `${text}${'\n'.repeat(body.length - end + 1)}`;
  return kept.length ? `${text}\n` : '';
}

function scalar(text: string, line: Line): Yaml {
  if (text === '{}') return {};
  if (text === '[]') return [];
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new Error(`workflow yaml: line ${line.at} opens a list it does not close`);
    return splitFlow(text.slice(1, -1), line).map((item) => scalar(item, line));
  }
  if (/^[{&*!%@`]/.test(text) || text.startsWith('? ')) throw new Error(`workflow yaml: line ${line.at} uses YAML this reader refuses: ${text}`);
  if (text.startsWith('"') || text.startsWith("'")) return scalarText(text, line);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

function scalarText(text: string, line: Line): string {
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new Error(`workflow yaml: line ${line.at} has an unclosed quote`);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) throw new Error(`workflow yaml: line ${line.at} has an unclosed quote`);
    return text.slice(1, -1).replace(/\\(["\\nt])/g, (_, c: string) => ({ n: '\n', t: '\t' })[c as 'n' | 't'] ?? c);
  }
  return text;
}

function splitFlow(text: string, line: Line): string[] {
  const items: string[] = [];
  let quote = '';
  let current = '';
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = '';
      current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === ',') {
      items.push(current.trim());
      current = '';
    } else if (c === '[' || c === '{') {
      throw new Error(`workflow yaml: line ${line.at} nests a flow collection`);
    } else {
      current += c;
    }
  }
  if (quote) throw new Error(`workflow yaml: line ${line.at} has an unclosed quote`);
  if (current.trim() !== '') items.push(current.trim());
  return items;
}
