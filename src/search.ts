export interface SearchDocument {
  path: string;
  content: string;
  frontmatter?: Record<string, unknown>;
}

type ScopeOperator =
  | 'file'
  | 'path'
  | 'content'
  | 'match-case'
  | 'ignore-case'
  | 'tag'
  | 'line'
  | 'block'
  | 'section'
  | 'task'
  | 'task-todo'
  | 'task-done';

type Token =
  | { kind: 'atom'; text: string }
  | { kind: 'bracket'; text: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

interface Operand {
  text: string;
  phrase: boolean;
  regex?: { source: string; flags: string };
}

type SearchExpression =
  | { kind: 'term'; operand: Operand }
  | { kind: 'and'; children: SearchExpression[] }
  | { kind: 'or'; children: SearchExpression[] }
  | { kind: 'not'; child: SearchExpression }
  | { kind: 'scope'; operator: ScopeOperator; child: SearchExpression }
  | {
      kind: 'property';
      name: string;
      child?: SearchExpression;
      nullValue?: boolean;
    };

const SCOPE_OPERATORS = new Set<ScopeOperator>([
  'file',
  'path',
  'content',
  'match-case',
  'ignore-case',
  'tag',
  'line',
  'block',
  'section',
  'task',
  'task-todo',
  'task-done',
]);

export function matchesSearchQuery(
  query: string,
  document: SearchDocument
): boolean {
  if (!query.trim()) return true;

  const parser = new Parser(tokenize(query));
  const expression = parser.parse();
  if (!expression || !parser.atEnd()) return false;

  return evaluate(expression, document, defaultContext(document));
}

function defaultContext(document: SearchDocument): EvaluationContext {
  return {
    values: [bodyContent(document.content)],
    caseSensitive: false,
    sameUnit: false,
  };
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): SearchExpression | null {
    if (this.tokens.length === 0) return null;
    return this.parseOr();
  }

  atEnd(): boolean {
    return this.index >= this.tokens.length;
  }

  private parseOr(): SearchExpression | null {
    const children: SearchExpression[] = [];
    const first = this.parseAnd();
    if (!first) return null;
    children.push(first);

    while (this.isOr(this.peek())) {
      this.index++;
      const next = this.parseAnd();
      if (!next) return null;
      children.push(next);
    }

    return children.length === 1 ? children[0]! : { kind: 'or', children };
  }

  private parseAnd(): SearchExpression | null {
    const children: SearchExpression[] = [];
    while (this.startsUnary(this.peek())) {
      const expression = this.parseUnary();
      if (!expression) return null;
      children.push(expression);
    }

    if (children.length === 0) return null;
    return children.length === 1 ? children[0]! : { kind: 'and', children };
  }

  private parseUnary(): SearchExpression | null {
    const token = this.peek();
    if (!token) return null;

    if (token.kind === 'atom') {
      if (token.text === '-') {
        this.index++;
        const child = this.parseUnary();
        return child ? { kind: 'not', child } : null;
      }

      if (token.text.startsWith('-') && token.text.length > 1) {
        this.index++;
        const child = this.parseAtomText(token.text.slice(1));
        return child ? { kind: 'not', child } : null;
      }
    }

    return this.parsePrimary();
  }

  private parsePrimary(): SearchExpression | null {
    const token = this.peek();
    if (!token) return null;

    if (token.kind === 'lparen') {
      this.index++;
      const expression = this.parseOr();
      if (this.peek()?.kind !== 'rparen') return null;
      this.index++;
      return expression;
    }

    if (token.kind === 'bracket') {
      this.index++;
      if (!token.text.endsWith(']')) return null;
      return parseProperty(token.text);
    }

    if (token.kind === 'atom') {
      this.index++;
      return this.parseAtomText(token.text);
    }

    return null;
  }

  private parseAtomText(text: string): SearchExpression | null {
    const operator = splitScopeOperator(text);
    if (!operator) {
      return { kind: 'term', operand: parseOperand(text) };
    }

    if (operator.inlineValue) {
      return {
        kind: 'scope',
        operator: operator.name,
        child: { kind: 'term', operand: parseOperand(operator.inlineValue) },
      };
    }

    if (this.peek()?.kind === 'lparen') {
      this.index++;
      const child = this.parseOr();
      if (!child || this.peek()?.kind !== 'rparen') return null;
      this.index++;
      return { kind: 'scope', operator: operator.name, child };
    }

    const operand = this.peek();
    if (operand?.kind === 'atom') {
      this.index++;
      return {
        kind: 'scope',
        operator: operator.name,
        child: { kind: 'term', operand: parseOperand(operand.text) },
      };
    }

    return null;
  }

  private startsUnary(token: Token | undefined): boolean {
    if (this.isOr(token)) return false;
    return (
      token?.kind === 'atom' ||
      token?.kind === 'bracket' ||
      token?.kind === 'lparen'
    );
  }

  private isOr(token: Token | undefined): boolean {
    return token?.kind === 'atom' && token.text.toLocaleLowerCase() === 'or';
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }
}

