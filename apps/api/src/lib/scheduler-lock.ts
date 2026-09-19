export function schedulerLockAvailable(
  lockToken: string | null | undefined,
  lockAcquiredAt: number | null | undefined,
  now: number,
  staleMs: number,
) {
  return !lockToken || !lockAcquiredAt || lockAcquiredAt < now - staleMs;
}