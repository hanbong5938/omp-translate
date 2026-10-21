# omp-translate

**English** | [한국어](docs/README.ko.md) | [日本語](docs/README.ja.md) | [简体中文](docs/README.zh-Hans.md) | [繁體中文](docs/README.zh-Hant.md) | [Español](docs/README.es.md) | [Français](docs/README.fr.md) | [Deutsch](docs/README.de.md) | [Português](docs/README.pt.md)

Version 0.1.7 — a language-neutral translation extension for OMP (the oh-my-pi coding agent).

## Overview

- **Thinking translation**: each completed assistant thinking block is translated into a display language you choose and shown in the TUI as a separate `omp-translate-thinking` message. The original thinking and the provider context are never modified.
- **Answer translation** (optional, off by default): each completed main-agent final answer gets a separate translated `omp-translate` box in the TUI. The original answer stays unchanged; the translation is excluded from future model requests while this extension is loaded.
- **Prompt translation** (optional, off by default): outgoing prompts are translated into a request language (default English) before they are sent.

Source text can be in any language, including mixed-language text. The target can be any valid BCP-47 language tag.

## Requirements

- OMP (tested with 18.10.4)
- Bun
- A model configured and authenticated in OMP

## Installation

### Local development (link)

To link a local checkout:

```sh
omp plugin link /path/to/omp-translate
```

### Local marketplace

The repository includes a marketplace catalog at `.omp-plugin/marketplace.json`:

```sh
omp plugin marketplace add /path/to/omp-translate
omp plugin discover omp-translate
omp plugin install omp-translate@omp-translate
omp plugin list
```

### Hosted repository

