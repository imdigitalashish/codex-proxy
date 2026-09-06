import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { install, parseArgs, parsePort, renderServiceDefinitions, type InstallOptions } from "./setup.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture(homeName = "home") {
  const root = await mkdtemp(join(tmpdir(), "codex-proxy-setup-"));
  temporary.push(root);
  const sourceDir = join(root, "source");
  const home = join(root, homeName);
  await mkdir(sourceDir, { recursive: true });
  const contents: Record<string, string> = {
    ".env.example": "# fresh settings\nUPSTREAM_MODE=copilot\nPORT=4141\n",
    "server.ts": 'throw new Error("server must not run during setup");\n',
    "picker-guard.ts": 'throw new Error("picker must not run during setup");\n',
    "tools/helper.sh": "#!/bin/sh\nexit 0\n",
  };
  const files = ["package.json", ...Object.keys(contents)];
  for (const [relative, text] of Object.entries(contents)) {
    await mkdir(dirname(join(sourceDir, relative)), { recursive: true });
    await writeFile(join(sourceDir, relative), text);
  }
  await chmod(join(sourceDir, "tools/helper.sh"), 0o755);
  await writeFile(join(sourceDir, "package.json"), JSON.stringify({ name: "fixture", files }));
  const options: InstallOptions = { home, sourceDir, platform: "darwin", env: {}, bunExecutable: process.execPath };
  return { root, sourceDir, home, files, contents, options, installDir: join(home, ".codex-proxy") };
}

async function exists(path: string) {
  return lstat(path).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function snapshot(path: string) {
  const result: Record<string, { data: string; mode: number; mtime: number }> = {};
  async function walk(dir: string, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), relative);
      else {
        const info = await stat(join(dir, entry.name));
        result[relative] = {
          data: (await readFile(join(dir, entry.name))).toString("base64"),
          mode: info.mode & 0o777, mtime: info.mtimeMs,
        };
      }
    }
  }
  await walk(path);
  return result;
}

