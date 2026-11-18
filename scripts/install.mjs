import { lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../extensions/jobs.ts", import.meta.url));
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const target = join(agentDir, "extensions", "jobs.ts");

if (process.argv.includes("--uninstall")) {
	rmSync(target, { force: true });
	console.log(`removed ${target}`);
	process.exit(0);
}

mkdirSync(dirname(target), { recursive: true });
if (lstatSync(target, { throwIfNoEntry: false })) rmSync(target, { force: true });
symlinkSync(source, target, "file");
console.log(`linked ${target}\nStart a new session or run /reload to pick it up.`);
