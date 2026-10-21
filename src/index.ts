import path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { TranslationSettings } from "./settings.ts";
import {
	canonicalizeLanguageTag,
	isConfigured,
	requestModelSelector,
	SETTINGS_FILE_NAME,
	SettingsStore,
	thinkingModelSelector,
} from "./settings.ts";
import type { ModelCaller, ThinkingRequest, ThinkingViewState, TimerHost } from "./translation.ts";
import {
	ANSWER_TRANSLATION_TIMEOUT_MS,
	buildAnswerPrompt,
	buildRequestPrompt,
	buildThinkingPrompt,
	createModelCaller,
	describeLanguage,
	finalAnswerText,
	shouldTranslateInput,
	ThinkingTranslator,
	translateRetrying,
} from "./translation.ts";

export interface TranslateExtensionDeps {
	/** Default: path.join(getAgentDir(), SETTINGS_FILE_NAME), evaluated once at factory time. */
	settingsPath?: string;
	/** Default: createModelCaller(model, ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId())). */
	createCaller?: (model: Model<Api>, ctx: ExtensionContext) => ModelCaller;
	/** Default: process.stderr.write. Used for the one-time setup instruction in print/json modes. */
	writeStderr?: (line: string) => void;
	/** Settings store writer override (tests). */
	writeFile?: (path: string, data: string) => Promise<void>;
}

type ManagedTimer = { owner: ExtensionContext; timer: Timer };

const LANGUAGE_CHOICES: readonly { label: string; tag: string }[] = [
	{ label: "English (en)", tag: "en" },
	{ label: "한국어 (ko)", tag: "ko" },
	{ label: "日本語 (ja)", tag: "ja" },
	{ label: "简体中文 (zh-Hans)", tag: "zh-Hans" },
	{ label: "繁體中文 (zh-Hant)", tag: "zh-Hant" },
	{ label: "Español (es)", tag: "es" },
	{ label: "Français (fr)", tag: "fr" },
	{ label: "Deutsch (de)", tag: "de" },
	{ label: "Português (pt)", tag: "pt" },
];
const CUSTOM_LANGUAGE_LABEL = "Custom language tag";
const SETUP_TITLE = "omp-translate: choose a language for translated thinking";
const QUOTA_NOTICE =
	"omp-translate sends completed thinking and enabled answer translations to your selected translation model's provider, which uses its quota.";

/** Custom message type of answer translations; shown as the box header and filtered from every provider request. */
export const ANSWER_CUSTOM_TYPE = "omp-translate";

/** Custom message type of completed-thinking translations; shown as the box header and filtered from every provider request. */
export const THINKING_CUSTOM_TYPE = "omp-translate-thinking";

/** Poll interval while a ready thinking translation waits for the agent to become idle. */
const THINKING_IDLE_POLL_MS = 250;

const COMMAND_DESCRIPTION =
	"Translate thinking, answers, and prompts: status, setup, thinking, answer, request, language, request-language, model, request-model";
const USAGE = {
	status: "/translate [status]",
	setup: "/translate setup",
	thinking: "/translate thinking on|off",
	answer: "/translate answer on|off",
	request: "/translate request on|off",
	language: "/translate language <BCP-47 tag>",
	"request-language": "/translate request-language <BCP-47 tag>",
	model: "/translate model <selector|clear>",
	"request-model": "/translate request-model <selector|clear>",
};
const COMPLETIONS: readonly string[] = [
	"status",
	"setup",
	"thinking on",
	"thinking off",
	"request on",
	"request off",
	"answer on",
	"answer off",
	"language ",
	"request-language ",
	"model ",
	"model clear",
	"request-model ",
	"request-model clear",
	...LANGUAGE_CHOICES.map(choice => `language ${choice.tag}`),
	...LANGUAGE_CHOICES.map(choice => `request-language ${choice.tag}`),
];

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function defaultCreateCaller(model: Model<Api>, ctx: ExtensionContext): ModelCaller {
	return createModelCaller(model, ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId()));
}

