import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Integration tests spawn the built CLI/bootstrap from dist/. Build ONCE for
 * the whole run — per-file builds in beforeAll raced each other, clobbering
 * dist/ while another suite was executing it.
 */
export default function globalSetup(): void {
  execFileSync(path.join(rootDir, "node_modules", ".bin", "tsup"), { cwd: rootDir });
}
