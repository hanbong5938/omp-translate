# omp-translate

[English](../README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-Hans.md) | **繁體中文** | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt.md)

版本 0.1.0 — 適用於 OMP（oh-my-pi 程式設計代理）的語言中立翻譯擴充功能。

## 概覽

- **思考翻譯**：每個助理思考區塊都會被翻譯成您選擇的顯示語言，譯文會顯示在 TUI 中原文的下方。原始思考內容與提供者上下文永遠不會被修改。
- **回答翻譯**（選用，預設關閉）：主代理執行結束後，其最終回答會被翻譯成顯示語言，並以獨立的 `omp-translate` 方框顯示在原文下方。原始回答在歷史記錄、工作階段檔案與後續 LLM 請求中都保持不變。
- **提示詞翻譯**（選用，預設關閉）：送出的提示詞會在傳送前被翻譯成請求語言（預設為英文）。

來源文字可以是任何語言，包括混合多種語言的文字。目標語言可以是任何有效的 BCP-47 語言標籤。

## 需求

- OMP（已於 18.10.4 測試）
- Bun
- 已在 OMP 中設定並完成驗證的模型

## 安裝

### 本機開發（連結）

連結本機的檢出副本：

```sh
omp plugin link /path/to/omp-translate
```

### 本機市集

此儲存庫在 `.omp-plugin/marketplace.json` 中包含一份市集目錄：

```sh
omp plugin marketplace add /path/to/omp-translate
omp plugin discover omp-translate
omp plugin install omp-translate@omp-translate
omp plugin list
```

### 託管儲存庫

