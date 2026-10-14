import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PipedSubprocess } from "bun";
import * as z from "@oh-my-pi/omptype/zod";
import { tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import {
	type AtomicWriteIO,
	atomicWriteFile,
	canonicalizeLanguageTag,
	DEFAULT_SETTINGS,
	isConfigured,
	requestModelSelector,
	SettingsStore,
	type TranslationSettings,
	thinkingModelSelector,
} from "../src/settings.ts";

let dir: string;
let file: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-translate-settings-"));
	file = path.join(dir, "omp-translate.json");
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };

function deferred(): Deferred {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Writer that signals `started`, waits for `gate`, then performs the real atomic write; a rejected gate fails before writing. */
function gatedWriter(started: Deferred, gate: Deferred): (filePath: string, data: string) => Promise<void> {
	return async (filePath, data) => {
		started.resolve();
		await gate.promise;
		await atomicWriteFile(filePath, data);
	};
}

/** Atomic-write temp files left in `directory` (the persistent `.lock` sidecar on macOS is expected and ignored). */
async function tempLeftovers(directory = dir): Promise<string[]> {
	return (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp"));
}

const fullSettings: TranslationSettings = {
	thinking: false,
	request: true,
	targetLanguage: "ko",
	requestLanguage: "en",
	model: "anthropic/claude-haiku",
	requestModel: "",
};

describe("SettingsStore.load", () => {
	test("missing file yields defaults and creates nothing", async () => {
		const store = new SettingsStore({ path: file, zod: z });
		const result = await store.load();
		expect(result).toEqual({
			status: "missing",
			settings: {
				thinking: true,
				request: false,
				targetLanguage: "",
				requestLanguage: "en",
				model: "",
				requestModel: "",
			},
		});
		expect(store.settings).toEqual({ ...DEFAULT_SETTINGS });
		expect(store.error).toBeUndefined();
		expect(isConfigured(store.settings ?? DEFAULT_SETTINGS)).toBe(false);
		expect(await Bun.file(file).exists()).toBe(false);
	});

	test.each([
		["invalid JSON", "{ thinking: true"],
		["wrong type", JSON.stringify({ thinking: "yes" })],
		["unknown key", JSON.stringify({ thinking: true, verbose: true })],
		["invalid target tag", JSON.stringify({ targetLanguage: "not a tag!!" })],
		["empty request language", JSON.stringify({ requestLanguage: "" })],
		["non-object JSON", JSON.stringify(["ko"])],
	])("%s is invalid, leaves the file untouched, and blocks update()", async (_label, contents) => {
		await fs.writeFile(file, contents);
		const writes: string[] = [];
		const store = new SettingsStore({
			path: file,
			zod: z,
			writeFile: async (_path, data) => {
				writes.push(data);
			},
		});

		const result = await store.load();
		expect(result.status).toBe("invalid");
		if (result.status !== "invalid") throw new Error("unreachable");
		expect(result.error).toContain(file);
		expect(store.error).toBe(result.error);
		expect(store.settings).toBeUndefined();

		const update = store.update({ thinking: false });
		await expect(update).rejects.toThrow(file);
		expect(store.settings).toBeUndefined();
		expect(writes).toEqual([]);
		expect(await fs.readFile(file, "utf8")).toBe(contents);
	});

	test("a directory at the settings path is invalid and is not replaced", async () => {
		await fs.mkdir(file);
		const store = new SettingsStore({ path: file, zod: z });

		const result = await store.load();
		expect(result.status).toBe("invalid");
		if (result.status !== "invalid") throw new Error("unreachable");
		expect(result.error).toContain(file);
		expect(store.settings).toBeUndefined();

		await expect(store.update({ thinking: false })).rejects.toThrow(file);
		expect((await fs.stat(file)).isDirectory()).toBe(true);
	});

	test("canonicalizes stored language tags and fills missing keys from defaults", async () => {
		await fs.writeFile(file, JSON.stringify({ targetLanguage: "JA-jp", request: true }));
		const store = new SettingsStore({ path: file, zod: z });

		const result = await store.load();
		const expected: TranslationSettings = { ...DEFAULT_SETTINGS, targetLanguage: "ja-JP", request: true };
		expect(result).toEqual({ status: "loaded", settings: expected });
		expect(store.settings).toEqual(expected);
		expect(isConfigured(expected)).toBe(true);
	});

	test("recovers after the invalid file is fixed", async () => {
		await fs.writeFile(file, "not json");
		const store = new SettingsStore({ path: file, zod: z });
		expect((await store.load()).status).toBe("invalid");

		await fs.writeFile(file, JSON.stringify(fullSettings));
		expect(await store.load()).toEqual({ status: "loaded", settings: fullSettings });
		expect(store.error).toBeUndefined();
		expect(store.settings).toEqual(fullSettings);
	});
});

describe("SettingsStore.update", () => {
	test("rejects before load()", async () => {
		const store = new SettingsStore({ path: file, zod: z });
		await expect(store.update({ thinking: false })).rejects.toThrow();
		expect(await Bun.file(file).exists()).toBe(false);
	});

	test("writes the full settings file, then reflects it; reloading yields the same settings", async () => {
		const nested = path.join(dir, "agent", "profile", "omp-translate.json");
		const store = new SettingsStore({ path: nested, zod: z });
		await store.load();

		const updated = await store.update({ targetLanguage: "zh-hant", requestLanguage: "EN-us", request: true });
		const expected: TranslationSettings = {
			...DEFAULT_SETTINGS,
			targetLanguage: "zh-Hant",
			requestLanguage: "en-US",
			request: true,
		};
		expect(updated).toEqual(expected);
		expect(store.settings).toEqual(expected);
		expect(await fs.readFile(nested, "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
		expect(await tempLeftovers(path.dirname(nested))).toEqual([]);

		const reloaded = new SettingsStore({ path: nested, zod: z });
		expect(await reloaded.load()).toEqual({ status: "loaded", settings: expected });
	});

	test("an invalid patch is rejected without writing", async () => {
		await fs.writeFile(file, JSON.stringify(fullSettings));
		const writes: string[] = [];
		const store = new SettingsStore({
			path: file,
			zod: z,
			writeFile: async (_path, data) => {
				writes.push(data);
			},
		});
		await store.load();

		await expect(store.update({ targetLanguage: "en,ja" })).rejects.toThrow();
		await expect(store.update({ requestLanguage: "" })).rejects.toThrow();
		expect(writes).toEqual([]);
		expect(store.settings).toEqual(fullSettings);
	});

	test("a failing writer rejects and leaves settings and file unchanged", async () => {
		const contents = JSON.stringify(fullSettings);
		await fs.writeFile(file, contents);
		const store = new SettingsStore({
			path: file,
			zod: z,
			writeFile: async () => {
				throw new Error("disk full");
			},
		});
		await store.load();
		const before = store.settings;

		await expect(store.update({ thinking: true, targetLanguage: "fr" })).rejects.toThrow("disk full");
		expect(store.settings).toEqual(before);
		expect(store.settings).toEqual(fullSettings);
		expect(await fs.readFile(file, "utf8")).toBe(contents);
	});

	test("does not expose new settings until the write resolves", async () => {
		const started = deferred();
		const gate = deferred();
		const store = new SettingsStore({ path: file, zod: z, writeFile: gatedWriter(started, gate) });
		await store.load();

		const pending = store.update({ targetLanguage: "de" });
		await started.promise;
		expect(store.settings?.targetLanguage).toBe("");
		expect(await Bun.file(file).exists()).toBe(false);

		gate.resolve();
		await pending;
		expect(store.settings?.targetLanguage).toBe("de");
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ ...DEFAULT_SETTINGS, targetLanguage: "de" });
	});

	test("serializes concurrent updates and keeps going after a failure", async () => {
		const started = [deferred(), deferred(), deferred()];
		const gates = [deferred(), deferred(), deferred()];
		const writes: string[] = [];
		const store = new SettingsStore({
			path: file,
			zod: z,
			writeFile: (filePath, data) => {
				const index = writes.length;
				writes.push(data);
				const [startedWrite, gate] = [started[index], gates[index]];
				if (startedWrite === undefined || gate === undefined) return Promise.reject(new Error("unexpected write"));
				return gatedWriter(startedWrite, gate)(filePath, data);
			},
		});
		await store.load();

		const first = store.update({ targetLanguage: "ko" });
		const second = store.update({ thinking: false });
		const third = store.update({ request: true });
		const secondSettled = second.then(
			() => "fulfilled",
			() => "rejected",
		);

		await started[0]?.promise;
		expect(writes.length).toBe(1);

		gates[0]?.resolve();
		await first;
		await started[1]?.promise;
		expect(writes.length).toBe(2);
		const secondWrite = JSON.parse(writes[1] ?? "null") as TranslationSettings;
		expect(secondWrite.targetLanguage).toBe("ko");
		expect(secondWrite.thinking).toBe(false);

		gates[1]?.reject(new Error("write failed"));
		expect(await secondSettled).toBe("rejected");
		await started[2]?.promise;
		expect(writes.length).toBe(3);

		gates[2]?.resolve();
		expect(await third).toEqual({ ...DEFAULT_SETTINGS, targetLanguage: "ko", request: true });
		expect(store.settings).toEqual({ ...DEFAULT_SETTINGS, targetLanguage: "ko", request: true });
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
			...DEFAULT_SETTINGS,
			targetLanguage: "ko",
			request: true,
		});
	});
});

