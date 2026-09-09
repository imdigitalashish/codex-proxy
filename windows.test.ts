import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { install, renderServiceDefinitions } from "./setup.ts";
import { installWindowsTasks, protectWindowsPath, runPowerShell } from "./windows.ts";
import { aclSnapshot, expectPrivatePermissions } from "./test-support/helpers.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

const options = {
  platform: "win32" as const,
  home: "C:\\Users\\O'Brien & [dev] $name %PATH%",
  codexHome: "C:\\Codex state",
  installDir: "C:\\Users\\O'Brien & [dev] $name %PATH%\\.codex-proxy",
  bunExecutable: "C:\\Program Files\\Bun\\bun.exe",
  path: "C:\\Program Files\\Bun;C:\\Windows\\System32;C:\\custom tools",
};

describe("Windows services", () => {
  test("generates disabled, least-privilege tasks and literal, hidden launch commands", () => {
    const definitions = renderServiceDefinitions(options);
    expect(Object.keys(definitions)).toEqual(["CodexProxy.xml", "CodexProxyPickerGuard.xml"]);
    for (const xml of Object.values(definitions)) {
      expect(xml).toContain("<Enabled>false</Enabled><Hidden>true</Hidden>");
      expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
      expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
      expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
      expect(xml).toContain("-WindowStyle Hidden -EncodedCommand");
      expect(xml).not.toContain("ExecutionPolicy");
      const encoded = xml.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)![1];
      const command = Buffer.from(encoded, "base64").toString("utf16le");
      expect(command).toContain("O''Brien & [dev] $name %PATH%");
      expect(command).toContain(options.path);
      expect(command).toContain("exit $LASTEXITCODE");
      expect(command).not.toContain("Start-Process");
      // A healthy server logging to stderr must not terminate its wrapper.
      expect(command).toContain("$ErrorActionPreference = 'Continue'");
      expect(command).not.toContain("$ErrorActionPreference = 'Stop'");
      // A real crash must still surface a failure exit code for RestartOnFailure.
      expect(command).toContain("if ($LASTEXITCODE -eq $null) { exit 1 }");
    }
    expect(definitions["CodexProxy.xml"]).toContain("<RestartOnFailure>");
    expect(definitions["CodexProxy.xml"]).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(definitions["CodexProxyPickerGuard.xml"]).toContain("<Interval>PT2M</Interval>");
  });

  test.skipIf(process.platform !== "win32")("Windows validates the real task XML without registering tasks", async () => {
    const definitions = renderServiceDefinitions(options);
    expect(await installWindowsTasks(definitions, true)).toEqual(["CodexProxy", "CodexProxyPickerGuard"]);
    for (const xml of Object.values(definitions)) {
      const command = Buffer.from(xml.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)![1], "base64").toString("utf16le");
      const errors = await runPowerShell(`
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$tokens = $null
$parseErrors = $null
$null = [Management.Automation.Language.Parser]::ParseInput($data.command, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
`, { command });
      expect(errors).toBe("");
    }
  }, 20_000);

  test("native setup generates only Windows definitions without touching Codex settings", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-proxy-win-setup-"));
    temporary.push(home);
    const result = await install({ home, sourceDir: import.meta.dir, platform: "win32", env: {} });
    expect(result.platform).toBe("win32");
    expect(result.installedServiceFiles).toEqual([]);
    expect(await readdir(join(result.installDir, "services"))).toEqual(["CodexProxy.xml", "CodexProxyPickerGuard.xml"]);
    expect(await readdir(home)).toEqual([".codex-proxy"]);
    await expectPrivatePermissions(join(result.installDir, ".env"), 0o600);
  }, 20_000);

  test.skipIf(process.platform !== "win32" || process.env.CODEX_TEST_WINDOWS_TASKS !== "1")(
    "disposable tasks start hidden, use the selected home, and stop their server", async () => {
      const directory = await mkdtemp(join(tmpdir(), "codex-proxy-task-lifecycle-"));
      temporary.push(directory);
      const installDir = join(directory, "proxy & 'literal' [path]");
      const codexHome = join(directory, "codex state");
      await mkdir(join(installDir, "logs"), { recursive: true });
      await protectWindowsPath(installDir);
      await writeFile(join(installDir, "server.ts"), `
import { watchTaskParent } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "windows.ts")).href)};
watchTaskParent();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
await Bun.write("ready.json", JSON.stringify({ port: server.port, pid: process.pid, home: Bun.env.HOME, codexHome: Bun.env.CODEX_HOME }));
`);
      await writeFile(join(installDir, "picker-guard.ts"), 'await Bun.write("picker-ready.json", JSON.stringify({ codexHome: Bun.env.CODEX_HOME }));\n');
      const rendered = renderServiceDefinitions({ platform: "win32", home: directory, codexHome, installDir,
        bunExecutable: process.execPath, path: process.env.PATH || join(process.execPath, "..") });
      const prefix = `CodexProxy-Test-${crypto.randomUUID()}`;
      const definitions = Object.fromEntries(Object.values(rendered).map((xml, index) => [`${prefix}-${index}.xml`, xml]));
      const names = Object.keys(definitions).map((name) => name.replace(/\.xml$/, ""));
      let ready: { port: number; pid: number; home: string; codexHome: string } | undefined;
      try {
        const pickerCommand = Buffer.from(rendered["CodexProxyPickerGuard.xml"].match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)![1], "base64").toString("utf16le");
        await runPowerShell(pickerCommand, {}).catch(async (error) => {
          const logs = await Promise.all((await readdir(join(installDir, "logs"))).map(async (name) =>
            `${name}: ${(await readFile(join(installDir, "logs", name))).toString("utf8")}`));
          throw new Error(`${error}\n${logs.join("\n")}`);
        });
        await rm(join(installDir, "picker-ready.json"));
        await installWindowsTasks(definitions);
        // Reinstallation must not modify matching tasks or try to reapply their ACLs.
        await installWindowsTasks(definitions);
        await runPowerShell(`
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\')
foreach ($name in $data.names) {
  $task = $folder.GetTask($name)
  if ($task.Enabled) { throw 'A new task was unexpectedly enabled' }
  $task.Enabled = $true
  $null = $task.Run($null)
}
`, { names });
        for (let attempt = 0; attempt < 200; attempt++) {
          if (await Bun.file(join(installDir, "ready.json")).exists()
            && await Bun.file(join(installDir, "picker-ready.json")).exists()) break;
          await Bun.sleep(50);
        }
        if (!await Bun.file(join(installDir, "ready.json")).exists()) {
          const status = await runPowerShell(`
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\')
@($data.names | ForEach-Object { $task = $folder.GetTask($_); @{ name = $_; state = $task.State; result = $task.LastTaskResult } }) | ConvertTo-Json -Compress
`, { names });
          const logs = await Promise.all((await readdir(join(installDir, "logs"))).map(async (name) =>
            `${name}: ${(await readFile(join(installDir, "logs", name))).toString("utf8")}`));
          throw new Error(`Task fixture did not start: ${status}\n${logs.join("\n")}`);
        }
        ready = await Bun.file(join(installDir, "ready.json")).json();
        expect(ready!.home).toBe(directory);
        expect(ready!.codexHome).toBe(codexHome);
        expect((await Bun.file(join(installDir, "picker-ready.json")).json()).codexHome).toBe(codexHome);
        expect(await (await fetch(`http://127.0.0.1:${ready!.port}`)).json()).toEqual({ ok: true });
      } finally {
        // Only touch the randomly named tasks whose working directory is our fixture.
        await runPowerShell(`
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\')
foreach ($name in $data.names) {
  $task = $null
  try { $task = $folder.GetTask($name) } catch { continue }
  if ($task.Definition.Actions.Item(1).WorkingDirectory -ne $data.installDir) { throw 'Unexpected task owner' }
  $task.Enabled = $false
  $task.Stop(0)
  $folder.DeleteTask($name, 0)
}
`, { names, installDir });
      }
      let stopped = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        try { await fetch(`http://127.0.0.1:${ready!.port}`, { signal: AbortSignal.timeout(200) }); }
        catch { stopped = true; break; }
        await Bun.sleep(50);
      }
      // Clean up a leaked fixture process, but still fail the stop-contract assertion.
      if (!stopped && ready) process.kill(ready.pid);
      expect(stopped).toBe(true);
    }, 45_000,
  );
});

