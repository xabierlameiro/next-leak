/** Seconds as the run prints them: "45s", "7m", "1.5h". */
export function formatDuration(seconds: number): string {
  if (seconds < 90) {
    return `${seconds}s`;
  }
  if (seconds < 5400) {
    return `${Math.round(seconds / 60)}m`;
  }
  return `${(seconds / 3600).toFixed(1)}h`;
}
