import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

const TICK_MS = 400;
const UPDATE_MS = 1000;
const KILL_GRACE_MS = 5000;
const TAIL_WINDOW_BYTES = 64 * 1024;
const DEFAULT_MAX_WAIT_SEC = 60;
const DEFAULT_TAIL_LINES = 40;
const MAX_WAIT_SEC_CAP = 3600;
const TAIL_LINES_CAP = 500;

type Outcome = "exited" | "timeout" | "ready" | "aborted";
type Status = "exited" | "running" | "aborted";

interface WaitDetails {
	job: string;
	pid: number;
	status: Status;
	outcome: Outcome;
	command: string;
	logPath: string;
	elapsedSec: number;
	waitedSec: number;
	maxWaitSec: number;
	exitCode: number | null;
	signal: string | null;
	outputBytes: number;
	tail: string;
	spawnError: string | null;
	listing: boolean;
}

interface Job {
	id: string;
	command: string;
	logPath: string;
	startedAt: number;
	child: ChildProcess;
	pid: number;
	finishedAt: number | null;
	exitCode: number | null;
	exitSignal: NodeJS.Signals | null;
	spawnError: string | null;
	terminated: boolean;
	done: Promise<void>;
	settle: () => void;
}

const jobs = new Map<string, Job>();

function shellFor(): { file: string; args: (command: string) => string[] } {
	if (process.platform === "win32") {
		return { file: process.env.COMSPEC ?? "cmd.exe", args: (command) => ["/d", "/s", "/c", command] };
	}
	const shell = process.env.SHELL ?? "";
	return { file: shell.endsWith("sh") ? shell : "/bin/bash", args: (command) => ["-c", command] };
}

function defaultLogPath(command: string): string {
	const scope = process.env.PI_SESSION_ID ?? "default";
	const slug =
		command
			.trim()
			.split(/\s+/)[0]
			?.replace(/[^A-Za-z0-9._-]/g, "")
			.slice(0, 24) || "job";
	return join(tmpdir(), "pi-run-wait", scope, `${slug}-${randomBytes(3).toString("hex")}.log`);
}

function spawnJob(input: {
	command: string;
	cwd: string;
	logPath: string;
	append: boolean;
	env?: Record<string, string>;
}): Job {
	mkdirSync(dirname(input.logPath), { recursive: true });
	const fd = openSync(input.logPath, input.append ? "a" : "w");
	const shell = shellFor();
	let child: ChildProcess;
	try {
		child = spawn(shell.file, shell.args(input.command), {
			cwd: input.cwd,
			env: input.env ? { ...process.env, ...input.env } : process.env,
			stdio: ["ignore", fd, fd],
			detached: process.platform !== "win32",
		});
	} finally {
		closeSync(fd);
	}

	const job: Job = {
		id: randomBytes(3).toString("hex"),
		command: input.command,
		logPath: input.logPath,
		startedAt: Date.now(),
		child,
		pid: child.pid ?? -1,
		finishedAt: null,
		exitCode: null,
		exitSignal: null,
		spawnError: null,
		terminated: false,
		done: Promise.resolve(),
		settle: () => {},
	};
	job.done = new Promise<void>((resolveDone) => {
		job.settle = resolveDone;
	});

	child.once("exit", (code, signal) => {
		job.exitCode = code;
		job.exitSignal = signal;
	});
	child.once("close", (code, signal) => {
		if (code !== null || job.exitCode === null) job.exitCode = code;
		if (signal !== null || job.exitSignal === null) job.exitSignal = signal;
		job.finishedAt = Date.now();
		job.settle();
	});
	child.once("error", (error) => {
		job.spawnError = error.message;
		if (job.finishedAt === null) {
			job.finishedAt = Date.now();
			job.settle();
		}
	});

	return job;
}

function signalTree(job: Job, signal: NodeJS.Signals): void {
	if (process.platform === "win32") {
		job.child.kill(signal);
		return;
	}
	try {
		process.kill(-job.pid, signal);
	} catch {
		try {
			job.child.kill(signal);
		} catch {}
	}
}

function killJob(job: Job): void {
	job.terminated = true;
	signalTree(job, "SIGTERM");
	const timer = setTimeout(() => {
		if (job.finishedAt === null) signalTree(job, "SIGKILL");
	}, KILL_GRACE_MS);
	timer.unref();
}