describe.skipIf(process.platform !== "win32")("Windows credential ACLs", () => {
  test("reapplies directory protection on upgrade without audit privileges", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-proxy-acl-upgrade-"));
    temporary.push(directory);
    await protectWindowsPath(directory);
    const file = join(directory, "existing.txt");
    await writeFile(file, "fixture-only");
    const before = (await aclSnapshot(directory)).sddl;
    await protectWindowsPath(directory);
    expect((await aclSnapshot(directory)).sddl).toBe(before);
    await expectPrivatePermissions(file, 0o600);
    expect(await readFile(file, "utf8")).toBe("fixture-only");
  }, 20_000);

  test("removes explicit broad grants and protects inheritance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-proxy-acl-"));
    temporary.push(directory);
    const file = join(directory, "private 'file' & [name].txt");
    await writeFile(file, "fixture-only");
    await runPowerShell(`
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$acl = Get-Acl -LiteralPath $data.path
$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Read', 'Allow'))
Set-Acl -LiteralPath $data.path -AclObject $acl
`, { path: file });
    await protectWindowsPath(file);
    await expectPrivatePermissions(file, 0o600);
    expect((await aclSnapshot(file)).protected).toBe(true);
    expect(await readFile(file, "utf8")).toBe("fixture-only");
  }, 20_000);

  test("refuses directory reparse points without changing the target ACL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-proxy-acl-link-"));
    temporary.push(directory);
    const target = join(directory, "target");
    const link = join(directory, "link");
    await mkdir(target);
    await symlink(target, link, "junction");
    const before = (await aclSnapshot(target)).sddl;
    await expect(protectWindowsPath(link)).rejects.toThrow("reparse point");
    expect((await aclSnapshot(target)).sddl).toBe(before);
  }, 20_000);
});
