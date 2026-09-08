import { expect } from "bun:test";
import { copyFile, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runPowerShell } from "../windows.ts";

let compiled: { directory: string; binary: string } | undefined;
const source = join(import.meta.dir, "mock-codex.ts");

export async function cleanupMockCodex() {
  if (compiled) {
    await rm(compiled.directory, { recursive: true, force: true });
    compiled = undefined;
  }
}

export async function fakeCodex(path: string, options: {
  version?: string; echoArgs?: boolean; exitCode?: number; hang?: boolean;
} = {}): Promise<string> {
  const binary = process.platform === "win32" && !path.endsWith(".exe") ? `${path}.exe` : path;
  await mkdir(dirname(binary), { recursive: true });
  if (process.platform === "win32") {
    if (!compiled) {
      const directory = await mkdtemp(join(tmpdir(), "codex-proxy-fixture-bin-"));
      compiled = { directory, binary: join(directory, "mock-codex.exe") };
      const child = Bun.spawn([process.execPath, "build", "--compile", source, "--outfile", compiled.binary], {
        stdout: "pipe", stderr: "pipe",
      });
      const output = new Response(child.stdout).text();
      const errors = new Response(child.stderr).text();
      if (await child.exited !== 0) throw new Error(`Fixture compilation failed: ${await output}\n${await errors}`);
      await output;
      await errors;
      // Let Windows finish its first-run executable checks before tests use the
      // production five-second version probe against this newly compiled fixture.
      await writeFile(`${compiled.binary}.fixture.json`, JSON.stringify({ version: "0.0.0" }));
      const warm = Bun.spawn([compiled.binary, "--version"], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000,
      });
      const warmOutput = new Response(warm.stdout).text();
      const warmErrors = new Response(warm.stderr).text();
      if (await warm.exited !== 0) throw new Error(`Fixture warmup failed: ${await warmErrors}`);
      await warmOutput;
      await warmErrors;
    }
    if (!await Bun.file(binary).exists()) {
      await link(compiled.binary, binary).catch(async (error) => {
        if (error.code !== "EXDEV") throw error;
        await copyFile(compiled!.binary, binary);
      });
    }
  } else {
    await writeFile(binary, `#!${process.execPath}\n${await readFile(source, "utf8")}`, { mode: 0o700 });
  }
  await writeFile(`${binary}.fixture.json`, JSON.stringify(options));
  return binary;
}

export async function aclSnapshot(path: string) {
  return JSON.parse(await runPowerShell(`
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$acl = Get-Acl -LiteralPath $data.path
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
  @{ sid = $_.IdentityReference.Value; allow = $_.AccessControlType -eq 'Allow'; rights = [int]$_.FileSystemRights }
})
@{ sddl = $acl.Sddl; protected = $acl.AreAccessRulesProtected;
   user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules = $rules } | ConvertTo-Json -Depth 5 -Compress
`, { path }));
}

export async function expectPrivatePermissions(path: string, posixMode: number) {
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(posixMode);
    return;
  }
  const acl = await aclSnapshot(path);
  const allowed = acl.rules.filter((rule: any) => rule.allow);
  expect(allowed.length).toBeGreaterThan(0);
  expect(allowed.every((rule: any) => [acl.user, "S-1-5-18"].includes(rule.sid))).toBe(true);
  expect(allowed.some((rule: any) => rule.sid === acl.user && (rule.rights & 0x1f01ff) === 0x1f01ff)).toBe(true);
}