The plugin is published at [hanbong5938/omp-translate](https://github.com/hanbong5938/omp-translate). It is not listed in any default catalog, so add the repository as a marketplace, then install:

```sh
omp plugin marketplace add hanbong5938/omp-translate
omp plugin install omp-translate@omp-translate
```

## First run

In the interactive TUI (main session only), a language picker appears once:

| Label | Tag |
|---|---|
| English (en) | `en` |
| 한국어 (ko) | `ko` |
| 日本語 (ja) | `ja` |
| 简体中文 (zh-Hans) | `zh-Hans` |
| 繁體中文 (zh-Hant) | `zh-Hant` |
| Español (es) | `es` |
| Français (fr) | `fr` |
| Deutsch (de) | `de` |
| Português (pt) | `pt` |
| Custom language tag | any BCP-47 tag, canonicalized with `Intl.getCanonicalLocales` |

- If you cancel, translation stays inactive and you are not asked again in this session. Run `/translate setup` later to choose a language.
- Prompt translation stays off until you turn it on with `/translate request on`.
- Answer translation is off by default. Enable it with `/translate answer on`; a reasoning-extraction refusal also enables it temporarily for the session.
- Non-interactive modes (`print`, `json`, `rpc`) and subagents never show dialogs. In `print`/`json` modes a one-line setup instruction is written to stderr. In `rpc` mode a notification is sent instead.

## Commands

| Command | Effect |
|---|---|
| `/translate` or `/translate status` | Show current settings and status |
| `/translate setup` | Open the language picker |
| `/translate thinking on\|off` | Turn thinking translation on or off |
| `/translate answer on\|off` | Turn final-answer translation on or off |
| `/translate request on\|off` | Turn prompt translation on or off |
| `/translate language <tag>` | Set the display language, e.g. `/translate language pt-BR` |
| `/translate request-language <tag>` | Set the request language, e.g. `/translate request-language en` |
| `/translate model <selector\|clear>` | Set the translation model, e.g. `/translate model provider/model` or `/translate model @role`. `clear` restores the default |
| `/translate request-model <selector\|clear>` | Set a separate model for prompt translation. `clear` makes it use `model` again |

Missing or extra operands, invalid language tags, and model selectors that can't be resolved are rejected with an error. Nothing is saved in that case.

## Settings file

Settings are stored in `<agent dir>/omp-translate.json`. The default location is `~/.omp/agent/omp-translate.json`, and the path follows OMP profiles and `PI_CONFIG_DIR`.

| Key | Default | Meaning |
|---|---|---|
| `thinking` | `true` | Translate thinking blocks |
| `request` | `false` | Translate outgoing prompts |
| `answer` | `false` | Translate completed main-agent final answers in the TUI |
| `targetLanguage` | `""` | Display language (`""` = not configured yet) |
| `requestLanguage` | `"en"` | Language prompts are translated into (must be non-empty) |
| `model` | `""` | Translation model selector (`""` = default) |
| `requestModel` | `""` | Prompt translation model (`""` = use `model`) |

```json
{
  "thinking": true,
  "request": true,
  "answer": false,
  "targetLanguage": "ja",
  "requestLanguage": "en",
  "model": "",
  "requestModel": ""
}
```

**Model precedence** for prompt translation is `requestModel` → `model` → `@tiny`. Thinking and answer translation use `model` → `@tiny`. `@tiny` is OMP's tiny model role. An empty value never means a hardcoded provider.

Language tags are stored in canonical form. If you edit the file by hand, missing keys fall back to their defaults. Unknown keys, wrong types, or invalid language tags make the file invalid. When the file is invalid, an error is shown, translation stays inactive, and the extension does not overwrite the file until you fix or delete it.

Older settings files without `answer` load with it off. The next settings update writes the key; remove it before downgrading to an older version whose strict schema does not accept it.

Each settings change re-reads the file under an OS file lock and overwrites only the changed keys, so changes made from several OMP processes are merged instead of lost. If another process holds the lock for about five seconds, the change fails with an error and the previous settings stay active. Running processes do not pick up each other's changes until they reload the file.

## Behavior details

### Thinking translation

- Only completed thinking is translated: the thinking blocks of a main-agent TUI assistant message once that message has ended, including messages that end in a tool call, length limit, error, or abort. Streaming updates are never sent. Each distinct completed text waits 1.5 s before its translation request starts. Redacted thinking, empty thinking, tool arguments, and answer text are not translated.
- Each thinking block gets its own separate `omp-translate-thinking` message. Messages are posted in the order the blocks completed, and only while the agent is idle: a result that finishes during a run waits until the agent becomes idle. Thinking and answer translations are not ordered relative to each other.
- If a new run starts at the moment a result is posted, the host queues the message for the next turn instead; it then appears under the next prompt. Posting never starts or steers an agent turn.
- Results are cached in memory (up to 500 entries). The cache key includes the model, target language, and text. Identical completed texts share one request; each occurrence still gets its own message.
- Changing settings, switching or branching the session, or ending the session cancels pending work and drops results not yet posted. Already posted translations remain.
- A failed translation shows a warning (`Thinking translation failed: …`) and posts nothing.
- A provider `Refusal (reasoning_extraction)` pauses thinking translation for the rest of the session, cancels pending thinking work, and shows one warning. Final-answer translation is enabled as a session-only fallback, including the latest completed answer if the refusal arrives late. Saved settings are unchanged. `/translate status` shows the pause and fallback; `/translate answer off` disables the fallback. Switching, branching, or ending the session clears both overrides. Other translation errors do not trigger this behavior.
- Each translation has a 20 s deadline, shared with its retry (see Retries).
- The host persists each posted translation and displays it again on resume. This extension filters those messages from every model request, as it does for answer translations. Resuming does not translate earlier thinking that has no translation message.

### Answer translation

- Only the last assistant message of a completed main-agent TUI run is translated. Continuations, tool-call turns, failed or aborted answers, empty answers, subagents, and non-interactive modes are skipped.
- Translation uses `targetLanguage` and the thinking translation model, with a 60 s deadline. It runs in the background without starting another agent turn. The 60 s deadline is shared with a retry (see Retries).
- If a new run is active when translation finishes, the result waits for the next idle main-agent end. Switching, branching, or shutting down the session discards pending and held results.
- Turning answer translation off drops still-pending results; already-held results can still appear at the next idle end. Existing displayed translations remain. An unchanged translation is not displayed; failures produce a warning without changing the original.
- The host persists each translation as a separate display-only custom message and displays it again on resume. This extension filters those messages from every model request, including when answer translation is off. **Keep the extension loaded when resuming translated sessions**: without its context filter, the host can include custom messages in model requests.

### Prompt translation

- Translation happens when the input is submitted. The translated text is what gets stored in session history and shown as your message.
- Host command syntax is not translated: slash commands (`/…`), shell commands (`!…`), Python commands (`$ …`, `$$ …` followed by whitespace), and queue markers (`->`, `=>`). Leading whitespace is ignored. Image attachments are left untouched.
- If the translated text itself looks like host command syntax, a warning is shown and the original text is sent.
- If translation fails, a warning is shown and the original text is sent.
- If the session is switched or branched while a prompt is being translated, the prompt is discarded with a warning; resend it in the new session. On shutdown, pending prompts are discarded silently.

### Code preservation

- Fenced code blocks and inline code spans are replaced with placeholders before translation and restored byte-for-byte afterwards.
- If the model drops or duplicates a placeholder, the translation is rejected and retried once (see Retries). If the retry is also rejected: for prompts, the original text is sent; for thinking, a failure is shown; for answers, a warning is shown and no translation is posted.
- Other identifiers and paths are protected only by instructions to the model. Perfect preservation and semantic equivalence are not guaranteed.
- The source text is wrapped in framing that tells the model to treat it as text to translate. This framing is guidance, not a security boundary.

### Retries

- Every translation (thinking, answer, prompt) is attempted at most twice under one shared deadline (20 s; 60 s for answers). A retry re-sends the original text.
- A retry happens when a code placeholder is missing or duplicated, or when the output contains letters from a script that does not belong to the target language. Latin letters are always accepted (identifiers, paths, English terms); Han characters are accepted for Korean, Japanese, and Chinese targets, kana for Japanese, Bopomofo for Chinese. Example: an English translation that still contains a Korean commit message is retried.
- The language retry adds an instruction to translate quoted text, titles, and commit messages too. Of the two results, the one with fewer foreign-script letters is shown; if the retry fails or times out, the first result is used.
- The check is script-based only. Output in the wrong language but the same script (Spanish instead of English, or untranslated English when the target is Korean) is not detected. Languages whose script cannot be determined from the tag are not checked.

## Privacy & cost

- Thinking translation sends completed thinking to the selected model provider. Enabled answer translation sends final-answer text; prompt translation sends your prompts. All use that provider's quota.
- The extension writes its settings file (plus, on macOS and similar platforms, an empty `omp-translate.json.lock` next to it for file locking). The host stores posted thinking and answer translations in session history as separate custom messages.
- Credentials are resolved by OMP's model registry. The extension does not read token stores and does not log credentials, source text, or translated text.

## Limitations

- The input hook applies to interactive and RPC inputs, as OMP provides them.
- Thinking and answer translation are main-agent TUI only. Answer translation requires a completed final answer.
- Thinking translation is independent of thinking visibility: thinking hidden with `hideThinkingBlock: true` (or `--hide-thinking`) is still translated and shown as separate messages. Use `/translate thinking off` to stop it.
- Thinking and answer translations are persisted; keep the extension loaded to exclude them from model context on resume. Thinking from sessions recorded before this version, or while thinking translation was off, is not translated retroactively.

## Development

```sh
bun install
bun test
bun run typecheck
```

The Markdown parser is bundled into `src/markdown-parser.js` so the extension runs without installing dependencies. After changing `mdast-util-from-markdown`, regenerate it with `bun run build:parser` and update `src/markdown-parser.LICENSE.txt`.
