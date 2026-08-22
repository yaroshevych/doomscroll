# Doomscroll

**Doomscroll your own notes.**

I used to be an engineering manager on Instagram Reels. Now I am using the same
feed format to scroll through my own notes.

No ranking algorithm, no cloud service, no celebrities. Just notes, web
snippets, book quotes, and other things already sitting in my Obsidian vault.

## Why

My problem was simple: I write a lot, save a lot, but rarely come back to any of
it. Jotted notes, diary entries, LLM Wiki pages - all had the same problem. The
content was great. I just didn't feel like going back to it.

My vault became write-only.

Social apps are very good at resurfacing content. Personal knowledge management
tools are not. Doomscroll borrows the science behind the social feed and applies
it to your vault, so you are motivated to engage with your notes.

Same scroll. Your content.

<img src="https://github.com/user-attachments/assets/bbb240b2-e7bd-4ee7-af4e-b9f583d74629" height="400px" alt="Doomscroll on mobile" />

## Features

- Shuffled card feed, not another list sorted by modification date
- Manual reshuffle when the current batch is not doing it for you
- At most 20% of each batch is reserved for notes seen in the last seven days,
  unless there are not enough unseen notes
- 30-minute cooldown before a note can appear again
- Back button for the batch you should not have reshuffled
- Filters for folders, tags, and filename patterns
- Cover images from frontmatter, Markdown, or HTML
- Prose previews without headings and code noise
- Lazy image loading
- Works on desktop and mobile
- Scroll position survives switching panes

## Installation

1. Clone this repository into your vault's `.obsidian/plugins/` directory:
   ```
   git clone https://github.com/yaroshevych/doomscroll .obsidian/plugins/doomscroll
   ```

2. Navigate to the plugin directory and install dependencies:
   ```
   cd .obsidian/plugins/doomscroll
   npm install
   ```

3. Build the plugin:
   ```
   npm run build
   ```

4. Enable the plugin in Obsidian settings under **Community plugins**.

## Settings

- **Batch size** (5 to 50): How many cards to show per reshuffle (default: 20)
- **Exclude folders**: Folder paths to skip (one per line)
- **Exclude tags**: Tag names to skip without # (one per line)
- **Exclude filename globs**: Glob patterns to skip (one per line, e.g., `_*` for drafts)
- **Frontmatter image properties**: Property names to check for images (default: `cover`, `image`, `banner`)

## Usage

1. Click the gallery icon in the ribbon or use the "Open feed" command
2. Click any card to open the note in a new pane
3. Click the refresh icon when you want a new random batch
4. Click the back arrow to return to the previous batch
5. Adjust settings to tune which notes appear

## Development

```bash
npm run dev    # Watch mode for development
npm run build  # Production build
```

## License

MIT
