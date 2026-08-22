import { ViewHistoryEntry } from './types';

export function recordView(
  history: ViewHistoryEntry[],
  path: string,
  now: number
): ViewHistoryEntry[] {
  // Append new entry
  const newHistory = [...history, { path, viewedAt: now }];

  // Trim entries older than 30 days
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const cutoff = now - thirtyDaysMs;

  return newHistory.filter((entry) => entry.viewedAt >= cutoff);
}
