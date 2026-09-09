import { execFile } from "node:child_process";
import { dirname, join, win32 } from "node:path";

export const powershellExecutable = () => join(
  process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);

export function runPowerShell(script: string, input: unknown): Promise<string> {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
${script}`, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = execFile(powershellExecutable(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024,
      // PowerShell 7's inherited module path can break Windows PowerShell 5.1.
      env: { ...process.env, PSModulePath: join(dirname(powershellExecutable()), "Modules") },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Windows operation failed: ${stderr.trim() || error.code}`));
      else resolve(stdout.trim());
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(JSON.stringify(input));
  });
}

// POSIX modes do not restrict access on Windows. Set a protected DACL before
// writing private bytes; an existing parent directory is never widened or changed.
export async function protectWindowsPath(path: string): Promise<void> {
  if (process.platform !== "win32") return;
  await runPowerShell(`
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$item = Get-Item -Force -LiteralPath $data.path
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a reparse point' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
if ($item.PSIsContainer) {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  $acl = [Security.AccessControl.FileSecurity]::new()
  $inheritance = [Security.AccessControl.InheritanceFlags]::None
}
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($identity)
foreach ($sid in @($identity, $system)) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid, [Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance, [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
$item.SetAccessControl($acl)
`, { path });
}

const xml = (value: string) => value.replace(/[<>&"']/g, (c) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
})[c]!);
const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function watchTaskParent(): void {
  const value = process.env.CODEX_PROXY_TASK_PARENT_PID;
  if (process.platform !== "win32" || value === undefined) return;
  const parent = Number(value);
  if (!Number.isSafeInteger(parent) || parent <= 0 || parent === process.pid) {
    throw new Error("Invalid CODEX_PROXY_TASK_PARENT_PID");
  }
  // Task Scheduler can stop its PowerShell action without terminating the native
  // child. Only managed tasks opt into this watchdog; manual starts are unaffected.
  setInterval(() => {
    try { process.kill(parent, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") process.exit(0); }
  }, 250).unref();
}

export function renderWindowsTasks(options: {
  home: string; codexHome: string; installDir: string; bunExecutable: string; path: string;
}): Record<string, string> {
  const { home, codexHome, installDir, bunExecutable, path } = options;
  const environment = { HOME: home, CODEX_HOME: codexHome, PATH: path };
  function task(script: string, log: string, repeat: boolean): string {
    const command = [
      // The server writes progress to stderr. Under 'Stop', PowerShell turns that
      // into a terminating NativeCommandError and kills a healthy proxy.
      "$ErrorActionPreference = 'Continue'",
      ...Object.entries(environment).map(([key, value]) =>
        `[Environment]::SetEnvironmentVariable(${psLiteral(key)}, ${psLiteral(value)}, 'Process')`),
      "$env:CODEX_PROXY_TASK_PARENT_PID = [string]$PID",
      `Set-Location -LiteralPath ${psLiteral(installDir)}`,
      `& ${psLiteral(bunExecutable)} run ${psLiteral(win32.join(installDir, script))} 2>&1 | Out-File -LiteralPath ${psLiteral(win32.join(installDir, "logs", `${log}.log`))} -Append -Encoding utf8`,
      // Report a real crash so Task Scheduler's RestartOnFailure policy applies.
      "if ($LASTEXITCODE -eq $null) { exit 1 }",
      "exit $LASTEXITCODE",
    ].join("\n");
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    return `<?xml version="1.0"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Codex proxy: ${xml(installDir)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger>${repeat ? "<Repetition><Interval>PT2M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>" : ""}<Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="User"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>false</Enabled><Hidden>true</Hidden>
    <ExecutionTimeLimit>${repeat ? "PT1M" : "PT0S"}</ExecutionTimeLimit>
    ${repeat ? "" : "<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>"}
  </Settings>
  <Actions Context="User"><Exec>
    <Command>${xml(powershellExecutable())}</Command>
    <Arguments>-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}</Arguments>
    <WorkingDirectory>${xml(installDir)}</WorkingDirectory>
  </Exec></Actions>
</Task>
`;
  }
  return {
    "CodexProxy.xml": task("server.ts", "proxy", false),
    "CodexProxyPickerGuard.xml": task("picker-guard.ts", "picker-guard", true),
  };
}

export async function installWindowsTasks(definitions: Record<string, string>, validateOnly = false): Promise<string[]> {
  if (process.platform !== "win32") throw new Error("Windows task registration requires Windows");
  const tasks = Object.entries(definitions).map(([file, xml]) => ({ name: file.replace(/\.xml$/, ""), xml }));
  await runPowerShell(`
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\')
$pending = @()
foreach ($task in $data.tasks) {
  $definition = $scheduler.NewTask(0)
  $definition.XmlText = $task.xml
  $definition.Principal.UserId = $identity
  $definition.Triggers.Item(1).UserId = $identity
  # TASK_VALIDATE_ONLY validates without registering or starting anything.
  $null = $folder.RegisterTaskDefinition($task.name, $definition, 1, $identity, $null, 3, $null)
  if ($data.validateOnly) { continue }
  $existing = $null
  try { $existing = $folder.GetTask($task.name) } catch {
    if ($_.Exception.HResult -ne -2147024894) { throw }
  }
  if ($existing) {
    $existingUser = $existing.Definition.Principal.UserId
    if ($existingUser -notmatch '^S-1-') {
      $existingUser = [Security.Principal.NTAccount]::new($existingUser).Translate([Security.Principal.SecurityIdentifier]).Value
    }
    if ($existing.Definition.Actions.Item(1).Arguments -ne $definition.Actions.Item(1).Arguments -or
        $existing.Definition.Actions.Item(1).Path -ne $definition.Actions.Item(1).Path -or
        $existing.Definition.Actions.Item(1).WorkingDirectory -ne $definition.Actions.Item(1).WorkingDirectory -or
        $existingUser -ne $identity) {
      throw "Task $($task.name) already exists with different settings; it was not replaced"
    }
    continue
  }
  $pending += @{ Name = $task.name; Definition = $definition }
}
foreach ($task in $pending) {
  # TASK_CREATE, not UPDATE: a concurrently created task must win.
  $null = $folder.RegisterTaskDefinition($task.Name, $task.Definition, 2, $identity, $null, 3, $null)
}
`, { tasks, validateOnly });
  return tasks.map((task) => task.name);
}
