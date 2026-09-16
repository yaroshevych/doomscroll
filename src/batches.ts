import type { NotePreview } from './types.ts';

export interface BatchRemovalResult {
  currentBatch: NotePreview[];
  batchHistory: NotePreview[][];
  batchHistoryCursor: number;
}

export function removePathFromBatches(
  currentBatch: readonly NotePreview[],
  batchHistory: readonly (readonly NotePreview[])[],
  batchHistoryCursor: number,
  path: string
): BatchRemovalResult {
  const nextCurrentBatch = currentBatch.filter(
    (preview) => preview.path !== path
  );
  const filteredHistory = batchHistory.map((batch) =>
    batch.filter((preview) => preview.path !== path)
  );
  const hasCurrentHistory =
    batchHistoryCursor >= 0 && batchHistoryCursor < filteredHistory.length;

  const nextHistory: NotePreview[][] = [];
  let nextCursor = -1;

  filteredHistory.forEach((batch, index) => {
    const isCurrentHistory = index === batchHistoryCursor;
    const keepEmptyCurrent = isCurrentHistory && hasCurrentHistory;
    if (batch.length === 0 && !keepEmptyCurrent) return;

    if (isCurrentHistory) nextCursor = nextHistory.length;
    nextHistory.push(batch);
  });

  return {
    currentBatch: nextCurrentBatch,
    batchHistory: nextHistory,
    batchHistoryCursor: nextCursor,
  };
}
