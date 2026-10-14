# omp-translate

[English](../README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-Hans.md) | [繁體中文](README.zh-Hant.md) | **Español** | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt.md)

Versión 0.1.0 — una extensión de traducción independiente del idioma para OMP (el agente de programación oh-my-pi).

## Descripción general

- **Traducción del razonamiento**: cada bloque de razonamiento (thinking) del asistente se traduce a un idioma de visualización que usted elige, y la traducción se muestra debajo del original en la TUI. El razonamiento original y el contexto del proveedor nunca se modifican.
- **Traducción de prompts** (opcional, desactivada por defecto): los prompts salientes se traducen a un idioma de solicitud (inglés por defecto) antes de enviarse.

El texto de origen puede estar en cualquier idioma, incluido texto con varios idiomas mezclados. El destino puede ser cualquier etiqueta de idioma BCP-47 válida.

## Requisitos

- OMP (probado con 18.10.4)
- Bun
- Un modelo configurado y autenticado en OMP

## Instalación

### Desarrollo local (link)

Para enlazar una copia local:

```sh
omp plugin link /path/to/omp-translate
```

### Marketplace local

El repositorio incluye un catálogo de marketplace en `.omp-plugin/marketplace.json`:

```sh
omp plugin marketplace add /path/to/omp-translate
omp plugin discover omp-translate
omp plugin install omp-translate@omp-translate
omp plugin list
```

### Repositorio alojado

