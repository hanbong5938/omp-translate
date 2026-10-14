import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as z from "@oh-my-pi/omptype/zod";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type {
	AssistantThinkingRenderContext,
	AssistantThinkingRenderer,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionMode,
} from "@oh-my-pi/pi-coding-agent";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { createTranslateExtension } from "../src/index.ts";
import type { TranslationSettings } from "../src/settings.ts";
import type { ModelCall } from "../src/translation.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type NotifyType = "info" | "warning" | "error";
type Notice = { message: string; type: NotifyType };

class FakeExtensionAPI {
	readonly zod = z;
	readonly logger = { warn() {}, error() {}, info() {}, debug() {} };
	readonly handlers = new Map<string, EventHandler[]>();
	readonly commands = new Map<string, CommandOptions>();
	readonly thinkingRenderers: AssistantThinkingRenderer[] = [];

	on(event: string, handler: EventHandler): void {
		this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
	}

	registerCommand(name: string, options: CommandOptions): void {
		this.commands.set(name, options);
	}

	registerAssistantThinkingRenderer(renderer: AssistantThinkingRenderer): void {
		this.thinkingRenderers.push(renderer);
	}

	async emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? []) result = await handler(payload, ctx);
		return result;
	}

	command(): CommandOptions {
		const command = this.commands.get("translate");
		if (!command) throw new Error("/translate is not registered");
		return command;
	}

	render(rc: AssistantThinkingRenderContext): Component | undefined {
		expect(this.thinkingRenderers).toHaveLength(1);
		const [renderer] = this.thinkingRenderers;
		return renderer?.(rc, theme);
	}
}

interface FakeTimer {
	callback: () => void;
	active: boolean;
}

interface FakeContextOptions {
	mode?: ExtensionMode;
	kind?: "main" | "sub";
	select?: () => Promise<string | undefined>;
	input?: () => Promise<string | undefined>;
}

const fakeModel = { provider: "test", id: "tiny" } as unknown as Model<Api>;
const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;

function fakeContext(options: FakeContextOptions = {}) {
	const mode = options.mode ?? "tui";
	const kind = options.kind ?? "main";
	const notifications: Notice[] = [];
	const notificationWaiters: ((notice: Notice) => void)[] = [];
	const selects: { title: string; items: unknown[] }[] = [];
	const inputs: string[] = [];
	const timers: FakeTimer[] = [];
	let sessionId = "session-1";
	const ctx = {
		mode,
		hasUI: mode === "tui",
		agent: { kind, id: kind === "main" ? "Main" : "0-Task", name: kind === "main" ? "main" : "task", depth: 0 },
		ui: {
			select: (title: string, items: unknown[]) => {
				selects.push({ title, items });
				return options.select?.() ?? Promise.resolve(undefined);
			},
			input: (title: string) => {
				inputs.push(title);
				return options.input?.() ?? Promise.resolve(undefined);
			},
			notify: (message: string, type: NotifyType = "info") => {
				const notification = { message, type };
				notifications.push(notification);
				for (const waiter of notificationWaiters.splice(0)) waiter(notification);
			},
		},
		models: { resolve: (spec: string) => (spec === "nope" ? undefined : fakeModel) },
		sessionManager: { getSessionId: () => sessionId },
		setTimeout: (callback: () => void) => {
			const timer: FakeTimer = { callback, active: true };
			timers.push(timer);
			return timer;
		},
		clearTimer: (timer: FakeTimer) => {
			timer.active = false;
		},
	};
	return {
		ctx: ctx as unknown as ExtensionCommandContext,
		notifications,
		selects,
		inputs,
		setSessionId(id: string): void {
			sessionId = id;
		},
		nextNotification(): Promise<Notice> {
			const { promise, resolve } = Promise.withResolvers<Notice>();
			notificationWaiters.push(resolve);
			return promise;
		},
		fireTimers(): void {
			for (const timer of timers.splice(0)) {
				if (!timer.active) continue;
				timer.active = false;
				timer.callback();
			}
		},
	};
}

let tempDir = "";
let settingsPath = "";

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-translate-test-"));
	settingsPath = path.join(tempDir, "omp-translate.json");
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeSettings(patch: Partial<TranslationSettings>): Promise<string> {
	const content = `${JSON.stringify(
		{
			thinking: true,
			request: false,
			targetLanguage: "",
			requestLanguage: "en",
			model: "",
			requestModel: "",
			...patch,
		},
		null,
		2,
	)}\n`;
	await fs.writeFile(settingsPath, content);
	return content;
}

