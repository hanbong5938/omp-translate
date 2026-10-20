import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as z from "@oh-my-pi/omptype/zod";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionMode } from "@oh-my-pi/pi-coding-agent";
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

	async emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? []) result = await handler(payload, ctx);
		return result;
	}

	/** Calls every handler without awaiting and returns their raw results, so tests can see a synchronous handler. */
	dispatch(event: string, payload: unknown, ctx: ExtensionContext): unknown[] {
		return (this.handlers.get(event) ?? []).map(handler => handler(payload, ctx));
	}

	command(): CommandOptions {
		const command = this.commands.get("translate");
		if (!command) throw new Error("/translate is not registered");
		return command;
	}
}

interface FakeTimer {
	callback: () => void;
	ms: number;
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

interface FakeSession {
	ctx: ExtensionCommandContext;
	notifications: Notice[];
	selects: { title: string; items: unknown[] }[];
	inputs: string[];
	setSessionId(id: string): void;
	setIdle(value: boolean): void;
	nextNotification(): Promise<Notice>;
	activeTimers(): number;
	activeDelays(): number[];
	resolves(): number;
	fireTimers(): void;
	fireTimersWithDelay(ms: number): void;
}

const fakeModel = { provider: "test", id: "tiny" } as unknown as Model<Api>;

function fakeContext(options: FakeContextOptions = {}): FakeSession {
	const mode = options.mode ?? "tui";
	const kind = options.kind ?? "main";
	const notifications: Notice[] = [];
	const notificationWaiters: ((notice: Notice) => void)[] = [];
	const selects: { title: string; items: unknown[] }[] = [];
	const inputs: string[] = [];
	const timers: FakeTimer[] = [];
	let idle = true;
	let sessionId = "session-1";
	let resolves = 0;
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
			resolve: (spec: string) => {
				resolves++;
				return options.models ? options.models[spec] : spec === "nope" ? undefined : fakeModel;
			},
		},
		sessionManager: { getSessionId: () => sessionId },
		setTimeout: (callback: () => void, ms: number) => {
			const timer: FakeTimer = { callback, ms, active: true };
			timers.push(timer);
			return timer;
		},
		clearTimer: (timer: FakeTimer) => {
			timer.active = false;
		},
	};
	/** Fires `snapshot` in order, skipping timers cleared by an earlier callback of the same batch. */
	const fire = (snapshot: FakeTimer[]): void => {
		for (const timer of snapshot) {
			if (!timer.active) continue;
			timer.active = false;
			timer.callback();
		}
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
		/** Timers scheduled through ctx.setTimeout that have neither fired nor been cleared. */
		activeTimers(): number {
			return timers.filter(timer => timer.active).length;
		},
		/** Delays (ms) of the active timers, in scheduling order. */
		activeDelays(): number[] {
			return timers.filter(timer => timer.active).map(timer => timer.ms);
		},
		/** Number of ctx.models.resolve calls so far. */
		resolves(): number {
			return resolves;
		},
		/** Fires the timers active at call time; timers scheduled by their callbacks wait for the next call. */
		fireTimers(): void {
			fire(timers.filter(timer => timer.active));
		},
		/** Like fireTimers, restricted to timers scheduled with exactly `ms`. */
		fireTimersWithDelay(ms: number): void {
			fire(timers.filter(timer => timer.active && timer.ms === ms));
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

interface Harness {
	pi: FakeExtensionAPI;
	calls: RecordedCall[];
	stderr: string[];
	respond: Responder;
}

function loadExtension(options: { writeFile?: (path: string, data: string) => Promise<void> } = {}): Harness {
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

const THINKING_DELAY_MS = 1_500;
const IDLE_POLL_MS = 250;
const THINKING_FAILED = "Thinking translation failed: ";
const isThinkingFailure = (notice: Notice) => notice.message.startsWith(THINKING_FAILED);

function thinkingPost(content: string, targetLanguage = "ja") {
	return {
		message: { customType: "omp-translate-thinking", content, display: true, details: { targetLanguage } },
		options: { deliverAs: "nextTurn", triggerTurn: false },
	};
}

/** A completed assistant message with one thinking block per text. */
function thoughts(...texts: string[]) {
	return assistantMessage(texts.map(thinking => ({ type: "thinking", thinking })));
}

/** Delivers message_end to every handler and asserts each returns synchronously (never a promise). */
function endMessage(extension: Harness, session: FakeSession, message: unknown): void {
	const results = extension.pi.dispatch("message_end", { type: "message_end", message }, session.ctx);
	expect(results.length).toBeGreaterThan(0);
	for (const result of results) expect(result).toBeUndefined();
}

/** Completes one thinking block, fires its start delay, settles the model call, and returns the last post. */
async function completeThinking(extension: Harness, session: FakeSession, text: string) {
	endMessage(extension, session, thoughts(text));
	session.fireTimersWithDelay(THINKING_DELAY_MS);
	await settle();
	return extension.pi.sent.at(-1);
}

async function thinkingSession(patch: Partial<TranslationSettings> = {}, options: FakeContextOptions = {}) {
	await writeSettings({ targetLanguage: "ja", ...patch });
	const extension = loadExtension();
	const session = fakeContext(options);
	await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
	return { extension, session };
}

/** Makes every model call wait on its own deferred reply; replies[i] answers extension.calls[i]. */
function deferReplies(extension: Harness): PromiseWithResolvers<string>[] {
	const replies: PromiseWithResolvers<string>[] = [];
	extension.respond = () => {
		const reply = Promise.withResolvers<string>();
		replies.push(reply);
		return reply.promise;
	};
	return replies;
}

const isSaveError = (notice: Notice) => notice.type === "error" && notice.message.includes("could not save settings");
const isSetupSuccess = (notice: Notice) =>
	notice.type === "info" && notice.message.startsWith("Thinking translations will be shown in");

async function readSettings(): Promise<TranslationSettings> {
	return JSON.parse(await fs.readFile(settingsPath, "utf8")) as TranslationSettings;
}

describe("reasoning refusal fallback", () => {
	for (const late of [false, true]) {
		test(`stops thinking and translates the final answer when refusal arrives ${late ? "after" : "before"} agent_end`, async () => {
			const { extension, session } = await thinkingSession();
			const saved = await readSettings();
			const replies = deferReplies(extension);
			endMessage(extension, session, thoughts("Pending first.", "Refused second."));
			session.fireTimersWithDelay(THINKING_DELAY_MS);
			endMessage(extension, session, thoughts("Still queued."));
			if (late) await extension.pi.emit("agent_end", agentEnd(finalAnswer("Build passed.")), session.ctx);
			replies[1]!.reject(new Error("error Refusal (reasoning_extraction): blocked"));
			await settle();
			expect(extension.calls[0]!.signal?.aborted).toBe(true);
			expect(session.activeTimers()).toBe(0);
			expect(session.notifications.filter(n => n.type === "warning")).toHaveLength(1);
			if (!late) await extension.pi.emit("agent_end", agentEnd(finalAnswer("Build passed.")), session.ctx);
			expect(extension.calls.map(call => call.text)).toEqual(["Pending first.", "Refused second.", "Build passed."]);
			replies[2]!.resolve("ビルドは成功しました。");
			replies[0]!.reject(new Error("error Refusal (reasoning_extraction): blocked"));
			await settle();
			expect(extension.pi.sent).toEqual([answerPost("ビルドは成功しました。")]);
			await completeThinking(extension, session, "New distinct thought.");
			expect(extension.calls).toHaveLength(3);
			expect(session.notifications.filter(n => n.type === "warning")).toHaveLength(1);
			expect(await readSettings()).toEqual(saved);

			await extension.pi.command().handler("answer off", session.ctx);
			await extension.pi.emit("agent_end", agentEnd(finalAnswer("Next answer.")), session.ctx);
			await completeThinking(extension, session, "Another thought.");
			expect(extension.calls).toHaveLength(3);

			await extension.pi.emit("session_switch", { type: "session_switch" }, session.ctx);
			extension.respond = () => Promise.resolve("新しい考え。");
			await completeThinking(extension, session, "New session thought.");
			expect(extension.pi.sent.at(-1)).toEqual(thinkingPost("新しい考え。"));
			await extension.pi.emit("agent_end", agentEnd(finalAnswer("Not enabled.")), session.ctx);
			expect(extension.calls).toHaveLength(4);
		});
	}

	test("ordinary errors do not pause thinking or enable answer translation", async () => {
		const { extension, session } = await thinkingSession();
		extension.respond = () => Promise.reject(new Error("rate limit"));
		await completeThinking(extension, session, "First thought.");
		extension.respond = () => Promise.resolve("次の考え。");
		await completeThinking(extension, session, "Second thought.");
		await extension.pi.emit("agent_end", agentEnd(finalAnswer("Build passed.")), session.ctx);
		expect(extension.calls.map(call => call.text)).toEqual(["First thought.", "Second thought."]);
		expect(extension.pi.sent).toEqual([thinkingPost("次の考え。")]);
	});
});

describe("completed thinking translation", () => {
	test("streaming updates never translate; one message_end translates the final text once after the start delay", async () => {
		const { extension, session } = await thinkingSession();
		const reply = Promise.withResolvers<string>();
		extension.respond = () => reply.promise;
		const resolvesBefore = session.resolves();

		const words = Array.from({ length: 200 }, (_, index) => `step${index}`);
		for (let length = 1; length <= words.length; length++) {
			const partial = thoughts(words.slice(0, length).join(" "));
			const update = {
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: ` ${words[length - 1]}`, partial },
			};
			await extension.pi.emit("message_update", update, session.ctx);
			expect(session.activeTimers()).toBe(0);
			session.fireTimers();
			await settle();
		}
		expect(extension.calls).toHaveLength(0);
		expect(session.resolves()).toBe(resolvesBefore);
		expect(extension.pi.sent).toHaveLength(0);

		const finalText = words.join(" ");
		endMessage(extension, session, thoughts(finalText));
		expect(session.activeDelays()).toEqual([THINKING_DELAY_MS]);
		await settle();
		expect(extension.calls).toHaveLength(0);

		session.fireTimersWithDelay(THINKING_DELAY_MS);
		expect(extension.calls.map(call => call.text)).toEqual([finalText]);
		expect(extension.calls[0]?.systemPrompt).toContain("internal reasoning");
		expect(extension.pi.sent).toHaveLength(0);

		reply.resolve("最終的な考え。");
		await settle();
		expect(extension.pi.sent).toEqual([thinkingPost("最終的な考え。")]);
		expect(extension.calls).toHaveLength(1);
		expect(session.activeTimers()).toBe(0);
	});

	test("translates only readable thinking blocks of one message and posts them in content order", async () => {
		const { extension, session } = await thinkingSession();
		const replies = deferReplies(extension);
		const message = assistantMessage(
			[
				{ type: "thinking", thinking: "First thought.\n" },
				{ type: "text", text: "Visible answer." },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo secret" } },
				{ type: "redactedThinking", data: "opaque" },
				{ type: "thinking", thinking: "  \n\t" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "Second thought.", thinkingSignature: "sig" },
			],
			"toolUse",
		);
		const snapshot = structuredClone(message);

		endMessage(extension, session, message);
		expect(session.activeDelays()).toEqual([THINKING_DELAY_MS, THINKING_DELAY_MS]);
		session.fireTimersWithDelay(THINKING_DELAY_MS);
		// The untrimmed source is what gets translated.
		expect(extension.calls.map(call => call.text)).toEqual(["First thought.\n", "Second thought."]);

		replies[1]?.resolve("二番目の考え。");
		await settle();
		expect(extension.pi.sent).toHaveLength(0);
		replies[0]?.resolve("最初の考え。");
		await settle();

		expect(extension.pi.sent).toEqual([thinkingPost("最初の考え。"), thinkingPost("二番目の考え。")]);
		expect(message).toEqual(snapshot);
		expect(session.activeTimers()).toBe(0);
	});

	const firstFailures: [string, () => unknown, (notice: Notice) => void][] = [
		[
			"fails",
			() => new Error("rate limited"),
			notice => expect(notice).toEqual({ message: `${THINKING_FAILED}rate limited`, type: "warning" }),
		],
		[
			"times out",
			() => new DOMException("The operation timed out.", "TimeoutError"),
			notice => {
				expect(notice.type).toBe("warning");
				expect(notice.message).toStartWith(THINKING_FAILED);
				expect(notice.message).toContain("timed out");
			},
		],
	];
	for (const [name, error, check] of firstFailures) {
		test(`a first block that ${name} warns once and does not block the next block`, async () => {
			const { extension, session } = await thinkingSession();
			const replies = deferReplies(extension);

			endMessage(extension, session, thoughts("First thought.", "Second thought."));
			session.fireTimersWithDelay(THINKING_DELAY_MS);
			replies[1]?.resolve("二番目の考え。");
			await settle();
			expect(extension.pi.sent).toHaveLength(0);
			replies[0]?.reject(error());
			await settle();

			const failures = session.notifications.filter(isThinkingFailure);
			expect(failures).toHaveLength(1);
			check(failures[0] as Notice);
			expect(extension.pi.sent).toEqual([thinkingPost("二番目の考え。")]);
			expect(session.activeTimers()).toBe(0);
		});
	}

	test("the same completed text in separate messages shares one call and posts once per occurrence", async () => {
		const { extension, session } = await thinkingSession();
		const reply = Promise.withResolvers<string>();
		extension.respond = () => reply.promise;
		const text = "I should check the config first.";
		const post = thinkingPost("まず設定を確認するべきだ。");

		endMessage(extension, session, thoughts(text));
		endMessage(extension, session, thoughts(text));
		expect(session.activeDelays()).toEqual([THINKING_DELAY_MS]);
		session.fireTimersWithDelay(THINKING_DELAY_MS);
		expect(extension.calls).toHaveLength(1);
		reply.resolve("まず設定を確認するべきだ。");
		await settle();
		expect(extension.pi.sent).toEqual([post, post]);

		// A completed cache hit posts synchronously, without a timer or a call.
		endMessage(extension, session, thoughts(text));
		expect(session.activeTimers()).toBe(0);
		expect(extension.pi.sent).toEqual([post, post, post]);
		await settle();
		expect(extension.calls).toHaveLength(1);
	});

	test("prefix-related texts are independent calls whose posts keep completion-event order", async () => {
		const { extension, session } = await thinkingSession();
		const replies = deferReplies(extension);

		endMessage(extension, session, thoughts("Let me think"));
		endMessage(extension, session, thoughts("Let me think about this"));
		expect(session.activeDelays()).toEqual([THINKING_DELAY_MS, THINKING_DELAY_MS]);
		session.fireTimersWithDelay(THINKING_DELAY_MS);
		expect(extension.calls.map(call => call.text)).toEqual(["Let me think", "Let me think about this"]);

		replies[1]?.resolve("これについて考えてみよう");
		await settle();
		expect(extension.pi.sent).toHaveLength(0);
		replies[0]?.resolve("考えてみよう");
		await settle();

		expect(extension.pi.sent).toEqual([thinkingPost("考えてみよう"), thinkingPost("これについて考えてみよう")]);
	});

	test("results finished while busy wait for idle and post from a single 250 ms drain timer", async () => {
		const { extension, session } = await thinkingSession();
		const replies = deferReplies(extension);
		session.setIdle(false);

		endMessage(extension, session, thoughts("First thought."));
		endMessage(extension, session, thoughts("Second thought."));
		session.fireTimersWithDelay(THINKING_DELAY_MS);
		replies[1]?.resolve("二番目の考え。");
		await settle();
		// A pending head blocks later results without polling.
		expect(session.activeDelays()).toEqual([]);
		replies[0]?.resolve("最初の考え。");
		await settle();
		expect(extension.pi.sent).toHaveLength(0);
		expect(session.activeDelays()).toEqual([IDLE_POLL_MS]);

		await extension.pi.emit("agent_end", agentEnd([], true), session.ctx);
		await extension.pi.emit("agent_end", agentEnd([]), session.ctx);
		expect(extension.pi.sent).toHaveLength(0);
		expect(session.activeDelays()).toEqual([IDLE_POLL_MS]);

		session.fireTimersWithDelay(IDLE_POLL_MS);
		expect(extension.pi.sent).toHaveLength(0);
		expect(session.activeDelays()).toEqual([IDLE_POLL_MS]);

		// No further event: the drain alone posts once idle.
		session.setIdle(true);
		session.fireTimersWithDelay(IDLE_POLL_MS);
		expect(extension.pi.sent).toEqual([thinkingPost("最初の考え。"), thinkingPost("二番目の考え。")]);
		expect(session.activeTimers()).toBe(0);
		await settle();
		expect(extension.pi.sent).toHaveLength(2);
		expect(extension.calls).toHaveLength(2);
	});

	test("an idle main agent_end posts held results immediately and cancels the drain timer", async () => {
		const { extension, session } = await thinkingSession();
		extension.respond = () => Promise.resolve("まず設定を確認するべきだ。");
		session.setIdle(false);

		await completeThinking(extension, session, "I should check the config first.");
		expect(extension.pi.sent).toHaveLength(0);
		expect(session.activeDelays()).toEqual([IDLE_POLL_MS]);

		session.setIdle(true);
		await extension.pi.emit("agent_end", agentEnd([]), session.ctx);
		expect(extension.pi.sent).toEqual([thinkingPost("まず設定を確認するべきだ。")]);
		expect(session.activeTimers()).toBe(0);
		session.fireTimers();
		await settle();
		expect(extension.pi.sent).toHaveLength(1);
	});
});

describe("thinking invalidation", () => {
	const TEXT = "I should check the config first.";
	type Change = {
		name: string;
		run: (pi: FakeExtensionAPI, current: FakeSession, next: FakeSession) => Promise<unknown>;
		/** stopped: no further thinking translation; same: the current ctx stays bound; rebound: `next` becomes the owner. */
		after: "stopped" | "same" | "rebound";
		model?: string;
		targetLanguage?: string;
	};
	const changes: Change[] = [
		{ name: "/translate thinking off", run: (pi, current) => pi.command().handler("thinking off", current.ctx), after: "stopped" },
		{
			name: "/translate language ko",
			run: (pi, current) => pi.command().handler("language ko", current.ctx),
			after: "same",
			targetLanguage: "ko",
		},
		{
			name: "/translate model test/shared",
			run: (pi, current) => pi.command().handler("model test/shared", current.ctx),
			after: "same",
			model: "shared",
		},
		{
			name: "session_switch",
			run: (pi, _current, next) =>
				pi.emit("session_switch", { type: "session_switch", reason: "new", previousSessionFile: undefined }, next.ctx),
			after: "rebound",
		},
		{
			name: "session_branch",
			run: (pi, _current, next) =>
				pi.emit("session_branch", { type: "session_branch", previousSessionFile: undefined }, next.ctx),
			after: "rebound",
		},
		{
			name: "session_shutdown",
			run: (pi, current) => pi.emit("session_shutdown", { type: "session_shutdown" }, current.ctx),
			after: "stopped",
		},
	];

	async function start() {
		const { extension, session } = await thinkingSession({}, { models: MODELS });
		return { extension, session, next: fakeContext({ models: MODELS }) };
	}

	/** Fires every remaining timer of both owners twice, so rescheduled drains also run. */
	async function drainAll(sessions: FakeSession[]): Promise<void> {
		for (let round = 0; round < 2; round++) {
			for (const session of sessions) session.fireTimers();
			await settle();
		}
	}

	for (const change of changes) {
		test(`${change.name} cancels a translation still waiting for its start delay`, async () => {
			const { extension, session, next } = await start();
			endMessage(extension, session, thoughts(TEXT));
			expect(session.activeDelays()).toEqual([THINKING_DELAY_MS]);

			await change.run(extension.pi, session, next);
			expect(session.activeTimers()).toBe(0);
			await drainAll([session, next]);

			expect(extension.calls).toHaveLength(0);
			expect(extension.pi.sent).toHaveLength(0);
		});

		for (const outcome of ["resolve", "reject"] as const) {
			test(`${change.name} aborts an in-flight translation and ignores its late ${outcome}`, async () => {
				const { extension, session, next } = await start();
				const replies = deferReplies(extension);
				endMessage(extension, session, thoughts(TEXT));
				session.fireTimersWithDelay(THINKING_DELAY_MS);
				expect(extension.calls).toHaveLength(1);

				await change.run(extension.pi, session, next);
				expect(extension.calls[0]?.signal.aborted).toBe(true);
				if (outcome === "resolve") replies[0]?.resolve("古い翻訳");
				else replies[0]?.reject(new Error("late failure"));
				await drainAll([session, next]);

				expect(extension.pi.sent).toHaveLength(0);
				expect([...session.notifications, ...next.notifications].filter(isThinkingFailure)).toEqual([]);
			});
		}

		test(`${change.name} drops a result held while busy and keeps already posted ones`, async () => {
			const { extension, session, next } = await start();
			extension.respond = byModel;
			expect(await completeThinking(extension, session, "Earlier thought.")).toEqual(thinkingPost("tiny:Earlier thought."));

			session.setIdle(false);
			await completeThinking(extension, session, TEXT);
			expect(extension.pi.sent).toHaveLength(1);
			expect(session.activeDelays()).toEqual([IDLE_POLL_MS]);

			await change.run(extension.pi, session, next);
			expect(session.activeTimers()).toBe(0);
			session.setIdle(true);
			await extension.pi.emit("agent_end", agentEnd([]), change.after === "rebound" ? next.ctx : session.ctx);
			await drainAll([session, next]);

			expect(extension.pi.sent).toEqual([thinkingPost("tiny:Earlier thought.")]);
		});

		const effect = change.after === "stopped" ? "stops later translations" : "translates the next completion afresh";
		test(`${change.name} ${effect}`, async () => {
			const { extension, session, next } = await start();
			extension.respond = byModel;
			expect(await completeThinking(extension, session, TEXT)).toEqual(thinkingPost(`tiny:${TEXT}`));

			await change.run(extension.pi, session, next);
			const owner = change.after === "rebound" ? next : session;
			endMessage(extension, owner, thoughts(TEXT));
			if (change.after === "stopped") {
				expect(session.activeTimers() + next.activeTimers()).toBe(0);
				await drainAll([session, next]);
				expect(extension.calls).toHaveLength(1);
				expect(extension.pi.sent).toHaveLength(1);
				return;
			}

			// The completed cache was dropped: a new start delay and call follow.
			expect(owner.activeDelays()).toEqual([THINKING_DELAY_MS]);
			owner.fireTimersWithDelay(THINKING_DELAY_MS);
			await settle();
			const model = change.model ?? "tiny";
			const targetLanguage = change.targetLanguage ?? "ja";
			expect(extension.calls).toHaveLength(2);
			expect(extension.calls[1]?.model.id).toBe(model);
			expect(extension.calls[1]?.systemPrompt).toContain(`(${targetLanguage})`);
			expect(extension.pi.sent).toEqual([
				thinkingPost(`tiny:${TEXT}`),
				thinkingPost(`${model}:${TEXT}`, targetLanguage),
			]);
		});
	}
});

describe("thinking eligibility", () => {
	const TEXT = "I should check the config first.";

	for (const [name, options] of [
		["a subagent", { kind: "sub" }],
		["print mode", { mode: "print" }],
		["json mode", { mode: "json" }],
		["rpc mode", { mode: "rpc" }],
	] as [string, FakeContextOptions][]) {
		test(`ignores completed thinking from ${name}`, async () => {
			const { extension, session } = await thinkingSession();
			const other = fakeContext(options);

			endMessage(extension, other, thoughts(TEXT));
			expect(session.activeTimers() + other.activeTimers()).toBe(0);
			session.fireTimers();
			other.fireTimers();
			await settle();

			expect(extension.calls).toHaveLength(0);
			expect(extension.pi.sent).toHaveLength(0);
			expect(other.resolves()).toBe(0);
			expect(other.notifications).toEqual([]);
		});
	}

	for (const [name, patch] of [
		["thinking translation is off", { thinking: false }],
		["no target language is configured", { targetLanguage: "" }],
	] as [string, Partial<TranslationSettings>][]) {
		test(`ignores completed thinking when ${name}`, async () => {
			const { extension, session } = await thinkingSession(patch);
			const resolvesBefore = session.resolves();

			endMessage(extension, session, thoughts(TEXT));
			expect(session.activeTimers()).toBe(0);
			session.fireTimers();
			await settle();

			expect(extension.calls).toHaveLength(0);
			expect(extension.pi.sent).toHaveLength(0);
			expect(session.resolves()).toBe(resolvesBefore);
		});
	}

	test("ignores completed thinking before a main session starts", async () => {
		await writeSettings({ targetLanguage: "ja" });
		const extension = loadExtension();
		const session = fakeContext();
		await extension.pi.command().handler("status", session.ctx);

		endMessage(extension, session, thoughts(TEXT));
		expect(session.activeTimers()).toBe(0);
		session.fireTimers();
		await settle();

		expect(extension.calls).toHaveLength(0);
		expect(extension.pi.sent).toHaveLength(0);
	});

	const ineligible: [string, unknown][] = [
		[
			"a thinking translation message",
			{
				role: "custom",
				customType: "omp-translate-thinking",
				content: "まず設定を確認するべきだ。",
				display: true,
				details: { targetLanguage: "ja" },
				timestamp: 0,
			},
		],
		[
			"another custom message",
			{
				role: "custom",
				customType: "other",
				content: [{ type: "thinking", thinking: "Custom thought." }],
				display: true,
				timestamp: 0,
			},
		],
		[
			"a user message",
			{
				role: "user",
				content: [
					{ type: "thinking", thinking: "User thought." },
					{ type: "text", text: "go" },
				],
				timestamp: 0,
			},
		],
		[
			"a tool result",
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "thinking", thinking: "Tool thought." }],
				isError: false,
				timestamp: 0,
			},
		],
		[
			"an assistant message without readable thinking",
			assistantMessage([
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: " \n\t" },
				{ type: "redactedThinking", data: "opaque" },
				{ type: "text", text: "Answer." },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
			]),
		],
	];
	for (const [name, message] of ineligible) {
		test(`does not translate ${name}`, async () => {
			const { extension, session } = await thinkingSession();
			const resolvesBefore = session.resolves();

			endMessage(extension, session, message);
			expect(session.activeTimers()).toBe(0);
			session.fireTimers();
			await settle();

			expect(extension.calls).toHaveLength(0);
			expect(extension.pi.sent).toHaveLength(0);
			expect(session.resolves()).toBe(resolvesBefore);
		});
	}

	for (const stopReason of ["stop", "toolUse", "length", "error", "aborted"]) {
		test(`translates readable thinking of a message that ended with ${stopReason}`, async () => {
			const { extension, session } = await thinkingSession();
			extension.respond = call => Promise.resolve(`訳:${call.text}`);
			const message = assistantMessage(
				[
					{ type: "thinking", thinking: "Partial thought." },
					{ type: "text", text: "Partial answer." },
				],
				stopReason,
			);
			const snapshot = structuredClone(message);

			endMessage(extension, session, message);
			session.fireTimersWithDelay(THINKING_DELAY_MS);
			await settle();

			expect(extension.calls.map(call => call.text)).toEqual(["Partial thought."]);
			expect(extension.pi.sent).toEqual([thinkingPost("訳:Partial thought.")]);
			expect(message).toEqual(snapshot);
		});
	}

	test("session start and resume translate no history and never re-translate replayed translations", async () => {
		const { extension, session } = await thinkingSession();
		await extension.pi.emit(
			"session_switch",
			{ type: "session_switch", reason: "resume", previousSessionFile: "previous.jsonl" },
			session.ctx,
		);
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
		endMessage(extension, session, {
			role: "custom",
			customType: "omp-translate-thinking",
			content: "まず設定を確認するべきだ。",
			display: true,
			details: { targetLanguage: "ja" },
			timestamp: 0,
		});
		expect(session.activeTimers()).toBe(0);
		session.fireTimers();
		await settle();

		expect(session.resolves()).toBe(0);
		expect(extension.calls).toHaveLength(0);
		expect(extension.pi.sent).toHaveLength(0);
	});
});

