# omp-translate

[English](../README.md) | **한국어** | [日本語](README.ja.md) | [简体中文](README.zh-Hans.md) | [繁體中文](README.zh-Hant.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt.md)

버전 0.1.0 — OMP(oh-my-pi 코딩 에이전트)를 위한 언어 중립적 번역 확장입니다.

## 개요

- **사고 번역**: 어시스턴트의 각 사고(thinking) 블록을 사용자가 선택한 표시 언어로 번역하고, 번역문을 TUI에서 원문 아래에 표시합니다. 원래 사고 내용과 프로바이더 컨텍스트는 절대 수정되지 않습니다.
- **프롬프트 번역**(선택 사항, 기본값은 꺼짐): 보내는 프롬프트를 전송 전에 요청 언어(기본값 영어)로 번역합니다.

원문은 여러 언어가 섞인 텍스트를 포함해 어떤 언어든 될 수 있습니다. 대상 언어는 유효한 BCP-47 언어 태그라면 무엇이든 지정할 수 있습니다.

## 요구 사항

- OMP (18.10.4에서 테스트됨)
- Bun
- OMP에 설정 및 인증된 모델

## 설치

### 로컬 개발 (link)

로컬 체크아웃을 링크하려면:

```sh
omp plugin link /path/to/omp-translate
```

### 로컬 마켓플레이스

저장소에는 `.omp-plugin/marketplace.json`에 마켓플레이스 카탈로그가 포함되어 있습니다:

```sh
omp plugin marketplace add /path/to/omp-translate
omp plugin discover omp-translate
omp plugin install omp-translate@omp-translate
omp plugin list
```

### 호스팅된 저장소

저장소를 GitHub에 공개한다고 해서 자동으로 검색되는 것은 **아닙니다**. 사용자는 먼저 마켓플레이스를 추가해야 합니다:

```sh
omp plugin marketplace add <owner>/<repo>
```

`<owner>/<repo>`는 자리 표시자입니다. 프로젝트가 호스팅되면 실제 저장소로 바꾸세요(아직 호스팅된 저장소는 없습니다). 그런 다음 위의 `discover`/`install` 명령을 실행하세요.

## 첫 실행

대화형 TUI(메인 세션에서만)에서 언어 선택기가 한 번 표시됩니다:

| 레이블 | 태그 |
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
| Custom language tag | 임의의 BCP-47 태그, `Intl.getCanonicalLocales`로 정규화됨 |

- 취소하면 번역은 비활성 상태로 유지되며 이 세션에서는 다시 묻지 않습니다. 나중에 `/translate setup`을 실행해 언어를 선택하세요.
- 프롬프트 번역은 `/translate request on`으로 켜기 전까지 꺼진 상태로 유지됩니다.
- 비대화형 모드(`print`, `json`, `rpc`)와 서브에이전트에서는 대화 상자를 표시하지 않습니다. `print`/`json` 모드에서는 한 줄짜리 설정 안내가 stderr에 출력됩니다. `rpc` 모드에서는 대신 알림이 전송됩니다.

## 명령어

| 명령어 | 효과 |
|---|---|
| `/translate` 또는 `/translate status` | 현재 설정과 상태 표시 |
| `/translate setup` | 언어 선택기 열기 |
| `/translate thinking on\|off` | 사고 번역 켜기/끄기 |
| `/translate request on\|off` | 프롬프트 번역 켜기/끄기 |
| `/translate language <tag>` | 표시 언어 설정, 예: `/translate language pt-BR` |
| `/translate request-language <tag>` | 요청 언어 설정, 예: `/translate request-language en` |
| `/translate model <selector\|clear>` | 번역 모델 설정, 예: `/translate model provider/model` 또는 `/translate model @role`. `clear`는 기본값으로 복원 |
| `/translate request-model <selector\|clear>` | 프롬프트 번역용 별도 모델 설정. `clear`는 다시 `model`을 사용하도록 함 |

피연산자가 없거나 남는 경우, 잘못된 언어 태그, 확인할 수 없는 모델 선택자는 오류와 함께 거부됩니다. 이 경우 아무것도 저장되지 않습니다.

## 설정 파일

설정은 `<agent dir>/omp-translate.json`에 저장됩니다. 기본 위치는 `~/.omp/agent/omp-translate.json`이며, 경로는 OMP 프로필과 `PI_CONFIG_DIR`을 따릅니다.

| 키 | 기본값 | 의미 |
|---|---|---|
| `thinking` | `true` | 사고 블록 번역 |
| `request` | `false` | 보내는 프롬프트 번역 |
| `targetLanguage` | `""` | 표시 언어 (`""` = 아직 설정되지 않음) |
| `requestLanguage` | `"en"` | 프롬프트를 번역할 언어 (비어 있으면 안 됨) |
| `model` | `""` | 번역 모델 선택자 (`""` = 기본값) |
| `requestModel` | `""` | 프롬프트 번역 모델 (`""` = `model` 사용) |

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

