export function compileGlob(pattern: string): RegExp {
  // Convert glob pattern to regex
  // * matches any chars except /
  // ** matches any chars including /

  let regex = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i] as string;

    if (char === '*') {
      if (i + 1 < pattern.length && pattern[i + 1] === '*') {
        // ** - matches anything including /
        if (
          i + 2 < pattern.length &&
          pattern[i + 2] === '/'
        ) {
          // **/ pattern
          regex += '(?:.*/)?';
          i += 3;
        } else if (i + 2 === pattern.length) {
          // ** at end
          regex += '.*';
          i += 2;
        } else {
          // ** followed by non-slash
          regex += '.*';
          i += 2;
        }
      } else {
        // single * - matches anything except /
        regex += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      regex += '.';
      i += 1;
    } else if (char === '[') {
      // character class
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== ']') {
        j++;
      }
      const classBody = pattern.substring(i + 1, j);
      const compiledClass =
        j < pattern.length ? compileCharacterClass(classBody) : null;
      if (compiledClass) {
        regex += compiledClass;
        i = j + 1;
      } else {
        regex += '\\[';
        i += 1;
      }
    } else {
      // literal character - escape special regex chars
      regex += escapeRegex(char);
      i += 1;
    }
  }

  return new RegExp(`^${regex}$`);
}

export function globMatch(pattern: string, filePath: string): boolean {
  return compileGlob(pattern).test(filePath);
}

function escapeRegex(char: string): string {
  const special = /[.+^${}()|[\]\\]/;
  if (special.test(char)) {
    return '\\' + char;
  }
  return char;
}

function compileCharacterClass(body: string): string | null {
  if (body.length === 0) return null;

  let content = body;
  let negated = false;
  if (content[0] === '^' || content[0] === '!') {
    negated = true;
    content = content.slice(1);
  }
  if (content.length === 0) return null;

  let escaped = '';
  for (const char of content) {
    if (char === '\\') {
      escaped += '\\\\';
    } else if (char === ']' || char === '[') {
      escaped += `\\${char}`;
    } else {
      // Keep '-' unescaped so ranges such as [a-z] remain supported.
      escaped += char;
    }
  }

  return `[${negated ? '^' : ''}${escaped}]`;
}
