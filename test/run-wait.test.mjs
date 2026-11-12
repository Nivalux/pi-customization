import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const piAi = new URL("../node_modules/@earendil-works/pi-ai/dist/utils/string-enum.js", import.meta.url).pathname;
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: { "@earendil-works/pi-ai": piAi },
});
const module = await jiti.import("../extensions/run-wait.ts");

const tools = new Map();
const events = new Map();
module.default({
	registerTool: (def) => tools.set(def.name, def),
	on: (event, handler) => events.set(event, handler),
});

const runWait = tools.get("run_wait");
const waitJob = tools.get("wait_job");
const ctx = { cwd: process.cwd() };
const dir = mkdtempSync(join(tmpdir(), "run-wait-spec-"));

let failures = 0;
function check(name, condition, extra = "") {
	if (condition) console.log(`  ok   ${name}`);
	else {
		failures++;
		console.log(`  FAIL ${name} ${extra}`);
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function pgrep(needle) {
	try {
		return execFileSync("pgrep", ["-f", needle], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

const theme = { fg: (_token, text) => text, bold: (text) => text };

console.log("fast exit returns before the max wait");
{
	const started = Date.now();
	const result = await runWait.execute("t1", { command: "echo hi; sleep 0.3", maxWaitSec: 30 }, undefined, undefined, ctx);
	const elapsed = Date.now() - started;
	check("returned in under 3s", elapsed < 3000, `${elapsed}ms`);
	check("status exited", result.details.status === "exited");
	check("exit code 0", result.details.exitCode === 0);
	check("tail captured", result.details.tail.includes("hi"));
	check("not an error", result.isError === false);
}

console.log("nonzero exit is a result, not a tool error");
{
	const result = await runWait.execute("t2", { command: "exit 3" }, undefined, undefined, ctx);
	check("exit code 3", result.details.exitCode === 3, String(result.details.exitCode));
	check("isError false", result.isError === false);
}

console.log("output path is honoured");
{
	const logPath = join(dir, "nested", "build.log");
	await runWait.execute("t3", { command: "echo to-stdout; echo to-stderr >&2", output: logPath }, undefined, undefined, ctx);
	const written = readFileSync(logPath, "utf8");
	check("stdout captured", written.includes("to-stdout"));
	check("stderr captured", written.includes("to-stderr"));
}

console.log("max wait returns with a resumable job");
{
	const logPath = join(dir, "slow.log");
	const started = Date.now();
	const result = await runWait.execute(
		"t4",
		{ command: "sleep 30", maxWaitSec: 2, output: logPath },
		undefined,
		undefined,
		ctx,
	);
	const elapsed = Date.now() - started;
	check("returned after ~2s", elapsed >= 1900 && elapsed < 3500, `${elapsed}ms`);
	check("status running", result.details.status === "running");
	check("outcome timeout", result.details.outcome === "timeout");
	check("pid alive after detach", alive(result.details.pid));
	check("result tells how to resume", result.content[0].text.includes("wait_job"));

	const resumed = await waitJob.execute("t5", { job: result.details.job, maxWaitSec: 1 }, undefined, undefined, ctx);
	check("resume reports same job", resumed.details.job === result.details.job);
	check("resume still running", resumed.details.status === "running");

	const killed = await waitJob.execute(
		"t6",
		{ job: result.details.job, maxWaitSec: 1, onTimeout: "kill" },
		undefined,
		undefined,
		ctx,
	);
	check("kill reported", killed.details.status === "exited" || killed.details.outcome === "timeout");
	await sleep(300);
	check("process gone after kill", !alive(result.details.pid));
}

console.log("wait_job waits out a short job");
{
	const first = await runWait.execute("t7", { command: "sleep 2; echo done", maxWaitSec: 1 }, undefined, undefined, ctx);
	check("first call detached", first.details.status === "running");
	const started = Date.now();
	const second = await waitJob.execute("t8", { job: first.details.job, maxWaitSec: 20 }, undefined, undefined, ctx);
	check("second call saw exit", second.details.status === "exited");
	check("second call returned early", Date.now() - started < 1900, `${Date.now() - started}ms`);
	check("output visible on resume", second.details.tail.includes("done"));
}

console.log("readyPattern returns while the process keeps running");
{
	const logPath = join(dir, "server.log");
	const result = await runWait.execute(
		"t9",
		{ command: "echo 'listening on :3000'; sleep 30", maxWaitSec: 30, readyPattern: "listening on", output: logPath },
		undefined,
		undefined,
		ctx,
	);
	check("outcome ready", result.details.outcome === "ready", result.details.outcome);
	check("still running", result.details.status === "running");
	check("pid alive", alive(result.details.pid));
	await waitJob.execute("t10", { job: result.details.job, maxWaitSec: 0, onTimeout: "kill" }, undefined, undefined, ctx);
	await sleep(300);
	check("cleaned up", !alive(result.details.pid));
}

console.log("abort kills the whole process tree");
{
	await runWait.execute(
		"t11",
		{ command: "sleep 41 & echo child; wait", maxWaitSec: 30, onTimeout: "kill" },
		undefined,
		undefined,
		ctx,
	);
	const controller = new AbortController();
	const pending = runWait.execute(
		"t12",
		{ command: "sleep 42 & echo child; wait", maxWaitSec: 30 },
		controller.signal,
		undefined,
		ctx,
	);
	await sleep(400);
	controller.abort();
	const aborted = await pending;
	check("outcome aborted", aborted.details.outcome === "aborted", aborted.details.outcome);
	await sleep(300);
	check("tree killed", !alive(aborted.details.pid));
	check("no orphan sleep 42", pgrep("sleep 42") === "", pgrep("sleep 42"));
}

console.log("abort leaves a kill-less job running");
{
	const controller = new AbortController();
	const pending = runWait.execute("t13", { command: "sleep 43", maxWaitSec: 30 }, controller.signal, undefined, ctx);
	await sleep(300);
	controller.abort();
	const aborted = await pending;
	check("aborted reported", aborted.details.outcome === "aborted");
	await sleep(200);
	check("process terminated on abort", !alive(aborted.details.pid));
}

console.log("listing and unknown ids");
{
	const list = await waitJob.execute("t14", { maxWaitSec: 1 }, undefined, undefined, ctx);
	check("listing reported", list.details.listing === true);
	check("listing is not empty", list.details.tail.includes("sleep"));
	let message = "";
	try {
		await waitJob.execute("t15", { job: "zzzzzz" }, undefined, undefined, ctx);
	} catch (error) {
		message = error.message;
	}
	check("unknown job throws", message.includes("Unknown job"), message);
}

console.log("renderers produce components");
{
	const result = await runWait.execute("t16", { command: "echo rendered", maxWaitSec: 5 }, undefined, undefined, ctx);
	const call = runWait.renderCall({ command: "echo rendered", maxWaitSec: 5 }, theme, {});
	const done = runWait.renderResult(result, { isPartial: false }, theme, {});
	const partial = runWait.renderResult(result, { isPartial: true }, theme, {});
	const listCall = waitJob.renderCall({ job: "abc123" }, theme, {});
	check("renderCall renders", call.render(60).length > 0);
	check("renderResult renders", done.render(60).join("").includes("exit 0"));
	check("partial renders", partial.render(60).join("").includes("running"));
	check("wait_job call renders", listCall.render(60).join("").includes("abc123"));
}

await events.get("session_shutdown")?.({}, ctx);
await sleep(200);
for (const needle of ["sleep 30", "sleep 41", "sleep 42", "sleep 43"]) {
	check(`shutdown cleaned ${needle}`, pgrep(needle) === "", pgrep(needle));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
