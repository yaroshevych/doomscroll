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

export function isInCooldown(
  history: ViewHistoryEntry[],
  path: string,
  now: number
): boolean {
  const thirtyMinMs = 30 * 60 * 1000;

  for (const entry of history) {
    if (entry.path === path && now - entry.viewedAt < thirtyMinMs) {
      return true;
    }
  }

  return false;
}

export function viewedWithinDays(
  history: ViewHistoryEntry[],
  path: string,
  now: number,
  days: number
): boolean {
  const daysMs = days * 24 * 60 * 60 * 1000;

  for (const entry of history) {
    if (entry.path === path && now - entry.viewedAt < daysMs) {
      return true;
    }
  }

  return false;
}
