import { existsSync } from "node:fs";

/**
 * The service-account JSON is never read from a default path.
 * This VM does not have the key. Set GMAIL_SA_KEY_PATH on the machine that does.
 */
export function requireServiceAccountKeyPath(env?: { GMAIL_SA_KEY_PATH?: string }): string {
  const keyPath = (env ?? process.env).GMAIL_SA_KEY_PATH?.trim() ?? "";
  if (!keyPath) {
    throw new Error(
      "GMAIL_SA_KEY_PATH is not set. On the machine that has the service-account JSON, " +
        "export GMAIL_SA_KEY_PATH=/path/to/sa.json and run npm run inbox:check. " +
        "Do not commit the file.",
    );
  }
  if (!existsSync(keyPath)) {
    throw new Error(`GMAIL_SA_KEY_PATH does not exist: ${keyPath}`);
  }
  return keyPath;
}
