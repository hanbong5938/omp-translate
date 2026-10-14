import path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
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
	buildRequestPrompt,
	buildThinkingPrompt,
	createModelCaller,
	describeLanguage,
	shouldTranslateInput,
	ThinkingTranslator,
	translateText,
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
	"omp-translate sends visible thinking to your selected translation model's provider, which uses its quota.";

const COMMAND_DESCRIPTION =
	"Translate thinking and prompts: status, setup, thinking, request, language, request-language, model, request-model";
const USAGE = {
	status: "/translate [status]",
	setup: "/translate setup",
	thinking: "/translate thinking on|off",
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

function renderState(state: ThinkingViewState, theme: Theme): string {
	switch (state.kind) {
		case "pending":
			return theme.fg("dim", "Translating…");
		case "done":
			return theme.fg("dim", state.text);
		case "failed":
			return theme.fg("dim", `(translation failed: ${state.error})`);
		case "cleared":
			return "";
	}
}

/** Dead weak refs are pruned whenever the tracked set reaches this size. */
const MOUNTED_PRUNE_THRESHOLD = 256;

/**
 * Weakly tracks mounted translation components so settings changes and shutdown can blank every one of them,
 * including completed ones. The host discards rebuilt components without notice, so nothing here keeps them alive.
 */
class MountedViews {
	readonly #refs = new Set<WeakRef<Text>>();
	readonly #clearers = new WeakMap<Text, () => void>();
	readonly #onError: (error: unknown) => void;

	constructor(onError: (error: unknown) => void) {
		this.#onError = onError;
	}

	track(view: Text, clear: () => void): void {
		if (this.#refs.size >= MOUNTED_PRUNE_THRESHOLD) {
			for (const ref of this.#refs) if (ref.deref() === undefined) this.#refs.delete(ref);
		}
		this.#refs.add(new WeakRef(view));
		this.#clearers.set(view, clear);
	}

	/** Blanks every live tracked component, then forgets them all (a host rebuild re-invokes the renderer). */
	clearAll(): void {
		const refs = [...this.#refs];
		this.#refs.clear();
		for (const ref of refs) {
			const view = ref.deref();
			if (view === undefined) continue;
			const clear = this.#clearers.get(view);
			this.#clearers.delete(view);
			try {
				clear?.();
			} catch (error) {
				this.#onError(error);
			}
		}
	}
}

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
		/** Bumped whenever the active main session changes or ends; in-flight prompt translations compare against it. */
		let sessionEpoch = 0;

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
		const mountedViews = new MountedViews(reportBackgroundError);

		/** Drops every pending/cached translation and blanks every mounted component (pending, done, failed). */
		function resetTranslations(): void {
			translator.invalidate();
			mountedViews.clearAll();
		}

		/** Marks in-flight prompt translations stale, aborts them, and drops thinking translations. */
		function invalidateSessionWork(): void {
			sessionEpoch++;
			for (const controller of inputControllers) controller.abort();
			inputControllers.clear();
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
				run: signal => translateText(createCaller(model, ctx), systemPrompt, text, signal),
			};
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
					`Thinking translation: ${settings.thinking ? "on" : "off"}`,
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
				ctx.ui.notify(`omp-translate: could not save settings: ${errorMessage(error)}`, "error");
				return;
			}
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
				case "request": {
					const [value] = operands;
					if (operands.length !== 1 || (value !== "on" && value !== "off")) return usage(ctx, sub);
					return applyPatch(ctx, sub === "thinking" ? { thinking: value === "on" } : { request: value === "on" });
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

		pi.registerAssistantThinkingRenderer((rc, theme) => {
			const ctx = boundCtx;
			const settings = store.settings;
			if (!ctx || !settings || !settings.thinking || !isConfigured(settings) || !rc.text.trim()) return undefined;
			const view = new Text("", 1, 0);
			const initial = translator.attach(thinkingRequest(ctx, settings, rc.text), state => {
				view.setText(renderState(state, theme));
				rc.requestRender();
			});
			view.setText(renderState(initial, theme));
			mountedViews.track(view, () => {
				view.setText("");
				rc.requestRender();
			});
			return view;
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
				const text = await translateText(
					createCaller(model, ctx),
					buildRequestPrompt(settings.requestLanguage),
					event.text,
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