function loadExtension() {
	const pi = new FakeExtensionAPI();
	const calls: ModelCall[] = [];
	const stderr: string[] = [];
	const harness = {
		pi,
		calls,
		stderr,
		respond: (_call: ModelCall): Promise<string> => Promise.resolve("translated"),
	};
	createTranslateExtension({
		settingsPath,
		createCaller: () => call => {
			calls.push(call);
			return harness.respond(call);
		},
		writeStderr: line => {
			stderr.push(line);
		},
	})(pi as unknown as ExtensionAPI);
	return harness;
}

/** Drains the microtask queue without a wall-clock delay: setImmediate runs after pending microtasks. */
function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

function inputEvent(text: string, images?: unknown[]) {
	return { type: "input", text, source: "interactive", ...(images ? { images } : {}) };
}

function thinkingContext(text: string) {
	let renders = 0;
	const renderWaiters: (() => void)[] = [];
	const rc: AssistantThinkingRenderContext = {
		contentIndex: 0,
		thinkingIndex: 0,
		text,
		requestRender: () => {
			renders++;
			for (const waiter of renderWaiters.splice(0)) waiter();
		},
	};
	return {
		rc,
		renders: () => renders,
		nextRender(): Promise<void> {
			const { promise, resolve } = Promise.withResolvers<void>();
			renderWaiters.push(resolve);
			return promise;
		},
	};
}

function textOf(component: Component | undefined): string {
	expect(component).toBeInstanceOf(Text);
	return (component as Text).getText();
}

describe("first-run setup", () => {
	test("canceled setup writes nothing, calls no model, and is not shown again in the same binding", async () => {
		const extension = loadExtension();
		const choice = Promise.withResolvers<string | undefined>();
		const session = fakeContext({ select: () => choice.promise });

		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
		expect(session.selects).toHaveLength(1);
		choice.resolve(undefined);
		await settle();
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
		await settle();

		expect(session.selects).toHaveLength(1);
		expect(await Bun.file(settingsPath).exists()).toBe(false);
		expect(extension.calls).toHaveLength(0);
	});

	test("session_start does not wait for the dialog; choosing 日本語 (ja) saves Japanese", async () => {
		const extension = loadExtension();
		const choice = Promise.withResolvers<string | undefined>();
		const session = fakeContext({ select: () => choice.promise });

		// Resolves while the dialog is still open: session_start must not await it.
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
		expect(session.selects).toHaveLength(1);
		expect(session.selects[0]?.items).toContain("日本語 (ja)");

		const saved = session.nextNotification();
		choice.resolve("日本語 (ja)");
		expect(await saved).toEqual({ message: "Thinking translations will be shown in Japanese (ja).", type: "info" });

		const settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as TranslationSettings;
		expect(settings.targetLanguage).toBe("ja");
		expect(settings.request).toBe(false);
		expect(settings.requestLanguage).toBe("en");
		expect(extension.calls).toHaveLength(0);
	});

	test("print mode writes one stderr instruction and never opens dialogs", async () => {
		const extension = loadExtension();
		const session = fakeContext({ mode: "print" });

		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);

		expect(session.selects).toHaveLength(0);
		expect(session.inputs).toHaveLength(0);
		expect(extension.stderr).toHaveLength(1);
		expect(extension.stderr[0]).toContain("no target language selected");
		expect(extension.stderr[0]).toContain(settingsPath);
	});

	test("subagent sessions never prompt, notify, or write stderr", async () => {
		const extension = loadExtension();
		const session = fakeContext({ kind: "sub" });

		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);

		expect(session.selects).toHaveLength(0);
		expect(session.inputs).toHaveLength(0);
		expect(session.notifications).toHaveLength(0);
		expect(extension.stderr).toHaveLength(0);
	});
});

