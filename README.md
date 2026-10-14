# omp-translate

**English** | [한국어](docs/README.ko.md) | [日本語](docs/README.ja.md) | [简体中文](docs/README.zh-Hans.md) | [繁體中文](docs/README.zh-Hant.md) | [Español](docs/README.es.md) | [Français](docs/README.fr.md) | [Deutsch](docs/README.de.md) | [Português](docs/README.pt.md)

Version 0.1.0 — a language-neutral translation extension for OMP (the oh-my-pi coding agent).

## Overview

- **Thinking translation**: each assistant thinking block is translated into a display language you choose, and the translation is shown beneath the original in the TUI. The original thinking and the provider context are never modified.
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
- Non-interactive modes (`print`, `json`, `rpc`) and subagents never show dialogs. In `print`/`json` modes a one-line setup instruction is written to stderr. In `rpc` mode a notification is sent instead.

## Commands

| Command | Effect |
|---|---|
| `/translate` or `/translate status` | Show current settings and status |
| `/translate setup` | Open the language picker |
| `/translate thinking on\|off` | Turn thinking translation on or off |
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
| `targetLanguage` | `""` | Display language (`""` = not configured yet) |
| `requestLanguage` | `"en"` | Language prompts are translated into (must be non-empty) |
| `model` | `""` | Translation model selector (`""` = default) |
| `requestModel` | `""` | Prompt translation model (`""` = use `model`) |

```json
{
  "thinking": true,
  "request": true,
  "targetLanguage": "ja",
  "requestLanguage": "en",
  "model": "",
  "requestModel": ""
}
```

**Model precedence** for prompt translation is `requestModel` → `model` → `@tiny`. Thinking translation uses `model` → `@tiny`. `@tiny` is OMP's tiny model role. An empty value never means a hardcoded provider.

Language tags are stored in canonical form. If you edit the file by hand, missing keys fall back to their defaults. Unknown keys, wrong types, or invalid language tags make the file invalid. When the file is invalid, an error is shown, translation stays inactive, and the extension does not overwrite the file until you fix or delete it.

Each settings change re-reads the file under an OS file lock and overwrites only the changed keys, so changes made from several OMP processes are merged instead of lost. If another process holds the lock for about five seconds, the change fails with an error and the previous settings stay active. Running processes do not pick up each other's changes until they reload the file.

## Behavior details

### Thinking translation

- Each distinct thinking text waits 1.5 s before its translation request starts. Distinct streaming snapshots are independent requests, so a long streamed block can issue several model calls.
- Results are cached in memory (up to 500 entries). The cache key includes the model, target language, and text. Views showing identical text share one request.
- Changing settings, switching or branching the session, or ending the session cancels pending work and clears translations already on screen.
- Each translation has a 20 s deadline.

### Prompt translation

- Translation happens when the input is submitted. The translated text is what gets stored in session history and shown as your message.
- Host command syntax is not translated: slash commands (`/…`), shell commands (`!…`), Python commands (`$ …`, `$$ …` followed by whitespace), and queue markers (`->`, `=>`). Leading whitespace is ignored. Image attachments are left untouched.
- If the translated text itself looks like host command syntax, a warning is shown and the original text is sent.
- If translation fails, a warning is shown and the original text is sent.
- If the session is switched or branched while a prompt is being translated, the prompt is discarded with a warning; resend it in the new session. On shutdown, pending prompts are discarded silently.

### Code preservation

- Fenced code blocks and inline code spans are replaced with placeholders before translation and restored byte-for-byte afterwards.
- If the model drops or duplicates a placeholder, the translation is rejected. For prompts, the original text is sent. For thinking, a failure is shown.
- Other identifiers and paths are protected only by instructions to the model. Perfect preservation and semantic equivalence are not guaranteed.
- The source text is wrapped in framing that tells the model to treat it as text to translate. This framing is guidance, not a security boundary.

## Privacy & cost

- Thinking translation sends the visible thinking text to the selected model provider. Prompt translation sends your prompts. Both use that provider's quota.
- The only file the extension writes is the settings file (plus, on macOS and similar platforms, an empty `omp-translate.json.lock` next to it for file locking). Translations are kept in memory only.
- Credentials are resolved by OMP's model registry. The extension does not read token stores and does not log credentials, source text, or translated text.

## Limitations

- The input hook applies to interactive and RPC inputs, as OMP provides them.
- Assistant responses are not translated.
- Thinking translations render only while thinking blocks are visible in the TUI. With `hideThinkingBlock: true` (or `--hide-thinking`), nothing is translated or shown; toggle visibility with `Ctrl+T`.
- Translations are not persisted. After a restart, thinking is translated again.

## Development

```sh
bun install
bun test
bun run typecheck
```

The Markdown parser is bundled into `src/markdown-parser.js` so the extension runs without installing dependencies. After changing `mdast-util-from-markdown`, regenerate it with `bun run build:parser` and update `src/markdown-parser.LICENSE.txt`.
