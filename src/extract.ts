const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const PREVIEW_SOURCE_MAX_CHARS = 12_000;
const PREVIEW_BLOCK_LIMIT = 5;
const PREVIEW_TABLE_ROW_LIMIT = 8;
const PREVIEW_CODE_LINE_LIMIT = 12;
const SIMPLE_PREVIEW_BLOCK_LIMIT = 3;
const SIMPLE_PREVIEW_TABLE_ROW_LIMIT = 5;
const SIMPLE_PREVIEW_CODE_LINE_LIMIT = 6;

function hasImageExtension(path: string): boolean {
  // Strip any query/anchor before checking extension (e.g. url?x=1)
  const clean = path.split(/[?#]/)[0] ?? path;
  return IMAGE_EXT_RE.test(clean);
}

export function extractImage(
  content: string,
  frontmatter: Record<string, unknown> | undefined,
  frontmatterImageProps: string[]
): string | null {
  if (frontmatter) {
    // Check frontmatter properties in order
    for (const prop of frontmatterImageProps) {
      const value = frontmatter[prop];
      if (typeof value === 'string') {
        return value.replace(/^\[\[/, '').replace(/\]\]$/, '');
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
      .replace(/^\s*(?:[-*+]\s+)?\[(.)\]\s*/, (_match, marker: string) => {
        if (marker === ' ') return '☐ ';
        if (marker.toLowerCase() === 'x') return '✅ ';
        return '❌ '; // any other marker (-, /, etc.) = cancelled/other status
      }) // checkbox "- [x] text" or "[x] text" -> status emoji + text
      .replace(/==([^=]+)==/g, '$1') // highlight ==text== -> text
      .replace(/\*\*([^*]+)\*\*/g, '$1') // bold **text** -> text
      .replace(/__([^_]+)__/g, '$1') // bold __text__ -> text
      .replace(/\*([^*]+)\*/g, '$1') // italic *text* -> text
      .replace(/_([^_]+)_/g, '$1') // italic _text_ -> text
      .replace(/`([^`]+)`/g, '$1') // inline code `text` -> text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // link [text](url) -> text
      .replace(
        /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
        (_match, path: string, label?: string) => label ?? path
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

/**
 * Prepare a bounded fragment for on-demand rendering. Frontmatter is omitted,
 * but Markdown structure—including fenced code—is retained so the renderer
 * can produce an accurate preview.
 */
export function preparePreviewMarkdown(
  content: string,
  maxChars = PREVIEW_SOURCE_MAX_CHARS
): string {
  const lines = content.split('\n');
  const startIndex = frontmatterEndIndex(lines);
  const selected: string[] = [];
  let inFence = false;
  let openFenceMarker: string | null = null;
  let characterCount = 0;
  let truncated = false;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);

    if (characterCount + line.length + 1 > maxChars) {
      if (selected.length === 0 && line.length > 0) {
        selected.push(line.slice(0, maxChars));
      }
      truncated = true;
      break;
    }

    selected.push(line);
    characterCount += line.length + 1;
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!inFence) {
        inFence = true;
        openFenceMarker = marker;
      } else if (marker[0] === openFenceMarker?.[0]) {
        inFence = false;
        openFenceMarker = null;
      }
    }
  }

  const markdown = selected.join('\n').trim();
  // A fragment ending inside a fence would make MarkdownRenderer treat all
  // following content as code. Close it explicitly when the source bound cut
  // through a fenced block.
  return `${markdown}${truncated && inFence ? `\n${openFenceMarker ?? '```'}` : ''}`.trim();
}

/** Return whether a note has content beyond an image/file embed. */
export function hasTextualPreviewContent(content: string): boolean {
  return preparePreviewMarkdown(content)
    .split('\n')
    .some((line) => {
      const trimmed = withoutListMarker(line);
      if (!trimmed) return false;
      if (isStandaloneMediaEmbed(trimmed)) return false;
      if (/^<img\b[^>]*>$/i.test(trimmed)) return false;
      return true;
    });
}

/** Return whether a note contains an image or attachment embed. */
export function hasMediaEmbed(content: string): boolean {
  return preparePreviewMarkdown(content)
    .split('\n')
    .some((line) => {
      const trimmed = withoutListMarker(line);
      return (
        isMediaWikiEmbed(trimmed) ||
        /^!\[[^\]]*\]\([^)]*\)/.test(trimmed) ||
        /^<img\b/i.test(trimmed)
      );
    });
}

function withoutListMarker(line: string): string {
  return line.replace(/^\s*(?:[-*+]\s+|\d+\.\s+)/, '').trim();
}

function isStandaloneMediaEmbed(line: string): boolean {
  return (
    isMediaWikiEmbed(line) ||
    /^!\[[^\]]*\]\([^)]*\)$/.test(line)
  );
}

function isMediaWikiEmbed(line: string): boolean {
  const match = line.match(/^!\[\[([^\]]+)\]\]$/);
  if (!match) return false;

  const target = match[1]!.split('|')[0]!.split('#')[0]!.trim();
  const extension = target.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return Boolean(extension && extension !== 'md');
}