describe("atomicWriteFile failure paths", () => {
	const original = `${JSON.stringify(fullSettings)}\n`;
	const next: TranslationSettings = { ...fullSettings, targetLanguage: "fr" };
	const nextBytes = `${JSON.stringify(next, null, 2)}\n`;

	/** Saves through a store whose atomic writer uses `failing`, checks the rollback, then saves again through the real fs. */
	async function expectFailedSaveThenRecovery(failing: AtomicWriteIO, sentinel: Error): Promise<void> {
		await fs.writeFile(file, original);
		let io = failing;
		const store = new SettingsStore({
			path: file,
			zod: z,
			writeFile: (filePath, data) => atomicWriteFile(filePath, data, io),
		});
		await store.load();
		const before = store.settings;

		const failure = await store.update({ targetLanguage: "fr" }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBe(sentinel);
		expect(await fs.readFile(file, "utf8")).toBe(original);
		expect(await tempLeftovers()).toEqual([]);
		expect(store.settings).toBe(before);
		expect(store.settings).toEqual(fullSettings);
		expect(store.error).toBeUndefined();

		io = fs;
		expect(await store.update({ targetLanguage: "fr" })).toEqual(next);
		expect(store.settings).toEqual(next);
		expect(await fs.readFile(file, "utf8")).toBe(nextBytes);
		expect(await tempLeftovers()).toEqual([]);
	}

	test("a rename failure after the real temp write keeps the original file and cache; the next save succeeds", async () => {
		const sentinel = new Error("rename sentinel");
		const renamed: { from: string; contents: string }[] = [];
		await expectFailedSaveThenRecovery(
			{
				...fs,
				rename: async (from) => {
					renamed.push({ from: String(from), contents: await fs.readFile(from, "utf8") });
					throw sentinel;
				},
			},
			sentinel,
		);

		expect(renamed.map((attempt) => attempt.contents)).toEqual([nextBytes]);
		for (const attempt of renamed) {
			expect(path.dirname(attempt.from)).toBe(dir);
			expect(attempt.from.endsWith(".tmp")).toBe(true);
			expect(await Bun.file(attempt.from).exists()).toBe(false);
		}
	});

	test("a partial temp write that throws keeps the original file and cache; the next save succeeds", async () => {
		const sentinel = new Error("partial write sentinel");
		const partial: { path: string; contents: string }[] = [];
		await expectFailedSaveThenRecovery(
			{
				...fs,
				writeFile: async (target, data) => {
					if (typeof data !== "string") throw new Error("expected string data");
					const tempPath = String(target);
					await fs.writeFile(tempPath, data.slice(0, Math.floor(data.length / 2)), "utf8");
					partial.push({ path: tempPath, contents: await fs.readFile(tempPath, "utf8") });
					throw sentinel;
				},
			},
			sentinel,
		);

		expect(partial.map((attempt) => attempt.contents)).toEqual([nextBytes.slice(0, Math.floor(nextBytes.length / 2))]);
		for (const attempt of partial) {
			expect(path.dirname(attempt.path)).toBe(dir);
			expect(attempt.path.endsWith(".tmp")).toBe(true);
			expect(await Bun.file(attempt.path).exists()).toBe(false);
		}
	});
});

describe("SettingsStore.update merges the latest file under the lock", () => {
	test("stores loaded from the same file keep each other's fields on sequential updates", async () => {
		const a = new SettingsStore({ path: file, zod: z });
		const b = new SettingsStore({ path: file, zod: z });
		await Promise.all([a.load(), b.load()]);

		await a.update({ targetLanguage: "ko" });
		const expected: TranslationSettings = { ...DEFAULT_SETTINGS, targetLanguage: "ko", request: true };
		expect(await b.update({ request: true })).toEqual(expected);
		expect(b.settings).toEqual(expected);
		expect(a.settings).toEqual({ ...DEFAULT_SETTINGS, targetLanguage: "ko" });
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(expected);
		expect(await tempLeftovers()).toEqual([]);
	});

	test("concurrent updates of different fields from two stores are both kept", async () => {
		await fs.writeFile(file, JSON.stringify(fullSettings));
		const a = new SettingsStore({ path: file, zod: z });
		const b = new SettingsStore({ path: file, zod: z });
		await Promise.all([a.load(), b.load()]);

		await Promise.all([a.update({ targetLanguage: "ja" }), b.update({ requestModel: "openai/gpt-mini" })]);
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
			...fullSettings,
			targetLanguage: "ja",
			requestModel: "openai/gpt-mini",
		});
		expect(await tempLeftovers()).toEqual([]);
	});

	test("for the same field, the last store to acquire the lock wins", async () => {
		const aStarted = deferred();
		const aGate = deferred();
		const bStarted = deferred();
		const bGate = deferred();
		const a = new SettingsStore({ path: file, zod: z, writeFile: gatedWriter(aStarted, aGate) });
		const b = new SettingsStore({ path: file, zod: z, writeFile: gatedWriter(bStarted, bGate) });
		await Promise.all([a.load(), b.load()]);

		const first = a.update({ targetLanguage: "ko", request: true });
		// The writer runs under the lock, so A holds it until its gate opens.
		await aStarted.promise;
		const second = b.update({ targetLanguage: "ja" });
		aGate.resolve();
		expect(await first).toEqual({ ...DEFAULT_SETTINGS, targetLanguage: "ko", request: true });

		await bStarted.promise;
		bGate.resolve();
		const expected: TranslationSettings = { ...DEFAULT_SETTINGS, targetLanguage: "ja", request: true };
		expect(await second).toEqual(expected);
		expect(b.settings).toEqual(expected);
		expect(a.settings).toEqual({ ...DEFAULT_SETTINGS, targetLanguage: "ko", request: true });
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(expected);
	});

	test("after an invalid patch or a failed write, another store can acquire the lock", async () => {
		const a = new SettingsStore({
			path: file,
			zod: z,
			writeFile: async () => {
				throw new Error("disk full");
			},
		});
		const b = new SettingsStore({ path: file, zod: z });
		await Promise.all([a.load(), b.load()]);

		await expect(a.update({ targetLanguage: "en,ja" })).rejects.toThrow("Invalid translation settings");
		expect(await b.update({ targetLanguage: "ko" })).toEqual({ ...DEFAULT_SETTINGS, targetLanguage: "ko" });

		await expect(a.update({ request: true })).rejects.toThrow("disk full");
		const expected: TranslationSettings = { ...DEFAULT_SETTINGS, targetLanguage: "ko", request: true };
		expect(await b.update({ request: true })).toEqual(expected);
		expect(a.settings).toEqual({ ...DEFAULT_SETTINGS });
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(expected);
	});

	test("a file corrupted after load fails the update, is preserved, and disables the store until reloaded", async () => {
		await fs.writeFile(file, JSON.stringify(fullSettings));
		const writes: string[] = [];
		const store = new SettingsStore({
			path: file,
			zod: z,
			writeFile: async (filePath, data) => {
				writes.push(data);
				await atomicWriteFile(filePath, data);
			},
		});
		await store.load();

		const corrupted = "{ corrupted";
		await fs.writeFile(file, corrupted);
		await expect(store.update({ thinking: true })).rejects.toThrow(`Fix or delete the file at ${file}`);
		expect(writes).toEqual([]);
		expect(await fs.readFile(file, "utf8")).toBe(corrupted);
		expect(store.settings).toBeUndefined();
		expect(store.error).toContain(file);
		expect(store.error).toContain("is not valid JSON");
		await expect(store.update({ thinking: true })).rejects.toThrow(`Fix or delete the file at ${file}`);
		expect(writes).toEqual([]);

		await fs.writeFile(file, JSON.stringify(fullSettings));
		expect(await store.load()).toEqual({ status: "loaded", settings: fullSettings });
		expect(await store.update({ thinking: true })).toEqual({ ...fullSettings, thinking: true });
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ ...fullSettings, thinking: true });
	});

	test("a file deleted after load is recreated from defaults plus the patch", async () => {
		await fs.writeFile(file, JSON.stringify(fullSettings));
		const store = new SettingsStore({ path: file, zod: z });
		await store.load();

		await fs.rm(file);
		const expected: TranslationSettings = { ...DEFAULT_SETTINGS, model: "openai/gpt-mini" };
		expect(await store.update({ model: "openai/gpt-mini" })).toEqual(expected);
		expect(store.settings).toEqual(expected);
		expect(await fs.readFile(file, "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
	});
});

