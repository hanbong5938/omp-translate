# omp-translate

[English](../README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | **简体中文** | [繁體中文](README.zh-Hant.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt.md)

版本 0.1.0 —— 一个与语言无关的 OMP（oh-my-pi 编码代理）翻译扩展。

## 概述

- **思考翻译**：每个助手思考块都会被翻译成你选择的显示语言，译文显示在 TUI 中原文的下方。原始思考内容和提供商上下文永远不会被修改。
- **提示词翻译**（可选，默认关闭）：发出的提示词在发送前会被翻译成请求语言（默认为英语）。

源文本可以是任何语言，包括多种语言混合的文本。目标语言可以是任何有效的 BCP-47 语言标签。

## 要求

- OMP（已在 18.10.4 上测试）
- Bun
- 在 OMP 中已配置并完成认证的模型

## 安装

### 本地开发（链接）

链接本地检出的代码：

```sh
omp plugin link /path/to/omp-translate
```

### 本地市场

仓库在 `.omp-plugin/marketplace.json` 中包含一个市场目录：

```sh
omp plugin marketplace add /path/to/omp-translate
omp plugin discover omp-translate
omp plugin install omp-translate@omp-translate
omp plugin list
```

### 托管仓库

在 GitHub 上发布仓库**不会**使其自动可被发现。用户必须先添加市场：

```sh
omp plugin marketplace add <owner>/<repo>
```

`<owner>/<repo>` 是占位符。项目托管后请将其替换为实际仓库（目前尚无托管仓库）。然后运行上面所示的 `discover`/`install` 命令。

## 首次运行

在交互式 TUI 中（仅限主会话），语言选择器会出现一次：

| Label | 标签 |
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
| Custom language tag | 任意 BCP-47 标签，使用 `Intl.getCanonicalLocales` 规范化 |

- 如果取消，翻译将保持未启用状态，并且本次会话中不会再次询问。之后可运行 `/translate setup` 选择语言。
- 提示词翻译保持关闭，直到你使用 `/translate request on` 将其开启。
- 非交互模式（`print`、`json`、`rpc`）和子代理永远不会显示对话框。在 `print`/`json` 模式下，会向 stderr 写入一行设置说明。在 `rpc` 模式下则会改为发送一条通知。

## 命令

| 命令 | 作用 |
|---|---|
| `/translate` 或 `/translate status` | 显示当前设置和状态 |
| `/translate setup` | 打开语言选择器 |
| `/translate thinking on\|off` | 开启或关闭思考翻译 |
| `/translate request on\|off` | 开启或关闭提示词翻译 |
| `/translate language <tag>` | 设置显示语言，例如 `/translate language pt-BR` |
| `/translate request-language <tag>` | 设置请求语言，例如 `/translate request-language en` |
| `/translate model <selector\|clear>` | 设置翻译模型，例如 `/translate model provider/model` 或 `/translate model @role`。`clear` 恢复默认值 |
| `/translate request-model <selector\|clear>` | 为提示词翻译设置单独的模型。`clear` 使其重新使用 `model` |

缺少或多余的操作数、无效的语言标签以及无法解析的模型选择器都会被拒绝并报错。这种情况下不会保存任何内容。

## 设置文件

设置存储在 `<agent dir>/omp-translate.json` 中。默认位置为 `~/.omp/agent/omp-translate.json`，路径会跟随 OMP 配置文件（profile）和 `PI_CONFIG_DIR`。

| 键 | 默认值 | 含义 |
|---|---|---|
| `thinking` | `true` | 翻译思考块 |
| `request` | `false` | 翻译发出的提示词 |
| `targetLanguage` | `""` | 显示语言（`""` = 尚未配置） |
| `requestLanguage` | `"en"` | 提示词被翻译成的语言（不能为空） |
| `model` | `""` | 翻译模型选择器（`""` = 默认） |
| `requestModel` | `""` | 提示词翻译模型（`""` = 使用 `model`） |

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

提示词翻译的**模型优先级**为 `requestModel` → `model` → `@tiny`。思考翻译使用 `model` → `@tiny`。`@tiny` 是 OMP 的小型模型角色。空值绝不意味着某个硬编码的提供商。

语言标签以规范形式存储。如果手动编辑该文件，缺失的键会回退为默认值。未知的键、错误的类型或无效的语言标签会使文件无效。文件无效时会显示错误，翻译保持未启用状态，并且在你修复或删除该文件之前，扩展不会覆盖它。

## 行为细节

### 思考翻译

- 每段不同的思考文本会等待 1.5 秒后才开始发起翻译请求。不同的流式快照是相互独立的请求，因此一个较长的流式块可能会发起多次模型调用。
- 结果缓存在内存中（最多 500 条）。缓存键包含模型、目标语言和文本。显示相同文本的视图共享同一个请求。
- 更改设置、切换或分支会话、或结束会话，都会取消待处理的工作并清除屏幕上已有的译文。
- 每次翻译的时限为 20 秒。

### 提示词翻译

- 翻译在提交输入时进行。翻译后的文本会存储到会话历史中，并作为你的消息显示。
- 宿主命令语法不会被翻译：斜杠命令（`/…`）、shell 命令（`!…`）、Python 命令（`$ …`、`$$ …`，后跟空白字符）以及队列标记（`->`、`=>`）。前导空白会被忽略。图片附件保持不变。
- 如果翻译后的文本本身看起来像宿主命令语法，会显示警告并发送原文。
- 如果翻译失败，会显示警告并发送原文。
- 如果在翻译提示词期间切换或分支了会话，该提示词会被丢弃并显示警告；请在新会话中重新发送。关闭时，待处理的提示词会被静默丢弃。

### 代码保留

- 围栏代码块和行内代码片段在翻译前会被替换为占位符，翻译后再逐字节还原。
- 如果模型丢失或重复了某个占位符，该译文会被拒绝。对于提示词，会发送原文；对于思考内容，会显示失败。
- 其他标识符和路径仅通过对模型的指令加以保护，不保证完美保留和语义等价。
- 源文本会被包裹在框架中，告诉模型将其视为待翻译的文本。该框架只是指导，而非安全边界。

## 隐私与费用

- 思考翻译会将可见的思考文本发送给所选的模型提供商。提示词翻译会发送你的提示词。两者都会消耗该提供商的配额。
- 扩展写入的唯一文件是设置文件。译文仅保存在内存中。
- 凭据由 OMP 的模型注册表解析。扩展不会读取令牌存储，也不会记录凭据、源文本或译文。

## 限制

- 输入钩子适用于 OMP 提供的交互式输入和 RPC 输入。
- 助手的回复不会被翻译。
- 思考译文仅在 TUI 中思考块可见时才会渲染。设置 `hideThinkingBlock: true`（或 `--hide-thinking`）时，不会翻译或显示任何内容；可使用 `Ctrl+T` 切换可见性。
- 译文不会持久化。重启后，思考内容会被重新翻译。

## 开发

```sh
bun install
bun test
bun run typecheck
```
