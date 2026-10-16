# omp-translate

[English](../README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-Hans.md) | [繁體中文](README.zh-Hant.md) | [Español](README.es.md) | [Français](README.fr.md) | **Deutsch** | [Português](README.pt.md)

Version 0.1.0 — eine sprachneutrale Übersetzungserweiterung für OMP (den Coding-Agenten oh-my-pi).

## Überblick

- **Übersetzung des Denkprozesses**: Jeder Thinking-Block des Assistenten wird in eine von Ihnen gewählte Anzeigesprache übersetzt, und die Übersetzung wird in der TUI unter dem Original angezeigt. Der ursprüngliche Denktext und der Provider-Kontext werden nie verändert.
- **Antwort-Übersetzung** (optional, standardmäßig deaktiviert): In der TUI wird die finale Antwort des Hauptagenten in die Anzeigesprache übersetzt und in einem separaten `omp-translate`-Kasten unter dem Original angezeigt. Die Originalnachricht bleibt unverändert.
- **Prompt-Übersetzung** (optional, standardmäßig deaktiviert): Ausgehende Prompts werden vor dem Senden in eine Anfragesprache (standardmäßig Englisch) übersetzt.

Der Quelltext kann in jeder Sprache vorliegen, auch gemischtsprachig. Als Zielsprache ist jedes gültige BCP-47-Sprach-Tag möglich.

## Voraussetzungen

- OMP (getestet mit 18.10.4)
- Bun
- Ein in OMP konfiguriertes und authentifiziertes Modell

## Installation

### Lokale Entwicklung (Link)

Um einen lokalen Checkout zu verlinken:

```sh
omp plugin link /path/to/omp-translate
```

### Lokaler Marketplace

Das Repository enthält einen Marketplace-Katalog unter `.omp-plugin/marketplace.json`:

```sh
omp plugin marketplace add /path/to/omp-translate
omp plugin discover omp-translate
omp plugin install omp-translate@omp-translate
omp plugin list
```

### Gehostetes Repository

