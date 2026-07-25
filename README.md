# PKM Feed

**Doom-scroll your own notes.** A randomized card feed that resurfaces what you already wrote — before some feed algorithm resurfaces someone else's.

## Why

Your vault is already a curated, ranked feed: every note passed your own bar for "worth writing down." That's higher signal than anything a recommendation engine infers from clicks. It's just buried, sorted by folder, and never opened again.

Social apps nailed the *consumption* layer — scroll-based UX, bite-sized cards, mobile-first, serendipity over chronology. PKM Feed steals that layer and points it at your own vault. Same scroll, your content.

## Features

- **Random card feed** — notes surface in shuffled order, not last-modified
- **Smart selection** — recent notes get a 20% boost; the rest of each batch is old gold
- **Configurable filters** — exclude folders, tags, filename patterns
- **Image extraction** — pulls cover images from frontmatter, markdown, or HTML
- **Clean previews** — prose-only snippets, no headings or code noise
- **Cooldown protection** — a note won't repeat for 30 minutes
- **Lazy image loading** — images load as they scroll into view
- **Session memory** — your scroll position survives switching panes

## Installation

1. Clone this repository into your vault's `.obsidian/plugins/` directory:
   ```
   git clone https://github.com/yaroshevych/pkm-feed .obsidian/plugins/pkm-feed
   ```

2. Navigate to the plugin directory and install dependencies:
   ```
   cd .obsidian/plugins/pkm-feed
   npm install
   ```

3. Build the plugin:
   ```
   npm run build
   ```

4. Enable the plugin in Obsidian settings under **Community plugins**.

## Settings

- **Batch size** (5–50): How many cards to show per reshuffle (default: 20)
- **Exclude folders**: Folder paths to skip (one per line)
- **Exclude tags**: Tag names to skip without # (one per line)
- **Exclude filename globs**: Glob patterns to skip (one per line, e.g., `_*` for drafts)
- **Frontmatter image properties**: Property names to check for images (default: `cover`, `image`, `banner`)

## Usage

1. Click the gallery icon in the ribbon or use the "Open Scroll" command to open the feed
2. Click any card to open the note in a new pane
3. Click the refresh icon to reshuffle and get a new random batch
4. Adjust settings to tune which notes appear

## Development

```bash
npm run dev    # Watch mode for development
npm run build  # Production build
```

## License

MIT
