/**
 * Whether Next stopped a command to recommend a security upgrade.
 *
 * Next 16.4 stops `next build` and `next dev` once when it detects an AI agent
 * and the installed version has an advisory, and lets the next run through
 * while a receipt in `.next/cache/next-agentic-upgrade-retries` survives. A
 * successful run consumes the receipt. The build prints `SecurityFatalError`;
 * the dev server's stderr carries only the message, so both are matched.
 */
export function stoppedForSecurityUpgrade(output: string): boolean {
  return (
    output.includes("SecurityFatalError") ||
    output.includes("stopped to show the upgrade recommendation")
  );
}