Das Plugin ist unter [hanbong5938/omp-translate](https://github.com/hanbong5938/omp-translate) veröffentlicht. Es ist in keinem Standardkatalog gelistet; fügen Sie das Repository daher als Marketplace hinzu und installieren Sie es anschließend:

```sh
omp plugin marketplace add hanbong5938/omp-translate
omp plugin install omp-translate@omp-translate
```

## Erster Start

In der interaktiven TUI (nur in der Hauptsitzung) erscheint einmalig eine Sprachauswahl:

| Bezeichnung | Tag |
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
| Custom language tag | beliebiges BCP-47-Tag, kanonisiert mit `Intl.getCanonicalLocales` |

- Wenn Sie abbrechen, bleibt die Übersetzung inaktiv, und Sie werden in dieser Sitzung nicht erneut gefragt. Führen Sie später `/translate setup` aus, um eine Sprache zu wählen.
- Die Prompt-Übersetzung bleibt deaktiviert, bis Sie sie mit `/translate request on` einschalten.
- Nicht-interaktive Modi (`print`, `json`, `rpc`) und Subagenten zeigen nie Dialoge an. In den Modi `print`/`json` wird eine einzeilige Einrichtungsanweisung nach stderr geschrieben. Im Modus `rpc` wird stattdessen eine Benachrichtigung gesendet.

## Befehle

| Befehl | Wirkung |
|---|---|
| `/translate` oder `/translate status` | Aktuelle Einstellungen und Status anzeigen |
| `/translate setup` | Sprachauswahl öffnen |
| `/translate thinking on\|off` | Übersetzung des Denkprozesses ein- oder ausschalten |
| `/translate answer on\|off` | Antwort-Übersetzung ein- oder ausschalten |
| `/translate request on\|off` | Prompt-Übersetzung ein- oder ausschalten |
| `/translate language <tag>` | Anzeigesprache festlegen, z. B. `/translate language pt-BR` |
| `/translate request-language <tag>` | Anfragesprache festlegen, z. B. `/translate request-language en` |
| `/translate model <selector\|clear>` | Übersetzungsmodell festlegen, z. B. `/translate model provider/model` oder `/translate model @role`. `clear` stellt den Standard wieder her |
| `/translate request-model <selector\|clear>` | Separates Modell für die Prompt-Übersetzung festlegen. `clear` lässt wieder `model` verwenden |

Fehlende oder überzählige Operanden, ungültige Sprach-Tags und nicht auflösbare Modell-Selektoren werden mit einem Fehler abgelehnt. In diesem Fall wird nichts gespeichert.

## Einstellungsdatei

Die Einstellungen werden in `<agent dir>/omp-translate.json` gespeichert. Der Standardort ist `~/.omp/agent/omp-translate.json`; der Pfad folgt OMP-Profilen und `PI_CONFIG_DIR`.

| Schlüssel | Standard | Bedeutung |
|---|---|---|
| `thinking` | `true` | Thinking-Blöcke übersetzen |
| `request` | `false` | Ausgehende Prompts übersetzen |
| `answer` | `false` | Finale Antwort des Hauptagenten übersetzen (TUI) |
| `targetLanguage` | `""` | Anzeigesprache (`""` = noch nicht konfiguriert) |
| `requestLanguage` | `"en"` | Sprache, in die Prompts übersetzt werden (darf nicht leer sein) |
| `model` | `""` | Selektor des Übersetzungsmodells (`""` = Standard) |
| `requestModel` | `""` | Modell für die Prompt-Übersetzung (`""` = `model` verwenden) |

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

**Modell-Rangfolge** für die Prompt-Übersetzung ist `requestModel` → `model` → `@tiny`. Die Übersetzung des Denkprozesses und der Antworten verwendet `model` → `@tiny` und dieselbe `targetLanguage`. `@tiny` ist die Tiny-Modellrolle von OMP. Ein leerer Wert bedeutet nie einen fest codierten Provider.

Sprach-Tags werden in kanonischer Form gespeichert. Wenn Sie die Datei von Hand bearbeiten, werden fehlende Schlüssel auf ihre Standardwerte gesetzt. Unbekannte Schlüssel, falsche Typen oder ungültige Sprach-Tags machen die Datei ungültig. Ist die Datei ungültig, wird ein Fehler angezeigt, die Übersetzung bleibt inaktiv, und die Erweiterung überschreibt die Datei nicht, bis Sie sie korrigieren oder löschen.

## Details zum Verhalten

### Übersetzung des Denkprozesses

- Für jeden unterschiedlichen Denktext wird 1,5 s gewartet, bevor seine Übersetzungsanfrage startet. Unterschiedliche Streaming-Snapshots sind unabhängige Anfragen, sodass ein langer gestreamter Block mehrere Modellaufrufe auslösen kann.
- Ergebnisse werden im Speicher zwischengespeichert (bis zu 500 Einträge). Der Cache-Schlüssel umfasst Modell, Zielsprache und Text. Ansichten mit identischem Text teilen sich eine Anfrage.
- Das Ändern von Einstellungen, das Wechseln oder Verzweigen der Sitzung oder das Beenden der Sitzung bricht ausstehende Arbeit ab und entfernt bereits angezeigte Übersetzungen.
- Jede Übersetzung hat eine Frist von 20 s.

### Antwort-Übersetzung

- Übersetzt werden nur abgeschlossene finale Antworten des Hauptagenten in der TUI. Subagenten, nicht interaktive Modi, Fortsetzungen/Wiederholungen und Turns mit Tool-Aufrufen werden nicht übersetzt.
- Die Übersetzung läuft im Hintergrund mit einer Frist von 60 s und startet keinen neuen Agenten-Turn. Ist der Agent bei Fertigstellung beschäftigt, wird sie zurückgehalten und am Ende des nächsten Laufs des Hauptagenten angezeigt.
- Verliert, dupliziert oder beschädigt das Modell einen Code-Platzhalter, wird die Antwort innerhalb derselben 60-s-Frist einmal erneut aus dem Originaltext übersetzt. Scheitert auch dieser Versuch, wird eine Warnung angezeigt und keine Übersetzung veröffentlicht.
- Ausstehende oder zurückgehaltene Übersetzungen werden beim Wechseln oder Verzweigen der Sitzung und beim Herunterfahren verworfen. Ein mit dem Original identisches Ergebnis (bereits in der Zielsprache) wird nicht angezeigt.
- Die Originalantwort bleibt im Transkript, in der Sitzungsdatei und in künftigen LLM-Anfragen unverändert. Die Übersetzung ist eine separate benutzerdefinierte Nachricht (`display: true`, `customType: "omp-translate"`), die der Host in der Sitzung speichert und beim Fortsetzen erneut anzeigt.
- Das Plugin entfernt diese Nachrichten immer aus dem an den Provider gesendeten Kontext, auch wenn `answer` deaktiviert ist. Das funktioniert nur, wenn das Plugin geladen ist: Deaktivieren Sie es nicht, wenn Sie Sitzungen mit übersetzten Antworten fortsetzen, sonst sendet der Host diese Nachrichten an das Modell.
- Schlägt die Platzhalterprüfung fehl, wird eine Warnung angezeigt und die Übersetzung dieser Antwort entfällt.

### Prompt-Übersetzung

- Die Übersetzung erfolgt beim Absenden der Eingabe. Der übersetzte Text wird im Sitzungsverlauf gespeichert und als Ihre Nachricht angezeigt.
- Host-Befehlssyntax wird nicht übersetzt: Slash-Befehle (`/…`), Shell-Befehle (`!…`), Python-Befehle (`$ …`, `$$ …` gefolgt von Leerraum) und Warteschlangen-Markierungen (`->`, `=>`). Führender Leerraum wird ignoriert. Bildanhänge bleiben unverändert.
- Sieht der übersetzte Text selbst wie Host-Befehlssyntax aus, wird eine Warnung angezeigt und der Originaltext gesendet.
- Schlägt die Übersetzung fehl, wird eine Warnung angezeigt und der Originaltext gesendet.
- Wird die Sitzung gewechselt oder verzweigt, während ein Prompt übersetzt wird, wird der Prompt mit einer Warnung verworfen; senden Sie ihn in der neuen Sitzung erneut. Beim Herunterfahren werden ausstehende Prompts stillschweigend verworfen.

### Erhaltung von Code

- Umzäunte Codeblöcke und Inline-Code-Abschnitte werden vor der Übersetzung durch Platzhalter ersetzt und danach Byte für Byte wiederhergestellt.
- Lässt das Modell einen Platzhalter weg oder dupliziert ihn, wird die Übersetzung verworfen. Bei Prompts wird der Originaltext gesendet. Beim Denkprozess wird ein Fehler angezeigt.
- Andere Bezeichner und Pfade werden nur durch Anweisungen an das Modell geschützt. Perfekte Erhaltung und semantische Gleichwertigkeit sind nicht garantiert.
- Der Quelltext wird in eine Rahmung eingebettet, die dem Modell mitteilt, ihn als zu übersetzenden Text zu behandeln. Diese Rahmung ist eine Anleitung, keine Sicherheitsgrenze.

## Datenschutz & Kosten

- Die Übersetzung des Denkprozesses sendet den sichtbaren Denktext an den ausgewählten Modell-Provider. Die Antwort-Übersetzung sendet, sofern aktiviert, die finalen Antworten. Die Prompt-Übersetzung sendet Ihre Prompts. Alle verbrauchen das Kontingent dieses Providers.
- Die einzige Datei, die die Erweiterung schreibt, ist die Einstellungsdatei. Übersetzungen des Denkprozesses werden nur im Speicher gehalten; Antwort-Übersetzungen speichert der Host in der Sitzungsdatei.
- Zugangsdaten werden von der Modell-Registry von OMP aufgelöst. Die Erweiterung liest keine Token-Speicher und protokolliert weder Zugangsdaten noch Quelltext oder übersetzten Text.

## Einschränkungen

- Der Eingabe-Hook gilt für interaktive und RPC-Eingaben, so wie OMP sie bereitstellt.
- Übersetzt wird nur die finale Antwort jedes Laufs des Hauptagenten in der TUI, nicht der Zwischentext von Turns mit Tools.
- Übersetzungen des Denkprozesses werden nur angezeigt, solange Thinking-Blöcke in der TUI sichtbar sind. Mit `hideThinkingBlock: true` (oder `--hide-thinking`) wird kein Denkprozess übersetzt oder angezeigt; die Sichtbarkeit lässt sich mit `Ctrl+T` umschalten. Die Antwort-Übersetzung ist davon unabhängig.
- Übersetzungen des Denkprozesses werden nicht dauerhaft gespeichert. Nach einem Neustart wird der Denkprozess erneut übersetzt.
- Ältere installierte Versionen mit striktem Schema lehnen den Schlüssel `answer` ab: Entfernen Sie ihn vor einem Downgrade aus der Einstellungsdatei.

## Entwicklung

```sh
bun install
bun test
bun run typecheck
```
