import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as z from "@oh-my-pi/omptype/zod";
import {
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

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
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
		expect(await fs.readdir(path.dirname(nested))).toEqual(["omp-translate.json"]);

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
		const store = new SettingsStore({
			path: file,
			zod: z,
			writeFile: () => {
				started.resolve();
				return gate.promise;
			},
		});
		await store.load();

		const pending = store.update({ targetLanguage: "de" });
		await started.promise;
		expect(store.settings?.targetLanguage).toBe("");

		gate.resolve();
		await pending;
		expect(store.settings?.targetLanguage).toBe("de");
	});

	test("serializes concurrent updates and keeps going after a failure", async () => {
		const started = [deferred(), deferred(), deferred()];
		const gates = [deferred(), deferred(), deferred()];
		const writes: string[] = [];
		const store = new SettingsStore({
			path: file,
			zod: z,
			writeFile: (_path, data) => {
				const index = writes.length;
				writes.push(data);
				started[index]?.resolve();
				return gates[index]?.promise ?? Promise.reject(new Error("unexpected write"));
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