프롬프트 번역의 **모델 우선순위**는 `requestModel` → `model` → `@tiny`입니다. 사고 번역은 `model` → `@tiny`를 사용합니다. `@tiny`는 OMP의 tiny 모델 역할입니다. 빈 값이 하드코딩된 프로바이더를 의미하는 경우는 없습니다.

언어 태그는 정규화된 형식으로 저장됩니다. 파일을 직접 편집하는 경우, 누락된 키는 기본값으로 대체됩니다. 알 수 없는 키, 잘못된 타입, 유효하지 않은 언어 태그가 있으면 파일이 유효하지 않게 됩니다. 파일이 유효하지 않으면 오류가 표시되고 번역은 비활성 상태로 유지되며, 파일을 수정하거나 삭제할 때까지 확장은 파일을 덮어쓰지 않습니다.

## 동작 세부 사항

### 사고 번역

- 서로 다른 각 사고 텍스트는 번역 요청을 시작하기 전에 1.5초 대기합니다. 서로 다른 스트리밍 스냅샷은 독립적인 요청이므로, 길게 스트리밍되는 블록은 여러 번의 모델 호출을 발생시킬 수 있습니다.
- 결과는 메모리에 캐시됩니다(최대 500개 항목). 캐시 키에는 모델, 대상 언어, 텍스트가 포함됩니다. 동일한 텍스트를 표시하는 뷰는 하나의 요청을 공유합니다.
- 설정을 변경하거나, 세션을 전환 또는 분기하거나, 세션을 종료하면 대기 중인 작업이 취소되고 이미 화면에 표시된 번역이 지워집니다.
- 각 번역의 제한 시간은 20초입니다.

### 프롬프트 번역

- 번역은 입력을 제출할 때 수행됩니다. 번역된 텍스트가 세션 기록에 저장되고 사용자 메시지로 표시됩니다.
- 호스트 명령 구문은 번역되지 않습니다: 슬래시 명령(`/…`), 셸 명령(`!…`), Python 명령(`$ …`, 공백이 뒤따르는 `$$ …`), 큐 마커(`->`, `=>`). 앞쪽 공백은 무시됩니다. 이미지 첨부는 그대로 유지됩니다.
- 번역된 텍스트 자체가 호스트 명령 구문처럼 보이면 경고가 표시되고 원문이 전송됩니다.
- 번역에 실패하면 경고가 표시되고 원문이 전송됩니다.
- 프롬프트를 번역하는 동안 세션이 전환되거나 분기되면 경고와 함께 프롬프트가 폐기됩니다. 새 세션에서 다시 보내세요. 종료 시에는 대기 중인 프롬프트가 조용히 폐기됩니다.

### 코드 보존

- 펜스 코드 블록과 인라인 코드 스팬은 번역 전에 자리 표시자로 대체되고, 번역 후 바이트 단위로 그대로 복원됩니다.
- 모델이 자리 표시자를 누락하거나 중복하면 번역이 거부됩니다. 프롬프트의 경우 원문이 전송됩니다. 사고의 경우 실패가 표시됩니다.
- 그 밖의 식별자와 경로는 모델에 대한 지시로만 보호됩니다. 완벽한 보존과 의미적 동등성은 보장되지 않습니다.
- 원문은 모델이 이를 번역할 텍스트로 취급하도록 지시하는 프레이밍으로 감싸집니다. 이 프레이밍은 안내일 뿐 보안 경계가 아닙니다.

## 개인정보 및 비용

- 사고 번역은 표시되는 사고 텍스트를 선택한 모델 프로바이더로 전송합니다. 프롬프트 번역은 사용자의 프롬프트를 전송합니다. 둘 다 해당 프로바이더의 할당량을 사용합니다.
- 확장이 기록하는 유일한 파일은 설정 파일입니다. 번역은 메모리에만 보관됩니다.
- 자격 증명은 OMP의 모델 레지스트리가 확인합니다. 확장은 토큰 저장소를 읽지 않으며 자격 증명, 원문, 번역문을 로그에 남기지 않습니다.

## 제한 사항

- 입력 훅은 OMP가 제공하는 대로 대화형 입력과 RPC 입력에 적용됩니다.
- 어시스턴트 응답은 번역되지 않습니다.
- 사고 번역은 TUI에 사고 블록이 표시되는 동안에만 렌더링됩니다. `hideThinkingBlock: true`(또는 `--hide-thinking`)인 경우 아무것도 번역되거나 표시되지 않습니다. `Ctrl+T`로 표시 여부를 전환하세요.
- 번역은 영구 저장되지 않습니다. 재시작 후에는 사고가 다시 번역됩니다.

## 개발

```sh
bun install
bun test
bun run typecheck
```
