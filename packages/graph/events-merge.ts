/** Browser-safe deterministic run event merger (dedup + sort + seq gap detection for A25). */
export function mergeRunEvents<T extends { seq: number }>(
  existing: readonly T[],
  incoming: readonly T[],
  expectedAfterSeq?: number,
): {
  events: T[];
  lastSeq: number;
  snapshotRequired: boolean;
  gapFromSeq?: number;
  gapToSeq?: number;
} {
  const bySeq = new Map<number, T>();
  for (const ev of existing) {
    bySeq.set(ev.seq, ev);
  }
  const existingSorted = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const maxExistingSeq = existingSorted.length
    ? existingSorted[existingSorted.length - 1].seq
    : 0;
  const baseline = expectedAfterSeq ?? maxExistingSeq;

  for (const ev of incoming) {
    bySeq.set(ev.seq, ev);
  }
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const lastSeq = events.length ? events[events.length - 1].seq : baseline;

  const newlySorted = [...incoming].sort((a, b) => a.seq - b.seq);
  if (newlySorted.length > 0 && (existingSorted.length > 0 || expectedAfterSeq !== undefined)) {
    const relevant = events.filter((e) => e.seq > baseline);
    if (relevant.length > 0 && relevant[0].seq > baseline + 1) {
      return {
        events,
        lastSeq,
        snapshotRequired: true,
        gapFromSeq: baseline + 1,
        gapToSeq: relevant[0].seq - 1,
      };
    }
    for (let i = 1; i < relevant.length; i += 1) {
      if (relevant[i].seq > relevant[i - 1].seq + 1) {
        return {
          events,
          lastSeq,
          snapshotRequired: true,
          gapFromSeq: relevant[i - 1].seq + 1,
          gapToSeq: relevant[i].seq - 1,
        };
      }
    }
  }

  return { events, lastSeq, snapshotRequired: false };
}
