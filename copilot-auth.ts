// GitHub device-flow login for the Copilot proxy. Prints a code for you to enter at github.com/login/device,
// then saves the GitHub OAuth token to ~/.codex-proxy/github-token (mode 600). Never asks for a password.
import { mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const CLIENT_ID = "Iv1.b507a08c87ecfe98"; // GitHub Copilot's VS Code client id (device flow)
const H = { "content-type": "application/json", accept: "application/json", "user-agent": "GitHubCopilotChat/0.26.7" };

export async function writePrivateAuthFile(path: string, contents: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  // Replacing a private temporary file avoids exposing partial writes or following an existing token symlink.
  const temporary = join(parent, `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(contents, "utf8"); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main(): Promise<number> {
  const home = Bun.env.HOME ?? homedir();
  const tokenPath = Bun.env.COPILOT_GITHUB_TOKEN_FILE ?? join(home, ".codex-proxy", "github-token");
  const statusPath = join(home, ".codex-proxy", "auth-status.json");
  const deviceResponse = await fetch("https://github.com/login/device/code", {
    method: "POST", headers: H,
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
  });
  const dc = await deviceResponse.json() as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };
  if (!dc.user_code) { console.error(`device code request failed: HTTP ${deviceResponse.status}`); return 1; }
  await writePrivateAuthFile(statusPath, JSON.stringify({ user_code: dc.user_code, verification_uri: dc.verification_uri, expires_at: new Date(Date.now() + dc.expires_in * 1000).toISOString(), state: "waiting" }));
  console.log(`Open ${dc.verification_uri} and enter code: ${dc.user_code}  (expires in ${Math.round(dc.expires_in / 60)} min)`);

  let interval = (dc.interval ?? 5) + 1;
  const deadline = Date.now() + dc.expires_in * 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(interval * 1000);
    const r = await (await fetch("https://github.com/login/oauth/access_token", {
      method: "POST", headers: H,
      body: JSON.stringify({ client_id: CLIENT_ID, device_code: dc.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    })).json() as { access_token?: string; error?: string };
    if (r.access_token) {
      await writePrivateAuthFile(tokenPath, r.access_token);
      await writePrivateAuthFile(statusPath, JSON.stringify({ state: "authenticated", at: new Date().toISOString() }));
      console.log(`GitHub token saved to ${tokenPath}`);
      return 0;
    }
    if (r.error === "slow_down") interval += 5;
    else if (r.error && r.error !== "authorization_pending") {
      await writePrivateAuthFile(statusPath, JSON.stringify({ state: "failed", error: r.error }));
      console.error(`login failed: ${r.error}`); return 1;
    }
  }
  await writePrivateAuthFile(statusPath, JSON.stringify({ state: "expired" }));
  console.error("device code expired before it was entered; run auth again"); return 1;
}

if (import.meta.main) process.exitCode = await main();
