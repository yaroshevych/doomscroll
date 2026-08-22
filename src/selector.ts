import type { NotePreview, ViewHistoryEntry } from './types';

const COOLDOWN_MS = 30 * 60 * 1000;
const RECENTLY_VIEWED_MS = 7 * 24 * 60 * 60 * 1000;

export function selectBatch(
  candidates: NotePreview[],
  history: ViewHistoryEntry[],
  batchSize: number,
  now: number
): NotePreview[] {
  const lastViewedAt = new Map<string, number>();
  for (const entry of history) {
    const previous = lastViewedAt.get(entry.path);
    if (previous === undefined || entry.viewedAt > previous) {
      lastViewedAt.set(entry.path, entry.viewedAt);
    }
  }

  const recentWeek: NotePreview[] = [];
  const fresh: NotePreview[] = [];
  const coolingDown: NotePreview[] = [];

  for (const preview of candidates) {
    const viewedAt = lastViewedAt.get(preview.path);
    if (viewedAt !== undefined && now - viewedAt < COOLDOWN_MS) {
      coolingDown.push(preview);
      continue;
    }

    if (viewedAt !== undefined && now - viewedAt < RECENTLY_VIEWED_MS) {
      recentWeek.push(preview);
    } else {
      fresh.push(preview);
    }
  }

  // A small or heavily filtered vault can put every note in cooldown. In that
  // case, repeat notes instead of returning an empty feed.
  if (recentWeek.length === 0 && fresh.length === 0) {
    recentWeek.push(...coolingDown);
  }

  // Calculate how many recent we can include (20% of batch)
  const maxRecent = Math.floor(batchSize * 0.2);

  const recentCount = Math.min(maxRecent, recentWeek.length);
  const freshCount = Math.min(fresh.length, batchSize - recentCount);
  const additionalRecent = Math.min(
    recentWeek.length - recentCount,
    batchSize - recentCount - freshCount
  );

  // A partial Fisher-Yates sample only touches the notes this batch will use.
  const selectedRecent = takeRandom(recentWeek, recentCount + additionalRecent);
  const selectedFresh = takeRandom(fresh, freshCount);

  return [
    ...selectedRecent.slice(0, recentCount),
    ...selectedFresh,
    ...selectedRecent.slice(recentCount),
  ];
}

function takeRandom<T>(items: T[], count: number): T[] {
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (items.length - i));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }

  return items.slice(0, count);
}
