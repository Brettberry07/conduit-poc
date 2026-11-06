// PM-supplied observations are assessments, never GitHub approvals. Inconsistent
// local/observed heads conservatively require reassessment rather than guessing.
export function reviewIsStale(
  examined: string | undefined,
  localHead: string | null,
  observedHead: string | undefined,
  examinedJob: string,
  latestJob: string,
) {
  return (
    !examined ||
    !localHead ||
    examined !== localHead ||
    (!!observedHead && examined !== observedHead) ||
    examinedJob !== latestJob
  );
}
