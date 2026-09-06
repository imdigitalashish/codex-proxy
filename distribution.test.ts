import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, type Platform } from "./setup.ts";

test.each(["darwin", "linux"] as Platform[])("actual package installs and launches offline for %s", async (platform) => {
  const root = await mkdtemp(join(tmpdir(), "codex-proxy-distribution-"));
  try {
    const home = join(root, "fresh home with spaces");
    const result = await install({ home, sourceDir: import.meta.dir, platform, env: {} });
    const manifest = await Bun.file(join(import.meta.dir, "package.json")).json();
    expect(result.copiedFiles).toBe(manifest.files.length);
    for (const file of manifest.files) {
      expect(await readFile(join(result.installDir, file))).toEqual(await readFile(join(import.meta.dir, file)));
    }
    const names = await readdir(result.installDir);
    expect(names).not.toContain("github-token");
    expect(names).not.toContain("auth-status.json");
    expect(names).not.toContain(".git");
    expect((await stat(join(result.installDir, ".env"))).mode & 0o777).toBe(0o600);
    expect(await readdir(home)).toEqual([".codex-proxy"]);
    const snippet = Bun.TOML.parse(await readFile(result.snippet, "utf8"));
    expect(snippet.model_provider).toBe("portable-codex-proxy");

    const fake = join(root, "fake codex");
    await writeFile(fake, "#!/bin/sh\nprintf '%s\\n' 'codex-cli fixture'\n", { mode: 0o700 });
    const child = Bun.spawn([process.execPath, "run", "codex", "--", "--version"], {
      cwd: result.installDir,
      env: {
        HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin",
        CODEX_BIN: process.env.CODEX_TEST_BIN || fake,
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(output).toContain("codex-cli");
    expect(error).not.toContain("error:");

    await mkdir(join(home, ".codex"), { recursive: true });
    const config = join(home, ".codex", "config.toml");
    await writeFile(config, 'model_provider = "existing-provider"\n');
    const before = await readFile(config, "utf8");
    const second = await install({ home, sourceDir: import.meta.dir, platform, env: {} });
    expect(second.copiedFiles).toBe(0);
    expect(second.envCreated).toBe(false);
    expect(await readFile(config, "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
