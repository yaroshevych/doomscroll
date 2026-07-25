import { NotePreview, ViewHistoryEntry } from './types';
import { isInCooldown, viewedWithinDays } from './history';

export function selectBatch(
  candidates: NotePreview[],
  history: ViewHistoryEntry[],
  batchSize: number,
  now: number
): NotePreview[] {
  // Filter out candidates in 30-min cooldown
  const available = candidates.filter(
    (preview) => !isInCooldown(history, preview.path, now)
  );

  if (available.length === 0) {
    return [];
  }

  // Partition into recentWeek and fresh
  const recentWeek: NotePreview[] = [];
  const fresh: NotePreview[] = [];

  for (const preview of available) {
    if (viewedWithinDays(history, preview.path, now, 7)) {
      recentWeek.push(preview);
    } else {
      fresh.push(preview);
    }
  }

  // Calculate how many recent we can include (20% of batch)
  const maxRecent = Math.floor(batchSize * 0.2);

  // Shuffle both partitions
  const shuffledRecent = shuffle(recentWeek);
  const shuffledFresh = shuffle(fresh);

  // Build result batch
  const result: NotePreview[] = [];

  // Take up to maxRecent from recentWeek
  const recentCount = Math.min(maxRecent, shuffledRecent.length);
  result.push(...shuffledRecent.slice(0, recentCount));

  // Fill rest of batch from fresh
  const remainingSpace = batchSize - result.length;
  result.push(...shuffledFresh.slice(0, remainingSpace));

  // If fresh runs short, top up from leftover recentWeek
  if (result.length < batchSize) {
    const additionalRecent = Math.min(
      shuffledRecent.length - recentCount,
      batchSize - result.length
    );
    result.push(
      ...shuffledRecent.slice(recentCount, recentCount + additionalRecent)
    );
  }

  // Cap at batchSize
  return result.slice(0, Math.min(batchSize, candidates.length));
}

function shuffle<T>(array: T[]): T[] {
  // Fisher-Yates shuffle
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