function readTail(logPath: string, lines: number): { text: string; bytes: number } {
	let size = 0;
	try {
		size = statSync(logPath).size;
	} catch {
		return { text: "", bytes: 0 };
	}
	if (size === 0 || lines <= 0) return { text: "", bytes: size };

	const length = Math.min(size, TAIL_WINDOW_BYTES);
	const buffer = Buffer.allocUnsafe(length);
	const fd = openSync(logPath, "r");
	try {
		readSync(fd, buffer, 0, length, size - length);
	} finally {
		closeSync(fd);
	}

	let text = buffer.toString("utf8");
	if (size > length) {
		const newline = text.indexOf("\n");
		if (newline !== -1) text = text.slice(newline + 1);
	}
	const rows = text.split("\n");
	if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();
	return { text: rows.slice(-lines).join("\n"), bytes: size };
}

function waitForJob(
	job: Job,
	options: { maxWaitMs: number; readyPattern?: RegExp; signal?: AbortSignal; onTick?: () => void },
): Promise<Outcome> {
	if (job.finishedAt !== null || options.maxWaitMs === 0) {
		return Promise.resolve(job.finishedAt !== null ? "exited" : "timeout");
	}

	return new Promise<Outcome>((resolveOutcome) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		let interval: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;

		const finish = (outcome: Outcome) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (interval) clearInterval(interval);
			if (onAbort) options.signal?.removeEventListener("abort", onAbort);
			resolveOutcome(outcome);
		};

		void job.done.then(() => finish("exited"));

		timer = setTimeout(() => finish("timeout"), options.maxWaitMs);
		timer.unref();

		if (options.signal) {
			if (options.signal.aborted) {
				finish("aborted");
				return;
			}
			onAbort = () => finish("aborted");
			options.signal.addEventListener("abort", onAbort, { once: true });
		}

		interval = setInterval(() => {
			options.onTick?.();
			if (options.readyPattern?.test(readTail(job.logPath, 200).text)) finish("ready");
		}, TICK_MS);
		interval.unref();
	});
}

function clampNumber(value: number | undefined, fallback: number, cap: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.round(value), 0), cap);
}

function compilePattern(pattern: string | undefined): RegExp | undefined {
	if (!pattern) return undefined;
	try {
		return new RegExp(pattern);
	} catch (error) {
		throw new Error(`Invalid regular expression ${JSON.stringify(pattern)}: ${(error as Error).message}`);
	}
}

function formatSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function stripAt(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

const BLANK_DETAILS: WaitDetails = {
	job: "",
	pid: -1,
	status: "running",
	outcome: "timeout",
	command: "",
	logPath: "",
	elapsedSec: 0,
	waitedSec: 0,
	maxWaitSec: 0,
	exitCode: null,
	signal: null,
	outputBytes: 0,
	tail: "",
	spawnError: null,
	listing: false,
};

function buildDetails(job: Job, outcome: Outcome, waitedMs: number, maxWaitSec: number, tailLines: number): WaitDetails {
	const tail = readTail(job.logPath, tailLines);
	return {
		job: job.id,
		pid: job.pid,
		status: job.finishedAt !== null ? "exited" : outcome === "aborted" ? "aborted" : "running",
		outcome,
		command: job.command,
		logPath: job.logPath,
		elapsedSec: (job.finishedAt ?? Date.now()) / 1000 - job.startedAt / 1000,
		waitedSec: waitedMs / 1000,
		maxWaitSec,
		exitCode: job.exitCode,
		signal: job.exitSignal,
		outputBytes: tail.bytes,
		tail: tail.text,
		spawnError: job.spawnError,
		listing: false,
	};
}

function describe(details: WaitDetails): string {
	const lines: string[] = [];
	if (details.status === "exited") {
		lines.push(`status: exited code=${details.exitCode ?? "null"}${details.signal ? ` signal=${details.signal}` : ""}`);
	} else if (details.outcome === "ready") {
		lines.push("status: ready — output matched, process still running");
	} else if (details.outcome === "aborted") {
		lines.push("status: aborted — process tree killed");
	} else {
		lines.push("status: running — max wait reached");
	}
	lines.push(`elapsed ${formatSeconds(details.elapsedSec * 1000)} · pid ${details.pid} · job ${details.job}`);
	lines.push(`log ${details.logPath} (${details.outputBytes} bytes)`);
	if (details.spawnError) lines.push(`spawn error: ${details.spawnError}`);
	if (details.status !== "exited") {
		lines.push(`wait_job { "job": "${details.job}" } to keep waiting`);
	}
	return lines.join("\n") + (details.tail ? `\n\n${details.tail}` : "");
}

function waitResult(job: Job, outcome: Outcome, waitedMs: number, maxWaitSec: number, tailLines: number) {
	const details = buildDetails(job, outcome, waitedMs, maxWaitSec, tailLines);
	return {
		content: [{ type: "text" as const, text: describe(details) }],
		details,
		isError: details.status === "exited" && job.spawnError !== null,
	};
}

function listingResult(): { content: { type: "text"; text: string }[]; details: WaitDetails } {
	const rows = [...jobs.values()].map((job) => {
		const state =
			job.finishedAt !== null
				? `exit ${job.exitCode ?? job.exitSignal}`
				: `running ${formatSeconds(Date.now() - job.startedAt)}`;
		return `${job.id}  ${state.padEnd(20)} ${truncate(job.command, 48)}  ${job.logPath}`;
	});
	const text = rows.length ? rows.join("\n") : "No jobs started in this session.";
	const details: WaitDetails = { ...BLANK_DETAILS, tail: text, listing: true };
	return { content: [{ type: "text", text }], details };
}

interface WaitParams {
	command?: string;
	job?: string;
	output?: string;
	append?: boolean;
	cwd?: string;
	env?: Record<string, string>;
	maxWaitSec?: number;
	readyPattern?: string;
	tailLines?: number;
	onTimeout?: "detach" | "kill";
}

async function awaitJob(
	job: Job,
	params: WaitParams,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: { content: { type: "text"; text: string }[]; details: WaitDetails }) => void) | undefined,
) {
	const maxWaitSec = clampNumber(params.maxWaitSec, DEFAULT_MAX_WAIT_SEC, MAX_WAIT_SEC_CAP);
	const tailLines = clampNumber(params.tailLines, DEFAULT_TAIL_LINES, TAIL_LINES_CAP);
	const readyPattern = compilePattern(params.readyPattern);
	const onTimeout = params.onTimeout ?? "detach";

	job.child.ref();
	const started = Date.now();
	let lastUpdate = 0;
	const outcome = await waitForJob(job, {
		maxWaitMs: maxWaitSec * 1000,
		readyPattern,
		signal,
		onTick: () => {
			if (!onUpdate || Date.now() - lastUpdate < UPDATE_MS) return;
			lastUpdate = Date.now();
			onUpdate({
				content: [{ type: "text", text: `running ${formatSeconds(Date.now() - started)} · pid ${job.pid}` }],
				details: buildDetails(job, "timeout", Date.now() - started, maxWaitSec, 0),
			});
		},
	});

	if (outcome === "aborted" || (outcome === "timeout" && onTimeout === "kill")) killJob(job);
	if (job.terminated && job.finishedAt === null) await waitForJob(job, { maxWaitMs: KILL_GRACE_MS + 500 });

	let finalOutcome = outcome;
	if (job.finishedAt !== null && finalOutcome !== "aborted") finalOutcome = "exited";
	if (job.finishedAt === null) job.child.unref();

	return waitResult(job, finalOutcome, Date.now() - started, maxWaitSec, tailLines);
}

function renderWaitCall(name: string) {
	return (args: WaitParams | undefined, theme: Theme, context: { lastComponent?: Component }) => {
		const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		const maxWait = clampNumber(args?.maxWaitSec, DEFAULT_MAX_WAIT_SEC, MAX_WAIT_SEC_CAP);
		const subject = name === "wait_job" ? (args?.job ?? "list") : truncate(args?.command ?? "", 60);
		component.setText(
			theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("muted", `≤${maxWait}s `) + theme.fg("dim", subject),
		);
		return component;
	};
}

function renderWaitResult(
	result: { details?: WaitDetails } | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
) {
	const details = result?.details;
	if (!details?.job && !details?.listing) return new Text(theme.fg("muted", "waiting…"), 0, 0);
	if (details.listing) return new Text(theme.fg("muted", details.tail), 0, 0);
	if (options.isPartial) {
		return new Text(theme.fg("warning", `running · pid ${details.pid} · ${formatSeconds(details.waitedSec * 1000)}`), 0, 0);
	}
	if (details.status === "exited") {
		const token = details.exitCode === 0 ? "success" : "error";
		return new Text(
			theme.fg(token, `${details.exitCode === 0 ? "✓" : "✗"} exit ${details.exitCode ?? details.signal} in ${formatSeconds(details.elapsedSec * 1000)}`),
			0,
			0,
		);
	}
	if (details.outcome === "ready") {
		return new Text(
			theme.fg("success", `ready in ${formatSeconds(details.elapsedSec * 1000)} · still running · job ${details.job}`),
			0,
			0,
		);
	}
	if (details.outcome === "aborted") {
		return new Text(theme.fg("warning", `aborted · job ${details.job}`), 0, 0);
	}
	return new Text(
		theme.fg("warning", `still running after ${formatSeconds(details.waitedSec * 1000)} · job ${details.job}`),
		0,
		0,
	);
}