const writerFixture = path.join(import.meta.dir, "fixtures", "settings-writer.ts");

interface WriterProcess {
	proc: PipedSubprocess;
	/** Next stdout line without its newline; throws with the writer's stderr if it exits first. */
	readLine(): Promise<string>;
	send(line: string): void;
}

/** Spawns test/fixtures/settings-writer.ts as a separate Bun process with line-based stdio. */
function spawnWriter(...args: string[]): WriterProcess {
	const proc = Bun.spawn([process.execPath, writerFixture, ...args], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	return {
		proc,
		async readLine(): Promise<string> {
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					return line;
				}
				const chunk = await reader.read();
				if (chunk.done) {
					const code = await proc.exited;
					const stderr = await new Response(proc.stderr).text();
					throw new Error(`settings writer exited (${code}) before a full stdout line: ${stderr}`);
				}
				buffer += decoder.decode(chunk.value, { stream: true });
			}
		},
		send(line: string): void {
			proc.stdin.write(`${line}\n`);
			proc.stdin.flush();
		},
	};
}

/** Kills any still-running writers and waits until every one has been reaped. */
async function reap(writers: WriterProcess[]): Promise<void> {
	for (const writer of writers) {
		if (writer.proc.exitCode === null && writer.proc.signalCode === null) writer.proc.kill("SIGKILL");
	}
	await Promise.all(writers.map((writer) => writer.proc.exited));
}