外掛發布於 [hanbong5938/omp-translate](https://github.com/hanbong5938/omp-translate)。它未列於任何預設目錄，因此請先將儲存庫新增為市集，然後安裝：

```sh
omp plugin marketplace add hanbong5938/omp-translate
omp plugin install omp-translate@omp-translate
```

## 首次執行

在互動式 TUI 中（僅限主工作階段），語言選擇器會出現一次：

| Label | 標籤 |
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
| Custom language tag | 任何 BCP-47 標籤，以 `Intl.getCanonicalLocales` 正規化 |

- 若您取消，翻譯會保持停用，且在此工作階段中不會再次詢問。之後可執行 `/translate setup` 來選擇語言。
- 提示詞翻譯會保持關閉，直到您以 `/translate request on` 開啟。
- 非互動模式（`print`、`json`、`rpc`）與子代理永遠不會顯示對話框。在 `print`/`json` 模式下，會將一行設定說明寫入 stderr。在 `rpc` 模式下則改為傳送通知。

## 指令

| 指令 | 效果 |
|---|---|
| `/translate` 或 `/translate status` | 顯示目前的設定與狀態 |
| `/translate setup` | 開啟語言選擇器 |
| `/translate thinking on\|off` | 開啟或關閉思考翻譯 |
| `/translate answer on\|off` | 開啟或關閉回答翻譯 |
| `/translate request on\|off` | 開啟或關閉提示詞翻譯 |
| `/translate language <tag>` | 設定顯示語言，例如 `/translate language pt-BR` |
| `/translate request-language <tag>` | 設定請求語言，例如 `/translate request-language en` |
| `/translate model <selector\|clear>` | 設定翻譯模型，例如 `/translate model provider/model` 或 `/translate model @role`。`clear` 會恢復預設值 |
| `/translate request-model <selector\|clear>` | 為提示詞翻譯設定獨立的模型。`clear` 會讓它重新使用 `model` |

缺少或多餘的運算元、無效的語言標籤，以及無法解析的模型選擇器都會被拒絕並顯示錯誤。在此情況下不會儲存任何內容。

## 設定檔

設定儲存在 `<agent dir>/omp-translate.json`。預設位置為 `~/.omp/agent/omp-translate.json`，路徑會依循 OMP 設定檔與 `PI_CONFIG_DIR`。

| 鍵 | 預設值 | 意義 |
|---|---|---|
| `thinking` | `true` | 翻譯思考區塊 |
| `answer` | `false` | 翻譯主代理的最終回答 |
| `request` | `false` | 翻譯送出的提示詞 |
| `targetLanguage` | `""` | 顯示語言（`""` = 尚未設定） |
| `requestLanguage` | `"en"` | 提示詞要翻譯成的語言（不得為空） |
| `model` | `""` | 翻譯模型選擇器（`""` = 預設） |
| `requestModel` | `""` | 提示詞翻譯模型（`""` = 使用 `model`） |

```json
{
  "thinking": true,
  "answer": false,
  "request": true,
  "targetLanguage": "ja",
  "requestLanguage": "en",
  "model": "",
  "requestModel": ""
}
```

提示詞翻譯的**模型優先順序**為 `requestModel` → `model` → `@tiny`。思考翻譯與回答翻譯使用 `model` → `@tiny`，並共用 `targetLanguage`。`@tiny` 是 OMP 的 tiny 模型角色。空值永遠不代表寫死的提供者。

語言標籤會以正規形式儲存。若您手動編輯檔案，缺少的鍵會回退為預設值。未知的鍵、錯誤的型別或無效的語言標籤會使檔案無效。當檔案無效時，會顯示錯誤，翻譯保持停用，且在您修正或刪除檔案之前，擴充功能不會覆寫該檔案。

## 行為細節

### 思考翻譯

- 每段不同的思考文字會等待 1.5 秒後才開始其翻譯請求。不同的串流快照是彼此獨立的請求，因此一個較長的串流區塊可能會發出多次模型呼叫。
- 結果會快取在記憶體中（最多 500 筆）。快取鍵包含模型、目標語言與文字。顯示相同文字的檢視會共用同一個請求。
- 變更設定、切換或分支工作階段，或結束工作階段，都會取消待處理的工作，並清除已顯示在畫面上的譯文。
- 每次翻譯的期限為 20 秒。

### 提示詞翻譯

- 翻譯會在輸入送出時進行。翻譯後的文字會被儲存到工作階段歷史中，並顯示為您的訊息。
- 主機指令語法不會被翻譯：斜線指令（`/…`）、shell 指令（`!…`）、Python 指令（`$ …`、`$$ …`，後接空白字元）以及佇列標記（`->`、`=>`）。開頭的空白字元會被忽略。圖片附件保持不變。
- 若翻譯後的文字本身看起來像主機指令語法，會顯示警告並傳送原文。
- 若翻譯失敗，會顯示警告並傳送原文。
- 若在提示詞翻譯期間切換或分支工作階段，該提示詞會被捨棄並顯示警告；請在新的工作階段中重新傳送。關閉時，待處理的提示詞會被無聲捨棄。

### 回答翻譯

- 以 `/translate answer on` 開啟。僅翻譯 TUI 中主代理正常完成的最終回答；子代理、非互動模式（`print`、`json`、`rpc`）、重試／接續執行，以及以工具呼叫結束的回合都不會翻譯。
- 翻譯以非同步方式進行，不會啟動新的代理回合，期限為 60 秒。代理忙碌時完成的譯文會在下一次主代理執行結束並閒置時顯示。
- 若模型遺漏、重複或損壞了程式碼預留位置，會在同一 60 秒期限內從原文重新翻譯一次。重試仍失敗時會顯示警告。
- 切換、分支或結束工作階段時，待處理與暫存的回答譯文都會被捨棄。
- 若回答已是目標語言、結果與原文相同，則不會顯示。翻譯或預留位置驗證失敗時會顯示警告，並省略該回答的翻譯。
- 譯文會以獨立的 `display: true` 自訂訊息（`customType` 為 `omp-translate`）由主機儲存到工作階段檔案中，因此恢復工作階段時會再次顯示。
- 無論回答翻譯是否開啟，外掛都會一律將這些訊息從提供者上下文中排除。此排除僅在外掛已載入時生效，因此恢復含有譯文的工作階段時請勿停用外掛，否則主機會將已儲存的譯文傳送給模型。

### 程式碼保留

- 圍欄程式碼區塊與行內程式碼片段會在翻譯前被替換為預留位置，並在之後逐位元組還原。
- 若模型遺漏或重複了某個預留位置，該譯文會被拒絕。對提示詞而言，會傳送原文；對思考而言，會顯示失敗。
- 其他識別符與路徑僅透過給模型的指示加以保護。不保證能完美保留，也不保證語意等價。
- 來源文字會被包在框架中，告知模型將其視為要翻譯的文字。此框架僅是指引，而非安全邊界。

## 隱私與費用

- 思考翻譯會將可見的思考文字、回答翻譯（開啟時）會將最終回答傳送給所選的模型提供者。提示詞翻譯會傳送您的提示詞。它們都會使用該提供者的配額。
- 擴充功能唯一會直接寫入的檔案是設定檔。思考譯文僅保存在記憶體中；回答譯文由主機以自訂訊息儲存到工作階段檔案中。
- 憑證由 OMP 的模型登錄檔解析。擴充功能不會讀取權杖儲存區，也不會記錄憑證、來源文字或譯文。

## 限制

- 輸入掛鉤適用於互動式與 RPC 輸入，依 OMP 提供的方式而定。
- 回答翻譯僅適用於 TUI 中主代理的最終回答；包含工具呼叫之回合中的中間文字不會被翻譯。
- 思考譯文僅在 TUI 中思考區塊可見時才會呈現。若設定 `hideThinkingBlock: true`（或 `--hide-thinking`），則不會進行或顯示思考翻譯；回答翻譯與思考是否可見無關。可用 `Ctrl+T` 切換可見性。
- 思考譯文不會被持久保存。重新啟動後，思考內容會再次被翻譯。
- 不支援 `answer` 鍵的舊版本會因嚴格的結構描述而拒絕此設定檔。降級前請移除 `answer` 鍵。

## 開發

```sh
bun install
bun test
bun run typecheck
```
