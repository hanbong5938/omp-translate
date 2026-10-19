# omp-translate

[English](../README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-Hans.md) | [繁體中文](README.zh-Hant.md) | **Español** | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt.md)

Versión 0.1.0 — una extensión de traducción independiente del idioma para OMP (el agente de programación oh-my-pi).

## Descripción general

- **Traducción del razonamiento**: cada bloque de razonamiento (thinking) completado del asistente se traduce a un idioma de visualización que usted elige y se muestra en la TUI como un mensaje `omp-translate-thinking` independiente. El razonamiento original y el contexto del proveedor nunca se modifican.
- **Traducción de respuestas** (opcional, desactivada por defecto): en la TUI, la respuesta final del agente principal se traduce al idioma de visualización y se muestra en un cuadro `omp-translate` independiente debajo del original. El mensaje original no se modifica.
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
| `/translate answer on\|off` | Activa o desactiva la traducción de respuestas |
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
| `answer` | `false` | Traducir la respuesta final del agente principal (TUI) |
| `targetLanguage` | `""` | Idioma de visualización (`""` = aún no configurado) |
| `requestLanguage` | `"en"` | Idioma al que se traducen los prompts (no puede estar vacío) |
| `model` | `""` | Selector del modelo de traducción (`""` = por defecto) |
| `requestModel` | `""` | Modelo de traducción de prompts (`""` = usar `model`) |

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

**Precedencia de modelos** para la traducción de prompts: `requestModel` → `model` → `@tiny`. La traducción del razonamiento y de las respuestas usa `model` → `@tiny` y el mismo `targetLanguage`. `@tiny` es el rol de modelo pequeño (tiny) de OMP. Un valor vacío nunca significa un proveedor codificado de forma fija.

Las etiquetas de idioma se guardan en forma canónica. Si edita el archivo a mano, las claves ausentes toman sus valores por defecto. Las claves desconocidas, los tipos incorrectos o las etiquetas de idioma no válidas hacen que el archivo sea inválido. Cuando el archivo es inválido, se muestra un error, la traducción permanece inactiva y la extensión no sobrescribe el archivo hasta que usted lo corrija o lo elimine.

## Detalles de funcionamiento

### Traducción del razonamiento

- Solo se traduce el razonamiento completado: los bloques de razonamiento de un mensaje del asistente del agente principal en la TUI una vez que ese mensaje ha terminado, incluidos los mensajes que terminan en una llamada a herramienta, un límite de longitud, un error o una cancelación. Las actualizaciones del streaming nunca se envían. Cada texto completado distinto espera 1,5 s antes de que comience su solicitud de traducción. El razonamiento ocultado (redacted), el razonamiento vacío, los argumentos de herramientas y el texto de la respuesta no se traducen.
- Cada bloque de razonamiento recibe su propio mensaje `omp-translate-thinking` independiente. Los mensajes se publican en el orden en que se completaron los bloques y solo mientras el agente está inactivo: un resultado que termina durante una ejecución espera hasta que el agente quede inactivo. Las traducciones del razonamiento y de las respuestas no están ordenadas entre sí.
- Si una nueva ejecución empieza justo cuando se publica un resultado, el host pone el mensaje en la cola del siguiente turno; entonces aparece bajo el siguiente prompt. La publicación nunca inicia ni redirige (steer) un turno del agente.
- Los resultados se almacenan en caché en memoria (hasta 500 entradas). La clave de caché incluye el modelo, el idioma de destino y el texto. Los textos completados idénticos comparten una misma solicitud; cada aparición recibe igualmente su propio mensaje.
- Cambiar la configuración, cambiar o ramificar la sesión, o finalizar la sesión cancela el trabajo pendiente y descarta los resultados aún no publicados. Las traducciones ya publicadas se conservan.
- Una traducción fallida muestra una advertencia (`Thinking translation failed: …`) y no publica nada.
- Cada traducción tiene un plazo de 20 s.
- El host conserva cada traducción publicada y la vuelve a mostrar al reanudar. Esta extensión filtra esos mensajes de cada solicitud al modelo, igual que con las traducciones de respuestas. Al reanudar no se traduce el razonamiento anterior que no tenga mensaje de traducción.

### Traducción de respuestas

- Solo se traducen las respuestas finales completadas del agente principal en la TUI. No se traducen subagentes, modos no interactivos, continuaciones/reintentos ni turnos con llamadas a herramientas.
- La traducción se ejecuta en segundo plano con un plazo de 60 s y no inicia un nuevo turno del agente. Si termina mientras el agente está ocupado, se retiene y se muestra al finalizar la siguiente ejecución del agente principal.
- Si el modelo omite, duplica o corrompe un marcador de código, la respuesta se vuelve a traducir una vez desde el texto original dentro del mismo plazo de 60 s. Si ese intento también falla, se muestra una advertencia y no se publica ninguna traducción.
- Las traducciones pendientes o retenidas se descartan al cambiar o ramificar la sesión, o al cerrarla. Si el resultado es idéntico al original (ya está en el idioma de destino), no se muestra.
- La respuesta original permanece intacta en la transcripción, en el archivo de sesión y en las solicitudes futuras al LLM. La traducción es un mensaje personalizado aparte (`display: true`, `customType: "omp-translate"`) que el host guarda en la sesión y vuelve a mostrar al reanudarla.
- El plugin excluye siempre estos mensajes del contexto enviado al proveedor, incluso con `answer` desactivado. Esta exclusión solo funciona si el plugin está cargado: no lo desactive al reanudar sesiones con respuestas traducidas, o el host enviará esos mensajes al modelo.
- Si falla la verificación de marcadores de posición, se muestra una advertencia y se omite la traducción de esa respuesta.

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

- La traducción del razonamiento envía el texto de razonamiento completado al proveedor del modelo seleccionado. La traducción de respuestas, si está activada, envía las respuestas finales. La traducción de prompts envía sus prompts. Todas consumen la cuota de ese proveedor.
- El único archivo que escribe la extensión es el archivo de configuración. El host guarda las traducciones publicadas del razonamiento y de las respuestas en el archivo de sesión como mensajes personalizados independientes.
- Las credenciales las resuelve el registro de modelos de OMP. La extensión no lee almacenes de tokens ni registra credenciales, texto de origen ni texto traducido.

## Limitaciones

- El hook de entrada se aplica a las entradas interactivas y RPC, tal como las proporciona OMP.
- La traducción del razonamiento y de las respuestas solo funciona para el agente principal en la TUI. Solo se traduce la respuesta final completada de cada ejecución, no el texto intermedio de los turnos con herramientas.
- La traducción del razonamiento no depende de su visibilidad: el razonamiento oculto con `hideThinkingBlock: true` (o `--hide-thinking`) se sigue traduciendo y mostrando como mensajes independientes. Use `/translate thinking off` para detenerla.
- Las traducciones del razonamiento y de las respuestas se conservan; mantenga la extensión cargada para excluirlas del contexto del modelo al reanudar. El razonamiento de sesiones registradas antes de esta versión, o mientras la traducción del razonamiento estaba desactivada, no se traduce retroactivamente.
- Las versiones anteriores instaladas, con esquema estricto, rechazan la clave `answer`: elimínela del archivo de configuración antes de volver a una versión anterior.

## Desarrollo

```sh
bun install
bun test
bun run typecheck
```