function unquoteUnitWord(word: string) {
  return word.slice(1, -1).replace(/\\([\\"])/g, "$1").replaceAll("%%", "%");
}

describe("portable setup", () => {
  test("copies exactly the manifest, creates private state, and leaves services inactive by default", async () => {
    const f = await fixture();
    await writeFile(join(f.sourceDir, "github-token"), "must-not-be-copied");
    await writeFile(join(f.sourceDir, ".env"), "PORT=7777\nSECRET=must-not-be-copied");
    await writeFile(join(f.sourceDir, "private.log"), "private-session-data");
    await writeFile(join(f.sourceDir, "unlisted.ts"), "not-in-distribution");
    const result = await install(f.options);
    expect(result.copiedFiles).toBe(f.files.length);
    expect(result.envCreated).toBe(true);
    expect(result.port).toBe(4141);
    for (const relative of f.files) {
      expect(await readFile(join(f.installDir, relative))).toEqual(await readFile(join(f.sourceDir, relative)));
    }
    expect(await readFile(join(f.installDir, ".env"), "utf8")).toBe(f.contents[".env.example"]);
    expect(await exists(join(f.installDir, "github-token"))).toBe(false);
    expect(await exists(join(f.installDir, "private.log"))).toBe(false);
    expect(await exists(join(f.installDir, "unlisted.ts"))).toBe(false);
    expect(await exists(join(f.home, ".codex"))).toBe(false);
    expect(await exists(join(f.home, "Library"))).toBe(false);
    expect(result.installedServiceFiles).toEqual([]);
    for (const relative of ["", "logs", "services", "tools"]) {
      expect((await stat(join(f.installDir, relative))).mode & 0o777).toBe(0o700);
    }
    expect((await stat(join(f.installDir, ".env"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.installDir, "tools/helper.sh"))).mode & 0o777).toBe(0o700);
    const config = Bun.TOML.parse(await readFile(result.snippet, "utf8")) as any;
    expect(config.model_provider).toBe("portable-codex-proxy");
    expect(config.model_catalog_json).toBe(join(f.home, ".codex/models_cache.json"));
    expect(config.model).toBe("claude-opus-5");
    expect(config.model_reasoning_effort).toBe("max");
    expect(Object.keys(config.model_providers)).toEqual(["portable-codex-proxy"]);
    expect(config.model_providers["portable-codex-proxy"]).toEqual({
      name: "Local Codex Proxy", base_url: "http://127.0.0.1:4141/v1",
      wire_api: "responses", requires_openai_auth: false, stream_idle_timeout_ms: 300000,
      request_max_retries: 4, stream_max_retries: 10,
    });
  });

  test("preserves existing .env, credentials, logs, Codex config, and unrelated files across upgrades", async () => {
    const f = await fixture();
    await mkdir(join(f.installDir, "logs"), { recursive: true });
    await mkdir(join(f.home, ".codex"), { recursive: true });
    const privateFiles = {
      [join(f.installDir, ".env")]: "UPSTREAM_MODE=relay\nPORT='5252' # preserve this\nSECRET=private\n",
      [join(f.installDir, "github-token")]: "existing-token\n",
      [join(f.installDir, "proxy.log")]: "legacy-log\n",
      [join(f.installDir, "logs/current.log")]: "current-log\n",
      [join(f.installDir, "config.toml")]: "custom-install-config\n",
      [join(f.home, ".codex/config.toml")]: 'model_provider = "other"\n# user decisions\n',
    };
    for (const [path, text] of Object.entries(privateFiles)) await writeFile(path, text, { mode: 0o600 });
    const before = await snapshot(f.home);
    await writeFile(join(f.installDir, "server.ts"), "old server\n");
    const result = await install({ ...f.options, env: { PORT: "7777", CODEX_HOME: "/unrelated-host-state" } });
    expect(result.port).toBe(5252);
    expect(result.envCreated).toBe(false);
    expect(result.codexHome).toBe(join(f.home, ".codex"));
    const after = await snapshot(f.home);
    for (const relative of Object.keys(before)) expect(after[relative]).toEqual(before[relative]);
    expect(await readFile(join(f.installDir, "server.ts"), "utf8")).toBe(f.contents["server.ts"]);
    expect(await readFile(result.snippet, "utf8")).toContain("http://127.0.0.1:5252/v1");
  });

  test("rerunning setup is content- and mtime-idempotent", async () => {
    const f = await fixture();
    await install({ ...f.options, services: true });
    const before = await snapshot(f.home);
    const result = await install({ ...f.options, services: true });
    expect(result.copiedFiles).toBe(0);
    expect(result.envCreated).toBe(false);
    expect(await snapshot(f.home)).toEqual(before);
  });

  test("running from the installation itself never rewrites the runtime files", async () => {
    const f = await fixture();
    await install(f.options);
    await writeFile(join(f.installDir, "server.ts"), "local runtime adjustment\n");
    const before = await snapshot(f.home);
    const result = await install({ ...f.options, sourceDir: f.installDir });
    expect(result.copiedFiles).toBe(0);
    expect(await snapshot(f.home)).toEqual(before);
  });

  test("an explicit new-install port is persisted in the new .env and provider snippet", async () => {
    const f = await fixture();
    const result = await install({ ...f.options, env: { PORT: "6001" } });
    expect(result.port).toBe(6001);
    expect(await readFile(join(f.installDir, ".env"), "utf8")).toContain("\nPORT=6001\n");
    expect(await readFile(result.snippet, "utf8")).toContain("http://127.0.0.1:6001/v1");
    expect((await stat(join(f.installDir, ".env"))).mode & 0o777).toBe(0o600);
  });

  test("an existing .env without PORT stays untouched and uses the server default", async () => {
    const f = await fixture();
    await mkdir(f.installDir, { recursive: true });
    await writeFile(join(f.installDir, ".env"), "UPSTREAM_MODE=copilot\n");
    const result = await install({ ...f.options, env: { PORT: "6001" } });
    expect(result.port).toBe(4141);
    expect(await readFile(join(f.installDir, ".env"), "utf8")).toBe("UPSTREAM_MODE=copilot\n");
  });

  test.each(["0", "65536", "-1", "1.5", "abc", "", "Infinity", "4e3"])("rejects invalid PORT %j before writing", async (port) => {
    const f = await fixture();
    await expect(install({ ...f.options, env: { PORT: port } })).rejects.toThrow("PORT must be");
    expect(await exists(f.home)).toBe(false);
  });

  test("rejects invalid existing PORT without changing the installation", async () => {
    const f = await fixture();
    await mkdir(f.installDir, { recursive: true });
    await writeFile(join(f.installDir, ".env"), "PORT=${UNRESOLVED}\n");
    const before = await snapshot(f.home);
    await expect(install(f.options)).rejects.toThrow("PORT must be");
    expect(await snapshot(f.home)).toEqual(before);
  });

  test("missing manifest files fail before any destination writes", async () => {
    const f = await fixture();
    await writeFile(join(f.sourceDir, "package.json"), JSON.stringify({ files: [...f.files, "missing.ts"] }));
    await expect(install(f.options)).rejects.toThrow("Missing distribution file: missing.ts");
    expect(await exists(f.home)).toBe(false);
  });

  test("missing manifest files also leave an existing installation unchanged", async () => {
    const f = await fixture();
    await install(f.options);
    const before = await snapshot(f.home);
    await writeFile(join(f.sourceDir, "server.ts"), "new version not ready to install\n");
    await writeFile(join(f.sourceDir, "package.json"), JSON.stringify({ files: [...f.files, "missing.ts"] }));
    await expect(install(f.options)).rejects.toThrow("Missing distribution file: missing.ts");
    expect(await snapshot(f.home)).toEqual(before);
  });

  test.each([{}, { files: [] }, { files: ["package.json"] }, { files: ["package.json", ".env.example", ".env.example"] }])(
    "requires an explicit complete and duplicate-free manifest %j", async (manifest) => {
      const f = await fixture();
      await writeFile(join(f.sourceDir, "package.json"), JSON.stringify(manifest));
      await expect(install(f.options)).rejects.toThrow();
      expect(await exists(f.home)).toBe(false);
    },
  );

  test.each(["../github-token", "/etc/passwd", "foo/../github-token", ".env", "github-token", "logs/session.log", ".git/config", "services/extra.service"])(
    "rejects unsafe or private manifest entry %s", async (entry) => {
      const f = await fixture();
      await writeFile(join(f.sourceDir, "package.json"), JSON.stringify({ files: [...f.files, entry] }));
      await expect(install(f.options)).rejects.toThrow();
      expect(await exists(f.home)).toBe(false);
    },
  );

  test("refuses source symlinks rather than copying a secret through an allowlisted name", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "private-secret"), "secret");
    await symlink(join(f.root, "private-secret"), join(f.sourceDir, "allowed.ts"));
    await writeFile(join(f.sourceDir, "package.json"), JSON.stringify({ files: [...f.files, "allowed.ts"] }));
    await expect(install(f.options)).rejects.toThrow("Refusing non-regular-file");
    expect(await exists(f.home)).toBe(false);
  });

  test("refuses symlinked destination directories without changing the linked target", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside");
    await mkdir(outside);
    await mkdir(f.installDir, { recursive: true });
    await symlink(outside, join(f.installDir, "tools"));
    await expect(install(f.options)).rejects.toThrow("Refusing non-directory");
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(f.installDir)).toEqual(["tools"]);
  });

  test("refuses symlinked runtime destinations without replacing their contents", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside-file");
    await writeFile(outside, "keep this\n");
    await mkdir(f.installDir, { recursive: true });
    await symlink(outside, join(f.installDir, "server.ts"));
    await expect(install(f.options)).rejects.toThrow("Refusing non-regular-file");
    expect(await readFile(outside, "utf8")).toBe("keep this\n");
    expect((await lstat(join(f.installDir, "server.ts"))).isSymbolicLink()).toBe(true);
  });

  test.each(["PORT=4545 # comment", "export PORT='4545'", ' PORT = "4545" # comment', "PORT=`4545`"])(
    "reads literal existing dotenv PORT syntax: %s", async (assignment) => {
      const f = await fixture();
      await mkdir(f.installDir, { recursive: true });
      await writeFile(join(f.installDir, ".env"), `${assignment}\r\n`);
      expect((await install(f.options)).port).toBe(4545);
      expect(await readFile(join(f.installDir, ".env"), "utf8")).toBe(`${assignment}\r\n`);
    },
  );

  test("macOS service definitions escape XML and execute the absolute Bun without a shell", async () => {
    const f = await fixture('home & <team> "quoted"');
    const bunExecutable = join(f.root, 'bun & <version> "tool"');
    const result = await install({ ...f.options, bunExecutable, services: true });
    expect(result.installedServiceFiles).toHaveLength(2);
    for (const path of result.serviceFiles) {
      const content = await readFile(path, "utf8");
      expect(content).toContain("&amp;");
      expect(content).toContain("&lt;team&gt;");
      expect(content).toContain("&quot;quoted&quot;");
      expect(content).toContain("<key>WorkingDirectory</key>");
      expect(content).toContain("<key>HOME</key>");
      expect(content).toContain("<key>PATH</key>");
      expect(content).toContain("<key>Umask</key><integer>63</integer>");
      expect(content).not.toContain("/bin/sh");
      expect(content).not.toContain("launchctl");
    }
    const picker = await readFile(join(f.installDir, "services/com.codex-proxy.picker-guard.plist"), "utf8");
    expect(picker).toContain("<key>StartInterval</key><integer>120</integer>");
    expect(picker).toContain("picker-guard.ts</string>");
    const config = Bun.TOML.parse(await readFile(result.snippet, "utf8")) as any;
    expect(config.model_catalog_json).toBe(join(f.home, ".codex/models_cache.json"));
    if (process.platform === "darwin") {
      const check = Bun.spawnSync(["/usr/bin/plutil", "-lint", ...result.serviceFiles]);
      expect(check.exitCode).toBe(0);
    }
  });

  test("Linux unit paths preserve spaces, quotes, backslashes, percent signs, and dollars", async () => {
    const f = await fixture('home with %h $USER "quotes" \\backslash');
    const bunExecutable = join(f.root, "bun %i $HOME");
    const result = await install({ ...f.options, platform: "linux", bunExecutable, services: true });
    expect(result.installedServiceFiles).toHaveLength(3);
    for (const path of result.installedServiceFiles) expect(path).toStartWith(join(f.home, ".config/systemd/user/"));
    const proxy = await readFile(join(f.installDir, "services/codex-proxy.service"), "utf8");
    expect(proxy).toContain(`WorkingDirectory=${f.installDir.replaceAll("%", "%%")}\n`);
    const command = proxy.split("\n").find((line) => line.startsWith("ExecStart="))!;
    expect(command).toStartWith('ExecStart=:"');
    expect(command).toContain("%%i $HOME");
    expect(command).toContain("%%h $USER");
    expect(command).toContain('\\"quotes\\"');
    expect(command).toContain("\\\\backslash");
    expect(command).not.toContain("/bin/sh");
    for (const line of proxy.split("\n").filter((line) => line.startsWith("Environment="))) {
      const value = unquoteUnitWord(line.slice("Environment=".length));
      if (value.startsWith("HOME=")) expect(value).toBe(`HOME=${f.home}`);
      if (value.startsWith("CODEX_HOME=")) expect(value).toBe(`CODEX_HOME=${join(f.home, ".codex")}`);
      if (value.startsWith("PATH=")) expect(value).toContain(join(f.home, ".local/bin"));
    }
    const timer = await readFile(join(f.installDir, "services/codex-proxy-picker-guard.timer"), "utf8");
    expect(timer).toContain("OnUnitActiveSec=120s");
    expect(timer).toContain("Unit=codex-proxy-picker-guard.service");
    expect(proxy).toContain("UMask=0077");
    expect(await exists(join(f.home, "Library"))).toBe(false);
  });

  test("an explicitly selected Codex home is used without reading host environment state", async () => {
    const f = await fixture();
    const codexHome = join(f.home, "alternate config");
    const result = await install({ ...f.options, codexHome, env: { CODEX_HOME: "/ignore-me" } });
    const config = Bun.TOML.parse(await readFile(result.snippet, "utf8")) as any;
    expect(config.model_catalog_json).toBe(join(codexHome, "models_cache.json"));
    expect(await exists(codexHome)).toBe(false);
  });

  test("normal installs honor ambient CODEX_HOME in the snippet and both service definitions", async () => {
    const f = await fixture();
    const codexHome = join(f.root, "custom Codex state");
    const result = await install({
      ...f.options, home: undefined, env: { HOME: f.home, CODEX_HOME: codexHome },
    });
    expect(result.codexHome).toBe(codexHome);
    const config = Bun.TOML.parse(await readFile(result.snippet, "utf8")) as any;
    expect(config.model_catalog_json).toBe(join(codexHome, "models_cache.json"));
    for (const path of result.serviceFiles) {
      expect(await readFile(path, "utf8")).toContain(`<key>CODEX_HOME</key><string>${codexHome}</string>`);
    }
    expect(await exists(codexHome)).toBe(false);
  });

  test("explicit --home isolates the snippet and services from ambient CODEX_HOME", async () => {
    const f = await fixture();
    const result = await install({ ...f.options, env: { CODEX_HOME: join(f.root, "host-only state") } });
    expect(result.codexHome).toBe(join(f.home, ".codex"));
    for (const path of result.serviceFiles) {
      expect(await readFile(path, "utf8")).toContain(`<key>CODEX_HOME</key><string>${join(f.home, ".codex")}</string>`);
      expect(await readFile(path, "utf8")).not.toContain("host-only state");
    }
  });

  test("an explicit Codex home overrides ambient CODEX_HOME on normal installs", async () => {
    const f = await fixture();
    const codexHome = join(f.root, "explicit Codex state");
    const result = await install({
      ...f.options, home: undefined, codexHome,
      env: { HOME: f.home, CODEX_HOME: join(f.root, "ignored state") },
    });
    expect(result.codexHome).toBe(codexHome);
    expect(await exists(codexHome)).toBe(false);
  });

  test("existing literal model settings win over ambient defaults and preserve the .env exactly", async () => {
    const f = await fixture();
    await mkdir(f.installDir, { recursive: true });
    const envText = `PORT=4242
export PROXY_MODEL='custom "model" # literal' # not a shell command
PROXY_REASONING_EFFORT="high" # custom effort
`;
    await writeFile(join(f.installDir, ".env"), envText);
    const result = await install({
      ...f.options, env: { PROXY_MODEL: "ignored-model", PROXY_REASONING_EFFORT: "low" },
    });
    const config = Bun.TOML.parse(await readFile(result.snippet, "utf8")) as any;
    expect(config.model).toBe('custom "model" # literal');
    expect(config.model_reasoning_effort).toBe("high");
    expect(await readFile(join(f.installDir, ".env"), "utf8")).toBe(envText);
  });

  test("model settings use ambient defaults when absent from an existing .env", async () => {
    const f = await fixture();
    await mkdir(f.installDir, { recursive: true });
    await writeFile(join(f.installDir, ".env"), "PORT=4242\n");
    const result = await install({
      ...f.options, env: { PROXY_MODEL: "other-model", PROXY_REASONING_EFFORT: "medium" },
    });
    const config = Bun.TOML.parse(await readFile(result.snippet, "utf8")) as any;
    expect(config.model).toBe("other-model");
    expect(config.model_reasoning_effort).toBe("medium");
    expect(await readFile(join(f.installDir, ".env"), "utf8")).toBe("PORT=4242\n");
  });

  test("fresh-install model overrides persist and remain stable without ambient overrides on rerun", async () => {
    const f = await fixture();
    await writeFile(join(f.sourceDir, ".env.example"), `${f.contents[".env.example"]}PROXY_MODEL=claude-opus-5\nPROXY_REASONING_EFFORT=max\n`);
    const result = await install({
      ...f.options, env: { PROXY_MODEL: 'custom "model"', PROXY_REASONING_EFFORT: "high" },
    });
    const config = Bun.TOML.parse(await readFile(result.snippet, "utf8")) as any;
    expect(config.model).toBe('custom "model"');
    expect(config.model_reasoning_effort).toBe("high");
    expect(await readFile(join(f.installDir, ".env"), "utf8")).toContain(`PROXY_MODEL='custom "model"'`);
    const before = await snapshot(f.home);
    await install(f.options);
    expect(await snapshot(f.home)).toEqual(before);
  });

  test("model settings are read as data and never execute command substitutions", async () => {
    const f = await fixture();
    await mkdir(f.installDir, { recursive: true });
    const marker = join(f.root, "must-not-exist");
    const model = `$(touch ${marker})`;
    await writeFile(join(f.installDir, ".env"), `PROXY_MODEL='${model}'\nPROXY_REASONING_EFFORT=max\n`);
    const result = await install(f.options);
    const config = Bun.TOML.parse(await readFile(result.snippet, "utf8")) as any;
    expect(config.model).toBe(model);
    expect(await exists(marker)).toBe(false);
  });

  test("malformed model assignments fail without changing the installation", async () => {
    const f = await fixture();
    await mkdir(f.installDir, { recursive: true });
    await writeFile(join(f.installDir, ".env"), 'PROXY_MODEL="unterminated\n');
    const before = await snapshot(f.home);
    await expect(install(f.options)).rejects.toThrow("PROXY_MODEL in .env must be a single-line literal");
    expect(await snapshot(f.home)).toEqual(before);
  });

  test("CLI setup neither activates services nor executes installed runtime scripts", async () => {
    const f = await fixture();
    await writeFile(join(f.sourceDir, "setup.ts"), await readFile(join(import.meta.dir, "setup.ts")));
    await writeFile(join(f.sourceDir, "package.json"), JSON.stringify({ files: [...f.files, "setup.ts"] }));
    const bin = join(f.root, "bin");
    const marker = join(f.root, "activation-attempt");
    await mkdir(bin);
    for (const command of ["launchctl", "systemctl", "curl", "codex"]) {
      await writeFile(join(bin, command), '#!/bin/sh\nprintf "%s\\n" "$0" >> "$ACTIVATION_MARKER"\nexit 99\n', { mode: 0o755 });
    }
    const child = Bun.spawn([process.execPath, join(f.sourceDir, "setup.ts"), "--home", f.home, "--platform", "linux", "--services"], {
      cwd: f.sourceDir,
      env: { HOME: f.home, PATH: bin, ACTIVATION_MARKER: marker },
      stdout: "pipe", stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("No services were enabled, started, or restarted.");
    expect(await exists(marker)).toBe(false);
    expect(await exists(join(f.home, ".codex/config.toml"))).toBe(false);
    expect(await readdir(join(f.home, ".config/systemd/user"))).toHaveLength(3);
  });
});