describe("prompt translation", () => {
	test("translates Japanese and Spanish prose into the request language", async () => {
		await writeSettings({ targetLanguage: "ja", request: true });
		const extension = loadExtension();
		const translations: Record<string, string> = {
			"このバグを直してください": "Please fix this bug",
			"Añade pruebas para el analizador": "Add tests for the parser",
		};
		extension.respond = call => Promise.resolve(translations[call.text] ?? "unexpected");
		const session = fakeContext();
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);

		const japanese = await extension.pi.emit("input", inputEvent("このバグを直してください"), session.ctx);
		const spanish = await extension.pi.emit("input", inputEvent("Añade pruebas para el analizador"), session.ctx);

		expect(japanese).toEqual({ text: "Please fix this bug" });
		expect(spanish).toEqual({ text: "Add tests for the parser" });
		expect(extension.calls.map(call => call.text)).toEqual([
			"このバグを直してください",
			"Añade pruebas para el analizador",
		]);
	});

	test("leaves input untouched when prompt translation is off", async () => {
		await writeSettings({ targetLanguage: "ja", request: false });
		const extension = loadExtension();
		const session = fakeContext();
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);

		expect(await extension.pi.emit("input", inputEvent("このバグを直してください"), session.ctx)).toBeUndefined();
		expect(extension.calls).toHaveLength(0);
	});

	test("skips slash commands and shell escapes", async () => {
		await writeSettings({ targetLanguage: "ja", request: true });
		const extension = loadExtension();
		const session = fakeContext();
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);

		expect(await extension.pi.emit("input", inputEvent("/translate status"), session.ctx)).toBeUndefined();
		expect(await extension.pi.emit("input", inputEvent("!ls"), session.ctx)).toBeUndefined();
		expect(extension.calls).toHaveLength(0);
	});

	test("replaces only the text when images are attached", async () => {
		await writeSettings({ targetLanguage: "ja", request: true });
		const extension = loadExtension();
		extension.respond = () => Promise.resolve("What is in this screenshot?");
		const session = fakeContext();
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);

		const images = [{ type: "image", data: "AAAA", mimeType: "image/png" }];
		const result = await extension.pi.emit("input", inputEvent("このスクリーンショットには何がありますか", images), session.ctx);

		expect(result).toEqual({ text: "What is in this screenshot?" });
		expect(Object.keys(result as object)).toEqual(["text"]);
	});

	test("sends the original and warns when translation fails", async () => {
		await writeSettings({ targetLanguage: "ja", request: true });
		const extension = loadExtension();
		extension.respond = () => Promise.reject(new Error("rate limited"));
		const session = fakeContext();
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);

		expect(await extension.pi.emit("input", inputEvent("このバグを直してください"), session.ctx)).toBeUndefined();
		const warning = session.notifications.find(n => n.type === "warning");
		expect(warning?.message).toStartWith("Prompt translation failed; sending original:");
		expect(warning?.message).toContain("rate limited");
	});

	test("keeps inline code spans exactly", async () => {
		await writeSettings({ targetLanguage: "ja", request: true });
		const extension = loadExtension();
		extension.respond = call =>
			Promise.resolve(call.text.replace("Por favor revisa", "Please review").replace("y corrige el error", "and fix the bug"));
		const session = fakeContext();
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);

		const result = await extension.pi.emit(
			"input",
			inputEvent("Por favor revisa `src/main.ts` y corrige el error"),
			session.ctx,
		);

		expect(result).toEqual({ text: "Please review `src/main.ts` and fix the bug" });
		expect(extension.calls[0]?.text).not.toContain("src/main.ts");
	});

	async function startPromptSession() {
		await writeSettings({ targetLanguage: "ja", request: true });
		const extension = loadExtension();
		const session = fakeContext();
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
		return { extension, session };
	}

	/** Makes the next model call wait on a deferred answer and records the signal it received. */
	function deferNextCall(extension: { respond: (call: ModelCall) => Promise<string> }) {
		const answer = Promise.withResolvers<string>();
		const called = Promise.withResolvers<AbortSignal>();
		extension.respond = call => {
			called.resolve(call.signal);
			return answer.promise;
		};
		return { answer, called: called.promise };
	}

	const isDiscardWarning = (notice: Notice) => notice.type === "warning" && notice.message.includes("discarded");
	const isFallbackWarning = (notice: Notice) => notice.type === "warning" && notice.message.includes("sending original");

	const commandInputs = [
		"/translate status",
		"!echo ok",
		"!!echo ok",
		'$ print("こんにちは")',
		"$$ print(1)",
		"$\tprint(1)",
		"$\nprint(1)",
		"$$\rprint(1)",
		"->next",
		"=> next",
	];
	for (const source of [...commandInputs, ...commandInputs.map(text => `  ${text}`)]) {
		test(`does not translate host input ${JSON.stringify(source)}`, async () => {
			const { extension, session } = await startPromptSession();
			expect(await extension.pi.emit("input", inputEvent(source), session.ctx)).toBeUndefined();
			expect(extension.calls).toHaveLength(0);
		});
	}

	for (const source of ["$HOME is set", "$5 is the price", "$$5", "Explain ! and / in this sentence"]) {
		test(`translates prose that only resembles a command: ${JSON.stringify(source)}`, async () => {
			const { extension, session } = await startPromptSession();
			extension.respond = call => Promise.resolve(`EN:${call.text}`);
			expect(await extension.pi.emit("input", inputEvent(source), session.ctx)).toEqual({ text: `EN:${source}` });
			expect(extension.calls).toHaveLength(1);
		});
	}

	for (const response of ["/exit", "!echo unsafe", "$$ print(1)", "\n  ->next", "=> next"]) {
		test(`keeps the original when the model answers with host input ${JSON.stringify(response)}`, async () => {
			const { extension, session } = await startPromptSession();
			extension.respond = () => Promise.resolve(response);
			expect(await extension.pi.emit("input", inputEvent("このバグを直してください"), session.ctx)).toBeUndefined();
			const warnings = session.notifications.filter(n => n.type === "warning");
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.message).toContain("sending original");
		});
	}

	test("falls back to the original when code markers are lost", async () => {
		const { extension, session } = await startPromptSession();
		extension.respond = () => Promise.resolve("Please review the file");
		const result = await extension.pi.emit("input", inputEvent("Por favor revisa `src/main.ts`"), session.ctx);
		expect(result).toBeUndefined();
		expect(session.notifications.some(isFallbackWarning)).toBe(true);
	});

	const sessionChanges: [string, (pi: FakeExtensionAPI, ctx: ExtensionCommandContext) => Promise<unknown>][] = [
		...(["new", "resume", "fork"] as const).map(
			reason =>
				[
					`session_switch (${reason})`,
					(pi: FakeExtensionAPI, ctx: ExtensionCommandContext) =>
						pi.emit("session_switch", { type: "session_switch", reason, previousSessionFile: undefined }, ctx),
				] as [string, (pi: FakeExtensionAPI, ctx: ExtensionCommandContext) => Promise<unknown>],
		),
		["session_branch", (pi, ctx) => pi.emit("session_branch", { type: "session_branch", previousSessionFile: undefined }, ctx)],
		["session_shutdown", (pi, ctx) => pi.emit("session_shutdown", { type: "session_shutdown" }, ctx)],
	];
	for (const [name, change] of sessionChanges) {
		for (const outcome of ["resolve", "reject"] as const) {
			test(`${name} during translation aborts and consumes the input (late ${outcome})`, async () => {
				const { extension, session } = await startPromptSession();
				const deferred = deferNextCall(extension);
				const pending = extension.pi.emit("input", inputEvent("このバグを直してください"), session.ctx);
				const signal = await deferred.called;

				await change(extension.pi, session.ctx);
				expect(signal.aborted).toBe(true);
				if (outcome === "resolve") deferred.answer.resolve("Please fix this bug");
				else deferred.answer.reject(new Error("late failure"));

				expect(await pending).toEqual({ handled: true });
				expect(session.notifications.some(isFallbackWarning)).toBe(false);
				if (name === "session_shutdown") expect(session.notifications.some(isDiscardWarning)).toBe(false);
				else expect(session.notifications.filter(isDiscardWarning)).toHaveLength(1);
			});
		}
	}

	test("consumes the input when the session id changes before the switch event", async () => {
		const { extension, session } = await startPromptSession();
		const deferred = deferNextCall(extension);
		const pending = extension.pi.emit("input", inputEvent("このバグを直してください"), session.ctx);
		await deferred.called;

		session.setSessionId("session-2");
		deferred.answer.resolve("Please fix this bug");

		expect(await pending).toEqual({ handled: true });
		expect(session.notifications.filter(isDiscardWarning)).toHaveLength(1);
	});

	test("consumes the input when the session switches while settings load is awaited", async () => {
		const { extension, session } = await startPromptSession();
		const pending = extension.pi.emit("input", inputEvent("このバグを直してください"), session.ctx);
		const switched = extension.pi.emit(
			"session_switch",
			{ type: "session_switch", reason: "new", previousSessionFile: undefined },
			session.ctx,
		);

		expect(await pending).toEqual({ handled: true });
		await switched;
		expect(extension.calls).toHaveLength(0);
	});

	test("cancellable before events alone do not cancel pending input", async () => {
		const { extension, session } = await startPromptSession();
		const deferred = deferNextCall(extension);
		const pending = extension.pi.emit("input", inputEvent("このバグを直してください"), session.ctx);
		const signal = await deferred.called;

		await extension.pi.emit("session_before_switch", { type: "session_before_switch", reason: "new" }, session.ctx);
		await extension.pi.emit("session_before_branch", { type: "session_before_branch", entryId: "e1" }, session.ctx);
		expect(signal.aborted).toBe(false);
		deferred.answer.resolve("Please fix this bug");

		expect(await pending).toEqual({ text: "Please fix this bug" });
	});

	test("subagent session events do not cancel main input", async () => {
		const { extension, session } = await startPromptSession();
		const subagent = fakeContext({ kind: "sub" });
		const deferred = deferNextCall(extension);
		const pending = extension.pi.emit("input", inputEvent("このバグを直してください"), session.ctx);
		const signal = await deferred.called;

		for (const [, change] of sessionChanges) await change(extension.pi, subagent.ctx);
		expect(signal.aborted).toBe(false);
		deferred.answer.resolve("Please fix this bug");

		expect(await pending).toEqual({ text: "Please fix this bug" });
	});

	test("translates new input normally after a switch", async () => {
		const { extension, session } = await startPromptSession();
		await extension.pi.emit(
			"session_switch",
			{ type: "session_switch", reason: "new", previousSessionFile: undefined },
			session.ctx,
		);
		session.setSessionId("session-2");
		extension.respond = () => Promise.resolve("Please fix this bug");

		expect(await extension.pi.emit("input", inputEvent("このバグを直してください"), session.ctx)).toEqual({
			text: "Please fix this bug",
		});
	});
});

