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
	readonly sent: { message: unknown; options: unknown }[] = [];

	on(event: string, handler: EventHandler): void {
		this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
	}

	registerCommand(name: string, options: CommandOptions): void {
		this.commands.set(name, options);
	}

	sendMessage(message: unknown, options?: unknown): void {
		this.sent.push({ message, options });
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
	/** When present, selectors resolve only from this map. */
	models?: Record<string, Model<Api>>;
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
	let idle = true;
	let sessionId = "session-1";
	const ctx = {
		mode,
		hasUI: mode === "tui",
		isIdle: () => idle,
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
		models: {
			resolve: (spec: string) =>
				options.models ? options.models[spec] : spec === "nope" ? undefined : fakeModel,
		},
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
		setIdle(value: boolean): void {
			idle = value;
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
			answer: false,
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

type RecordedCall = ModelCall & { model: Model<Api> };
type Responder = (call: ModelCall, model: Model<Api>) => Promise<string>;

function loadExtension(options: { writeFile?: (path: string, data: string) => Promise<void> } = {}) {
	const pi = new FakeExtensionAPI();
	const calls: RecordedCall[] = [];
	const stderr: string[] = [];
	const harness = {
		pi,
		calls,
		stderr,
		respond: ((_call, _model) => Promise.resolve("translated")) as Responder,
	};
	createTranslateExtension({
		settingsPath,
		createCaller: model => call => {
			calls.push({ ...call, model });
			return harness.respond(call, model);
		},
		writeStderr: line => {
			stderr.push(line);
		},
		writeFile: options.writeFile,
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
	function deferNextCall(extension: { respond: Responder }) {
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

function userMessage(text: string) {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function assistantMessage(content: unknown[], stopReason = "stop") {
	return { role: "assistant", content, stopReason, timestamp: 0 };
}

interface AgentEndPayload {
	type: "agent_end";
	messages: unknown[];
	willContinue?: boolean;
}

function agentEnd(messages: unknown[], willContinue?: boolean): AgentEndPayload {
	return { type: "agent_end", messages, ...(willContinue === undefined ? {} : { willContinue }) };
}

const finalAnswer = (text: string) => [userMessage("run the build"), assistantMessage([{ type: "text", text }])];

function answerPost(content: string, targetLanguage = "ja") {
	return {
		message: { customType: "omp-translate", content, display: true, details: { targetLanguage } },
		options: undefined,
	};
}

async function answerSession(patch: Partial<TranslationSettings> = {}, options: FakeContextOptions = {}) {
	await writeSettings({ targetLanguage: "ja", answer: true, ...patch });
	const extension = loadExtension();
	const session = fakeContext(options);
	await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
	return { extension, session };
}

describe("answer translation", () => {
	test("translates the main agent's final answer into a display-only custom message", async () => {
		const { extension, session } = await answerSession();
		extension.respond = () => Promise.resolve("ビルドは成功しました。");

		await extension.pi.emit("agent_end", agentEnd(finalAnswer("Build passed.")), session.ctx);
		await settle();

		expect(extension.calls).toHaveLength(1);
		expect(extension.calls[0]?.text).toBe("Build passed.");
		expect(extension.calls[0]?.systemPrompt).toContain("final answer");
		expect(extension.pi.sent).toEqual([answerPost("ビルドは成功しました。")]);
	});

	test("agent_end does not wait for the translation", async () => {
		const { extension, session } = await answerSession();
		const reply = Promise.withResolvers<string>();
		extension.respond = () => reply.promise;

		const result = await extension.pi.emit("agent_end", agentEnd(finalAnswer("Build passed.")), session.ctx);
		expect(result).toBeUndefined();
		expect(extension.pi.sent).toHaveLength(0);

		reply.resolve("ビルドは成功しました。");
		await settle();
		expect(extension.pi.sent).toEqual([answerPost("ビルドは成功しました。")]);
	});

	test("joins multiple text blocks of the last assistant message", async () => {
		const { extension, session } = await answerSession();
		const messages = [
			userMessage("go"),
			assistantMessage([{ type: "text", text: "Earlier." }]),
			userMessage("again"),
			assistantMessage([
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "First." },
				{ type: "text", text: "Second." },
			]),
		];

		await extension.pi.emit("agent_end", agentEnd(messages), session.ctx);
		await settle();

		expect(extension.calls.map(call => call.text)).toEqual(["First.\n\nSecond."]);
	});

	const skipped: [string, Partial<TranslationSettings>, FakeContextOptions, () => AgentEndPayload][] = [
		["answer translation is off", { answer: false }, {}, () => agentEnd(finalAnswer("Build passed."))],
		["the agent is a subagent", {}, { kind: "sub" }, () => agentEnd(finalAnswer("Build passed."))],
		["the mode is not tui", {}, { mode: "print" }, () => agentEnd(finalAnswer("Build passed."))],
		["the run will continue", {}, {}, () => agentEnd(finalAnswer("Build passed."), true)],
		[
			"the last assistant stopped for tool use",
			{},
			{},
			() => agentEnd([userMessage("go"), assistantMessage([{ type: "text", text: "Checking." }], "toolUse")]),
		],
		[
			"the last assistant stopped with an error",
			{},
			{},
			() => agentEnd([userMessage("go"), assistantMessage([{ type: "text", text: "Partial." }], "error")]),
		],
		[
			"the last assistant contains a tool call",
			{},
			{},
			() =>
				agentEnd([
					userMessage("go"),
					assistantMessage([
						{ type: "text", text: "Running." },
						{ type: "toolCall", id: "1", name: "bash", arguments: {} },
					]),
				]),
		],
		[
			"the answer text is empty",
			{},
			{},
			() => agentEnd([userMessage("go"), assistantMessage([{ type: "text", text: "   " }])]),
		],
		["there is no assistant message", {}, {}, () => agentEnd([userMessage("go")])],
		["no target language is configured", { targetLanguage: "" }, {}, () => agentEnd(finalAnswer("Build passed."))],
	];
	for (const [name, patch, options, event] of skipped) {
		test(`skips translation when ${name}`, async () => {
			const { extension, session } = await answerSession(patch, options);

			await extension.pi.emit("agent_end", event(), session.ctx);
			await settle();

			expect(extension.calls).toHaveLength(0);
			expect(extension.pi.sent).toHaveLength(0);
		});
	}

	test("warns and skips when the translation model cannot be resolved", async () => {
		const { extension, session } = await answerSession({ model: "nope" });

		await extension.pi.emit("agent_end", agentEnd(finalAnswer("Build passed.")), session.ctx);
		await settle();

		expect(extension.calls).toHaveLength(0);
		expect(extension.pi.sent).toHaveLength(0);
		expect(session.notifications.at(-1)?.type).toBe("warning");
		expect(session.notifications.at(-1)?.message).toContain("nope");
	});

	test("posts nothing when the model returns the answer unchanged", async () => {
		const { extension, session } = await answerSession();
		extension.respond = call => Promise.resolve(`  ${call.text}\n`);

		await extension.pi.emit("agent_end", agentEnd(finalAnswer("Build passed.")), session.ctx);
		await settle();

		expect(extension.calls).toHaveLength(1);
		expect(extension.pi.sent).toHaveLength(0);
	});

	test("holds a translation finished while busy and posts it at the next main agent_end", async () => {
		const { extension, session } = await answerSession();
		const reply = Promise.withResolvers<string>();
		extension.respond = () => reply.promise;

		await extension.pi.emit("agent_end", agentEnd(finalAnswer("Build passed.")), session.ctx);
		session.setIdle(false);
		reply.resolve("ビルドは成功しました。");
		await settle();
		expect(extension.pi.sent).toHaveLength(0);

		// A subagent finishing must not flush the main session's held answer.
		const sub = fakeContext({ kind: "sub" });
		await extension.pi.emit("agent_end", agentEnd([]), sub.ctx);
		expect(extension.pi.sent).toHaveLength(0);

		// Toggling off does not discard an already finished translation; the next main run flushes it.
		await extension.pi.command().handler("answer off", session.ctx);
		session.setIdle(true);
		await extension.pi.emit("agent_end", agentEnd(finalAnswer("Second answer.")), session.ctx);
		await settle();

		expect(extension.pi.sent).toEqual([answerPost("ビルドは成功しました。")]);
		expect(extension.calls).toHaveLength(1);
	});

	test("does not flush held translations while still busy", async () => {
		const { extension, session } = await answerSession();
		extension.respond = () => Promise.resolve("最初の回答。");

		session.setIdle(false);
		await extension.pi.emit("agent_end", agentEnd(finalAnswer("First answer.")), session.ctx);
		await settle();
		await extension.pi.emit("agent_end", agentEnd([], true), session.ctx);
		expect(extension.pi.sent).toHaveLength(0);

		session.setIdle(true);
		extension.respond = () => Promise.resolve("二番目の回答。");
		await extension.pi.emit("agent_end", agentEnd(finalAnswer("Second answer.")), session.ctx);
		await settle();

		// The held answer is posted before the newer one.
		expect(extension.pi.sent).toEqual([answerPost("最初の回答。"), answerPost("二番目の回答。")]);
	});

	test("drops a translation that resolves after toggling answer off", async () => {
		const { extension, session } = await answerSession();
		const reply = Promise.withResolvers<string>();
		extension.respond = () => reply.promise;

		await extension.pi.emit("agent_end", agentEnd(finalAnswer("Build passed.")), session.ctx);
		await extension.pi.command().handler("answer off", session.ctx);
		reply.resolve("ビルドは成功しました。");
		await settle();

		expect(extension.pi.sent).toHaveLength(0);
	});

	test("session_switch discards pending translations", async () => {
		const { extension, session } = await answerSession();
		const reply = Promise.withResolvers<string>();
		extension.respond = () => reply.promise;

		await extension.pi.emit("agent_end", agentEnd(finalAnswer("Build passed.")), session.ctx);
		session.setSessionId("session-2");
		await extension.pi.emit("session_switch", { type: "session_switch" }, session.ctx);
		reply.resolve("ビルドは成功しました。");
		await settle();

		expect(extension.pi.sent).toHaveLength(0);
		expect(session.notifications.filter(notice => notice.message.startsWith("Answer translation failed"))).toEqual(
			[],
		);
	});

	test("session_switch discards held translations", async () => {
		const { extension, session } = await answerSession();
		extension.respond = () => Promise.resolve("ビルドは成功しました。");

		session.setIdle(false);
		await extension.pi.emit("agent_end", agentEnd(finalAnswer("Build passed.")), session.ctx);
		await settle();
		session.setSessionId("session-2");
		await extension.pi.emit("session_switch", { type: "session_switch" }, session.ctx);
		session.setIdle(true);
		await extension.pi.command().handler("answer off", session.ctx);
		await extension.pi.emit("agent_end", agentEnd(finalAnswer("Next.")), session.ctx);
		await settle();

		expect(extension.pi.sent).toHaveLength(0);
	});

	test("warns when the translation model fails", async () => {
		const { extension, session } = await answerSession();
		extension.respond = () => Promise.reject(new Error("quota exceeded"));

		await extension.pi.emit("agent_end", agentEnd(finalAnswer("Build passed.")), session.ctx);
		const notice = await waitForNotice(session, n => n.message.startsWith("Answer translation failed:"));

		expect(notice.type).toBe("warning");
		expect(notice.message).toContain("quota exceeded");
		expect(extension.pi.sent).toHaveLength(0);
	});

	test("retries once after a dropped code marker and posts the restored answer without warning", async () => {
		const { extension, session } = await answerSession();
		let attempt = 0;
		extension.respond = call => {
			attempt++;
			return Promise.resolve(attempt === 1 ? "実行してください。" : call.text.replace("Run ", "実行: "));
		};

		await extension.pi.emit("agent_end", agentEnd(finalAnswer("Run `npm test` now.")), session.ctx);
		await settle();
		await settle();

		expect(extension.calls).toHaveLength(2);
		expect(extension.calls[1]?.text).not.toBe(extension.calls[0]?.text);
		expect(extension.pi.sent).toEqual([answerPost("実行: `npm test` now.")]);
		expect(session.notifications.filter(n => n.message.startsWith("Answer translation failed"))).toEqual([]);
	});

	test("warns once and posts nothing when both attempts drop a code marker", async () => {
		const { extension, session } = await answerSession();
		extension.respond = () => Promise.resolve("実行してください。");

		await extension.pi.emit("agent_end", agentEnd(finalAnswer("Run `npm test` now.")), session.ctx);
		const notice = await waitForNotice(session, n => n.message.startsWith("Answer translation failed:"));
		await settle();

		expect(notice.type).toBe("warning");
		expect(extension.calls).toHaveLength(2);
		expect(extension.pi.sent).toHaveLength(0);
		expect(session.notifications.filter(n => n.message.startsWith("Answer translation failed"))).toHaveLength(1);
	});

	test("session_switch during the retry aborts it and suppresses late output and warnings", async () => {
		const { extension, session } = await answerSession();
		const retry = Promise.withResolvers<string>();
		const retrySignal = Promise.withResolvers<{ signal: AbortSignal; text: string }>();
		let attempt = 0;
		extension.respond = call => {
			attempt++;
			if (attempt === 1) return Promise.resolve("実行してください。");
			retrySignal.resolve({ signal: call.signal, text: call.text });
			return retry.promise;
		};

		await extension.pi.emit("agent_end", agentEnd(finalAnswer("Run `npm test` now.")), session.ctx);
		const second = await retrySignal.promise;
		session.setSessionId("session-2");
		await extension.pi.emit("session_switch", { type: "session_switch" }, session.ctx);
		expect(second.signal.aborted).toBe(true);
		retry.resolve(second.text.replace("Run ", "実行: "));
		await settle();

		expect(extension.calls).toHaveLength(2);
		expect(extension.pi.sent).toHaveLength(0);
		expect(session.notifications.filter(n => n.message.startsWith("Answer translation failed"))).toEqual([]);
	});

	describe("provider context", () => {
		const contextMessages = () => [
			userMessage("go"),
			assistantMessage([{ type: "text", text: "Build passed." }]),
			{ role: "custom", customType: "omp-translate", content: "ビルドは成功しました。", display: true, timestamp: 0 },
			{ role: "custom", customType: "other", content: "keep me", display: true, timestamp: 0 },
		];

		for (const [name, patch, options] of [
			["answer on", { answer: true }, {}],
			["answer off", { answer: false }, {}],
			["no target language", { targetLanguage: "", answer: false }, {}],
			["a subagent", {}, { kind: "sub" }],
		] as [string, Partial<TranslationSettings>, FakeContextOptions][]) {
			test(`excludes only omp-translate messages with ${name}`, async () => {
				const { extension, session } = await answerSession(patch, options);
				const messages = contextMessages();

				const result = await extension.pi.emit("context", { type: "context", messages }, session.ctx);

				expect(result).toEqual({ messages: [messages[0], messages[1], messages[3]] });
			});
		}

		test("leaves context untouched without translation messages", async () => {
			const { extension, session } = await answerSession();
			const messages = contextMessages().filter(m => !("customType" in m && m.customType === "omp-translate"));

			const result = await extension.pi.emit("context", { type: "context", messages }, session.ctx);

			expect(result).toBeUndefined();
		});
	});

	test("/translate answer on persists and reports status", async () => {
		await writeSettings({ targetLanguage: "ja" });
		const extension = loadExtension();
		const session = fakeContext();

		await extension.pi.command().handler("answer on", session.ctx);
		expect((await readSettings()).answer).toBe(true);

		await extension.pi.command().handler("status", session.ctx);
		expect(session.notifications.at(-1)?.message).toContain("Answer translation: on");

		await extension.pi.command().handler("answer off", session.ctx);
		expect((await readSettings()).answer).toBe(false);
		await extension.pi.command().handler("status", session.ctx);
		expect(session.notifications.at(-1)?.message).toContain("Answer translation: off");
	});

	test("settings files without the answer key load as off", async () => {
		const { answer: _answer, ...legacy } = JSON.parse(await writeSettings({ targetLanguage: "ja" }));
		await fs.writeFile(settingsPath, JSON.stringify(legacy));
		const extension = loadExtension();
		const session = fakeContext();

		await extension.pi.command().handler("status", session.ctx);
		expect(session.notifications.at(-1)?.message).toContain("Answer translation: off");
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
		await extension.pi.emit("agent_end", agentEnd(finalAnswer("Build passed.")), session.ctx);
		await settle();
		expect(extension.calls).toHaveLength(0);
	});

	test("completes answer subcommands", () => {
		const extension = loadExtension();
		const complete = extension.pi.command().getArgumentCompletions;

		expect(complete?.("ans")).toEqual([
			{ value: "answer on", label: "answer on" },
			{ value: "answer off", label: "answer off" },
		]);
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

const tinyModel = { provider: "test", id: "tiny" } as unknown as Model<Api>;
const sharedModel = { provider: "test", id: "shared" } as unknown as Model<Api>;
const requestOnlyModel = { provider: "test", id: "req" } as unknown as Model<Api>;
const MODELS: Record<string, Model<Api>> = {
	"@tiny": tinyModel,
	"test/shared": sharedModel,
	"test/req": requestOnlyModel,
};
/** Fake provider whose answer names the model that produced it. */
const byModel: Responder = (call, model) => Promise.resolve(`${model.id}:${call.text}`);

type NoticeSource = { notifications: Notice[]; nextNotification(): Promise<Notice> };

/** Resolves with the first notification (already recorded or future) that matches. */
async function waitForNotice(session: NoticeSource, matches: (notice: Notice) => boolean): Promise<Notice> {
	const existing = session.notifications.find(matches);
	if (existing) return existing;
	for (;;) {
		const notice = await session.nextNotification();
		if (matches(notice)) return notice;
	}
}

/** Renders a thinking block, fires the debounce, and waits for the settled state's requestRender. */
async function renderSettled(extension: { pi: FakeExtensionAPI }, session: { fireTimers(): void }, text: string) {
	const thinking = thinkingContext(text);
	const component = extension.pi.render(thinking.rc);
	expect(textOf(component)).toBe("Translating…");
	const rendered = thinking.nextRender();
	session.fireTimers();
	await rendered;
	return { thinking, component };
}

const isSaveError = (notice: Notice) => notice.type === "error" && notice.message.includes("could not save settings");
const isSetupSuccess = (notice: Notice) =>
	notice.type === "info" && notice.message.startsWith("Thinking translations will be shown in");

async function readSettings(): Promise<TranslationSettings> {
	return JSON.parse(await fs.readFile(settingsPath, "utf8")) as TranslationSettings;
}

describe("model and language selection", () => {
	const steps: { command?: string; thinking: string; request: string }[] = [
		{ thinking: "tiny", request: "tiny" },
		{ command: "model test/shared", thinking: "shared", request: "shared" },
		{ command: "request-model test/req", thinking: "shared", request: "req" },
		{ command: "request-model clear", thinking: "shared", request: "shared" },
		{ command: "model clear", thinking: "tiny", request: "tiny" },
	];
	test("thinking and request paths each resolve their own model", async () => {
		await writeSettings({ targetLanguage: "ja", request: true });
		const extension = loadExtension();
		extension.respond = byModel;
		const session = fakeContext({ models: MODELS });
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);

		for (const [index, step] of steps.entries()) {
			if (step.command) {
				await extension.pi.command().handler(step.command, session.ctx);
				expect(session.notifications.at(-1)?.type).toBe("info");
			}
			const thought = `Thought number ${index}.`;
			const { component } = await renderSettled(extension, session, thought);
			expect(textOf(component)).toBe(`${step.thinking}:${thought}`);

			const prompt = `Arregla el fallo ${index}`;
			expect(await extension.pi.emit("input", inputEvent(prompt), session.ctx)).toEqual({
				text: `${step.request}:${prompt}`,
			});
			const [thinkingCall, requestCall] = extension.calls.slice(-2);
			expect(thinkingCall?.text).toBe(thought);
			expect(thinkingCall?.model.id).toBe(step.thinking);
			expect(requestCall?.text).toBe(prompt);
			expect(requestCall?.model.id).toBe(step.request);
		}
		expect(extension.calls).toHaveLength(steps.length * 2);
	});

	test("thinking uses the target language and requests use the request language", async () => {
		await writeSettings({ targetLanguage: "ja", requestLanguage: "ko", request: true });
		const extension = loadExtension();
		extension.respond = byModel;
		const session = fakeContext({ models: MODELS });
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);

		const { component } = await renderSettled(extension, session, "Check the config.");
		expect(textOf(component)).toBe("tiny:Check the config.");
		expect(await extension.pi.emit("input", inputEvent("Arregla el fallo"), session.ctx)).toEqual({
			text: "tiny:Arregla el fallo",
		});
		const [thinkingCall, requestCall] = extension.calls;
		expect(thinkingCall?.systemPrompt).toContain("Target language: Japanese (ja)");
		expect(thinkingCall?.systemPrompt).toContain("internal reasoning");
		expect(thinkingCall?.systemPrompt).not.toContain("developer's message");
		expect(requestCall?.systemPrompt).toContain("Target language: Korean (ko)");
		expect(requestCall?.systemPrompt).toContain("developer's message");
		expect(requestCall?.systemPrompt).not.toContain("internal reasoning");

		await extension.pi.command().handler("request-language fr", session.ctx);
		expect((await readSettings()).requestLanguage).toBe("fr");

		expect(await extension.pi.emit("input", inputEvent("Añade pruebas"), session.ctx)).toEqual({
			text: "tiny:Añade pruebas",
		});
		const after = await renderSettled(extension, session, "Then run the tests.");
		expect(textOf(after.component)).toBe("tiny:Then run the tests.");
		const frRequest = extension.calls.find(call => call.text === "Añade pruebas");
		const jaThinking = extension.calls.find(call => call.text === "Then run the tests.");
		expect(frRequest?.systemPrompt).toContain("(fr)");
		expect(frRequest?.systemPrompt).toContain("developer's message");
		expect(frRequest?.systemPrompt).not.toContain("(ko)");
		expect(jaThinking?.systemPrompt).toContain("(ja)");
		expect(jaThinking?.systemPrompt).toContain("internal reasoning");
		expect(jaThinking?.systemPrompt).not.toContain("(fr)");
	});
});

describe("custom language tag setup", () => {
	const CUSTOM = "Custom language tag";

	test("sr-latn is saved canonically and used by later thinking prompts", async () => {
		const extension = loadExtension();
		extension.respond = byModel;
		const session = fakeContext({
			models: MODELS,
			select: () => Promise.resolve(CUSTOM),
			input: () => Promise.resolve("sr-latn"),
		});
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
		await waitForNotice(session, isSetupSuccess);

		expect(session.selects[0]?.items).toContain(CUSTOM);
		expect((await readSettings()).targetLanguage).toBe("sr-Latn");
		expect(extension.calls).toHaveLength(0);

		const { component } = await renderSettled(extension, session, "Check the config.");
		expect(textOf(component)).toBe("tiny:Check the config.");
		expect(extension.calls[0]?.systemPrompt).toContain("(sr-Latn)");
	});

	test("invalid and blank tags re-prompt until PT-br is saved as pt-BR", async () => {
		const extension = loadExtension();
		const answers = ["not a tag!!", "   ", "PT-br"];
		const session = fakeContext({
			select: () => Promise.resolve(CUSTOM),
			input: () => Promise.resolve(answers.shift()),
		});
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
		const success = await waitForNotice(session, isSetupSuccess);

		expect(success.message).toContain("(pt-BR)");
		expect(session.inputs).toHaveLength(3);
		const errors = session.notifications.filter(notice => notice.type === "error");
		expect(errors).toHaveLength(2);
		expect(errors[0]?.message).toStartWith("Invalid language tag");
		expect(errors[0]?.message).toContain('"not a tag!!"');
		expect(errors[1]?.message).toStartWith("Invalid language tag");
		expect(errors[1]?.message).toContain('"   "');
		expect((await readSettings()).targetLanguage).toBe("pt-BR");
		expect(extension.calls).toHaveLength(0);
	});

	for (const [name, initialAnswers] of [
		["cancel", [undefined]],
		["invalid then cancel", ["not a tag!!", undefined]],
	] as [string, (string | undefined)[]][]) {
		test(`${name} saves nothing, is not re-shown, and explicit setup can still save`, async () => {
			const extension = loadExtension();
			let label = CUSTOM;
			const answers = [...initialAnswers];
			const session = fakeContext({
				select: () => Promise.resolve(label),
				input: () => Promise.resolve(answers.shift()),
			});
			await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
			await settle();
			expect(session.inputs).toHaveLength(initialAnswers.length);
			await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
			await settle();

			expect(session.selects).toHaveLength(1);
			expect(await Bun.file(settingsPath).exists()).toBe(false);
			expect(extension.calls).toHaveLength(0);
			expect(session.notifications.some(isSetupSuccess)).toBe(false);

			label = "日本語 (ja)";
			await extension.pi.command().handler("setup", session.ctx);
			expect(session.selects).toHaveLength(2);
			expect(session.notifications.some(isSetupSuccess)).toBe(true);
			expect((await readSettings()).targetLanguage).toBe("ja");
			expect(extension.calls).toHaveLength(0);
		});
	}
});

describe("settings save failures", () => {
	/** Fails the first write only; later writes hit the real file system. */
	function failFirstWrite() {
		let failed = false;
		return async (filePath: string, data: string): Promise<void> => {
			if (!failed) {
				failed = true;
				throw new Error("disk full");
			}
			await fs.writeFile(filePath, data);
		};
	}

	test("a failed thinking off keeps file, status, and view; retry turns it off and clears the view", async () => {
		const original = await writeSettings({ targetLanguage: "ja" });
		const extension = loadExtension({ writeFile: failFirstWrite() });
		extension.respond = byModel;
		const session = fakeContext({ models: MODELS });
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
		const { component } = await renderSettled(extension, session, "Check the config.");
		expect(textOf(component)).toBe("tiny:Check the config.");

		await extension.pi.command().handler("thinking off", session.ctx);
		const failure = session.notifications.at(-1);
		expect(failure && isSaveError(failure)).toBe(true);
		expect(failure?.message).toContain("disk full");
		expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
		expect(textOf(component)).toBe("tiny:Check the config.");
		await extension.pi.command().handler("status", session.ctx);
		expect(session.notifications.at(-1)?.message).toContain("Thinking translation: on");

		await extension.pi.command().handler("thinking off", session.ctx);
		expect(session.notifications.at(-1)?.type).toBe("info");
		expect(session.notifications.at(-1)?.message).toContain("Thinking translation: off");
		expect((await readSettings()).thinking).toBe(false);
		expect(textOf(component)).toBe("");
		expect(extension.pi.render(thinkingContext("Another thought.").rc)).toBeUndefined();
	});

	test("a failed first-run setup save reports an error; explicit setup retry saves and activates", async () => {
		const extension = loadExtension({ writeFile: failFirstWrite() });
		const session = fakeContext({ select: () => Promise.resolve("日本語 (ja)") });
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
		const failure = await waitForNotice(session, isSaveError);

		expect(failure.message).toContain("disk full");
		expect(session.notifications.some(isSetupSuccess)).toBe(false);
		expect(await Bun.file(settingsPath).exists()).toBe(false);
		expect(extension.pi.render(thinkingContext("A thought.").rc)).toBeUndefined();

		await extension.pi.command().handler("setup", session.ctx);
		expect(session.notifications.some(isSetupSuccess)).toBe(true);
		expect((await readSettings()).targetLanguage).toBe("ja");
		expect(textOf(extension.pi.render(thinkingContext("A thought.").rc))).toBe("Translating…");
	});
});

describe("settings that become invalid during a save", () => {
	const SOURCE = "Check the config.";
	const routes: {
		name: string;
		select?: () => Promise<string | undefined>;
		run: (pi: FakeExtensionAPI, ctx: ExtensionCommandContext) => Promise<unknown>;
	}[] = [
		{
			name: "/translate thinking off",
			run: async (pi, ctx) => {
				await fs.writeFile(settingsPath, "{ corrupted");
				await pi.command().handler("thinking off", ctx);
			},
		},
		{
			name: "/translate setup",
			select: async () => {
				await fs.writeFile(settingsPath, "{ corrupted");
				return "日本語 (ja)";
			},
			run: (pi, ctx) => pi.command().handler("setup", ctx),
		},
	];

	for (const route of routes) {
		async function start() {
			await writeSettings({ targetLanguage: "ja" });
			const extension = loadExtension();
			const session = fakeContext({ select: route.select });
			await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
			const fail = async () => {
				await route.run(extension.pi, session.ctx);
				expect(session.notifications.some(isSaveError)).toBe(true);
				expect(session.notifications.some(isSetupSuccess)).toBe(false);
				expect(await fs.readFile(settingsPath, "utf8")).toBe("{ corrupted");
			};
			return { extension, session, fail };
		}

		test(`${route.name}: a queued thinking translation is cancelled and cleared`, async () => {
			const { extension, session, fail } = await start();
			const component = extension.pi.render(thinkingContext(SOURCE).rc);
			expect(textOf(component)).toBe("Translating…");

			await fail();
			expect(textOf(component)).toBe("");
			session.fireTimers();
			await settle();
			expect(extension.calls).toHaveLength(0);
			expect(textOf(component)).toBe("");
		});

		test(`${route.name}: an in-flight translation is aborted and never shown; recovery translates afresh`, async () => {
			const { extension, session, fail } = await start();
			const stale = Promise.withResolvers<string>();
			extension.respond = () => stale.promise;
			const component = extension.pi.render(thinkingContext(SOURCE).rc);
			session.fireTimers();
			await settle();
			expect(extension.calls).toHaveLength(1);

			await fail();
			expect(textOf(component)).toBe("");
			expect(extension.calls[0]?.signal.aborted).toBe(true);
			stale.resolve("古い翻訳");
			await settle();
			expect(textOf(component)).toBe("");
			expect(extension.pi.render(thinkingContext(SOURCE).rc)).toBeUndefined();

			await writeSettings({ targetLanguage: "ja" });
			await extension.pi.command().handler("status", session.ctx);
			expect(session.notifications.at(-1)?.message).toContain("Thinking translation: on");
			const fresh = Promise.withResolvers<string>();
			extension.respond = () => fresh.promise;
			const thinking = thinkingContext(SOURCE);
			const next = extension.pi.render(thinking.rc);
			expect(textOf(next)).toBe("Translating…");
			session.fireTimers();
			await settle();
			expect(extension.calls).toHaveLength(2);
			const rendered = thinking.nextRender();
			fresh.resolve("新しい翻訳");
			await rendered;
			expect(textOf(next)).toBe("新しい翻訳");
			expect(textOf(component)).toBe("");
		});

		test(`${route.name}: a completed translation is cleared; recovery does not reuse the cache`, async () => {
			const { extension, session, fail } = await start();
			extension.respond = () => Promise.resolve("古い翻訳");
			const { component } = await renderSettled(extension, session, SOURCE);
			expect(textOf(component)).toBe("古い翻訳");

			await fail();
			expect(textOf(component)).toBe("");
			expect(extension.pi.render(thinkingContext(SOURCE).rc)).toBeUndefined();

			await writeSettings({ targetLanguage: "ja" });
			await extension.pi.command().handler("status", session.ctx);
			extension.respond = () => Promise.resolve("新しい翻訳");
			const { component: next } = await renderSettled(extension, session, SOURCE);
			expect(textOf(next)).toBe("新しい翻訳");
			expect(extension.calls).toHaveLength(2);
		});
	}
});

describe("thinking failures and recovery", () => {
	const failures: {
		name: string;
		settings: Partial<TranslationSettings>;
		text: string;
		respond: Responder;
		cause: string;
		recovery: string;
		providerCalls: number;
	}[] = [
		{
			name: "provider rejection",
			settings: {},
			text: "I should check the config first.",
			respond: () => Promise.reject(new Error("rate limited")),
			cause: "rate limited",
			recovery: "language ko",
			providerCalls: 1,
		},
		{
			name: "dropped code marker",
			settings: {},
			text: "Run `npm test` before committing.",
			respond: () => Promise.resolve("Ejecuta las pruebas antes de confirmar."),
			cause: "code marker",
			recovery: "language ko",
			providerCalls: 1,
		},
		{
			name: "unresolved model",
			settings: { model: "test/missing" },
			text: "I should check the config first.",
			respond: byModel,
			cause: "Model not found: test/missing",
			recovery: "model clear",
			providerCalls: 0,
		},
	];
	for (const failure of failures) {
		test(`${failure.name} shows the cause, is cached, and clears after ${failure.recovery}`, async () => {
			await writeSettings({ targetLanguage: "ja", ...failure.settings });
			const extension = loadExtension();
			extension.respond = failure.respond;
			const session = fakeContext({ models: MODELS });
			await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);

			const { thinking, component } = await renderSettled(extension, session, failure.text);
			const shown = textOf(component);
			expect(shown).toStartWith("(translation failed:");
			expect(shown).toContain(failure.cause);
			expect(thinking.renders()).toBe(1);
			expect(extension.calls).toHaveLength(failure.providerCalls);

			const again = extension.pi.render(thinkingContext(failure.text).rc);
			expect(textOf(again)).toBe(shown);
			session.fireTimers();
			await settle();
			expect(extension.calls).toHaveLength(failure.providerCalls);

			extension.respond = byModel;
			await extension.pi.command().handler(failure.recovery, session.ctx);
			expect(session.notifications.at(-1)?.type).toBe("info");
			expect(textOf(component)).toBe("");
			expect(textOf(again)).toBe("");

			const recovered = await renderSettled(extension, session, failure.text);
			expect(textOf(recovered.component)).toBe(`tiny:${failure.text}`);
			expect(extension.calls.at(-1)?.model.id).toBe("tiny");
			if (failure.recovery === "language ko") expect(extension.calls.at(-1)?.systemPrompt).toContain("(ko)");
		});
	}

	const sessionChanges: [string, (pi: FakeExtensionAPI, ctx: ExtensionCommandContext) => Promise<unknown>][] = [
		[
			"session_switch",
			(pi, ctx) => pi.emit("session_switch", { type: "session_switch", reason: "new", previousSessionFile: undefined }, ctx),
		],
		["session_branch", (pi, ctx) => pi.emit("session_branch", { type: "session_branch", previousSessionFile: undefined }, ctx)],
		["session_shutdown", (pi, ctx) => pi.emit("session_shutdown", { type: "session_shutdown" }, ctx)],
	];
	for (const [name, change] of sessionChanges) {
		test(`${name} clears a failure view`, async () => {
			await writeSettings({ targetLanguage: "ja" });
			const extension = loadExtension();
			extension.respond = () => Promise.reject(new Error("rate limited"));
			const session = fakeContext({ models: MODELS });
			await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
			const { thinking, component } = await renderSettled(extension, session, "Check the config.");
			expect(textOf(component)).toContain("rate limited");

			const rendersBefore = thinking.renders();
			await change(extension.pi, session.ctx);
			expect(textOf(component)).toBe("");
			expect(thinking.renders()).toBeGreaterThan(rendersBefore);
		});

		test(`${name}: a late rejection of invalidated work does not overwrite views`, async () => {
			await writeSettings({ targetLanguage: "ja" });
			const extension = loadExtension();
			const answers: PromiseWithResolvers<string>[] = [];
			extension.respond = () => {
				const answer = Promise.withResolvers<string>();
				answers.push(answer);
				return answer.promise;
			};
			const session = fakeContext({ models: MODELS });
			await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);

			const text = "Check the config.";
			const old = thinkingContext(text);
			const oldView = extension.pi.render(old.rc);
			session.fireTimers();
			await settle();
			expect(answers).toHaveLength(1);

			await change(extension.pi, session.ctx);
			expect(textOf(oldView)).toBe("");
			const fresh = thinkingContext(text);
			const freshView = extension.pi.render(fresh.rc);
			if (name === "session_shutdown") expect(freshView).toBeUndefined();
			else expect(textOf(freshView)).toBe("Translating…");

			const oldRenders = old.renders();
			answers[0]?.reject(new Error("late failure"));
			await settle();
			expect(textOf(oldView)).toBe("");
			expect(old.renders()).toBe(oldRenders);
			expect(fresh.renders()).toBe(0);
			if (name === "session_shutdown") return;

			expect(textOf(freshView)).toBe("Translating…");
			session.fireTimers();
			await settle();
			expect(answers).toHaveLength(2);
			const rendered = fresh.nextRender();
			answers[1]?.resolve("設定を確認する。");
			await rendered;
			expect(textOf(freshView)).toBe("設定を確認する。");
		});
	}
});