function splitScopeOperator(
  text: string
): { name: ScopeOperator; inlineValue: string } | null {
  const colon = text.indexOf(':');
  if (colon <= 0) return null;

  const name = text.slice(0, colon).toLocaleLowerCase() as ScopeOperator;
  if (!SCOPE_OPERATORS.has(name)) return null;
  return { name, inlineValue: text.slice(colon + 1) };
}

function parseProperty(text: string): SearchExpression {
  const inner = text.slice(1, -1).trim();
  const colon = findTopLevelColon(inner);
  if (colon < 0) return { kind: 'property', name: inner };

  const name = inner.slice(0, colon).trim();
  const value = inner.slice(colon + 1).trim();
  if (value.toLocaleLowerCase() === 'null') {
    return { kind: 'property', name, nullValue: true };
  }

  const parser = new Parser(tokenize(value));
  const child = parser.parse();
  return child && parser.atEnd()
    ? { kind: 'property', name, child }
    : {
        kind: 'property',
        name,
        child: { kind: 'term', operand: parseOperand(value) },
      };
}

function findTopLevelColon(value: string): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quoted) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ':' && depth === 0) return i;
  }
  return -1;
}

function parseOperand(raw: string): Operand {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return { text: unescapeQuoted(trimmed.slice(1, -1)), phrase: true };
  }

  const regex = parseRegex(trimmed);
  if (regex) return { text: trimmed, phrase: false, regex };
  return { text: trimmed, phrase: false };
}

function parseRegex(raw: string): { source: string; flags: string } | undefined {
  if (!raw.startsWith('/')) return undefined;

  let escaped = false;
  for (let i = 1; i < raw.length; i++) {
    const char = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '/') {
      const flags = raw.slice(i + 1);
      if (!/^[dgimsuvy]*$/.test(flags)) return undefined;
      return { source: raw.slice(1, i), flags };
    }
  }
  return undefined;
}

function unescapeQuoted(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < query.length) {
    const char = query[index];
    if (!char || /\s/.test(char)) {
      index++;
      continue;
    }
    if (char === '(') {
      tokens.push({ kind: 'lparen' });
      index++;
      continue;
    }
    if (char === ')') {
      tokens.push({ kind: 'rparen' });
      index++;
      continue;
    }
    if (char === '[') {
      const start = index++;
      let quoted = false;
      let escaped = false;
      let nestedBrackets = 0;
      while (index < query.length) {
        const current = query[index++];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (current === '\\' && quoted) {
          escaped = true;
          continue;
        }
        if (current === '"') quoted = !quoted;
        if (!quoted && current === '[') nestedBrackets++;
        if (!quoted && current === ']') {
          if (nestedBrackets === 0) break;
          nestedBrackets--;
        }
      }
      tokens.push({ kind: 'bracket', text: query.slice(start, index) });
      continue;
    }

    const start = index;
    let quoted = false;
    let escaped = false;
    while (index < query.length) {
      const current = query[index];
      if (escaped) {
        escaped = false;
        index++;
        continue;
      }
      if (current === '\\' && quoted) {
        escaped = true;
        index++;
        continue;
      }
      if (current === '"') {
        quoted = !quoted;
        index++;
        continue;
      }
      if (
        current &&
        !quoted &&
        (current === '(' || current === ')' || /\s/.test(current))
      ) {
        break;
      }
      index++;
    }
    tokens.push({ kind: 'atom', text: query.slice(start, index) });
  }

  return tokens;
}

interface EvaluationContext {
  values: string[];
  caseSensitive: boolean;
  sameUnit: boolean;
  propertyMode?: boolean;
}

function evaluate(
  expression: SearchExpression,
  document: SearchDocument,
  context: EvaluationContext
): boolean {
  switch (expression.kind) {
    case 'term':
      return context.values.some((value) =>
        matchesOperand(expression.operand, value, context)
      );
    case 'and':
      return expression.children.every((child) =>
        evaluate(child, document, context)
      );
    case 'or':
      return expression.children.some((child) =>
        evaluate(child, document, context)
      );
    case 'not':
      return !evaluate(expression.child, document, context);
    case 'property':
      return evaluateProperty(expression, document, context);
    case 'scope': {
      const scoped = scopeContext(expression.operator, document, context);
      if (scoped.sameUnit) {
        return scoped.values.some((value) =>
          evaluate(expression.child, document, {
            ...scoped,
            values: [value],
            sameUnit: false,
          })
        );
      }
      return evaluate(expression.child, document, scoped);
    }
  }
}