describe("/translate command", () => {
	test("rejects an unresolved model without saving", async () => {
		const original = await writeSettings({ targetLanguage: "ja" });
		const extension = loadExtension();
		const session = fakeContext();

		await extension.pi.command().handler("model nope", session.ctx);

		expect(session.notifications.at(-1)?.type).toBe("error");
		expect(session.notifications.at(-1)?.message).toContain("nope");
		expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
	});

	test("rejects an invalid language tag without saving", async () => {
		const original = await writeSettings({ targetLanguage: "ja" });
		const extension = loadExtension();
		const session = fakeContext();

		await extension.pi.command().handler("language en_US!!", session.ctx);

		expect(session.notifications.at(-1)).toEqual({ message: 'Invalid language tag: "en_US!!"', type: "error" });
		expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
	});

	test("rejects excess operands without saving", async () => {
		const original = await writeSettings({ targetLanguage: "ja", thinking: false });
		const extension = loadExtension();
		const session = fakeContext();

		await extension.pi.command().handler("thinking on extra", session.ctx);

		expect(session.notifications.at(-1)?.type).toBe("warning");
		expect(session.notifications.at(-1)?.message).toStartWith("Usage: /translate thinking");
		expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
	});

	test("request-model clear stores an empty selector and reports inheritance", async () => {
		await writeSettings({ targetLanguage: "ja", requestModel: "test/other" });
		const extension = loadExtension();
		const session = fakeContext();

		await extension.pi.command().handler("request-model clear", session.ctx);

		const saved = JSON.parse(await fs.readFile(settingsPath, "utf8")) as TranslationSettings;
		expect(saved.requestModel).toBe("");
		const status = session.notifications.at(-1);
		expect(status?.type).toBe("info");
		expect(status?.message).toContain("Request model: @tiny → test/tiny (inherits model)");
	});

	test("completes subcommands and preset language tags", () => {
		const extension = loadExtension();
		const complete = extension.pi.command().getArgumentCompletions;

		expect(complete?.("language j")).toEqual([{ value: "language ja", label: "language ja" }]);
		expect(complete?.("zzz")).toBeNull();
	});
});