/**
 * Prepare rendered preview DOM for one of Doomscroll's two display modes.
 * MarkdownRenderer remains responsible for understanding Obsidian Markdown;
 * this function only applies the card-specific size and interaction policy.
 */
export function prepareRenderedPreview(
  container: HTMLElement,
  simplified: boolean
): HTMLElement {
  const root = container.cloneNode(true) as HTMLElement;

  // Inline images and embeds are represented by the card's separate lazy
  // image; keeping them here would make a single note dominate the card.
  root
    .querySelectorAll(
      'img, svg, video, audio, iframe, object, embed, button, .image-embed, .media-embed, .external-link-icon, .external-link-flair'
    )
    .forEach((element) => element.remove());

  // Card clicks open the source note. Keep the rendered link appearance, but
  // make individual links visual-only in both modes.
  root.querySelectorAll('a').forEach((anchor) => {
    if (!anchor.textContent?.trim()) {
      anchor.remove();
      return;
    }
    const replacement = root.ownerDocument.createElement('span');
    // Do not copy Obsidian's `external-link`/icon classes: they add arrow
    // decorations that are distracting inside a card preview.
    replacement.className = 'doomscroll-preview-link';
    while (anchor.firstChild) replacement.appendChild(anchor.firstChild);
    anchor.replaceWith(replacement);
  });

  root.querySelectorAll('input[type="checkbox"]').forEach((element) => {
    const checkbox = element as HTMLInputElement;
    element.replaceWith(
      root.ownerDocument.createTextNode(checkbox.checked ? '✅ ' : '☐ ')
    );
  });

  limitTablesAndCode(
    root,
    simplified ? SIMPLE_PREVIEW_TABLE_ROW_LIMIT : PREVIEW_TABLE_ROW_LIMIT,
    simplified ? SIMPLE_PREVIEW_CODE_LINE_LIMIT : PREVIEW_CODE_LINE_LIMIT
  );

  if (simplified) {
    root
      .querySelectorAll('hr, .footnotes, .footnote-backref')
      .forEach((element) => element.remove());
    root
      .querySelectorAll('script, style, iframe, object, embed, form')
      .forEach((element) => element.remove());

    // Keep heading content, but remove heading semantics and visual weight.
    root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
      const paragraph = root.ownerDocument.createElement('p');
      paragraph.className = 'doomscroll-simple-heading';
      while (heading.firstChild) paragraph.appendChild(heading.firstChild);
      heading.replaceWith(paragraph);
    });

    // Keep the DOM needed for tables, code, checkboxes, and math, while
    // unwrapping ordinary Markdown emphasis and inline-code styling.
    root
      .querySelectorAll('strong, b, em, i, mark, del, s, u, :not(pre) > code')
      .forEach((element) => unwrap(element));

    root.classList.add('doomscroll-simple-preview');
  } else {
    root.classList.add('doomscroll-markdown-preview');
  }

  removeEmptyPreviewElements(root);
  limitTopLevelBlocks(
    root,
    simplified ? SIMPLE_PREVIEW_BLOCK_LIMIT : PREVIEW_BLOCK_LIMIT
  );
  return root;
}

function removeEmptyPreviewElements(root: HTMLElement): void {
  root
    .querySelectorAll('p, li, blockquote, div, span')
    .forEach((element) => {
      if (!element.textContent?.trim() && !element.querySelector('pre, table')) {
        element.remove();
      }
    });
}

function frontmatterEndIndex(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return 0;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') return i + 1;
  }
  return 0;
}

function limitTablesAndCode(
  root: HTMLElement,
  tableRowLimit: number,
  codeLineLimit: number
): void {
  root.querySelectorAll('table').forEach((table) => {
    table.classList.add('doomscroll-preview-table');
    Array.from(table.querySelectorAll('tr'))
      .slice(tableRowLimit)
      .forEach((row) => row.remove());
  });

  root.querySelectorAll('pre').forEach((pre) => {
    pre.classList.add('doomscroll-preview-code');
    const code = pre.querySelector('code') ?? pre;
    const lines = (code.textContent ?? '').split('\n');
    if (lines.length > codeLineLimit) {
      code.textContent = `${lines.slice(0, codeLineLimit).join('\n')}\n…`;
    }
  });
}

function limitTopLevelBlocks(root: HTMLElement, blockLimit: number): void {
  Array.from(root.children)
    .slice(blockLimit)
    .forEach((element) => element.remove());
}

function unwrap(element: Element): void {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  element.remove();
}