describe("SettingsStore across processes", () => {
	test("two writer processes with stale snapshots merge their different fields", async () => {
		const initial: TranslationSettings = { ...DEFAULT_SETTINGS, model: "anthropic/claude-haiku" };
		await fs.writeFile(file, `${JSON.stringify(initial, null, 2)}\n`);
		const writers = [
			spawnWriter("update", file, JSON.stringify({ targetLanguage: "ko" })),
			spawnWriter("update", file, JSON.stringify({ request: true })),
		];
		try {
			expect(await Promise.all(writers.map((writer) => writer.readLine()))).toEqual(["READY", "READY"]);
			for (const writer of writers) writer.send("GO");
			const lines = await Promise.all(writers.map((writer) => writer.readLine()));
			expect(await Promise.all(writers.map((writer) => writer.proc.exited))).toEqual([0, 0]);

			const expected: TranslationSettings = { ...initial, targetLanguage: "ko", request: true };
			expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(expected);
			const results = lines.map((line) => JSON.parse(line) as TranslationSettings);
			expect(results[0]?.targetLanguage).toBe("ko");
			expect(results[1]?.request).toBe(true);
			expect(results).toContainEqual(expected);
			expect(await tempLeftovers()).toEqual([]);
		} finally {
			await reap(writers);
		}
	});

	test("a held lock rejects update after the default attempts, keeps file and memory, and a retry succeeds after release", async () => {
		const contents = `${JSON.stringify(fullSettings)}\n`;
		await fs.writeFile(file, contents);
		const store = new SettingsStore({ path: file, zod: z });
		await store.load();
		const before = store.settings;
		const holder = spawnWriter("hold", file);
		try {
			expect(await holder.readLine()).toBe("HELD");
			await expect(store.update({ thinking: true })).rejects.toThrow(
				`Failed to acquire lock for ${file} after 50 attempts`,
			);
			expect(await fs.readFile(file, "utf8")).toBe(contents);
			expect(store.settings).toBe(before);
			expect(store.error).toBeUndefined();

			holder.send("RELEASE");
			expect(await holder.proc.exited).toBe(0);
			expect(await store.update({ thinking: true })).toEqual({ ...fullSettings, thinking: true });
			expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ ...fullSettings, thinking: true });
		} finally {
			await reap([holder]);
		}
	}, 10_000);

	test("a force-killed lock holder releases the lock when it exits", async () => {
		const store = new SettingsStore({ path: file, zod: z });
		await store.load();
		const holder = spawnWriter("hold", file);
		try {
			expect(await holder.readLine()).toBe("HELD");
			const probe = tryAcquireFileLock(file);
			probe?.release();
			expect(probe).toBeNull();

			holder.proc.kill("SIGKILL");
			await holder.proc.exited;
			expect(holder.proc.signalCode).toBe("SIGKILL");
			expect(await store.update({ targetLanguage: "ko" })).toEqual({ ...DEFAULT_SETTINGS, targetLanguage: "ko" });
			expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ ...DEFAULT_SETTINGS, targetLanguage: "ko" });
		} finally {
			await reap([holder]);
		}
	});
});