describe("thinking renderer", () => {
	test("shows the translation once the debounce fires and the model answers", async () => {
		await writeSettings({ targetLanguage: "ja" });
		const extension = loadExtension();
		const answer = Promise.withResolvers<string>();
		extension.respond = () => answer.promise;
		const session = fakeContext();
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);

		const thinking = thinkingContext("I should check the config first.");
		const component = extension.pi.render(thinking.rc);
		expect(textOf(component)).toBe("Translating…");

		session.fireTimers();
		await settle();
		expect(extension.calls).toHaveLength(1);
		const rendered = thinking.nextRender();
		answer.resolve("まず設定を確認するべきだ。");
		await rendered;
		expect(textOf(component)).toBe("まず設定を確認するべきだ。");
	});

	const clearTriggers: [string, (pi: FakeExtensionAPI, ctx: ExtensionCommandContext) => Promise<unknown>][] = [
		["/translate thinking off", (pi, ctx) => pi.command().handler("thinking off", ctx)],
		["/translate language ko", (pi, ctx) => pi.command().handler("language ko", ctx)],
		["session_shutdown", (pi, ctx) => pi.emit("session_shutdown", { type: "session_shutdown" }, ctx)],
		[
			"session_switch",
			(pi, ctx) => pi.emit("session_switch", { type: "session_switch", reason: "new", previousSessionFile: undefined }, ctx),
		],
		["session_branch", (pi, ctx) => pi.emit("session_branch", { type: "session_branch", previousSessionFile: undefined }, ctx)],
	];
	for (const [name, trigger] of clearTriggers) {
		test(`${name} clears a completed translation component`, async () => {
			await writeSettings({ targetLanguage: "ja" });
			const extension = loadExtension();
			const answer = Promise.withResolvers<string>();
			extension.respond = () => answer.promise;
			const session = fakeContext();
			await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);

			const thinking = thinkingContext("I should check the config first.");
			const component = extension.pi.render(thinking.rc);
			session.fireTimers();
			await settle();
			const rendered = thinking.nextRender();
			answer.resolve("まず設定を確認するべきだ。");
			await rendered;
			expect(textOf(component)).toBe("まず設定を確認するべきだ。");

			const rendersBefore = thinking.renders();
			await trigger(extension.pi, session.ctx);
			expect(textOf(component)).toBe("");
			expect(thinking.renders()).toBeGreaterThan(rendersBefore);

			if (name === "session_switch" || name === "session_branch") {
				const next = thinkingContext("A new thought after the change.");
				const fresh = extension.pi.render(next.rc);
				expect(textOf(fresh)).toBe("Translating…");
				const nextAnswer = Promise.withResolvers<string>();
				extension.respond = () => nextAnswer.promise;
				session.fireTimers();
				await settle();
				const freshRendered = next.nextRender();
				nextAnswer.resolve("変更後の新しい考え。");
				await freshRendered;
				expect(textOf(fresh)).toBe("変更後の新しい考え。");
			}
		});
	}

	test("thinking off clears mounted pending translations and stops rendering", async () => {
		await writeSettings({ targetLanguage: "ja" });
		const extension = loadExtension();
		const session = fakeContext();
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);

		const thinking = thinkingContext("I should check the config first.");
		const component = extension.pi.render(thinking.rc);
		expect(textOf(component)).toBe("Translating…");

		await extension.pi.command().handler("thinking off", session.ctx);

		expect(textOf(component)).toBe("");
		expect(thinking.renders()).toBeGreaterThan(0);
		expect(extension.pi.render(thinkingContext("Another thought.").rc)).toBeUndefined();
		session.fireTimers();
		expect(extension.calls).toHaveLength(0);
	});

	test("renders nothing after session_shutdown", async () => {
		await writeSettings({ targetLanguage: "ja" });
		const extension = loadExtension();
		const session = fakeContext();
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);

		const component = extension.pi.render(thinkingContext("I should check the config first.").rc);
		expect(textOf(component)).toBe("Translating…");

		await extension.pi.emit("session_shutdown", { type: "session_shutdown" }, session.ctx);

		expect(textOf(component)).toBe("");
		expect(extension.pi.render(thinkingContext("I should check the config first.").rc)).toBeUndefined();
		session.fireTimers();
		expect(extension.calls).toHaveLength(0);
	});

	test("distinct blocks with identical indices and prefix texts each show their own translation", async () => {
		await writeSettings({ targetLanguage: "ja" });
		const extension = loadExtension();
		const answers = new Map<string, PromiseWithResolvers<string>>();
		extension.respond = call => {
			const answer = Promise.withResolvers<string>();
			answers.set(call.text, answer);
			return answer.promise;
		};
		const session = fakeContext();
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);

		const short = thinkingContext("Let me think");
		const long = thinkingContext("Let me think about this");
		expect(short.rc.requestRender).not.toBe(long.rc.requestRender);
		const shortView = extension.pi.render(short.rc);
		const longView = extension.pi.render(long.rc);

		session.fireTimers();
		await settle();
		expect([...answers.keys()].sort()).toEqual(["Let me think", "Let me think about this"]);
		const shortRendered = short.nextRender();
		const longRendered = long.nextRender();
		answers.get("Let me think")?.resolve("考えてみよう");
		answers.get("Let me think about this")?.resolve("これについて考えてみよう");
		await Promise.all([shortRendered, longRendered]);

		expect(textOf(shortView)).toBe("考えてみよう");
		expect(textOf(longView)).toBe("これについて考えてみよう");
	});
});