El plugin está publicado en [hanbong5938/omp-translate](https://github.com/hanbong5938/omp-translate). No figura en ningún catálogo predeterminado, así que añada el repositorio como marketplace y luego instálelo:

```sh
omp plugin marketplace add hanbong5938/omp-translate
omp plugin install omp-translate@omp-translate
```

## Primera ejecución

En la TUI interactiva (solo en la sesión principal), aparece una vez un selector de idioma:

| Etiqueta | Tag |
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
| Custom language tag | cualquier etiqueta BCP-47, canonicalizada con `Intl.getCanonicalLocales` |

- Si cancela, la traducción permanece inactiva y no se le volverá a preguntar en esta sesión. Ejecute `/translate setup` más tarde para elegir un idioma.
- La traducción de prompts permanece desactivada hasta que la active con `/translate request on`.
- Los modos no interactivos (`print`, `json`, `rpc`) y los subagentes nunca muestran diálogos. En los modos `print`/`json` se escribe en stderr una instrucción de configuración de una línea. En el modo `rpc` se envía una notificación en su lugar.

## Comandos

| Comando | Efecto |
|---|---|
| `/translate` o `/translate status` | Muestra la configuración y el estado actuales |
| `/translate setup` | Abre el selector de idioma |
| `/translate thinking on\|off` | Activa o desactiva la traducción del razonamiento |
| `/translate request on\|off` | Activa o desactiva la traducción de prompts |
| `/translate language <tag>` | Establece el idioma de visualización, p. ej. `/translate language pt-BR` |
| `/translate request-language <tag>` | Establece el idioma de solicitud, p. ej. `/translate request-language en` |
| `/translate model <selector\|clear>` | Establece el modelo de traducción, p. ej. `/translate model provider/model` o `/translate model @role`. `clear` restaura el valor por defecto |
| `/translate request-model <selector\|clear>` | Establece un modelo independiente para la traducción de prompts. `clear` hace que vuelva a usar `model` |

Los operandos ausentes o sobrantes, las etiquetas de idioma no válidas y los selectores de modelo que no se pueden resolver se rechazan con un error. En ese caso no se guarda nada.

## Archivo de configuración

La configuración se guarda en `<agent dir>/omp-translate.json`. La ubicación por defecto es `~/.omp/agent/omp-translate.json`, y la ruta respeta los perfiles de OMP y `PI_CONFIG_DIR`.

| Clave | Por defecto | Significado |
|---|---|---|
| `thinking` | `true` | Traducir los bloques de razonamiento |
| `request` | `false` | Traducir los prompts salientes |
| `targetLanguage` | `""` | Idioma de visualización (`""` = aún no configurado) |
| `requestLanguage` | `"en"` | Idioma al que se traducen los prompts (no puede estar vacío) |
| `model` | `""` | Selector del modelo de traducción (`""` = por defecto) |
| `requestModel` | `""` | Modelo de traducción de prompts (`""` = usar `model`) |

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

**Precedencia de modelos** para la traducción de prompts: `requestModel` → `model` → `@tiny`. La traducción del razonamiento usa `model` → `@tiny`. `@tiny` es el rol de modelo pequeño (tiny) de OMP. Un valor vacío nunca significa un proveedor codificado de forma fija.

Las etiquetas de idioma se guardan en forma canónica. Si edita el archivo a mano, las claves ausentes toman sus valores por defecto. Las claves desconocidas, los tipos incorrectos o las etiquetas de idioma no válidas hacen que el archivo sea inválido. Cuando el archivo es inválido, se muestra un error, la traducción permanece inactiva y la extensión no sobrescribe el archivo hasta que usted lo corrija o lo elimine.

## Detalles de funcionamiento

### Traducción del razonamiento

- Cada texto de razonamiento distinto espera 1,5 s antes de que comience su solicitud de traducción. Las instantáneas distintas del streaming son solicitudes independientes, por lo que un bloque largo transmitido en streaming puede generar varias llamadas al modelo.
- Los resultados se almacenan en caché en memoria (hasta 500 entradas). La clave de caché incluye el modelo, el idioma de destino y el texto. Las vistas que muestran un texto idéntico comparten una misma solicitud.
- Cambiar la configuración, cambiar o ramificar la sesión, o finalizar la sesión cancela el trabajo pendiente y borra las traducciones ya mostradas en pantalla.
- Cada traducción tiene un plazo de 20 s.

### Traducción de prompts

- La traducción se realiza al enviar la entrada. El texto traducido es lo que se guarda en el historial de la sesión y lo que se muestra como su mensaje.
- La sintaxis de comandos del host no se traduce: comandos slash (`/…`), comandos de shell (`!…`), comandos de Python (`$ …`, `$$ …` seguidos de un espacio en blanco) y marcadores de cola (`->`, `=>`). Los espacios en blanco iniciales se ignoran. Las imágenes adjuntas no se modifican.
- Si el propio texto traducido parece sintaxis de comandos del host, se muestra una advertencia y se envía el texto original.
- Si la traducción falla, se muestra una advertencia y se envía el texto original.
- Si se cambia o ramifica la sesión mientras se traduce un prompt, el prompt se descarta con una advertencia; vuelva a enviarlo en la nueva sesión. Al cerrar, los prompts pendientes se descartan sin aviso.

### Preservación del código

- Los bloques de código delimitados y los fragmentos de código en línea se sustituyen por marcadores de posición antes de la traducción y se restauran byte a byte después.
- Si el modelo omite o duplica un marcador de posición, la traducción se rechaza. En el caso de los prompts, se envía el texto original. En el caso del razonamiento, se muestra un fallo.
- Los demás identificadores y rutas solo están protegidos mediante instrucciones al modelo. No se garantiza una preservación perfecta ni la equivalencia semántica.
- El texto de origen se envuelve en un encuadre que indica al modelo que lo trate como texto a traducir. Este encuadre es una orientación, no una barrera de seguridad.

## Privacidad y coste

- La traducción del razonamiento envía el texto de razonamiento visible al proveedor del modelo seleccionado. La traducción de prompts envía sus prompts. Ambas consumen la cuota de ese proveedor.
- El único archivo que escribe la extensión es el archivo de configuración. Las traducciones se guardan solo en memoria.
- Las credenciales las resuelve el registro de modelos de OMP. La extensión no lee almacenes de tokens ni registra credenciales, texto de origen ni texto traducido.

## Limitaciones

- El hook de entrada se aplica a las entradas interactivas y RPC, tal como las proporciona OMP.
- Las respuestas del asistente no se traducen.
- Las traducciones del razonamiento solo se muestran mientras los bloques de razonamiento son visibles en la TUI. Con `hideThinkingBlock: true` (o `--hide-thinking`), no se traduce ni se muestra nada; alterne la visibilidad con `Ctrl+T`.
- Las traducciones no se conservan. Tras un reinicio, el razonamiento se vuelve a traducir.

## Desarrollo

```sh
bun install
bun test
bun run typecheck
```
