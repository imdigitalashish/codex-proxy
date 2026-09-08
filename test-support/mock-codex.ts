import { readFileSync } from "node:fs";

const executable = process.platform === "win32" ? process.execPath : process.argv[1];
const options = JSON.parse(readFileSync(`${executable}.fixture.json`, "utf8"));
if (options.hang) while (true) await Bun.sleep(1000);
if (options.echoArgs) {
  console.log(JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME, codexHome: process.env.CODEX_HOME }));
} else if (options.version) {
  console.log(`codex-cli ${options.version}`);
}
process.exit(Number(process.env.FAKE_EXIT ?? options.exitCode ?? 0));