describe("canonicalizeLanguageTag", () => {
	test("accepts valid BCP-47 tags and returns the canonical form", () => {
		expect(canonicalizeLanguageTag("pt-BR")).toBe("pt-BR");
		expect(canonicalizeLanguageTag("zh-hant")).toBe("zh-Hant");
		expect(canonicalizeLanguageTag("SR-latn-rs")).toBe("sr-Latn-RS");
		expect(canonicalizeLanguageTag("  JA-jp  ")).toBe("ja-JP");
	});

	test("rejects empty, malformed, and multiple tags", () => {
		for (const input of ["", "  ", "x", "123", "en--US", "en_US", "not a tag!!", "en,ja", "en ja"]) {
			expect(canonicalizeLanguageTag(input)).toBeUndefined();
		}
	});
});

describe("model selectors", () => {
	test("request model inherits the shared model, which falls back to @tiny", () => {
		expect(thinkingModelSelector({ ...DEFAULT_SETTINGS })).toBe("@tiny");
		expect(requestModelSelector({ ...DEFAULT_SETTINGS })).toBe("@tiny");
		expect(requestModelSelector({ ...DEFAULT_SETTINGS, model: "openai/gpt-mini" })).toBe("openai/gpt-mini");
		expect(
			requestModelSelector({ ...DEFAULT_SETTINGS, model: "openai/gpt-mini", requestModel: "anthropic/haiku" }),
		).toBe("anthropic/haiku");
		expect(thinkingModelSelector({ ...DEFAULT_SETTINGS, requestModel: "anthropic/haiku" })).toBe("@tiny");
	});
});
