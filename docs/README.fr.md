# omp-translate

[English](../README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-Hans.md) | [繁體中文](README.zh-Hant.md) | [Español](README.es.md) | **Français** | [Deutsch](README.de.md) | [Português](README.pt.md)

Version 0.1.0 — une extension de traduction indépendante de la langue pour OMP (l'agent de programmation oh-my-pi).

## Présentation

- **Traduction de la réflexion** : chaque bloc de réflexion (thinking) de l'assistant est traduit dans la langue d'affichage de votre choix, et la traduction s'affiche sous l'original dans la TUI. La réflexion originale et le contexte envoyé au fournisseur ne sont jamais modifiés.
- **Traduction des réponses** (facultative, désactivée par défaut) : dans la TUI, la réponse finale de l'agent principal est traduite dans la langue d'affichage et affichée dans un cadre `omp-translate` distinct sous l'original. Le message original n'est pas modifié.
- **Traduction des prompts** (facultative, désactivée par défaut) : les prompts sortants sont traduits dans une langue de requête (l'anglais par défaut) avant leur envoi.

Le texte source peut être dans n'importe quelle langue, y compris un texte mêlant plusieurs langues. La cible peut être n'importe quelle étiquette de langue BCP-47 valide.

## Prérequis

- OMP (testé avec 18.10.4)
- Bun
- Un modèle configuré et authentifié dans OMP

## Installation

### Développement local (lien)

Pour lier une copie locale :

```sh
omp plugin link /path/to/omp-translate
```

### Marketplace locale

Le dépôt contient un catalogue de marketplace dans `.omp-plugin/marketplace.json` :

```sh
omp plugin marketplace add /path/to/omp-translate
omp plugin discover omp-translate
omp plugin install omp-translate@omp-translate
omp plugin list
```

### Dépôt hébergé

Le plugin est publié sur [hanbong5938/omp-translate](https://github.com/hanbong5938/omp-translate). Il n'apparaît dans aucun catalogue par défaut : ajoutez le dépôt comme marketplace, puis installez-le :

```sh
omp plugin marketplace add hanbong5938/omp-translate
omp plugin install omp-translate@omp-translate
```

## Premier lancement

Dans la TUI interactive (session principale uniquement), un sélecteur de langue apparaît une seule fois :

| Libellé | Étiquette |
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
| Custom language tag | toute étiquette BCP-47, canonisée avec `Intl.getCanonicalLocales` |

- Si vous annulez, la traduction reste inactive et la question ne vous est plus posée pendant cette session. Exécutez `/translate setup` plus tard pour choisir une langue.
- La traduction des prompts reste désactivée tant que vous ne l'activez pas avec `/translate request on`.
- Les modes non interactifs (`print`, `json`, `rpc`) et les sous-agents n'affichent jamais de boîte de dialogue. En modes `print`/`json`, une instruction de configuration d'une ligne est écrite sur stderr. En mode `rpc`, une notification est envoyée à la place.

## Commandes

| Commande | Effet |
|---|---|
| `/translate` ou `/translate status` | Afficher les paramètres et l'état actuels |
| `/translate setup` | Ouvrir le sélecteur de langue |
| `/translate thinking on\|off` | Activer ou désactiver la traduction de la réflexion |
| `/translate answer on\|off` | Activer ou désactiver la traduction des réponses |
| `/translate request on\|off` | Activer ou désactiver la traduction des prompts |
| `/translate language <tag>` | Définir la langue d'affichage, p. ex. `/translate language pt-BR` |
| `/translate request-language <tag>` | Définir la langue de requête, p. ex. `/translate request-language en` |
| `/translate model <selector\|clear>` | Définir le modèle de traduction, p. ex. `/translate model provider/model` ou `/translate model @role`. `clear` rétablit la valeur par défaut |
| `/translate request-model <selector\|clear>` | Définir un modèle distinct pour la traduction des prompts. `clear` le fait revenir à `model` |

Les opérandes manquants ou superflus, les étiquettes de langue invalides et les sélecteurs de modèle impossibles à résoudre sont rejetés avec une erreur. Rien n'est enregistré dans ce cas.

## Fichier de paramètres

Les paramètres sont stockés dans `<agent dir>/omp-translate.json`. L'emplacement par défaut est `~/.omp/agent/omp-translate.json`, et le chemin suit les profils OMP et `PI_CONFIG_DIR`.

| Clé | Défaut | Signification |
|---|---|---|
| `thinking` | `true` | Traduire les blocs de réflexion |
| `request` | `false` | Traduire les prompts sortants |
| `answer` | `false` | Traduire la réponse finale de l'agent principal (TUI) |
| `targetLanguage` | `""` | Langue d'affichage (`""` = pas encore configurée) |
| `requestLanguage` | `"en"` | Langue vers laquelle les prompts sont traduits (ne doit pas être vide) |
| `model` | `""` | Sélecteur du modèle de traduction (`""` = défaut) |
| `requestModel` | `""` | Modèle de traduction des prompts (`""` = utiliser `model`) |

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

**Priorité des modèles** pour la traduction des prompts : `requestModel` → `model` → `@tiny`. La traduction de la réflexion et des réponses utilise `model` → `@tiny` et le même `targetLanguage`. `@tiny` est le rôle de petit modèle d'OMP. Une valeur vide ne désigne jamais un fournisseur codé en dur.

Les étiquettes de langue sont stockées sous forme canonique. Si vous modifiez le fichier à la main, les clés manquantes reprennent leurs valeurs par défaut. Des clés inconnues, des types incorrects ou des étiquettes de langue invalides rendent le fichier invalide. Lorsque le fichier est invalide, une erreur s'affiche, la traduction reste inactive et l'extension n'écrase pas le fichier tant que vous ne l'avez pas corrigé ou supprimé.

## Détails du fonctionnement

### Traduction de la réflexion

- Seule la réflexion finalisée est traduite : le texte confirmé par l'hôte (un message terminé, un segment clos par un appel d'outil, l'historique/la reprise). Les instantanés de streaming ne sont jamais envoyés. Chaque texte finalisé distinct attend 1,5 s avant le lancement de sa requête de traduction.
- Nécessite un hôte OMP qui transmet `final` aux moteurs de rendu de la réflexion. Sur un hôte plus ancien, la traduction de la réflexion est désactivée et une erreur s'affiche une fois par session : `omp-translate: thinking translation requires an OMP host with finalized thinking renders; update OMP.` La traduction des prompts et des réponses continue de fonctionner.
- Les résultats sont mis en cache en mémoire (jusqu'à 500 entrées). La clé de cache comprend le modèle, la langue cible et le texte. Les vues affichant un texte identique partagent une même requête.
- Modifier les paramètres, changer de session ou en créer une branche, ou terminer la session annule le travail en attente et efface les traductions déjà affichées.
- Chaque traduction dispose d'un délai de 20 s.

### Traduction des réponses

- Seules les réponses finales terminées de l'agent principal dans la TUI sont traduites. Les sous-agents, les modes non interactifs, les continuations/nouvelles tentatives et les tours avec appels d'outils ne le sont pas.
- La traduction s'exécute en arrière-plan avec un délai de 60 s et ne démarre aucun nouveau tour de l'agent. Si elle se termine pendant que l'agent est occupé, elle est mise de côté et affichée à la fin de la prochaine exécution de l'agent principal.
- Si le modèle omet, duplique ou altère un marqueur de code, la réponse est retraduite une fois à partir du texte original dans le même délai de 60 s. Si cette tentative échoue aussi, un avertissement s'affiche et aucune traduction n'est publiée.
- Les traductions en attente ou mises de côté sont abandonnées lors d'un changement de session, d'une création de branche ou de l'arrêt. Un résultat identique à l'original (déjà dans la langue cible) n'est pas affiché.
- La réponse originale reste intacte dans la transcription, le fichier de session et les futures requêtes au LLM. La traduction est un message personnalisé distinct (`display: true`, `customType: "omp-translate"`) que l'hôte enregistre dans la session et réaffiche à la reprise.
- Le plugin exclut toujours ces messages du contexte envoyé au fournisseur, même lorsque `answer` est désactivé. Cette exclusion ne fonctionne que si le plugin est chargé : ne le désactivez pas lorsque vous reprenez des sessions contenant des réponses traduites, sinon l'hôte enverra ces messages au modèle.
- Si la vérification des espaces réservés échoue, un avertissement s'affiche et la traduction de cette réponse est omise.

### Traduction des prompts

- La traduction a lieu à l'envoi de la saisie. C'est le texte traduit qui est enregistré dans l'historique de la session et affiché comme votre message.
- La syntaxe des commandes de l'hôte n'est pas traduite : commandes slash (`/…`), commandes shell (`!…`), commandes Python (`$ …`, `$$ …` suivis d'un espace) et marqueurs de file d'attente (`->`, `=>`). Les espaces en début de texte sont ignorés. Les images jointes ne sont pas modifiées.
- Si le texte traduit ressemble lui-même à une syntaxe de commande de l'hôte, un avertissement s'affiche et le texte original est envoyé.
- Si la traduction échoue, un avertissement s'affiche et le texte original est envoyé.
- Si la session est changée ou qu'une branche est créée pendant la traduction d'un prompt, celui-ci est abandonné avec un avertissement ; renvoyez-le dans la nouvelle session. À l'arrêt, les prompts en attente sont abandonnés silencieusement.

### Préservation du code

- Les blocs de code délimités et le code en ligne sont remplacés par des espaces réservés avant la traduction, puis restaurés à l'octet près ensuite.
- Si le modèle supprime ou duplique un espace réservé, la traduction est rejetée. Pour les prompts, le texte original est envoyé. Pour la réflexion, un échec est affiché.
- Les autres identifiants et chemins ne sont protégés que par des instructions données au modèle. Une préservation parfaite et une équivalence sémantique ne sont pas garanties.
- Le texte source est encadré par des consignes indiquant au modèle de le traiter comme un texte à traduire. Cet encadrement est une indication, pas une frontière de sécurité.

## Confidentialité et coût

- La traduction de la réflexion envoie le texte de réflexion visible au fournisseur du modèle sélectionné. La traduction des réponses, si elle est activée, envoie les réponses finales. La traduction des prompts envoie vos prompts. Toutes consomment le quota de ce fournisseur.
- Le seul fichier écrit par l'extension est le fichier de paramètres. Les traductions de la réflexion sont conservées uniquement en mémoire ; les traductions des réponses sont enregistrées par l'hôte dans le fichier de session.
- Les identifiants sont résolus par le registre de modèles d'OMP. L'extension ne lit pas les magasins de jetons et ne journalise ni les identifiants, ni le texte source, ni le texte traduit.

## Limitations

- Le hook de saisie s'applique aux saisies interactives et RPC, telles que fournies par OMP.
- Seule la réponse finale de chaque exécution de l'agent principal dans la TUI est traduite, pas le texte intermédiaire des tours avec outils.
- Les traductions de la réflexion ne s'affichent que lorsque les blocs de réflexion sont visibles dans la TUI. Avec `hideThinkingBlock: true` (ou `--hide-thinking`), aucune réflexion n'est traduite ni affichée ; basculez la visibilité avec `Ctrl+T`. La traduction des réponses ne dépend pas de cette visibilité.
- Les traductions de la réflexion ne sont pas persistées. Après un redémarrage, la réflexion est traduite à nouveau.
- Les anciennes versions installées, au schéma strict, rejettent la clé `answer` : supprimez-la du fichier de paramètres avant de revenir à une version antérieure.

## Développement

```sh
bun install
bun test
bun run typecheck
```