function scopeContext(
  operator: ScopeOperator,
  document: SearchDocument,
  context: EvaluationContext
): EvaluationContext {
  if (operator === 'match-case' || operator === 'ignore-case') {
    return { ...context, caseSensitive: operator === 'match-case' };
  }

  const body = bodyContent(document.content);
  switch (operator) {
    case 'file':
      return {
        values: [fileName(document.path)],
        caseSensitive: context.caseSensitive,
        sameUnit: false,
      };
    case 'path':
      return {
        values: [document.path],
        caseSensitive: context.caseSensitive,
        sameUnit: false,
      };
    case 'content':
      return {
        values: [body],
        caseSensitive: context.caseSensitive,
        sameUnit: false,
      };
    case 'tag':
      return {
        values: extractTags(body, document.frontmatter),
        caseSensitive: context.caseSensitive,
        sameUnit: false,
      };
    case 'line':
      return {
        values: body.split(/\r?\n/),
        caseSensitive: context.caseSensitive,
        sameUnit: true,
      };
    case 'block':
      return {
        values: splitBlocks(body),
        caseSensitive: context.caseSensitive,
        sameUnit: true,
      };
    case 'section':
      return {
        values: splitSections(body),
        caseSensitive: context.caseSensitive,
        sameUnit: true,
      };
    case 'task':
      return {
        values: taskLines(body),
        caseSensitive: context.caseSensitive,
        sameUnit: true,
      };
    case 'task-todo':
      return {
        values: taskLines(body).filter((line) => /\[[ ]\]/.test(line)),
        caseSensitive: context.caseSensitive,
        sameUnit: true,
      };
    case 'task-done':
      return {
        values: taskLines(body).filter((line) => /\[[xX]\]/.test(line)),
        caseSensitive: context.caseSensitive,
        sameUnit: true,
      };
  }
}

function evaluateProperty(
  expression: Extract<SearchExpression, { kind: 'property' }>,
  document: SearchDocument,
  context: EvaluationContext
): boolean {
  const frontmatter = document.frontmatter;
  if (!frontmatter) return false;
  const entry = Object.entries(frontmatter).find(
    ([name]) => name.toLocaleLowerCase() === expression.name.toLocaleLowerCase()
  );
  if (!entry) return false;

  const value = entry[1];
  if (expression.nullValue) {
    return value === null || value === undefined || value === '';
  }
  if (!expression.child) return true;

  return evaluate(expression.child, document, {
    values: propertyValues(value),
    caseSensitive: context.caseSensitive,
    sameUnit: false,
    propertyMode: true,
  });
}

function matchesOperand(
  operand: Operand,
  candidate: string,
  context: EvaluationContext
): boolean {
  if (context.propertyMode) {
    const comparison = operand.text.match(/^(<|>)(.+)$/);
    if (comparison) {
      return compareValue(
        candidate,
        comparison[1] as '<' | '>',
        comparison[2]!
      );
    }
  }

  if (operand.regex) {
    let flags = operand.regex.flags;
    if (context.caseSensitive) flags = flags.replace(/i/g, '');
    else if (!flags.includes('i')) flags += 'i';
    try {
      return new RegExp(operand.regex.source, flags).test(candidate);
    } catch {
      return false;
    }
  }

  if (context.caseSensitive) return candidate.includes(operand.text);
  return candidate.toLocaleLowerCase().includes(operand.text.toLocaleLowerCase());
}

function compareValue(actual: string, operator: '<' | '>', expected: string): boolean {
  const actualNumber = Number(actual);
  const expectedNumber = Number(expected);
  if (Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)) {
    return operator === '<' ? actualNumber < expectedNumber : actualNumber > expectedNumber;
  }

  const left = actual.toLocaleLowerCase();
  const right = expected.toLocaleLowerCase();
  return operator === '<' ? left < right : left > right;
}

function propertyValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => propertyValues(item));
  if (value === null || value === undefined) return [];
  if (typeof value === 'object') return [JSON.stringify(value)];
  return [String(value)];
}

function bodyContent(content: string): string {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return content;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') return lines.slice(i + 1).join('\n');
  }
  return content;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function splitBlocks(body: string): string[] {
  return body
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function splitSections(body: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*#+\s/.test(line) && current.length > 0) {
      sections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current.join('\n'));
  return sections.filter((section) => section.trim().length > 0);
}

function taskLines(body: string): string[] {
  return body
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*+]\s+)?\[[ xX]\]\s+/.test(line));
}

function extractTags(
  body: string,
  frontmatter: Record<string, unknown> | undefined
): string[] {
  const tags = new Set<string>();
  for (const value of propertyValues(frontmatter?.tags)) {
    for (const part of value.split(/\s+/).filter(Boolean)) {
      tags.add(part.startsWith('#') ? part : `#${part}`);
    }
  }

  const masked = maskCode(body);
  for (const match of masked.matchAll(/(^|[^\w#])#([\w/-]+)/gm)) {
    tags.add(`#${match[2]!}`);
  }
  return [...tags];
}

function maskCode(body: string): string {
  let masked = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (value) =>
    value.replace(/[^\n]/g, ' ')
  );
  masked = masked.replace(/`[^`]*`/g, (value) => value.replace(/[^\n]/g, ' '));
  return masked;
}
