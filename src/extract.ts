const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

function hasImageExtension(path: string): boolean {
  // Strip any query/anchor before checking extension (e.g. url?x=1)
  const clean = path.split(/[?#]/)[0] ?? path;
  return IMAGE_EXT_RE.test(clean);
}

export function extractImage(
  content: string,
  frontmatter: Record<string, any> | undefined,
  frontmatterImageProps: string[]
): string | null {
  if (frontmatter) {
    // Check frontmatter properties in order
    for (const prop of frontmatterImageProps) {
      if (frontmatter[prop]) {
        let value = frontmatter[prop];
        // Handle string values
        if (typeof value === 'string') {
          // Strip wikilink brackets if present
          value = value.replace(/^\[\[/, '').replace(/\]\]$/, '');
          return value;
        }
      }
    }
  }

  // Check for markdown image: ![alt](path) — first one with an image extension
  const markdownImageRe = /!\[.*?\]\(([^)]+)\)/g;
  let mdMatch: RegExpExecArray | null;
  while ((mdMatch = markdownImageRe.exec(content))) {
    if (hasImageExtension(mdMatch[1]!)) {
      return mdMatch[1]!;
    }
  }

  // Check for wikilink embed: ![[file.ext]] — first one with an image extension
  const wikiImageRe = /!\[\[([^\]]+)\]\]/g;
  let wikiMatch: RegExpExecArray | null;
  while ((wikiMatch = wikiImageRe.exec(content))) {
    const imagePath = wikiMatch[1]!.split('|')[0]!; // strip piped syntax like ![[path|width]]
    if (hasImageExtension(imagePath)) {
      return imagePath;
    }
  }

  // Check for raw <img src="..."> (assume genuine image tags are always images)
  const htmlImageMatch = content.match(/<img\s+src="([^"]+)"/);
  if (htmlImageMatch) {
    return htmlImageMatch[1]!;
  }

  return null;
}

export function extractSnippet(content: string): string {
  // Strip frontmatter block (--- ... ---)
  let lines = content.split('\n');
  let startIdx = 0;

  // Skip frontmatter
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') {
        startIdx = i + 1;
        break;
      }
    }
  }

  // Collect prose lines
  const proseLines: string[] = [];
  let inCodeBlock = false;
  let attachmentExt: string | null = null;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];

    // Skip fenced code blocks
    if (line?.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      continue;
    }

    // Skip heading lines
    if (line?.match(/^\s*#+\s/)) {
      continue;
    }

    // Skip blank lines
    if (!line || !line.trim()) {
      continue;
    }

    const trimmed = line.trim();

    // Skip embeds: ![[file]] or ![alt](path) — image/file embeds, not prose
    const embedMatch =
      trimmed.match(/^!\[\[([^\]]+)\]\]$/) ||
      trimmed.match(/^!\[.*\]\(([^)]+)\)$/);
    if (embedMatch) {
      if (!attachmentExt) {
        const extMatch = embedMatch[1]!.split('|')[0]!.match(/\.([a-z0-9]+)$/i);
        if (extMatch && !IMAGE_EXT_RE.test('.' + extMatch[1]!)) {
          attachmentExt = extMatch[1]!.toLowerCase();
        }
      }
      continue;
    }

    // Skip callouts/blockquotes (e.g. "> [!info] ...", metadata asides)
    if (trimmed.startsWith('>')) {
      continue;
    }

    // Skip lines that are just a bare list marker with no content (e.g. "*", "-")
    if (/^\s*[-*+]\s*$/.test(line)) {
      continue;
    }

    // Process line: strip markdown syntax
    let processed = line
      .replace(/^\s*(?:[-*+]\s+)?\[(.)\]\s*/, (_, c) => {
        if (c === ' ') return '☐ ';
        if (c.toLowerCase() === 'x') return '✅ ';
        return '❌ '; // any other marker (-, /, etc.) = cancelled/other status
      }) // checkbox "- [x] text" or "[x] text" -> status emoji + text
      .replace(/==([^=]+)==/g, '$1') // highlight ==text== -> text
      .replace(/\*\*([^*]+)\*\*/g, '$1') // bold **text** -> text
      .replace(/__([^_]+)__/g, '$1') // bold __text__ -> text
      .replace(/\*([^*]+)\*/g, '$1') // italic *text* -> text
      .replace(/_([^_]+)_/g, '$1') // italic _text_ -> text
      .replace(/`([^`]+)`/g, '$1') // inline code `text` -> text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // link [text](url) -> text
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, path, label) =>
        label || path
      ) // wikilink [[path|label]] -> label or [[path]] -> path
      .replace(/^\s*[-*+]\s+/, '') // remove list markers
      .replace(/^\s*\d+\.\s+/, '') // remove numbered list markers
      .trim();

    // Skip if stripping left nothing behind
    if (!processed) {
      continue;
    }

    // Truncate line to ~120 chars
    if (processed.length > 120) {
      processed = processed.substring(0, 120).trim() + '...';
    }

    proseLines.push(processed);

    // Collect first 3-5 lines
    if (proseLines.length >= 5) {
      break;
    }
  }

  if (proseLines.length === 0) {
    if (attachmentExt === 'pdf') {
      return '📎 PDF attached';
    }
    if (attachmentExt) {
      return `📎 ${attachmentExt.toUpperCase()} attached`;
    }
    return '(no preview text)';
  }

  // Cap total snippet size regardless of line count/length
  let snippet = proseLines.join('\n');
  if (snippet.length > 400) {
    snippet = snippet.substring(0, 400).trim() + '...';
  }

  return snippet;
}