export function createTranslateExtension(deps: TranslateExtensionDeps = {}): (pi: ExtensionAPI) => void {
	return pi => {
		const createCaller = deps.createCaller ?? defaultCreateCaller;
		const writeStderr = deps.writeStderr ?? ((line: string) => void process.stderr.write(line));
		const store = new SettingsStore({
			path: deps.settingsPath ?? path.join(getAgentDir(), SETTINGS_FILE_NAME),
			zod: pi.zod,
			writeFile: deps.writeFile,
		});
		const initialLoad = store.load();

		/** Main-agent context of the active session; undefined before session_start and after session_shutdown. */
		let boundCtx: ExtensionContext | undefined;
		let setupDismissed = false;
		let setupActive = false;
		let instructionShown = false;
		const inputControllers = new Set<AbortController>();
		const answerControllers = new Set<AbortController>();
		/** Answer translations finished while the agent was busy; posted at the next idle main agent_end. */
		let heldAnswers: { epoch: number; text: string; targetLanguage: string }[] = [];
		/** Bumped whenever the active main session changes or ends; in-flight prompt/answer translations compare against it. */
		let sessionEpoch = 0;
		let thinkingRefused = false;
		let answerFallback = false;
		/** Latest completed answer awaiting a possible late thinking refusal. Consumed once. */
		let fallbackAnswer: { text: string; ctx: ExtensionContext } | undefined;

		type ThinkingOutput = {
			epoch: number;
			generation: number;
			targetLanguage: string;
			state: ThinkingViewState;
		};
		/** Completed-thinking translations in completion/block order; posted from the head only while idle. */
		let thinkingOutputs: ThinkingOutput[] = [];
		let thinkingDrainTimer: ManagedTimer | undefined;

		const timers: TimerHost = {
			setTimeout(callback, ms) {
				const owner = boundCtx;
				if (!owner) throw new Error("omp-translate: no active session");
				const handle: ManagedTimer = { owner, timer: owner.setTimeout(callback, ms) };
				return handle;
			},
			clearTimeout(handle) {
				const managed = handle as ManagedTimer;
				managed.owner.clearTimer(managed.timer);
			},
		};
		const reportBackgroundError = (error: unknown) => {
			pi.logger.warn("omp-translate: background error", { error: errorMessage(error) });
		};
		const translator = new ThinkingTranslator({ timers, onBackgroundError: reportBackgroundError });

		function cancelThinkingDrain(): void {
			const handle = thinkingDrainTimer;
			thinkingDrainTimer = undefined;
			if (handle) handle.owner.clearTimer(handle.timer);
		}

		/** Drops unposted thinking translations, the idle drain, and every pending/cached translation. */
		function resetTranslations(): void {
			thinkingOutputs = [];
			cancelThinkingDrain();
			translator.invalidate();
		}

		/** Marks in-flight prompt/answer translations stale, aborts them, and drops held answers and thinking translations. */
		function invalidateSessionWork(): void {
			sessionEpoch++;
			thinkingRefused = false;
			answerFallback = false;
			fallbackAnswer = undefined;
			for (const controller of inputControllers) controller.abort();
			inputControllers.clear();
			for (const controller of answerControllers) controller.abort();
			answerControllers.clear();
			heldAnswers = [];
			resetTranslations();
		}

		const invalidSettingsMessage = () => `omp-translate: ${store.error ?? `settings are not loaded (${store.path})`}`;
		const instruction = `omp-translate: no target language selected. Run "/translate language <BCP-47 tag>" or set "targetLanguage" in ${store.path}.`;

		/** Visible message: stderr line in print/json (where ui.notify is a no-op), otherwise a notification. */
		function report(ctx: ExtensionContext, message: string, type: "info" | "error"): void {
			if (ctx.mode === "print" || ctx.mode === "json") writeStderr(`${message}\n`);
			else ctx.ui.notify(message, type);
		}

		async function runSetup(ctx: ExtensionContext): Promise<void> {
			if (setupActive) return;
			setupActive = true;
			try {
				ctx.ui.notify(QUOTA_NOTICE, "info");
				const label = await ctx.ui.select(SETUP_TITLE, [
					...LANGUAGE_CHOICES.map(choice => choice.label),
					CUSTOM_LANGUAGE_LABEL,
				]);
				if (label === undefined) {
					setupDismissed = true;
					return;
				}
				let tag = LANGUAGE_CHOICES.find(choice => choice.label === label)?.tag;
				if (label === CUSTOM_LANGUAGE_LABEL) {
					while (tag === undefined) {
						const input = await ctx.ui.input("Enter a BCP-47 language tag", "e.g. pt-BR, sr-Latn");
						if (input === undefined) {
							setupDismissed = true;
							return;
						}
						tag = canonicalizeLanguageTag(input);
						if (tag === undefined) ctx.ui.notify(`Invalid language tag: "${input}"`, "error");
					}
				}
				if (tag === undefined) return;
				try {
					await store.update({ targetLanguage: tag });
				} catch (error) {
					if (store.settings === undefined) resetTranslations();
					ctx.ui.notify(`omp-translate: could not save settings: ${errorMessage(error)}`, "error");
					return;
				}
				resetTranslations();
				ctx.ui.notify(`Thinking translations will be shown in ${describeLanguage(tag)}.`, "info");
			} finally {
				setupActive = false;
			}
		}

		function startAutomaticSetup(ctx: ExtensionContext): void {
			if (ctx.mode === "tui") {
				if (setupDismissed || setupActive) return;
				runSetup(ctx).catch(error => {
					ctx.ui.notify(`omp-translate: setup failed: ${errorMessage(error)}`, "error");
				});
				return;
			}
			if (instructionShown) return;
			instructionShown = true;
			report(ctx, instruction, "info");
		}

		function thinkingRequest(ctx: ExtensionContext, settings: TranslationSettings, text: string): ThinkingRequest {
			const selector = thinkingModelSelector(settings);
			const targetLanguage = settings.targetLanguage;
			const model = ctx.models.resolve(selector);
			if (!model) {
				return {
					modelKey: `unresolved:${selector}`,
					targetLanguage,
					text,
					run: () => Promise.reject(new Error(`Model not found: ${selector}`)),
				};
			}
			const systemPrompt = buildThinkingPrompt(targetLanguage);
			return {
				modelKey: `${model.provider}/${model.id}`,
				targetLanguage,
				text,
				run: signal => translateRetrying(createCaller(model, ctx), systemPrompt, text, targetLanguage, signal),
			};
		}

		const isCurrentThinking = (item: ThinkingOutput): boolean =>
			item.epoch === sessionEpoch && item.generation === translator.generation;

		/** Single idle-drain timer: re-flushes shortly so a ready result posts once the agent goes idle. */
		function scheduleThinkingDrain(): void {
			if (thinkingDrainTimer) return;
			const owner = boundCtx;
			if (!owner) return;
			const epoch = sessionEpoch;
			const generation = translator.generation;
			thinkingDrainTimer = {
				owner,
				timer: owner.setTimeout(() => {
					thinkingDrainTimer = undefined;
					try {
						if (epoch === sessionEpoch && generation === translator.generation) flushThinkingOutputs();
					} catch (error) {
						reportBackgroundError(error);
					}
				}, THINKING_IDLE_POLL_MS),
			};
		}

		/** Posts ready thinking translations in order while idle; failures warn; stale slots are dropped. */
		function flushThinkingOutputs(): void {
			while (thinkingOutputs.length > 0) {
				const ctx = boundCtx;
				const item = thinkingOutputs[0]!;
				if (!ctx || !isCurrentThinking(item)) {
					thinkingOutputs.shift();
					continue;
				}
				const state = item.state;
				if (state.kind === "pending") break;
				if (state.kind === "cleared") {
					thinkingOutputs.shift();
					continue;
				}
				if (state.kind === "failed") {
					thinkingOutputs.shift();
					ctx.ui.notify(`Thinking translation failed: ${state.error}`, "warning");
					continue;
				}
				const settings = store.settings;
				if (!settings || !settings.thinking || !isConfigured(settings)) {
					thinkingOutputs.shift();
					continue;
				}
				if (!ctx.isIdle()) {
					scheduleThinkingDrain();
					return;
				}
				thinkingOutputs.shift();
				try {
					pi.sendMessage(
						{
							customType: THINKING_CUSTOM_TYPE,
							content: state.text,
							display: true,
							details: { targetLanguage: item.targetLanguage },
						},
						{ deliverAs: "nextTurn", triggerTurn: false },
					);
				} catch (error) {
					ctx.ui.notify(`Thinking translation could not be posted: ${errorMessage(error)}`, "warning");
				}
			}
			cancelThinkingDrain();
		}

		/** Queues one completed thinking block; the translation result is applied to its slot and flushed in order. */
		function enqueueThinking(text: string, ctx: ExtensionContext, settings: TranslationSettings): void {
			const item: ThinkingOutput = {
				epoch: sessionEpoch,
				generation: translator.generation,
				targetLanguage: settings.targetLanguage,
				state: { kind: "pending" },
			};
			thinkingOutputs.push(item);
			const update = (state: ThinkingViewState): void => {
				if (!isCurrentThinking(item)) return;
				if (state.kind === "failed" && /\bRefusal\s*\(reasoning_extraction\)/i.test(state.error)) {
					thinkingRefused = true;
					answerFallback = true;
					resetTranslations();
					ctx.ui.notify(
						"Thinking translation paused for this session: the provider refused reasoning extraction. Final-answer translation is now enabled for this session; use /translate answer off to disable it. Saved settings are unchanged.",
						"warning",
					);
					const answer = fallbackAnswer;
					fallbackAnswer = undefined;
					const current = store.settings;
					if (answer && current && isConfigured(current)) startAnswerTranslation(answer.text, answer.ctx, current);
					return;
				}
				item.state = state;
				flushThinkingOutputs();
			};
			let initial: ThinkingViewState;
			try {
				initial = translator.attach(thinkingRequest(ctx, settings, text), update);
			} catch (error) {
				initial = { kind: "failed", error: errorMessage(error) };
			}
			update(initial);
		}

		function modelLine(ctx: ExtensionContext, selector: string): string {
			const model = ctx.models.resolve(selector);
			return model ? `${selector} → ${model.provider}/${model.id}` : `${selector} (unresolved)`;
		}

		function showStatus(ctx: ExtensionContext): void {
			const settings = store.settings;
			if (!settings) {
				ctx.ui.notify(invalidSettingsMessage(), "error");
				return;
			}
			const target = isConfigured(settings) ? describeLanguage(settings.targetLanguage) : "not selected";
			ctx.ui.notify(
				[
					`Thinking translation: ${thinkingRefused ? "paused (provider refusal, this session)" : settings.thinking ? "on" : "off"}`,
					`Answer translation: ${settings.answer || answerFallback ? "on" : "off"}${answerFallback ? " (session fallback)" : ""}`,
					`Prompt translation: ${settings.request ? "on" : "off"}`,
					`Target language: ${target}`,
					`Request language: ${describeLanguage(settings.requestLanguage)}`,
					`Model: ${modelLine(ctx, thinkingModelSelector(settings))}${settings.model ? "" : " (default)"}`,
					`Request model: ${modelLine(ctx, requestModelSelector(settings))}${settings.requestModel ? "" : " (inherits model)"}`,
					`Settings file: ${store.path}`,
				].join("\n"),
				"info",
			);
		}

		async function applyPatch(ctx: ExtensionContext, patch: Partial<TranslationSettings>): Promise<void> {
			try {
				await store.update(patch);
			} catch (error) {
				if (store.settings === undefined) resetTranslations();
				ctx.ui.notify(`omp-translate: could not save settings: ${errorMessage(error)}`, "error");
				return;
			}
			if (patch.answer !== undefined) answerFallback = false;
			fallbackAnswer = undefined;
			resetTranslations();
			showStatus(ctx);
		}

		function usage(ctx: ExtensionContext, sub: keyof typeof USAGE): void {
			ctx.ui.notify(`Usage: ${USAGE[sub]}`, "warning");
		}

		async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
			if (ctx.agent.kind !== "main") return;
			await initialLoad;
			if (store.error !== undefined) await store.load();
			const [sub = "status", ...operands] = args.trim().split(/\s+/).filter(word => word !== "");
			switch (sub) {
				case "status":
				case "setup": {
					if (operands.length > 0) return usage(ctx, sub);
					if (sub === "status") return showStatus(ctx);
					if (!store.settings) return ctx.ui.notify(invalidSettingsMessage(), "error");
					if (ctx.mode !== "tui") return report(ctx, instruction, "info");
					return runSetup(ctx);
				}
				case "thinking":
				case "answer":
				case "request": {
					const [value] = operands;
					if (operands.length !== 1 || (value !== "on" && value !== "off")) return usage(ctx, sub);
					const on = value === "on";
					return applyPatch(ctx, sub === "thinking" ? { thinking: on } : sub === "answer" ? { answer: on } : { request: on });
				}
				case "language":
				case "request-language": {
					const [value] = operands;
					if (operands.length !== 1 || value === undefined) return usage(ctx, sub);
					const tag = canonicalizeLanguageTag(value);
					if (tag === undefined) return ctx.ui.notify(`Invalid language tag: "${value}"`, "error");
					return applyPatch(ctx, sub === "language" ? { targetLanguage: tag } : { requestLanguage: tag });
				}
				case "model":
				case "request-model": {
					const [value] = operands;
					if (operands.length !== 1 || value === undefined) return usage(ctx, sub);
					const selector = value === "clear" ? "" : value;
					if (selector !== "" && !ctx.models.resolve(selector)) {
						return ctx.ui.notify(`Model not found: ${selector}`, "error");
					}
					return applyPatch(ctx, sub === "model" ? { model: selector } : { requestModel: selector });
				}
				default:
					ctx.ui.notify(
						[`Unknown subcommand "${sub}". Usage:`, ...Object.values(USAGE)].join("\n"),
						"warning",
					);
			}
		}

		pi.on("session_start", async (_event, ctx) => {
			if (ctx.agent.kind !== "main") return;
			boundCtx = ctx;
			await initialLoad;
			if (boundCtx !== ctx) return;
			const settings = store.settings;
			if (!settings) {
				report(ctx, invalidSettingsMessage(), "error");
				return;
			}
			if (!isConfigured(settings)) startAutomaticSetup(ctx);
		});

		pi.on("session_switch", (_event, ctx) => {
			if (ctx.agent.kind !== "main") return;
			invalidateSessionWork();
			boundCtx = ctx;
		});

		pi.on("session_branch", (_event, ctx) => {
			if (ctx.agent.kind !== "main") return;
			invalidateSessionWork();
			boundCtx = ctx;
		});

		pi.on("session_shutdown", (_event, ctx) => {
			if (ctx.agent.kind !== "main") return;
			invalidateSessionWork();
			boundCtx = undefined;
		});

		// Synchronous: completed thinking is queued; translation and posting happen in the background.
		pi.on("message_end", (event, ctx) => {
			try {
				if (ctx.agent.kind !== "main" || ctx.mode !== "tui" || !boundCtx) return;
				const settings = store.settings;
				if (!settings || !settings.thinking || thinkingRefused || !isConfigured(settings)) return;
				const message = event.message;
				if (message.role !== "assistant") return;
				for (const block of message.content) {
					if (block.type === "thinking" && block.thinking.trim() !== "") enqueueThinking(block.thinking, ctx, settings);
				}
			} catch (error) {
				reportBackgroundError(error);
			}
		});

		pi.on("input", async (event, ctx) => {
			if (ctx.agent.kind !== "main") return undefined;
			const epoch = sessionEpoch;
			const sessionId = ctx.sessionManager.getSessionId();
			const isStale = (): boolean => epoch !== sessionEpoch || ctx.sessionManager.getSessionId() !== sessionId;
			/** Consumes input whose session ended or changed, so neither original nor translation is submitted. */
			const discardStaleInput = (): { handled: true } => {
				boundCtx?.ui.notify("Prompt translation discarded: session changed; resend", "warning");
				return { handled: true };
			};
			await initialLoad;
			if (isStale()) return discardStaleInput();
			const settings = store.settings;
			if (!settings || !settings.request || !shouldTranslateInput(event.text)) return undefined;
			const selector = requestModelSelector(settings);
			const model = ctx.models.resolve(selector);
			if (!model) {
				ctx.ui.notify(`Prompt translation skipped; model not found: ${selector}`, "warning");
				return undefined;
			}
			const controller = new AbortController();
			inputControllers.add(controller);
			try {
				const text = await translateRetrying(
					createCaller(model, ctx),
					buildRequestPrompt(settings.requestLanguage),
					event.text,
					settings.requestLanguage,
					controller.signal,
				);
				if (isStale() || controller.signal.aborted) return discardStaleInput();
				if (!shouldTranslateInput(text)) {
					ctx.ui.notify("Prompt translation skipped: result looked like a host command; sending original", "warning");
					return undefined;
				}
				return { text };
			} catch (error) {
				if (isStale() || controller.signal.aborted) return discardStaleInput();
				ctx.ui.notify(`Prompt translation failed; sending original: ${errorMessage(error)}`, "warning");
				return undefined;
			} finally {
				inputControllers.delete(controller);
			}
		});

		/** Posts a display-only translation; idle-only, no options, so it never steers or starts a turn. */
		function postAnswer(text: string, targetLanguage: string): void {
			pi.sendMessage({ customType: ANSWER_CUSTOM_TYPE, content: text, display: true, details: { targetLanguage } });
		}

		/** Posts translations that finished while a newer run was streaming, in order, if the agent is idle. */
		function flushHeldAnswers(ctx: ExtensionContext): void {
			if (!ctx.isIdle()) return;
			const held = heldAnswers;
			heldAnswers = [];
			for (const answer of held) {
				if (answer.epoch === sessionEpoch) postAnswer(answer.text, answer.targetLanguage);
			}
		}

		function startAnswerTranslation(text: string, ctx: ExtensionContext, settings: TranslationSettings): void {
			const selector = thinkingModelSelector(settings);
			const model = ctx.models.resolve(selector);
			if (!model) {
				ctx.ui.notify(`Answer translation skipped; model not found: ${selector}`, "warning");
				return;
			}
			const epoch = sessionEpoch;
			const targetLanguage = settings.targetLanguage;
			const controller = new AbortController();
			answerControllers.add(controller);
			const isStale = (): boolean => epoch !== sessionEpoch || controller.signal.aborted;
			translateRetrying(
				createCaller(model, ctx),
				buildAnswerPrompt(targetLanguage),
				text,
				targetLanguage,
				controller.signal,
				ANSWER_TRANSLATION_TIMEOUT_MS,
			)
				.then(translated => {
					if (isStale() || (!store.settings?.answer && !answerFallback) || translated.trim() === text) return;
					if (ctx.isIdle()) postAnswer(translated, targetLanguage);
					else heldAnswers.push({ epoch, text: translated, targetLanguage });
				})
				.catch(error => {
					if (isStale()) return;
					ctx.ui.notify(`Answer translation failed: ${errorMessage(error)}`, "warning");
				})
				.finally(() => {
					answerControllers.delete(controller);
				});
		}

		// Synchronous: the translation runs in the background so the 30 s handler timeout never applies.
		pi.on("agent_end", (event, ctx) => {
			if (ctx.agent.kind !== "main" || ctx.mode !== "tui") return;
			flushThinkingOutputs();
			flushHeldAnswers(ctx);
			if (event.willContinue === true) return;
			fallbackAnswer = undefined;
			const settings = store.settings;
			if (!settings || !isConfigured(settings)) return;
			const text = finalAnswerText(event.messages);
			if (text === undefined) return;
			if (settings.answer || answerFallback) startAnswerTranslation(text, ctx, settings);
			else if (settings.thinking && !thinkingRefused) fallbackAnswer = { text, ctx };
		});

		// Unconditional: translations are display-only and must never reach any provider request.
		pi.on("context", event => {
			const kept = event.messages.filter(
				message =>
					!(
						message.role === "custom" &&
						(message.customType === ANSWER_CUSTOM_TYPE || message.customType === THINKING_CUSTOM_TYPE)
					),
			);
			return kept.length === event.messages.length ? undefined : { messages: kept };
		});

		pi.registerCommand("translate", {
			description: COMMAND_DESCRIPTION,
			getArgumentCompletions: prefix => {
				const items = COMPLETIONS.filter(value => value.startsWith(prefix)).map(value => ({
					value,
					label: value,
				}));
				return items.length > 0 ? items : null;
			},
			handler: handleCommand,
		});
	};
}

export default function translateExtension(pi: ExtensionAPI): void {
	createTranslateExtension()(pi);
}