describe("provider context excludes both translation kinds", () => {
	const contextMessages = () => [
		userMessage("go"),
		assistantMessage([
			{ type: "thinking", thinking: "I should check the config first." },
			{ type: "text", text: "Build passed." },
		]),
		{ role: "custom", customType: "omp-translate", content: "ビルドは成功しました。", display: true, timestamp: 0 },
		{
			role: "custom",
			customType: "omp-translate-thinking",
			content: "まず設定を確認するべきだ。",
			display: true,
			details: { targetLanguage: "ja" },
			timestamp: 0,
		},
		{ role: "custom", customType: "other", content: "keep me", display: true, timestamp: 0 },
	];

	for (const [name, patch, options] of [
		["thinking on", {}, {}],
		["thinking off", { thinking: false }, {}],
		["every translation off", { thinking: false, answer: false, request: false }, {}],
		["answer on", { answer: true }, {}],
		["no target language", { targetLanguage: "" }, {}],
		["a subagent", {}, { kind: "sub" }],
	] as [string, Partial<TranslationSettings>, FakeContextOptions][]) {
		test(`removes answer and thinking translations with ${name}`, async () => {
			const { extension, session } = await thinkingSession(patch, options);
			const messages = contextMessages();

			const result = await extension.pi.emit("context", { type: "context", messages }, session.ctx);

			expect(result).toEqual({ messages: [messages[0], messages[1], messages[4]] });
		});
	}

	test("removes a thinking translation alone", async () => {
		const { extension, session } = await thinkingSession();
		const messages = contextMessages().filter(m => !("customType" in m && m.customType === "omp-translate"));

		const result = await extension.pi.emit("context", { type: "context", messages }, session.ctx);

		expect(result).toEqual({ messages: [messages[0], messages[1], messages[3]] });
	});

	test("leaves context untouched without translation messages", async () => {
		const { extension, session } = await thinkingSession();
		const messages = contextMessages().filter(m => !("customType" in m && m.customType.startsWith("omp-translate")));

		const result = await extension.pi.emit("context", { type: "context", messages }, session.ctx);

		expect(result).toBeUndefined();
	});
});

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
			expect(await completeThinking(extension, session, thought)).toEqual(thinkingPost(`${step.thinking}:${thought}`));

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

		expect(await completeThinking(extension, session, "Check the config.")).toEqual(thinkingPost("tiny:Check the config."));
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
		expect(await completeThinking(extension, session, "Then run the tests.")).toEqual(
			thinkingPost("tiny:Then run the tests."),
		);
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

		expect(await completeThinking(extension, session, "Check the config.")).toEqual(
			thinkingPost("tiny:Check the config.", "sr-Latn"),
		);
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

	test("a failed thinking off keeps file, status, and translation; retry turns it off and stops translating", async () => {
		const original = await writeSettings({ targetLanguage: "ja" });
		const extension = loadExtension({ writeFile: failFirstWrite() });
		extension.respond = byModel;
		const session = fakeContext({ models: MODELS });
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
		expect(await completeThinking(extension, session, "Check the config.")).toEqual(thinkingPost("tiny:Check the config."));

		await extension.pi.command().handler("thinking off", session.ctx);
		const failure = session.notifications.at(-1);
		expect(failure && isSaveError(failure)).toBe(true);
		expect(failure?.message).toContain("disk full");
		expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
		expect(await completeThinking(extension, session, "Then run the tests.")).toEqual(
			thinkingPost("tiny:Then run the tests."),
		);
		await extension.pi.command().handler("status", session.ctx);
		expect(session.notifications.at(-1)?.message).toContain("Thinking translation: on");

		await extension.pi.command().handler("thinking off", session.ctx);
		expect(session.notifications.at(-1)?.type).toBe("info");
		expect(session.notifications.at(-1)?.message).toContain("Thinking translation: off");
		expect((await readSettings()).thinking).toBe(false);
		endMessage(extension, session, thoughts("Another thought."));
		expect(session.activeTimers()).toBe(0);
		session.fireTimers();
		await settle();
		expect(extension.calls).toHaveLength(2);
		expect(extension.pi.sent).toHaveLength(2);
	});

	test("a failed first-run setup save reports an error; explicit setup retry saves and activates", async () => {
		const extension = loadExtension({ writeFile: failFirstWrite() });
		const session = fakeContext({ select: () => Promise.resolve("日本語 (ja)") });
		await extension.pi.emit("session_start", { type: "session_start" }, session.ctx);
		const failure = await waitForNotice(session, isSaveError);

		expect(failure.message).toContain("disk full");
		expect(session.notifications.some(isSetupSuccess)).toBe(false);
		expect(await Bun.file(settingsPath).exists()).toBe(false);
		endMessage(extension, session, thoughts("A thought."));
		expect(session.activeTimers()).toBe(0);

		await extension.pi.command().handler("setup", session.ctx);
		expect(session.notifications.some(isSetupSuccess)).toBe(true);
		expect((await readSettings()).targetLanguage).toBe("ja");
		endMessage(extension, session, thoughts("A thought."));
		expect(session.activeDelays()).toEqual([THINKING_DELAY_MS]);
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

		test(`${route.name}: a queued thinking translation is cancelled`, async () => {
			const { extension, session, fail } = await start();
			endMessage(extension, session, thoughts(SOURCE));
			expect(session.activeDelays()).toEqual([THINKING_DELAY_MS]);

			await fail();
			expect(session.activeTimers()).toBe(0);
			session.fireTimers();
			await settle();
			expect(extension.calls).toHaveLength(0);
			expect(extension.pi.sent).toHaveLength(0);
		});

		test(`${route.name}: an in-flight translation is aborted and never posted; recovery translates afresh`, async () => {
			const { extension, session, fail } = await start();
			const replies = deferReplies(extension);
			endMessage(extension, session, thoughts(SOURCE));
			session.fireTimersWithDelay(THINKING_DELAY_MS);
			expect(extension.calls).toHaveLength(1);

			await fail();
			expect(extension.calls[0]?.signal.aborted).toBe(true);
			replies[0]?.resolve("古い翻訳");
			await settle();
			expect(extension.pi.sent).toHaveLength(0);
			endMessage(extension, session, thoughts(SOURCE));
			expect(session.activeTimers()).toBe(0);

			await writeSettings({ targetLanguage: "ja" });
			await extension.pi.command().handler("status", session.ctx);
			expect(session.notifications.at(-1)?.message).toContain("Thinking translation: on");
			endMessage(extension, session, thoughts(SOURCE));
			session.fireTimersWithDelay(THINKING_DELAY_MS);
			expect(extension.calls).toHaveLength(2);
			replies[1]?.resolve("新しい翻訳");
			await settle();
			expect(extension.pi.sent).toEqual([thinkingPost("新しい翻訳")]);
		});

		test(`${route.name}: a held result is dropped, posted ones stay, and recovery does not reuse the cache`, async () => {
			const { extension, session, fail } = await start();
			extension.respond = () => Promise.resolve("古い翻訳");
			expect(await completeThinking(extension, session, SOURCE)).toEqual(thinkingPost("古い翻訳"));

			session.setIdle(false);
			endMessage(extension, session, thoughts(SOURCE));
			expect(session.activeDelays()).toEqual([IDLE_POLL_MS]);
			await fail();
			expect(session.activeTimers()).toBe(0);
			session.setIdle(true);
			await extension.pi.emit("agent_end", agentEnd([]), session.ctx);
			session.fireTimers();
			await settle();
			expect(extension.pi.sent).toEqual([thinkingPost("古い翻訳")]);

			await writeSettings({ targetLanguage: "ja" });
			await extension.pi.command().handler("status", session.ctx);
			extension.respond = () => Promise.resolve("新しい翻訳");
			expect(await completeThinking(extension, session, SOURCE)).toEqual(thinkingPost("新しい翻訳"));
			expect(extension.calls).toHaveLength(2);
			expect(extension.pi.sent).toEqual([thinkingPost("古い翻訳"), thinkingPost("新しい翻訳")]);
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
		test(`${failure.name} warns without posting, reuses the cached failure, and recovers after ${failure.recovery}`, async () => {
			const { extension, session } = await thinkingSession(failure.settings, { models: MODELS });
			extension.respond = failure.respond;

			expect(await completeThinking(extension, session, failure.text)).toBeUndefined();
			const warnings = session.notifications.filter(isThinkingFailure);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.type).toBe("warning");
			expect(warnings[0]?.message).toContain(failure.cause);
			if (failure.name !== "dropped code marker") expect(warnings[0]?.message).toBe(`${THINKING_FAILED}${failure.cause}`);
			expect(extension.calls).toHaveLength(failure.providerCalls);

			// The cached failure warns for the new occurrence without a timer or a model call.
			endMessage(extension, session, thoughts(failure.text));
			expect(session.activeTimers()).toBe(0);
			session.fireTimers();
			await settle();
			expect(extension.calls).toHaveLength(failure.providerCalls);
			expect(session.notifications.filter(isThinkingFailure)).toHaveLength(2);
			expect(extension.pi.sent).toHaveLength(0);

			extension.respond = byModel;
			await extension.pi.command().handler(failure.recovery, session.ctx);
			expect(session.notifications.at(-1)?.type).toBe("info");
			const targetLanguage = failure.recovery === "language ko" ? "ko" : "ja";
			expect(await completeThinking(extension, session, failure.text)).toEqual(
				thinkingPost(`tiny:${failure.text}`, targetLanguage),
			);
			expect(extension.calls.at(-1)?.model.id).toBe("tiny");
			expect(extension.calls.at(-1)?.systemPrompt).toContain(`(${targetLanguage})`);
			expect(extension.pi.sent).toHaveLength(1);
		});
	}

	test("code spans are restored verbatim in the posted translation body", async () => {
		const { extension, session } = await thinkingSession();
		extension.respond = call =>
			Promise.resolve(call.text.replace("Run", "実行:").replace("before committing.", "をコミット前に。"));

		expect(await completeThinking(extension, session, "Run `npm test` before committing.")).toEqual(
			thinkingPost("実行: `npm test` をコミット前に。"),
		);
		expect(extension.calls).toHaveLength(1);
		expect(extension.calls[0]?.text).not.toContain("npm test");
		expect(session.notifications.filter(isThinkingFailure)).toEqual([]);
	});
});
