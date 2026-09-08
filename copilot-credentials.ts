import { Database } from "bun:sqlite";

export type CopilotCredential = { token: string; apiBase: string };

function copilotOrigin(value: unknown): string {
  let url: URL;
  try { url = new URL(typeof value === "string" ? value : "https://api.githubcopilot.com"); }
  catch { throw new Error("Invalid Copilot endpoint in the configured OMP store"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || url.pathname !== "/" || url.search || url.hash
    || !/^api(?:\.(?:enterprise|business))?\.githubcopilot\.com$/.test(url.hostname)) {
    throw new Error("Untrusted Copilot endpoint in the configured OMP store");
  }
  return url.origin;
}

// Explicit opt-in only. Match the existing shim's provider selection, never
// modify the store, and reopen it so credential rotations are picked up.
export function readOmpCopilotCredential(path: string): CopilotCredential {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query(`SELECT data FROM auth_credentials
      WHERE provider = ? AND disabled_cause IS NULL ORDER BY updated_at DESC`).all("github-copilot") as { data: string }[];
    for (const row of rows) {
      let data: any;
      try { data = JSON.parse(row.data); } catch { continue; }
      if (!data || typeof data.access !== "string" || !data.access.trim()) continue;
      const token = data.access.trim();
      if (!/^[A-Za-z0-9_.=-]+$/.test(token)) throw new Error("Invalid Copilot credential in the configured OMP store");
      return { token, apiBase: copilotOrigin(data.apiEndpoint) };
    }
    throw new Error("No enabled GitHub Copilot credential in the configured OMP store; sign in through OMP");
  } finally {
    db.close();
  }
}