describe("setup validation", () => {
  test("parses documented options and rejects mistakes", () => {
    expect(parseArgs(["--home", "/tmp/new home", "--platform=linux", "--services"])).toEqual({
      home: "/tmp/new home", platform: "linux", services: true,
    });
    expect(parseArgs(["--help"])).toEqual({ help: true });
    expect(() => parseArgs(["--home"])).toThrow("requires a value");
    expect(() => parseArgs(["--home", "--services"])).toThrow("requires a value");
    expect(() => parseArgs(["--services=false"])).toThrow("does not take a value");
    expect(() => parseArgs(["--services", "--services"])).toThrow("Duplicate");
    expect(() => parseArgs(["--platform=win32"])).toThrow("Unsupported platform");
    expect(() => parseArgs(["--start"])).toThrow("Unknown option");
    expect(parsePort("65535")).toBe(65535);
    expect(parsePort("1")).toBe(1);
  });

  test("rejects service directive injection", () => {
    expect(() => renderServiceDefinitions({
      platform: "linux", home: "/tmp/home\nExecStart=/bin/false",
      codexHome: "/tmp/home/.codex", installDir: "/tmp/home/.codex-proxy",
      bunExecutable: "/usr/bin/bun", path: "/usr/bin",
    })).toThrow("control characters");
  });
});
