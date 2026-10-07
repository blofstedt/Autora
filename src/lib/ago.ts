// How long until, and how long since, in the words the schedule pages use.
// Apart from the page so the rail and the corner widgets can use them
// without loading it.

/** "in 4h", "in 3 days" -- a countdown answers "is this on?" faster than a date. */
export function until(ts: number): string {
  const seconds = Math.round(ts - Date.now() / 1000);
  if (seconds <= 0) return "due now";
  if (seconds < 90) return `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)} days`;
}

export function ago(ts: number): string {
  const seconds = Math.round(Date.now() / 1000 - ts);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
