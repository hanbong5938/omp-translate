# omp-translate

[English](../README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-Hans.md) | [繁體中文](README.zh-Hant.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | **Português**

Versão 0.1.0 — uma extensão de tradução independente de idioma para o OMP (o agente de programação oh-my-pi).

## Visão geral

- **Tradução do raciocínio**: cada bloco de raciocínio (thinking) do assistente é traduzido para um idioma de exibição escolhido por você, e a tradução é mostrada abaixo do original na TUI. O raciocínio original e o contexto do provedor nunca são modificados.
- **Tradução de prompts** (opcional, desativada por padrão): os prompts enviados são traduzidos para um idioma de requisição (padrão: inglês) antes de serem enviados.

O texto de origem pode estar em qualquer idioma, inclusive texto com idiomas misturados. O destino pode ser qualquer tag de idioma BCP-47 válida.

## Requisitos

- OMP (testado com 18.10.4)
- Bun
- Um modelo configurado e autenticado no OMP

## Instalação

### Desenvolvimento local (link)

Para vincular um checkout local:

```sh
omp plugin link /path/to/omp-translate
```

### Marketplace local

O repositório inclui um catálogo de marketplace em `.omp-plugin/marketplace.json`:

```sh
omp plugin marketplace add /path/to/omp-translate
omp plugin discover omp-translate
omp plugin install omp-translate@omp-translate
omp plugin list
```

### Repositório hospedado

O plugin está publicado em [hanbong5938/omp-translate](https://github.com/hanbong5938/omp-translate). Ele não está listado em nenhum catálogo padrão, então adicione o repositório como marketplace e depois instale:

```sh
omp plugin marketplace add hanbong5938/omp-translate
omp plugin install omp-translate@omp-translate
```

## Primeira execução

Na TUI interativa (somente na sessão principal), um seletor de idioma aparece uma única vez:

| Rótulo | Tag |
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
| Custom language tag | qualquer tag BCP-47, canonicalizada com `Intl.getCanonicalLocales` |

- Se você cancelar, a tradução permanece inativa e você não será perguntado novamente nesta sessão. Execute `/translate setup` mais tarde para escolher um idioma.
- A tradução de prompts permanece desativada até que você a ative com `/translate request on`.
- Modos não interativos (`print`, `json`, `rpc`) e subagentes nunca exibem diálogos. Nos modos `print`/`json`, uma instrução de configuração de uma linha é escrita no stderr. No modo `rpc`, é enviada uma notificação.

## Comandos

| Comando | Efeito |
|---|---|
| `/translate` ou `/translate status` | Mostra as configurações e o status atuais |
| `/translate setup` | Abre o seletor de idioma |
| `/translate thinking on\|off` | Ativa ou desativa a tradução do raciocínio |
| `/translate request on\|off` | Ativa ou desativa a tradução de prompts |
| `/translate language <tag>` | Define o idioma de exibição, por exemplo `/translate language pt-BR` |
| `/translate request-language <tag>` | Define o idioma de requisição, por exemplo `/translate request-language en` |
| `/translate model <selector\|clear>` | Define o modelo de tradução, por exemplo `/translate model provider/model` ou `/translate model @role`. `clear` restaura o padrão |
| `/translate request-model <selector\|clear>` | Define um modelo separado para a tradução de prompts. `clear` faz com que volte a usar `model` |

Operandos ausentes ou excedentes, tags de idioma inválidas e seletores de modelo que não podem ser resolvidos são rejeitados com um erro. Nesse caso, nada é salvo.

## Arquivo de configurações

As configurações são armazenadas em `<agent dir>/omp-translate.json`. O local padrão é `~/.omp/agent/omp-translate.json`, e o caminho segue os perfis do OMP e `PI_CONFIG_DIR`.

| Chave | Padrão | Significado |
|---|---|---|
| `thinking` | `true` | Traduzir blocos de raciocínio |
| `request` | `false` | Traduzir prompts enviados |
| `targetLanguage` | `""` | Idioma de exibição (`""` = ainda não configurado) |
| `requestLanguage` | `"en"` | Idioma para o qual os prompts são traduzidos (não pode ser vazio) |
| `model` | `""` | Seletor do modelo de tradução (`""` = padrão) |
| `requestModel` | `""` | Modelo de tradução de prompts (`""` = usar `model`) |

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

**Precedência de modelos** para a tradução de prompts: `requestModel` → `model` → `@tiny`. A tradução do raciocínio usa `model` → `@tiny`. `@tiny` é o papel de modelo minúsculo (tiny) do OMP. Um valor vazio nunca significa um provedor fixo no código.

As tags de idioma são armazenadas na forma canônica. Se você editar o arquivo manualmente, as chaves ausentes assumem seus valores padrão. Chaves desconhecidas, tipos incorretos ou tags de idioma inválidas tornam o arquivo inválido. Quando o arquivo é inválido, um erro é exibido, a tradução permanece inativa e a extensão não sobrescreve o arquivo até que você o corrija ou exclua.

## Detalhes de comportamento

### Tradução do raciocínio

- Cada texto de raciocínio distinto aguarda 1,5 s antes que sua requisição de tradução comece. Snapshots distintos do streaming são requisições independentes, portanto um bloco longo transmitido em streaming pode gerar várias chamadas ao modelo.
- Os resultados são armazenados em cache na memória (até 500 entradas). A chave do cache inclui o modelo, o idioma de destino e o texto. Visualizações que exibem texto idêntico compartilham uma única requisição.
- Alterar as configurações, trocar ou ramificar a sessão, ou encerrar a sessão cancela o trabalho pendente e limpa as traduções já exibidas na tela.
- Cada tradução tem um prazo de 20 s.

### Tradução de prompts

- A tradução ocorre quando a entrada é enviada. O texto traduzido é o que fica armazenado no histórico da sessão e é exibido como sua mensagem.
- A sintaxe de comandos do host não é traduzida: comandos de barra (`/…`), comandos de shell (`!…`), comandos Python (`$ …`, `$$ …` seguidos de espaço em branco) e marcadores de fila (`->`, `=>`). Espaços em branco iniciais são ignorados. Anexos de imagem não são alterados.
- Se o próprio texto traduzido parecer sintaxe de comando do host, um aviso é exibido e o texto original é enviado.
- Se a tradução falhar, um aviso é exibido e o texto original é enviado.
- Se a sessão for trocada ou ramificada enquanto um prompt está sendo traduzido, o prompt é descartado com um aviso; reenvie-o na nova sessão. No encerramento, prompts pendentes são descartados silenciosamente.

### Preservação de código

- Blocos de código delimitados e trechos de código inline são substituídos por marcadores antes da tradução e restaurados byte a byte depois.
- Se o modelo omitir ou duplicar um marcador, a tradução é rejeitada. Para prompts, o texto original é enviado. Para o raciocínio, uma falha é exibida.
- Outros identificadores e caminhos são protegidos apenas por instruções ao modelo. A preservação perfeita e a equivalência semântica não são garantidas.
- O texto de origem é envolvido por um enquadramento que instrui o modelo a tratá-lo como texto a ser traduzido. Esse enquadramento é uma orientação, não uma barreira de segurança.

## Privacidade e custo

- A tradução do raciocínio envia o texto de raciocínio visível ao provedor do modelo selecionado. A tradução de prompts envia seus prompts. Ambas consomem a cota desse provedor.
- O único arquivo que a extensão escreve é o arquivo de configurações. As traduções são mantidas apenas na memória.
- As credenciais são resolvidas pelo registro de modelos do OMP. A extensão não lê armazenamentos de tokens e não registra em log credenciais, texto de origem nem texto traduzido.

## Limitações

- O hook de entrada se aplica às entradas interativas e RPC, conforme fornecidas pelo OMP.
- As respostas do assistente não são traduzidas.
- As traduções do raciocínio só são renderizadas enquanto os blocos de raciocínio estão visíveis na TUI. Com `hideThinkingBlock: true` (ou `--hide-thinking`), nada é traduzido nem exibido; alterne a visibilidade com `Ctrl+T`.
- As traduções não são persistidas. Após uma reinicialização, o raciocínio é traduzido novamente.

## Desenvolvimento

```sh
bun install
bun test
bun run typecheck
```
