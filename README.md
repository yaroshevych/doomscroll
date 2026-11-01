# Doomscroll

A social-style feed of your own Obsidian notes.

You write and save a lot. How often do you look at it again? Scroll through
forgotten notes, reflect on your thoughts, and find new ideas.

<img src="https://github.com/user-attachments/assets/bbb240b2-e7bd-4ee7-af4e-b9f583d74629" height="400px" alt="Doomscroll on mobile" />

## Usage

1. Open the feed with the menu item on Mobile, or the "Open feed" command.
   Scroll through previews of random notes, and click a card to open it.
2. Create separate feeds, each with its own search and filter options.
   For example, make one feed for only your Journal folder and another
   for only your Books folder. Switch feeds from the menu at the top of the feed.
3. Reshuffle for a fresh set of notes, or turn on infinite scrolling in settings.
   You can keep multiple feeds open at the same time and rename any feed in
   settings if you'd prefer a different name to Doomscroll.
4. Adjust previews in each feed's settings. Choose how much text to show, turn
   Simplified view off for full note formatting, or show selected note properties.
   Major plugins like Bases or Dataview supported.
5. On desktop, use the arrow keys to select a card, Space to preview a note, PDF,
   or video, and Enter to open it. Find more shortcuts under **Keyboard shortcuts**
   in Doomscroll settings.

## Settings

Each feed has its own filters and preview settings:

- Choose what appears using Obsidian search, or exclude folders, tags, and
  filename patterns. Try a search in Obsidian's Search sidebar, then copy it
  into the feed settings.
- Adjust preview length and choose simplified previews or full note formatting.
  Previews also support Dataview and Bases content.
- Show note properties (frontmatter), such as tags or author, above or below
  the preview. Use image properties such as `cover`, `image`, or `banner` to
  show images on cards.
- Include notes containing only attachments, or standalone images, PDFs, and
  other files that aren't linked from a note.

## Installation

1. In Obsidian, open **Settings → Community plugins**.
2. Browse for **Doomscroll**, then install and enable it.

## Development

```bash
npm run dev    # Watch mode for development
npm run build  # Production build
```

## License

MIT
