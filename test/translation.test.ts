import { describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Context, Model, StopReason, completeSimple } from "@oh-my-pi/pi-ai";
import {
	buildRequestPrompt,
	createModelCaller,
	MarkerMismatchError,
	type ModelCall,
	protectCode,
	shouldTranslateInput,
	type ThinkingRequest,
	ThinkingTranslator,
	type ThinkingViewState,
	type TimerHost,
	translateText,
} from "../src/translation.ts";

/** Drains pending promise callbacks without waiting on the wall clock. */
async function tick(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

class FakeTimers implements TimerHost {
	readonly scheduled = new Map<unknown, () => void>();
	#next = 0;

	setTimeout(callback: () => void, _ms: number): unknown {
		const handle = ++this.#next;
		this.scheduled.set(handle, callback);
		return handle;
	}

	clearTimeout(handle: unknown): void {
		this.scheduled.delete(handle);
	}

	/** Fires every scheduled timer (as if the debounce elapsed). */
	fire(): void {
		const callbacks = [...this.scheduled.values()];
		this.scheduled.clear();
		for (const callback of callbacks) callback();
	}
}

describe("protectCode", () => {
	test("round-trips fenced and inline code byte-for-byte while prose is translated", () => {
		const source = [
			"Run `npm test` then check ``a ` b`` output.",
			'```ts title="x"',
			"const x = `tpl`;",
			"```",
			"Prose between.",
			"~~~~",
			"~~~ not a close",
			"~~~~",
			"Final words.",
			"```",
			"unclosed ` body",
		].join("\n");
		// An all-uppercase nonce keeps markers intact under the uppercase "translation".
		const protectedText = protectCode(source, "TESTNONCE");
		expect(protectedText.count).toBe(5);
		for (const code of ["npm test", "a ` b", "const x", "not a close", "unclosed"]) {
			expect(protectedText.text).not.toContain(code);
		}
		expect(protectedText.restore(protectedText.text.toUpperCase())).toBe(
			[
				"RUN `npm test` THEN CHECK ``a ` b`` OUTPUT.",
				'```ts title="x"',
				"const x = `tpl`;",
				"```",
				"PROSE BETWEEN.",
				"~~~~",
				"~~~ not a close",
				"~~~~",
				"FINAL WORDS.",
				"```",
				"unclosed ` body",
			].join("\n"),
		);
	});

	test("restores CRLF fences and leaves unmatched backtick runs literal", () => {
		const fenced = "Intro\r\n```js\r\nlet a = 1;\r\n```\r\nOutro";
		const protectedFence = protectCode(fenced);
		expect(protectedFence.count).toBe(1);
		expect(protectedFence.text).not.toContain("let a");
		expect(protectedFence.restore(protectedFence.text)).toBe(fenced);

		const unmatched = "a ` b `` c";
		const protectedUnmatched = protectCode(unmatched);
		expect(protectedUnmatched.count).toBe(0);
		expect(protectedUnmatched.text).toBe(unmatched);
	});

	/** Protects with an uppercase-safe nonce, "translates" by uppercasing, and restores. */
	function uppercaseRoundTrip(source: string): { count: number; text: string; restored: string } {
		const protectedText = protectCode(source, "TESTNONCE");
		return {
			count: protectedText.count,
			text: protectedText.text,
			restored: protectedText.restore(protectedText.text.toUpperCase()),
		};
	}

	test("protects a tilde fence inside a block quote, prefixes included", () => {
		const source = '> ~~~js\n> const message = "Hola";\n> ~~~\nprose';
		const result = uppercaseRoundTrip(source);
		expect(result.count).toBe(1);
		expect(result.text).not.toContain("message");
		expect(result.text).not.toContain(">");
		expect(result.restored).toBe('> ~~~js\n> const message = "Hola";\n> ~~~\nPROSE');
	});

	test.each([
		["direct list fence", "- ~~~\n  code\n  ~~~\nafter", "- ~~~\n  code\n  ~~~\nAFTER"],
		["list continuation fence", "- item\n\n  ~~~\n  code\n  ~~~", "- ITEM\n\n  ~~~\n  code\n  ~~~"],
		["ordered list fence", "1. ~~~sh\n   echo hola\n   ~~~\n2. done", "1. ~~~sh\n   echo hola\n   ~~~\n2. DONE"],
		[
			"fence in a list inside a quote",
			"> - item\n>\n>   ```\n>   code\n>   ```\n> outro",
			"> - ITEM\n>\n>   ```\n>   code\n>   ```\n> OUTRO",
		],
		["fence in a nested list", "- outer\n  - ~~~\n    code\n    ~~~", "- OUTER\n  - ~~~\n    code\n    ~~~"],
		["quote inside a list", "- note\n  > ```\n  > code\n  > ```", "- NOTE\n  > ```\n  > code\n  > ```"],
	])("keeps a %s verbatim", (_name, source, expected) => {
		const result = uppercaseRoundTrip(source);
		expect(result.count).toBe(1);
		expect(result.text).not.toContain("code");
		expect(result.restored).toBe(expected);
	});

	test.each([
		["quote", "> ~~~\n> code\n\nplain prose", "> ~~~\n> code\n\nPLAIN PROSE"],
		["list", "- ~~~\n  code\n\nplain prose", "- ~~~\n  code\n\nPLAIN PROSE"],
	])("an unclosed %s fence ends with its container so outside prose is translated", (_name, source, expected) => {
		const result = uppercaseRoundTrip(source);
		expect(result.count).toBe(1);
		expect(result.text).toContain("plain prose");
		expect(result.restored).toBe(expected);
	});

	test("a top-level unclosed fence still runs to the end", () => {
		const source = "Intro\n```\nstill code `x`\nmore";
		const result = uppercaseRoundTrip(source);
		expect(result.count).toBe(1);
		expect(result.restored).toBe("INTRO\n```\nstill code `x`\nmore");
	});

	test("escaped backticks open no code span and stay translatable", () => {
		const source = "Di \\`hola\\` ahora";
		const result = uppercaseRoundTrip(source);
		expect(result.count).toBe(0);
		expect(result.text).toBe(source);
		expect(result.restored).toBe("DI \\`HOLA\\` AHORA");
	});

	test("a backtick after an even number of backslashes opens a real span", () => {
		const source = "ruta \\\\`C:\\x` fin";
		const result = uppercaseRoundTrip(source);
		expect(result.count).toBe(1);
		expect(result.text).not.toContain("C:");
		expect(result.restored).toBe("RUTA \\\\`C:\\x` FIN");
	});

	test("the backtick left after an escaped double run opens a span", () => {
		const source = "usa \\``npm ci` ya";
		const result = uppercaseRoundTrip(source);
		expect(result.count).toBe(1);
		expect(result.text).toBe("usa \\`@@OMPT_TESTNONCE_0@@ ya");
		expect(result.restored).toBe("USA \\``npm ci` YA");
	});

	test("a backslash inside code does not escape the closing backtick", () => {
		const source = "abre `C:\\dir\\` luego";
		const result = uppercaseRoundTrip(source);
		expect(result.count).toBe(1);
		expect(result.text).toBe("abre @@OMPT_TESTNONCE_0@@ luego");
		expect(result.restored).toBe("ABRE `C:\\dir\\` LUEGO");
	});

	test("round-trips a nested CRLF fence", () => {
		const source = "> - ```js\r\n>   let a = 1;\r\n>   ```\r\nprose\r\n";
		const result = uppercaseRoundTrip(source);
		expect(result.count).toBe(1);
		expect(result.text).toBe("@@OMPT_TESTNONCE_0@@\nprose\r\n");
		expect(result.restored).toBe("> - ```js\r\n>   let a = 1;\r\n>   ```\r\nPROSE\r\n");
	});

	test("maps offsets past a leading BOM", () => {
		const inline = "\uFEFFUsa `npm test` ahora";
		const inlineResult = uppercaseRoundTrip(inline);
		expect(inlineResult.count).toBe(1);
		expect(inlineResult.text).toBe("\uFEFFUsa @@OMPT_TESTNONCE_0@@ ahora");
		expect(inlineResult.restored).toBe("\uFEFFUSA `npm test` AHORA");

		const fence = "\uFEFF```\ncode\n```\nfin";
		const fenceResult = uppercaseRoundTrip(fence);
		expect(fenceResult.count).toBe(1);
		expect(fenceResult.text).toBe("\uFEFF@@OMPT_TESTNONCE_0@@\nfin");
		expect(fenceResult.restored).toBe("\uFEFF```\ncode\n```\nFIN");
	});

	test("round-trips inline code around Korean and emoji", () => {
		const source = "`ls` 실행 후 🎉 `pwd` 확인 done";
		const result = uppercaseRoundTrip(source);
		expect(result.count).toBe(2);
		expect(result.text).toBe("@@OMPT_TESTNONCE_0@@ 실행 후 🎉 @@OMPT_TESTNONCE_1@@ 확인 done");
		expect(result.restored).toBe("`ls` 실행 후 🎉 `pwd` 확인 DONE");
	});

	test("keeps a tab inside inline code", () => {
		const source = "Text: `a\tb` end";
		const result = uppercaseRoundTrip(source);
		expect(result.count).toBe(1);
		expect(result.text).toBe("Text: @@OMPT_TESTNONCE_0@@ end");
		expect(result.restored).toBe("TEXT: `a\tb` END");
	});

	test("CR-only fence after inline code does not duplicate the prose prefix", () => {
		const source = "before `x`\r~~~\rcode\r~~~";
		expect(protectCode(source, "TESTNONCE").restore(protectCode(source, "TESTNONCE").text)).toBe(source);
		const result = uppercaseRoundTrip(source);
		expect(result.count).toBe(2);
		expect(result.text).not.toContain("code");
		expect(result.restored).toBe("BEFORE `x`\r~~~\rcode\r~~~");
	});

	test("mixed CR, LF and CRLF newlines around a fence are preserved", () => {
		const source = "intro\r~~~\ncode\r\n~~~\routro";
		const protectedText = protectCode(source, "TESTNONCE");
		expect(protectedText.restore(protectedText.text)).toBe(source);
		const result = uppercaseRoundTrip(source);
		expect(result.count).toBe(1);
		expect(result.text).not.toContain("code");
		expect(result.restored).toBe("INTRO\r~~~\ncode\r\n~~~\rOUTRO");
	});

	test.each([
		["two BOMs before a fence", "\uFEFF\uFEFFIntro\n~~~\ncode\n~~~\nfin", "\uFEFF\uFEFFINTRO\n~~~\ncode\n~~~\nFIN", "code"],
		["two BOMs before inline code", "\uFEFF\uFEFFUsa `npm test` ahora", "\uFEFF\uFEFFUSA `npm test` AHORA", "npm test"],
		["three BOMs before inline code", "\uFEFF\uFEFF\uFEFFUsa `npm test` ahora", "\uFEFF\uFEFF\uFEFFUSA `npm test` AHORA", "npm test"],
	])("%s keeps every BOM and protects the code", (_name, source, expected, code) => {
		const protectedText = protectCode(source, "TESTNONCE");
		expect(protectedText.restore(protectedText.text)).toBe(source);
		const result = uppercaseRoundTrip(source);
		expect(result.count).toBe(1);
		expect(result.text).not.toContain(code);
		expect(result.restored).toBe(expected);
	});

	test.each([
		["empty", ""],
		["BOM-only", "\uFEFF"],
	])("%s source has no spans and restores identically", (_name, source) => {
		const protectedText = protectCode(source, "TESTNONCE");
		expect(protectedText.count).toBe(0);
		expect(protectedText.restore(protectedText.text)).toBe(source);
	});

	test("restore rejects missing, duplicated, unknown, and altered markers", () => {
		const protectedText = protectCode("a `x` b `y`", "Q7");
		expect(protectedText.count).toBe(2);
		expect(() => protectedText.restore(protectedText.text.replace("@@OMPT_Q7_1@@", ""))).toThrow(
			MarkerMismatchError,
		);
		expect(() => protectedText.restore(`${protectedText.text} @@OMPT_Q7_0@@`)).toThrow(MarkerMismatchError);
		expect(() => protectedText.restore(`${protectedText.text} @@OMPT_Q7_9@@`)).toThrow(MarkerMismatchError);
		expect(() => protectedText.restore(protectedText.text.replace("@@OMPT_Q7_0@@", "@OMPT_Q7_0@"))).toThrow(
			MarkerMismatchError,
		);
	});

	test("never reuses a nonce that occurs in the source", () => {
		const lookalike = "@@OMPT_abc_0@@";
		const source = `literal ${lookalike} text with \`code\``;
		const protectedText = protectCode(source, "abc");
		expect(protectedText.count).toBe(1);
		expect(protectedText.text.startsWith(`literal ${lookalike} text with `)).toBe(true);
		expect(protectedText.text.split("@@OMPT_abc_")).toHaveLength(2);
		expect(protectedText.restore(protectedText.text)).toBe(source);

		const randomNonce = protectCode(source);
		expect(randomNonce.restore(randomNonce.text)).toBe(source);
	});
});

describe("translateText", () => {
	const systemPrompt = buildRequestPrompt("en");

	test("rejects when the caller fails", async () => {
		const caller = async () => {
			throw new Error("boom");
		};
		await expect(translateText(caller, systemPrompt, "Hola")).rejects.toThrow("boom");
	});

	test("rejects when the model drops a code marker", async () => {
		const caller = async () => "Run it";
		await expect(translateText(caller, systemPrompt, "Ejecuta `ls`")).rejects.toThrow(MarkerMismatchError);
	});

	test("rejects when aborted even if the caller never settles", async () => {
		const controller = new AbortController();
		const signals: AbortSignal[] = [];
		const caller = (call: ModelCall) => {
			signals.push(call.signal);
			return new Promise<string>(() => {});
		};
		const translation = translateText(caller, systemPrompt, "Hola", controller.signal);
		controller.abort(new Error("cancelled"));
		await expect(translation).rejects.toThrow("cancelled");
		expect(signals[0]?.aborted).toBe(true);
	});

	test("restores code around the translated prose", async () => {
		const caller = async ({ text }: ModelCall) => text.replace("Ejecuta", "Run");
		expect(await translateText(caller, systemPrompt, "Ejecuta `ls -la`")).toBe("Run `ls -la`");
	});

	test.each(["この関数を説明して", "Explica esta función"])("sends %p to the caller unfiltered", async source => {
		const seen: string[] = [];
		const caller = async ({ text }: ModelCall) => {
			seen.push(text);
			return "Explain this function";
		};
		expect(await translateText(caller, systemPrompt, source)).toBe("Explain this function");
		expect(seen).toEqual([source]);
	});
});

describe("createModelCaller", () => {
	// Opaque to the fake completer; only passed through.
	const model = { id: "fake-model", provider: "fake", api: "openai-completions" } as unknown as Model<Api>;
	const call: ModelCall = { systemPrompt: "rules", text: "Hola mundo", signal: new AbortController().signal };

	function reply(content: AssistantMessage["content"], stopReason: StopReason = "stop", errorMessage?: string): AssistantMessage {
		return {
			role: "assistant",
			content,
			api: "openai-completions",
			provider: "fake",
			model: "fake-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			errorMessage,
			timestamp: 0,
		};
	}

	function fakeComplete(result: AssistantMessage, contexts: Context[] = []): typeof completeSimple {
		return async (_model, context) => {
			contexts.push(context);
			return result;
		};
	}

	test("rejects when the model did not stop normally", async () => {
		const caller = createModelCaller(model, "key", fakeComplete(reply([], "error", "rate limited")));
		await expect(caller(call)).rejects.toThrow("error rate limited");
	});

	test("rejects empty output", async () => {
		const caller = createModelCaller(model, "key", fakeComplete(reply([{ type: "text", text: "  \n " }])));
		await expect(caller(call)).rejects.toThrow("empty translation");
	});

	test("wraps the source and returns joined, trimmed text blocks", async () => {
		const contexts: Context[] = [];
		const caller = createModelCaller(
			model,
			"key",
			fakeComplete(
				reply([
					{ type: "text", text: "  Hello" },
					{ type: "text", text: " world \n" },
				]),
				contexts,
			),
		);
		expect(await caller(call)).toBe("Hello world");
		expect(contexts[0]?.messages[0]?.content).toBe("<source>\nHola mundo\n</source>");
	});
});

describe("shouldTranslateInput", () => {
	test.each([
		"/translate status",
		"/exit",
		"  !ls",
		"!echo ok",
		"!!echo ok",
		"!echo unsafe",
		'$ print("こんにちは")',
		"$$ print(1)",
		"$\tprint(1)",
		"$\nprint(1)",
		"$$\rprint(1)",
		"->next",
		"=> next",
		"\n  ->next",
		"  $ ls",
		"\t=> next",
		"",
		"   ",
	])("skips %p", text => {
		expect(shouldTranslateInput(text)).toBe(false);
	});

	test.each(["Explain this function, please", "$HOME is set", "$5 is the price", "$$5", "Explain ! and / in this sentence"])(
		"translates %p",
		text => {
			expect(shouldTranslateInput(text)).toBe(true);
		},
	);
});

describe("ThinkingTranslator", () => {
	interface Harness {
		timers: FakeTimers;
		translator: ThinkingTranslator;
		errors: unknown[];
	}

	function harness(cacheLimit?: number): Harness {
		const timers = new FakeTimers();
		const errors: unknown[] = [];
		const translator = new ThinkingTranslator({ timers, cacheLimit, onBackgroundError: error => errors.push(error) });
		return { timers, translator, errors };
	}

	interface Controlled {
		request: ThinkingRequest;
		signals: AbortSignal[];
		deferred: PromiseWithResolvers<string>;
	}

	function controlled(text: string, targetLanguage = "ko", modelKey = "fake/model"): Controlled {
		const signals: AbortSignal[] = [];
		const deferred = Promise.withResolvers<string>();
		const request: ThinkingRequest = {
			modelKey,
			targetLanguage,
			text,
			run: signal => {
				signals.push(signal);
				return deferred.promise;
			},
		};
		return { request, signals, deferred };
	}

	function recorder(): { states: ThinkingViewState[]; view: (state: ThinkingViewState) => void } {
		const states: ThinkingViewState[] = [];
		return { states, view: state => states.push(state) };
	}

	test("keeps results per target language", async () => {
		const { timers, translator } = harness();
		const ko = controlled("Checking the config", "ko");
		const koView = recorder();
		expect(translator.attach(ko.request, koView.view)).toEqual({ kind: "pending" });
		timers.fire();
		ko.deferred.resolve("설정 확인 중");
		await tick();
		expect(koView.states).toEqual([{ kind: "done", text: "설정 확인 중" }]);

		const ja = controlled("Checking the config", "ja");
		const jaView = recorder();
		expect(translator.attach(ja.request, jaView.view)).toEqual({ kind: "pending" });
		expect(translator.attach(ko.request, recorder().view)).toEqual({ kind: "done", text: "설정 확인 중" });
		timers.fire();
		ja.deferred.resolve("設定を確認中");
		await tick();
		expect(jaView.states).toEqual([{ kind: "done", text: "設定を確認中" }]);
		expect(translator.attach(ja.request, recorder().view)).toEqual({ kind: "done", text: "設定を確認中" });
	});

	test("invalidate during a run aborts it, clears views, and drops the late result", async () => {
		const { timers, translator } = harness();
		const entry = controlled("Reading files");
		const view = recorder();
		translator.attach(entry.request, view.view);
		timers.fire();
		expect(entry.signals).toHaveLength(1);

		translator.invalidate();
		expect(translator.generation).toBe(1);
		expect(entry.signals[0]?.aborted).toBe(true);
		expect(view.states).toEqual([{ kind: "cleared" }]);

		entry.deferred.resolve("late result");
		await tick();
		expect(view.states).toEqual([{ kind: "cleared" }]);
		expect(translator.attach(entry.request, recorder().view)).toEqual({ kind: "pending" });
	});

	test("invalidate before the debounce cancels the timer so the run never starts", () => {
		const { timers, translator } = harness();
		const entry = controlled("Planning");
		const view = recorder();
		translator.attach(entry.request, view.view);
		translator.invalidate();
		expect(view.states).toEqual([{ kind: "cleared" }]);
		expect(timers.scheduled.size).toBe(0);
		timers.fire();
		expect(entry.signals).toHaveLength(0);
	});

	test("delivers the result to every view attached to the same entry", async () => {
		const { timers, translator } = harness();
		const entry = controlled("Same text");
		const first = recorder();
		const second = recorder();
		translator.attach(entry.request, first.view);
		translator.attach(entry.request, second.view);
		timers.fire();
		expect(entry.signals).toHaveLength(1);
		entry.deferred.resolve("같은 텍스트");
		await tick();
		expect(first.states).toEqual([{ kind: "done", text: "같은 텍스트" }]);
		expect(second.states).toEqual([{ kind: "done", text: "같은 텍스트" }]);
	});

	test("a throwing view is reported and does not block other views", async () => {
		const { timers, translator, errors } = harness();
		const entry = controlled("Fragile");
		const failure = new Error("view broke");
		const healthy = recorder();
		translator.attach(entry.request, () => {
			throw failure;
		});
		translator.attach(entry.request, healthy.view);
		timers.fire();
		entry.deferred.resolve("done");
		await tick();
		expect(healthy.states).toEqual([{ kind: "done", text: "done" }]);
		expect(errors).toEqual([failure]);
	});

	test("caches failures without re-running", async () => {
		const { timers, translator, errors } = harness();
		const entry = controlled("Will fail");
		const view = recorder();
		translator.attach(entry.request, view.view);
		timers.fire();
		entry.deferred.reject(new Error("quota exceeded"));
		await tick();
		expect(view.states).toEqual([{ kind: "failed", error: "quota exceeded" }]);
		expect(translator.attach(entry.request, recorder().view)).toEqual({ kind: "failed", error: "quota exceeded" });
		expect(timers.scheduled.size).toBe(0);
		expect(entry.signals).toHaveLength(1);
		expect(errors).toEqual([]);
	});

	test("a synchronously throwing run becomes a failed state", async () => {
		const { timers, translator } = harness();
		const view = recorder();
		translator.attach(
			{
				modelKey: "fake/model",
				targetLanguage: "ko",
				text: "Sync",
				run: () => {
					throw new Error("no credentials");
				},
			},
			view.view,
		);
		timers.fire();
		await tick();
		expect(view.states).toEqual([{ kind: "failed", error: "no credentials" }]);
	});

	test.each([
		["prefix first", ["Let me think", "Let me think about this"]],
		["prefix second", ["Let me think about this", "Let me think"]],
	] as const)("prefix-related texts are independent requests (%s)", async (_label, order) => {
		const { timers, translator } = harness();
		const entries = order.map(text => ({ c: controlled(text), r: recorder() }));
		for (const { c, r } of entries) expect(translator.attach(c.request, r.view)).toEqual({ kind: "pending" });
		timers.fire();
		for (const { c } of entries) expect(c.signals).toHaveLength(1);
		for (const { c } of entries) c.deferred.resolve(`T:${c.request.text}`);
		await tick();
		for (const { c, r } of entries) expect(r.states).toEqual([{ kind: "done", text: `T:${c.request.text}` }]);
	});

	test("evicts the oldest cached result beyond the cache limit", async () => {
		const { timers, translator } = harness(1);
		const first = controlled("First");
		const second = controlled("Second");
		translator.attach(first.request, recorder().view);
		translator.attach(second.request, recorder().view);
		timers.fire();
		first.deferred.resolve("하나");
		second.deferred.resolve("둘");
		await tick();
		expect(translator.attach(second.request, recorder().view)).toEqual({ kind: "done", text: "둘" });
		expect(translator.attach(first.request, recorder().view)).toEqual({ kind: "pending" });
	});
});
