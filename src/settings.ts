import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export type Zod = ExtensionAPI["zod"];

export interface TranslationSettings {
	thinking: boolean;
	request: boolean;
	/** "" = not yet selected (unconfigured). */
	targetLanguage: string;
	requestLanguage: string;
	/** "" = default selector. */
	model: string;
	/** "" = inherit `model`. */
	requestModel: string;
}

export const SETTINGS_FILE_NAME = "omp-translate.json";
export const DEFAULT_MODEL_SELECTOR = "@tiny";
export const DEFAULT_SETTINGS: Readonly<TranslationSettings> = Object.freeze({
	thinking: true,
	request: false,
	targetLanguage: "",
	requestLanguage: "en",
	model: "",
	requestModel: "",
});

/** Trim, then Intl.getCanonicalLocales; exactly one valid tag → canonical string, else undefined (empty, invalid, throws). */
export function canonicalizeLanguageTag(input: string): string | undefined {
	const trimmed = input.trim();
	if (trimmed === "") return undefined;
	let tags: string[];
	try {
		tags = Intl.getCanonicalLocales(trimmed);
	} catch {
		return undefined;
	}
	return tags.length === 1 ? tags[0] : undefined;
}

export function thinkingModelSelector(s: TranslationSettings): string {
	return s.model || DEFAULT_MODEL_SELECTOR;
}

export function requestModelSelector(s: TranslationSettings): string {
	return s.requestModel || thinkingModelSelector(s);
}

export function isConfigured(s: TranslationSettings): boolean {
	return s.targetLanguage !== "";
}

export type SettingsLoadResult =
	| { status: "missing"; settings: TranslationSettings }
	| { status: "loaded"; settings: TranslationSettings }
	| { status: "invalid"; error: string };

export interface SettingsStoreOptions {
	path: string;
	zod: Zod;
	/** Defaults to an atomic write (mkdir -p parent, write temp file in same dir, rename). */
	writeFile?: (path: string, data: string) => Promise<void>;
}

/** The slice of the injected Zod object schema this module consumes. */
interface SettingsSchema {
	safeParse(
		value: unknown,
	): { success: true; data: Partial<TranslationSettings> } | { success: false; error: { message: string } };
}

type ValidationResult = { ok: true; settings: TranslationSettings } | { ok: false; reason: string };

function validateSettings(schema: SettingsSchema, value: unknown): ValidationResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, reason: "expected a JSON object" };
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) return { ok: false, reason: parsed.error.message };
	const data = parsed.data;

	const rawTarget = data.targetLanguage ?? DEFAULT_SETTINGS.targetLanguage;
	let targetLanguage = "";
	if (rawTarget.trim() !== "") {
		const canonical = canonicalizeLanguageTag(rawTarget);
		if (canonical === undefined) {
			return { ok: false, reason: `targetLanguage ${JSON.stringify(rawTarget)} is not a valid BCP-47 language tag` };
		}
		targetLanguage = canonical;
	}

	const rawRequest = data.requestLanguage ?? DEFAULT_SETTINGS.requestLanguage;
	const requestLanguage = canonicalizeLanguageTag(rawRequest);
	if (requestLanguage === undefined) {
		return {
			ok: false,
			reason: `requestLanguage ${JSON.stringify(rawRequest)} is not a valid BCP-47 language tag`,
		};
	}

	return {
		ok: true,
		settings: {
			thinking: data.thinking ?? DEFAULT_SETTINGS.thinking,
			request: data.request ?? DEFAULT_SETTINGS.request,
			targetLanguage,
			requestLanguage,
			model: data.model ?? DEFAULT_SETTINGS.model,
			requestModel: data.requestModel ?? DEFAULT_SETTINGS.requestModel,
		},
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function atomicWriteFile(filePath: string, data: string): Promise<void> {
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, { recursive: true });
	const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await fs.writeFile(tempPath, data, "utf8");
		await fs.rename(tempPath, filePath);
	} catch (error) {
		await fs.unlink(tempPath).catch(() => undefined);
		throw error;
	}
}

export class SettingsStore {
	readonly path: string;
	readonly #schema: SettingsSchema;
	readonly #writeFile: (path: string, data: string) => Promise<void>;
	#settings: Readonly<TranslationSettings> | undefined;
	#error: string | undefined;
	#queue: Promise<unknown> = Promise.resolve();

	constructor(options: SettingsStoreOptions) {
		this.path = options.path;
		const zod = options.zod;
		this.#schema = zod
			.object({
				thinking: zod.boolean().optional(),
				request: zod.boolean().optional(),
				targetLanguage: zod.string().optional(),
				requestLanguage: zod.string().optional(),
				model: zod.string().optional(),
				requestModel: zod.string().optional(),
			})
			.strict();
		this.#writeFile = options.writeFile ?? atomicWriteFile;
	}

	/** Active settings; undefined before the first load() and while the file is invalid. */
	get settings(): TranslationSettings | undefined {
		return this.#settings;
	}

	/** Message from the last failed load(), else undefined. */
	get error(): string | undefined {
		return this.#error;
	}

	/** Re-reads the file. Never writes. */
	load(): Promise<SettingsLoadResult> {
		return this.#enqueue(() => this.#load());
	}

	/** Merge patch, validate (schema + language tags canonicalized), write JSON (2-space, trailing newline), THEN swap in-memory settings and return the copy. Throws (leaving settings untouched) on invalid patch, write failure, or when the store is unloaded/invalid. Calls are serialized. */
	update(patch: Partial<TranslationSettings>): Promise<TranslationSettings> {
		return this.#enqueue(() => this.#update(patch));
	}

	#enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(task);
		this.#queue = run.catch(() => undefined);
		return run;
	}

	async #load(): Promise<SettingsLoadResult> {
		let raw: string;
		try {
			raw = await fs.readFile(this.path, "utf8");
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
				const settings: TranslationSettings = { ...DEFAULT_SETTINGS };
				this.#settings = Object.freeze({ ...settings });
				this.#error = undefined;
				return { status: "missing", settings };
			}
			return this.#fail(`Could not read translation settings file ${this.path}: ${errorMessage(error)}`);
		}

		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch (error) {
			return this.#fail(`Translation settings file ${this.path} is not valid JSON: ${errorMessage(error)}`);
		}

		const result = validateSettings(this.#schema, json);
		if (!result.ok) return this.#fail(`Invalid translation settings file ${this.path}: ${result.reason}`);

		this.#settings = Object.freeze({ ...result.settings });
		this.#error = undefined;
		return { status: "loaded", settings: result.settings };
	}

	#fail(error: string): SettingsLoadResult {
		this.#settings = undefined;
		this.#error = error;
		return { status: "invalid", error };
	}

	async #update(patch: Partial<TranslationSettings>): Promise<TranslationSettings> {
		const current = this.#settings;
		if (current === undefined) {
			if (this.#error !== undefined) {
				throw new Error(`${this.#error}. Fix or delete the file at ${this.path}, then try again.`);
			}
			throw new Error(`Translation settings are not loaded yet (${this.path}).`);
		}

		const merged: Record<string, unknown> = { ...current };
		for (const [key, value] of Object.entries(patch)) {
			if (value !== undefined) merged[key] = value;
		}
		const result = validateSettings(this.#schema, merged);
		if (!result.ok) throw new Error(`Invalid translation settings: ${result.reason}`);

		const next = result.settings;
		await this.#writeFile(this.path, `${JSON.stringify(next, null, 2)}\n`);
		this.#settings = Object.freeze({ ...next });
		this.#error = undefined;
		return next;
	}
}