const waitOptions = {
	maxWaitSec: Type.Optional(
		Type.Number({
			description: `Seconds to wait before returning. Returns the moment the command exits, not after the full wait. Default ${DEFAULT_MAX_WAIT_SEC}, max ${MAX_WAIT_SEC_CAP}.`,
		}),
	),
	readyPattern: Type.Optional(
		Type.String({
			description:
				"JavaScript regex tested against the output tail while waiting. On match, return immediately with status ready and leave the process running. Use for servers and daemons.",
		}),
	),
	tailLines: Type.Optional(
		Type.Number({ description: `Lines of output to include in the result. Default ${DEFAULT_TAIL_LINES}.` }),
	),
	onTimeout: StringEnum(["detach", "kill"] as const, {
		description:
			'When the wait ends and the command is still running: "detach" (default) leaves it running so wait_job can resume, "kill" terminates the whole process tree.',
	}),
};

const runWaitSchema = Type.Object({
	command: Type.String({ description: "Shell command to run." }),
	output: Type.Optional(
		Type.String({
			description:
				"Path for combined stdout and stderr. Parent directories are created, relative paths resolve against the session cwd. Default: a temp file, reported in the result.",
		}),
	),
	append: Type.Optional(Type.Boolean({ description: "Append to the output file instead of truncating it." })),
	cwd: Type.Optional(Type.String({ description: "Working directory. Default: session cwd." })),
	env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra environment variables." })),
	...waitOptions,
});

const waitJobSchema = Type.Object({
	job: Type.Optional(Type.String({ description: "Job id returned by run_wait. Omit to list the jobs of this session." })),
	...waitOptions,
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "run_wait",
		label: "Run and wait",
		description:
			"Run a shell command in the background with stdout and stderr redirected to a log file, and return as soon as the command exits or the max wait elapses. Waiting ends on process exit, so a 4 second command costs 4 seconds regardless of the max wait. A command still running at the deadline keeps running and is resumed with wait_job.",
		promptSnippet: "Run a command and return the instant it exits, capped by a max wait; resume waiting by job id",
		promptGuidelines: [
			"Use run_wait instead of sleep polling loops or long bash timeouts, because run_wait returns as soon as the command exits.",
			"When run_wait reports status running, call wait_job with the returned job id instead of sleeping in bash.",
			"Pass output to run_wait when the log matters, then read that file with the read tool if the returned tail is not enough.",
			"Use run_wait with readyPattern to wait for a server or daemon to report readiness; the process stays running and the result carries its job id.",
		],
		parameters: runWaitSchema,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const input = params as Static<typeof runWaitSchema>;
			const job = spawnJob({
				command: input.command,
				cwd: input.cwd ? resolve(ctx.cwd, stripAt(input.cwd)) : ctx.cwd,
				logPath: input.output ? resolve(ctx.cwd, stripAt(input.output)) : defaultLogPath(input.command),
				append: input.append ?? false,
				env: input.env,
			});
			jobs.set(job.id, job);
			return awaitJob(job, input, signal, onUpdate);
		},

		renderCall: renderWaitCall("run_wait"),
		renderResult: renderWaitResult,
	});

	pi.registerTool({
		name: "wait_job",
		label: "Wait for job",
		description:
			"Continue waiting on a background job started by run_wait. Returns when the job exits, when readyPattern matches, or when maxWaitSec elapses. Omit job to list the jobs of this session.",
		promptSnippet: "Resume waiting on a run_wait job until it exits, capped by a max wait",
		promptGuidelines: [
			"Use wait_job with the job id from a run_wait result that reported status running, instead of sleeping or re-running the command.",
		],
		parameters: waitJobSchema,

		async execute(_toolCallId, params, signal, onUpdate) {
			const input = params as Static<typeof waitJobSchema>;
			if (!input.job) return listingResult();
			const job = jobs.get(stripAt(input.job));
			if (!job) {
				const known = [...jobs.keys()].join(", ") || "none";
				throw new Error(`Unknown job ${JSON.stringify(input.job)}. Known jobs: ${known}.`);
			}
			return awaitJob(job, input, signal, onUpdate);
		},

		renderCall: renderWaitCall("wait_job"),
		renderResult: renderWaitResult,
	});

	pi.on("session_shutdown", async () => {
		for (const job of jobs.values()) {
			if (job.finishedAt === null) killJob(job);
		}
	});
}
