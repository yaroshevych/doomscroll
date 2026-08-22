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
      if (j < pattern.length) {
        regex += pattern.substring(i, j + 1);
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
