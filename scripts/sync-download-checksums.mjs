#!/usr/bin/env node
// sync-download-checksums.mjs — synchronise les `ARG <OUTIL>_SHA256` du Dockerfile
// avec les `ARG <OUTIL>_VERSION` correspondants.
//
// POURQUOI CE SCRIPT EXISTE
// Le Dockerfile épingle, pour chacun des 3 outils (gws, gh, kubectl),
// une version ET le SHA-256 attendu de l'artefact téléchargé (finding S-01 :
// le téléchargement est vérifié AVANT extraction). Renovate sait bumper l'ARG
// version, mais aucune des datasources utilisées (github-releases, github-tags)
// ne sait fournir le SHA-256 d'une archive sous forme de `currentDigest` :
// Renovate échoue, abandonne la recherche, ou écrit un SHA de commit git sans
// rapport. Le SHA-256 restait donc périmé et le build cassait sur
// `sha256sum -c`. Ce script est le maillon manquant : c'est lui qui recalcule le
// SHA-256 après un bump de version (voir renovate.json postUpgradeTasks) et c'est
// lui qui vérifie l'accord version/checksum en CI (mode --check).
//
// POURQUOI DEUX SOURCES, ET CE QUE ÇA NE COUVRE PAS (S-01)
// Avant d'écrire une valeur, on récupère le checksum PUBLIÉ en amont, puis on
// télécharge l'artefact et on recalcule son SHA-256 nous-mêmes ; rien n'est
// écrit si les deux ne concordent pas. Attention à la portée réelle de cette
// contre-vérification : pour un outil donné, le checksum publié et l'artefact
// viennent du MÊME éditeur, sur le MÊME domaine et la même chaîne TLS. Elle
// attrape un téléchargement tronqué, un cache/miroir divergent, une publication
// incohérente — PAS un éditeur qui publierait un artefact malveillant avec le
// checksum correspondant (compromission de compte de release). Ce qui reste
// acquis vs une résolution à la volée dans le Dockerfile : la valeur est figée
// dans le dépôt, relisible dans le diff de la PR, et rejouée au build contre le
// CDN. Le seul délai humain sur ce chemin est `minimumReleaseAge` (3 jours).
//
// MODES ET CODES DE SORTIE
// --check : sort 1 dès qu'un checksum ne peut pas être déclaré à jour, c'est-à-dire
//   (a) le checksum commité diffère du checksum publié en amont — la divergence est
//   CERTAINE à ce stade, l'artefact ne sert qu'à dire lequel des deux a raison, donc
//   il n'a pas droit de veto sur le code de sortie ; (b) l'amont a répondu mais la
//   valeur publiée est introuvable ou illisible (nom de fichier absent de `gh_<V>_checksums.txt`, asset 404, renommage amont) :
//   « je n'ai pas pu établir la valeur publiée » est un échec de vérification, pas
//   une panne d'amont ; (c) TOUS les amonts sélectionnés sont indisponibles — la
//   garde n'a alors rien vérifié, et un vert serait indiscernable d'un vrai
//   contrôle ; (d) avec `--verify-artifacts`, moins d'artefacts rehashés que
//   d'outils sélectionnés (c'est la seule rejouée régulière de S-01, elle ne doit
//   pas se dégrader en avertissement dans un run post-merge que personne ne relit).
//   Une INDISPONIBILITÉ PARTIELLE (erreur réseau/DNS/TLS, 5xx, throttling — 429,
//   ou 403 portant un indice de throttling —, flux coupé, budget épuisé) est
//   retentée puis signalée en AVERTISSEMENT sans faire échouer le job : elle ne
//   doit pas rendre `main` non mergeable alors que l'image reste construisible.
//   Chemin OK : aucun artefact n'est retéléchargé (3 petites requêtes). ATTENTION à
//   la portée de ce raccourci : le `sha256sum -c` du Dockerfile rehashe bien l'archive
//   réellement téléchargée, mais `pr-validation.yml` build avec `cache-from: type=gha`,
//   donc la couche `RUN curl … && sha256sum -c` n'est rejouée que lorsque son `ARG`
//   version ou SHA change. Sur une PR qui ne touche pas ces lignes, PERSONNE ne
//   rehashe d'octets. C'est pourquoi `--verify-artifacts` existe et est utilisé sur
//   `push: main` (voir pr-validation.yml).
// --write : tout échec est fatal (exit 1, rien n'est écrit) pour que Renovate
//   remonte un `artifactErrors` visible dans la PR plutôt qu'un checksum faux.
//
// BUDGET DE TEMPS
// Chaque requête a un timeout (60 s, 5 min pour un artefact) et 3 tentatives avec
// backoff ; un budget GLOBAL borne l'ensemble du run pour que la garde ne puisse pas
// occuper le job pendant des dizaines de minutes avant le build : 10 min en
// `--check`, 20 min avec `--verify-artifacts` (artefacts des 3 outils). Ce budget
// est RÉPARTI en tranches égales entre les outils restants, sinon un seul amont
// dégradé le consommait en entier et les suivants sortaient « budget épuisé » sans
// avoir émis une requête. Conséquence assumée : le pire cas annoncé par outil
// (3 tentatives × 5 min sur un artefact) dépasse sa tranche, donc les tentatives
// supplémentaires ne servent qu'aux échecs RAPIDES (flux coupé d'emblée) ; un
// artefact simplement trop lent épuise sa tranche, et c'est alors un ÉCHEC sous
// `--verify-artifacts` (cas (d) ci-dessus), pas un avertissement. Le job
// `build-and-verify` porte en plus un `timeout-minutes` (borne dure).
//
// CONTRAINTE : SANS DÉPENDANCE
// Ce script tourne dans le conteneur ghcr.io/renovatebot/renovate, qui embarque
// Node mais ne garantit ni curl ni jq. Il doit donc rester en ESM pur, n'utiliser
// que les modules `node:` et le `fetch` global, et le dépôt ne doit contenir ni
// package.json ni node_modules.
//
// TABLE `TOOLS` ↔ LIGNES `RUN` DU DOCKERFILE
// La table ci-dessous duplique les URLs d'artefacts des `RUN curl` du Dockerfile.
// Une divergence (renommage d'asset amont, passage de gws en -musl…) donnerait
// une garde verte et un build rouge. Pour fermer la boucle, chaque URL est
// recroisée avec le Dockerfile AVANT tout appel réseau : l'URL modèle
// (`${<OUTIL>_VERSION}` en place de la version) doit apparaître telle quelle dans
// l'instruction `RUN` qui vérifie `${<OUTIL>_SHA256}` — pas ailleurs dans le
// fichier. Les lignes de commentaire sont ignorées : un commentaire citant
// l'ancienne URL ne doit pas pouvoir valider un `RUN` basculé sur une autre.
// Corollaire assumé : retirer un outil de l'image (règle 4 d'AGENTS.md) impose
// d'éditer cette table dans le même commit.
//
// Usage : node scripts/sync-download-checksums.mjs [--check|--write] [--only=<outil>]
//                                                  [--verify-artifacts]

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = join(SCRIPT_DIR, '..', 'Dockerfile');
const HEX64 = /^[0-9a-f]{64}$/;
const USER_AGENT = 'hermes-lya-config-sync-download-checksums';
const HTTP_TIMEOUT_MS = 60_000;
// `AbortSignal.timeout` couvre aussi la lecture du corps : 60 s peuvent être
// serrés sur un runner lent, d'où ARTIFACT_TIMEOUT_MS plus large.
const ARTIFACT_TIMEOUT_MS = 300_000;
const HTTP_ATTEMPTS = 3;
const HTTP_RETRY_DELAY_MS = 2_000;
// Borne globale du run, tous outils confondus (retries inclus). Sans elle, 3 outils
// × 3 tentatives × timeout tiendraient le job requis occupé avant le build.
// Elle est RÉPARTIE en tranches égales entre les outils restants (voir
// `startToolBudget`) : sans tranche, un seul amont dégradé consommait la totalité
// et les outils suivants sortaient en « budget épuisé » sans avoir émis une requête.
const GLOBAL_BUDGET_MS = 10 * 60_000;
// Avec --verify-artifacts, les 3 artefacts sont retéléchargés : la borne est
// relevée pour que chaque artefact dispose d'une tranche utilisable, tout en
// restant sous le `timeout-minutes` du job `build-and-verify`.
const GLOBAL_BUDGET_ARTIFACTS_MS = 20 * 60_000;
// Statuts qui décrivent une indisponibilité passagère, donc retentables — et, une
// fois les tentatives épuisées, classés « amont indisponible ».
// Un 404 N'EST PAS retenté et N'EST PAS une indisponibilité : l'asset n'existe pas
// (version inexistante, asset renommé/retiré), c'est un échec de vérification.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
// 403 est ambigu et ne peut pas être classé sur le seul code : GitHub le renvoie
// sur throttling secondaire (indisponibilité, à retenter) alors que certains
// amonts le renvoient pour un objet INEXISTANT. On ne le retente donc que s'il
// ressemble à du throttling (en-têtes ou corps), sinon c'est un échec de
// vérification comme un 404.
const THROTTLING_HINT = /rate limit|secondary rate|abuse detection|too many requests|throttl/i;

// --- Table des outils ------------------------------------------------------
// `prefix`  : préfixe des ARG dans le Dockerfile (ARG <prefix>_VERSION / _SHA256)
// `aliases` : noms acceptés par --only, y compris les depName Renovate
// `artifact`: URL de l'artefact réellement téléchargé par le Dockerfile
// `upstream`: résolution du checksum publié en amont -> { url, body, value }
const TOOLS = [
  {
    prefix: 'GWS',
    label: 'Google Workspace CLI',
    aliases: ['gws', 'googleworkspace/cli', 'google-workspace-cli'],
    artifact: (v) =>
      `https://github.com/googleworkspace/cli/releases/download/v${v}/google-workspace-cli-x86_64-unknown-linux-gnu.tar.gz`,
    // Corps de la forme « <hex>  <nom de fichier> » : on prend le premier champ.
    upstream: async (v, tool) => {
      const url = `${tool.artifact(v)}.sha256`;
      const body = await httpText(url);
      return { url, body, value: body.trim().split(/\s+/)[0] };
    },
  },
  {
    prefix: 'GH',
    label: 'GitHub CLI',
    aliases: ['gh', 'cli/cli', 'github-cli'],
    artifact: (v) =>
      `https://github.com/cli/cli/releases/download/v${v}/gh_${v}_linux_amd64.tar.gz`,
    // Le fichier liste aussi les .deb et .rpm : on compare le nom de fichier
    // à l'identique, jamais par sous-chaîne.
    upstream: async (v) => {
      const url = `https://github.com/cli/cli/releases/download/v${v}/gh_${v}_checksums.txt`;
      const body = await httpText(url);
      const wanted = `gh_${v}_linux_amd64.tar.gz`;
      let value;
      for (const line of body.split('\n')) {
        const [hex, file] = line.trim().split(/\s+/);
        if (file === wanted) {
          value = hex;
          break;
        }
      }
      return { url, body, value };
    },
  },
  {
    prefix: 'KUBECTL',
    label: 'kubectl',
    aliases: ['kubectl', 'kubernetes/kubernetes', 'kubernetes'],
    // Binaire nu, pas une archive : le checksum porte sur le binaire lui-même.
    artifact: (v) => `https://dl.k8s.io/release/v${v}/bin/linux/amd64/kubectl`,
    // Hex brut, sans nom de fichier et sans garantie de saut de ligne final.
    upstream: async (v, tool) => {
      const url = `${tool.artifact(v)}.sha256`;
      const body = await httpText(url);
      return { url, body, value: body.trim() };
    },
  }
];

// --- Classification des échecs --------------------------------------------

/**
 * INDISPONIBILITÉ amont : erreur réseau/DNS/TLS, 5xx, throttling (403/429), flux
 * coupé, budget global épuisé. Rien n'est su du checksum, mais rien ne prouve
 * qu'il est faux. `--check` le signale en AVERTISSEMENT (exit 0), `--write` le
 * traite comme fatal. Voir l'en-tête « MODES ET CODES DE SORTIE ».
 */
class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/**
 * ÉCHEC DE VÉRIFICATION : l'amont a répondu et sa réponse contredit le dépôt, ou
 * ne permet pas d'établir la valeur publiée (404, asset renommé/retiré, version
 * absente de l'index, réponse illisible, checksum publié ≠ artefact rehashé).
 * Fatal dans LES DEUX modes : ce n'est pas une panne, c'est le Dockerfile ou la
 * table TOOLS qui est en défaut.
 */
class VerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerificationError';
  }
}

// --- Utilitaires réseau / parsing -----------------------------------------

let budgetDeadline = null;
let budgetTotalMs = null;
let toolDeadline = null;

function startBudget(ms) {
  budgetTotalMs = ms;
  budgetDeadline = Date.now() + ms;
  toolDeadline = null;
}

/**
 * Ouvre la tranche de budget de l'outil courant : ce qui reste du budget global
 * divisé par le nombre d'outils encore à traiter, celui-ci compris. Un amont qui
 * traîne ne peut donc pas priver les suivants de leur vérification, et le pire cas
 * d'un outil est borné même quand la politique de retry annoncée (3 tentatives,
 * jusqu'à 5 min pour un artefact) dépasse la tranche : les tentatives 2 et 3 ne
 * servent alors qu'aux échecs RAPIDES (flux coupé d'emblée), un artefact
 * simplement trop lent épuise sa tranche et sort en erreur de budget — rouge sous
 * `--verify-artifacts` (voir main).
 */
function startToolBudget(remainingTools) {
  if (budgetDeadline === null || remainingTools <= 0) {
    toolDeadline = null;
    return;
  }
  const left = Math.max(0, budgetDeadline - Date.now());
  toolDeadline = Date.now() + Math.floor(left / remainingTools);
}

function remainingBudgetMs() {
  const global =
    budgetDeadline === null ? Number.POSITIVE_INFINITY : budgetDeadline - Date.now();
  const tool = toolDeadline === null ? Number.POSITIVE_INFINITY : toolDeadline - Date.now();
  return Math.min(global, tool);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function warn(message) {
  // Annotation GitHub Actions en CI, ligne lisible ailleurs.
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::warning::${message.replace(/\n/g, ' ')}`);
  }
  console.warn(`AVERTISSEMENT : ${message}`);
}

/**
 * Réponse qui ressemble à du throttling plutôt qu'à un refus définitif : en-tête
 * `retry-after`, quota GitHub épuisé, ou corps qui le dit. Sert à trancher les 403
 * ET RIEN D'AUTRE (voir l'appel dans `httpGet`) : appliqué à tous les statuts, il
 * transformait un 404 portant `retry-after` en indisponibilité, donc en garde
 * verte, alors qu'un 404 dit que l'asset n'existe pas.
 */
function isThrottling(res, body) {
  if (res.headers.get('retry-after')) return true;
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (remaining !== null && Number(remaining) === 0) return true;
  return THROTTLING_HINT.test(body ?? '');
}

/**
 * GET avec timeout par tentative, budget global et retry sur erreur réseau ou
 * statut passager. Un statut non retentable (404 en tête, 403 sans indice de
 * throttling) lève une `VerificationError` : l'amont a répondu, et sa réponse dit
 * que ce qu'on cherche n'existe pas.
 */
async function httpGet(url, { timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= HTTP_ATTEMPTS; attempt += 1) {
    const remaining = remainingBudgetMs();
    if (remaining <= 0) {
      throw new UpstreamError(
        `budget de temps épuisé avant ${url} (borne globale ` +
          `${Math.round((budgetTotalMs ?? 0) / 1000)} s, répartie en tranches égales ` +
          'entre les outils)',
      );
    }

    let res;
    try {
      res = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(Math.min(timeoutMs, remaining)),
      });
    } catch (error) {
      lastError = new UpstreamError(
        `${url} injoignable (${error instanceof Error ? error.message : error})`,
      );
      if (attempt < HTTP_ATTEMPTS) {
        await sleep(HTTP_RETRY_DELAY_MS * attempt);
        continue;
      }
      throw lastError;
    }

    if (res.ok) return res;

    // Corps d'erreur : lu (et non simplement annulé) parce qu'il sert à
    // distinguer un throttling d'un refus définitif, et à enrichir le message.
    const errorBody = await res.text().catch(() => '');

    // Le test de throttling ne s'applique QU'AU 403, seul statut ambigu : un 404
    // n'est jamais une indisponibilité, même accompagné d'un `retry-after` ou
    // d'un `x-ratelimit-remaining: 0` (l'asset n'existe pas, point).
    if (RETRYABLE_STATUS.has(res.status) || (res.status === 403 && isThrottling(res, errorBody))) {
      lastError = new UpstreamError(`HTTP ${res.status} ${res.statusText} sur ${url}`);
      if (attempt < HTTP_ATTEMPTS) {
        await sleep(HTTP_RETRY_DELAY_MS * attempt);
        continue;
      }
      throw lastError;
    }

    // Un 403 sans en-tête ni corps exploitable n'est pas forcément l'amont : un
    // proxy de sortie, un WAF ou un CDN qui refuse le user-agent produit la même
    // réponse. Le fail-closed reste le bon comportement, mais le message doit
    // citer cette piste au lieu d'envoyer chercher un asset renommé.
    const intermediaryHint =
      res.status === 403
        ? ' Hypothèse à écarter en premier sur un 403 sans corps : un intermédiaire ' +
          'réseau (proxy de sortie, WAF, CDN refusant le user-agent) plutôt que ' +
          "l'amont — rejouer la même URL depuis un autre réseau tranche en une minute."
        : '';

    throw new VerificationError(
      `HTTP ${res.status} ${res.statusText} sur ${url}. L'amont a répondu et refuse ` +
        "cette URL : version inexistante, asset renommé ou retiré. Ce n'est pas une " +
        'indisponibilité passagère (aucun indice de throttling dans la réponse) : ' +
        'corriger la version épinglée du Dockerfile ou la table TOOLS de ce script.' +
        intermediaryHint +
        (errorBody ? `\nDébut de la réponse : ${errorBody.slice(0, 200)}` : ''),
    );
  }
  throw lastError;
}

async function httpText(url) {
  return (await httpGet(url)).text();
}

/**
 * SHA-256 calculé en flux : on ne bufferise pas l'artefact en mémoire.
 * La coupure de flux se produit hors de `httpGet`, donc la boucle de retry est
 * ici (sinon un flux interrompu ne serait jamais retenté).
 */
async function computeSha256(url) {
  let lastError;
  for (let attempt = 1; attempt <= HTTP_ATTEMPTS; attempt += 1) {
    const res = await httpGet(url, { timeoutMs: ARTIFACT_TIMEOUT_MS });
    if (!res.body) {
      throw new UpstreamError(`Réponse sans corps pour ${url}`);
    }
    const hash = createHash('sha256');
    try {
      for await (const chunk of Readable.fromWeb(res.body)) {
        hash.update(chunk);
      }
      return hash.digest('hex');
    } catch (error) {
      // Flux coupé en cours de route : indisponibilité, pas écart de checksum.
      lastError = new UpstreamError(
        `Téléchargement interrompu pour ${url} (${error instanceof Error ? error.message : error})`,
      );
      if (attempt < HTTP_ATTEMPTS) {
        await sleep(HTTP_RETRY_DELAY_MS * attempt);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError;
}

// --- Dockerfile ------------------------------------------------------------

function readDockerfile() {
  return readFileSync(DOCKERFILE, 'utf8');
}

function versionRegex(prefix) {
  return new RegExp(`^ARG ${prefix}_VERSION=(\\S*)$`, 'm');
}

function shaRegex(prefix) {
  return new RegExp(`^ARG ${prefix}_SHA256=(\\S*)$`, 'm');
}

/**
 * Lit version + checksum commité des outils DEMANDÉS (pas des trois) : sous
 * `--only=cli/cli`, un outil retiré de l'image ne doit pas faire échouer la
 * synchro de Go. La liste complète reste exigée par `--check` sans `--only`,
 * ce qui est le comportement fail-closed voulu : retirer un outil du Dockerfile
 * impose d'éditer la table TOOLS dans le même commit (AGENTS.md, règles 4 et 5).
 */
function parseDockerfile(content, tools) {
  const parsed = new Map();
  const missing = [];
  for (const tool of tools) {
    const version = content.match(versionRegex(tool.prefix))?.[1];
    const sha256 = content.match(shaRegex(tool.prefix))?.[1];
    if (!version) missing.push(`ARG ${tool.prefix}_VERSION=`);
    if (sha256 === undefined) missing.push(`ARG ${tool.prefix}_SHA256=`);
    parsed.set(tool.prefix, { version, sha256 });
  }
  if (missing.length > 0) {
    throw new Error(
      `Dockerfile incomplet : ligne(s) introuvable(s) -> ${missing.join(', ')}. ` +
        'Chaque outil géré doit garder son couple version/SHA256, chacun sur une ' +
        'seule ligne (voir AGENTS.md et la disposition des couches P-02). Si ' +
        "l'outil a été retiré de l'image, le retirer aussi de la table TOOLS de " +
        'ce script, dans le même commit.',
    );
  }
  return parsed;
}

/**
 * Instructions `RUN` du Dockerfile, une entrée par instruction LOGIQUE
 * (continuations `\` recollées), lignes de commentaire exclues. Le recroisement
 * d'URL ne doit voir que du code : un commentaire citant l'URL attendue ne doit
 * pas pouvoir valider un `RUN` qui télécharge autre chose.
 */
function dockerfileRunInstructions(content) {
  const instructions = [];
  let current = null;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    // Un commentaire peut apparaître AU MILIEU d'une continuation : il n'est
    // jamais du code, on le saute sans clore l'instruction en cours.
    if (line.startsWith('#')) continue;
    if (current === null) {
      if (!/^RUN\s/.test(line)) continue;
      current = [line];
    } else {
      current.push(line);
    }
    if (!line.endsWith('\\')) {
      instructions.push(current.join('\n'));
      current = null;
    }
  }
  if (current !== null) instructions.push(current.join('\n'));
  return instructions;
}

// `\S*` avale la ponctuation collée à l'URL : guillemets, parenthèse ou virgule
// fermantes, antislash de continuation. On la retire pour que le message d'erreur
// ne compare pas deux URLs visuellement identiques.
const URL_TRAILING_JUNK = /["'`,;<>()[\]{}\\]+$/;

/**
 * URLs d'artefacts (avec `${<OUTIL>_VERSION}` non substitué) lues dans les
 * instructions `RUN` qui vérifient `${<OUTIL>_SHA256}` — donc dans le `RUN` qui
 * télécharge réellement l'artefact couvert par ce checksum, et nulle part ailleurs.
 */
function dockerfileArtifactUrls(content, prefix) {
  const re = new RegExp(`https://\\S*\\$\\{${prefix}_VERSION\\}\\S*`, 'g');
  const urls = new Set();
  for (const run of dockerfileRunInstructions(content)) {
    if (!run.includes(`\${${prefix}_SHA256}`)) continue;
    for (const match of run.matchAll(re)) {
      urls.add(match[0].replace(URL_TRAILING_JUNK, ''));
    }
  }
  return [...urls];
}

/**
 * Recroise l'URL de la table TOOLS avec celle réellement téléchargée par le
 * Dockerfile. Sans ça, une divergence donnerait une garde verte et un build
 * rouge sur `sha256sum -c` (exactement le symptôme opaque que ce script existe
 * pour supprimer). Vérifié avant tout appel réseau.
 */
function assertArtifactUrlMatchesDockerfile(content, tool) {
  const expected = tool.artifact(`\${${tool.prefix}_VERSION}`);
  const found = dockerfileArtifactUrls(content, tool.prefix);
  if (found.includes(expected)) return;
  throw new Error(
    `URL d'artefact divergente pour ${tool.prefix} (${tool.label}) :\n` +
      `  table TOOLS du script : ${expected}\n` +
      `  Dockerfile            : ${found.length > 0 ? found.join('\n                          ') : `(aucune URL dans le RUN qui vérifie \${${tool.prefix}_SHA256})`}\n` +
      'Le script recalculerait le checksum d\'un autre fichier que celui que le ' +
      'build télécharge. Aligner la table TOOLS sur le `RUN curl` du Dockerfile ' +
      '(seules les lignes de code du `RUN` correspondant sont lues, pas les commentaires).',
  );
}

/** Réécrit UNIQUEMENT la ligne ARG <prefix>_SHA256= ; le reste est intact. */
function rewriteSha(content, prefix, value) {
  const re = shaRegex(prefix);
  if (!re.test(content)) {
    throw new Error(`Impossible de réécrire ARG ${prefix}_SHA256= : ligne introuvable`);
  }
  return content.replace(re, `ARG ${prefix}_SHA256=${value}`);
}

// --- Résolution + contre-vérification -------------------------------------

/**
 * Checksum publié en amont pour cette version.
 * Indisponibilité -> UpstreamError (levée par httpGet). Réponse lisible dont on
 * n'extrait pas 64 caractères hexadécimaux -> VerificationError : la valeur
 * publiée n'a pas pu être établie, ce qui est un échec de vérification et non
 * une panne d'amont (version absente de l'index, asset renommé, réponse HTML…).
 */
async function fetchPublishedChecksum(tool, version) {
  const { url, body, value } = await tool.upstream(version, tool);
  if (typeof value !== 'string' || !HEX64.test(value)) {
    throw new VerificationError(
      `Checksum amont introuvable pour ${tool.prefix} ${version} : ` +
        `la source ${url} a répondu, mais n'a pas fourni 64 caractères hexadécimaux ` +
        `(valeur extraite : ${JSON.stringify(value)}).\n` +
        'Causes usuelles : version épinglée absente en amont, asset renommé ou ' +
        'retiré, format de la source amont modifié -> corriger la version du ' +
        'Dockerfile ou la table TOOLS de ce script.\n' +
        `Début de la réponse (200 premiers caractères) :\n${String(body).slice(0, 200)}`,
    );
  }
  return { value, url };
}

/**
 * Contre-vérification S-01 : retélécharge l'artefact et recalcule son SHA-256.
 * Renvoie la valeur recalculée. Une divergence publié/recalculé n'est PAS un
 * problème d'amont : c'est fatal dans les deux modes (VerificationError).
 * Appelée avant toute écriture, et pour ARBITRER un écart déjà détecté — dans ce
 * dernier cas elle ne décide QUE le message, pas le code de sortie (voir main).
 */
async function verifyAgainstArtifact(tool, version, published, publishedUrl) {
  const artifactUrl = tool.artifact(version);
  const computed = await computeSha256(artifactUrl);
  if (computed !== published) {
    throw new VerificationError(
      `Contre-vérification ÉCHOUÉE pour ${tool.prefix} ${version} (${tool.label}).\n` +
        `  artefact          : ${artifactUrl}\n` +
        `  checksum publié   : ${published} (${publishedUrl})\n` +
        `  checksum recalculé: ${computed}\n` +
        'Aucune valeur n\'est écrite : les deux sources doivent concorder (S-01).',
    );
  }
  return computed;
}

// --- CLI -------------------------------------------------------------------

const USAGE = `Usage : node scripts/sync-download-checksums.mjs [options]

Synchronise les ARG <OUTIL>_SHA256 du Dockerfile avec les ARG <OUTIL>_VERSION,
en croisant le checksum publié en amont et un SHA-256 recalculé localement.

Options :
  --check             (défaut) ne modifie rien. Sort 1 si un checksum commité
                      diffère du checksum publié en amont, si la valeur publiée
                      n'a pas pu être établie (404, 403 sur objet absent, asset
                      renommé, version absente de l'index), ou si TOUS les amonts
                      sélectionnés sont indisponibles (rien n'a été vérifié). Une
                      indisponibilité PARTIELLE (réseau, 5xx, throttling) est
                      retentée puis signalée en AVERTISSEMENT, sans faire échouer
                      la commande.
  --write             réécrit la ligne ARG <OUTIL>_SHA256 des outils concernés.
                      Tout échec est fatal et n'écrit rien.
  --only=<outil>      limite le traitement à un outil. Accepte gws, gh, kubectl,
                      ainsi que les depName Renovate (googleworkspace/cli,
                      cli/cli, kubernetes/kubernetes). Une valeur
                      inconnue sort en 0 sans rien écrire.
  --verify-artifacts  retélécharge et rehashe l'artefact de CHAQUE outil, même
                      quand le checksum commité est déjà à jour. Sert à
                      rejouer la contre-vérification S-01 que le cache de couches
                      Docker ne rejoue pas sur les PRs : utilisé sur push: main,
                      pas sur chaque PR. Sort 1 si un seul artefact n'a pas pu
                      être rehashé (amont injoignable, flux coupé, budget épuisé) :
                      ce mode n'a de valeur que complet.
  --help              affiche cette aide

Outils gérés : ${TOOLS.map((t) => t.prefix).join(', ')}
`;

function parseArgs(argv) {
  const options = { mode: 'check', only: null, help: false, verifyArtifacts: false };
  for (const arg of argv) {
    if (arg === '--check') options.mode = 'check';
    else if (arg === '--write') options.mode = 'write';
    else if (arg === '--verify-artifacts') options.verifyArtifacts = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--only=')) options.only = arg.slice('--only='.length).trim();
    else throw new Error(`Option inconnue : ${arg}\n\n${USAGE}`);
  }
  return options;
}

function selectTools(only) {
  if (!only) return TOOLS;
  const needle = only.toLowerCase();
  return TOOLS.filter(
    (t) => t.prefix.toLowerCase() === needle || t.aliases.includes(needle),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const selected = selectTools(options.only);
  if (selected.length === 0) {
    // Cas normal en postUpgradeTasks : Renovate a bumpé une Action ou l'image de
    // base, aucun de nos 3 outils n'est concerné. Ce n'est pas une erreur.
    console.log(
      `--only=${options.only} ne correspond à aucun outil géré ` +
        `(${TOOLS.map((t) => t.aliases[0]).join(', ')}) : rien à faire.`,
    );
    return 0;
  }

  startBudget(options.verifyArtifacts ? GLOBAL_BUDGET_ARTIFACTS_MS : GLOBAL_BUDGET_MS);

  let content = readDockerfile();
  const state = parseDockerfile(content, selected);
  const isCheck = options.mode === 'check';

  let mismatches = 0;
  let failures = 0;
  let rewritten = 0;
  // Outils pour lesquels la valeur publiée n'a PAS pu être établie (amont
  // indisponible) : aucune vérification n'a eu lieu pour eux.
  let unverified = 0;
  // Outils dont l'artefact a réellement été retéléchargé et rehashé.
  let rehashed = 0;

  let index = 0;
  for (const tool of selected) {
    // Tranche de budget de cet outil (cf. startToolBudget).
    index += 1;
    startToolBudget(selected.length - index + 1);

    const { version, sha256: committed } = state.get(tool.prefix);
    const label = `${tool.prefix.padEnd(8)} ${version.padEnd(10)}`;

    // Garde-fou hors réseau : la table TOOLS doit décrire l'artefact que le
    // Dockerfile télécharge réellement.
    assertArtifactUrlMatchesDockerfile(content, tool);

    let published;
    try {
      published = await fetchPublishedChecksum(tool, version);
    } catch (error) {
      if (isCheck && error instanceof UpstreamError) {
        unverified += 1;
        console.log(`${label} AMONT INDISPONIBLE (checksum non vérifié)`);
        warn(`${tool.prefix} ${version} : ${error.message}`);
        continue;
      }
      // VerificationError : l'amont a répondu et sa réponse ne permet pas de
      // valider le pin. Fatal en --write, échec (exit 1) en --check — sans
      // interrompre les autres outils, pour un rapport complet.
      if (isCheck && error instanceof VerificationError) {
        failures += 1;
        console.log(`${label} ÉCHEC DE VÉRIFICATION`);
        console.error(error.message);
        continue;
      }
      throw error;
    }

    if (published.value === committed) {
      if (!options.verifyArtifacts) {
        // Pas de retéléchargement : voir l'en-tête (le `sha256sum -c` du build
        // ne rehashe que si la couche est invalidée, d'où --verify-artifacts).
        console.log(`${label} OK       ${published.value}`);
        continue;
      }
      try {
        await verifyAgainstArtifact(tool, version, published.value, published.url);
        rehashed += 1;
        console.log(`${label} OK       ${published.value} (artefact rehashé)`);
      } catch (error) {
        if (isCheck && error instanceof UpstreamError) {
          console.log(`${label} OK       ${published.value} (artefact NON rehashé)`);
          warn(`${tool.prefix} ${version} : ${error.message}`);
          continue;
        }
        if (isCheck && error instanceof VerificationError) {
          // Publié == commité mais l'artefact hashe autrement : incohérence amont.
          failures += 1;
          console.log(`${label} ÉCHEC DE VÉRIFICATION (artefact ≠ checksum publié)`);
          console.error(error.message);
          continue;
        }
        throw error;
      }
      continue;
    }

    // ÉCART CERTAIN : le checksum commité ne correspond pas à ce que l'éditeur
    // publie pour cette version. On le compte AVANT l'arbitrage : l'artefact ne
    // sert qu'à dire lequel des deux a raison (donc à enrichir le message et à
    // autoriser une écriture), jamais à annuler l'échec.
    mismatches += 1;
    console.log(`${label} ÉCART`);
    console.log(`  - Dockerfile : ${committed}`);
    console.log(`  + amont      : ${published.value} (${published.url})`);

    let arbitrated = false;
    try {
      await verifyAgainstArtifact(tool, version, published.value, published.url);
      arbitrated = true;
      rehashed += 1;
      console.log('  = artefact rehashé : concorde avec le checksum publié');
    } catch (error) {
      if (isCheck && error instanceof UpstreamError) {
        // L'écart reste établi : on sort 1 quand même, seul le message est dégradé.
        warn(
          `${tool.prefix} ${version} : écart CONFIRMÉ (commité ≠ publié) mais artefact ` +
            `non rehashé, donc non arbitré (${error.message}). L'écart fait échouer la ` +
            'garde ; relancer `--write` une fois l\'amont joignable.',
        );
      } else if (isCheck && error instanceof VerificationError) {
        // L'artefact contredit le checksum publié : anomalie amont EN PLUS de
        // l'écart. Les deux sont rapportées, la garde sort 1 dans tous les cas.
        failures += 1;
        console.error(error.message);
      } else {
        throw error;
      }
    }

    if (options.mode === 'write') {
      // Inatteignable sans arbitrage : en --write toute erreur ci-dessus est fatale.
      if (!arbitrated) throw new Error(`Arbitrage manquant pour ${tool.prefix}`);
      content = rewriteSha(content, tool.prefix, published.value);
      rewritten += 1;
      console.log(`${label} ÉCART réécrit`);
    }
  }

  if (rewritten > 0) {
    writeFileSync(DOCKERFILE, content);
  }

  if (options.mode === 'write') {
    console.log(
      `Résumé : ${selected.length} outil(s) vérifié(s), ` +
        `${rewritten} ligne(s) ARG _SHA256 réécrite(s), Dockerfile ` +
        `${rewritten > 0 ? 'modifié' : 'inchangé'}.`,
    );
    return 0;
  }

  console.log(
    `Résumé : ${selected.length} outil(s) traité(s), ${mismatches} écart(s), ` +
      `${failures} échec(s) de vérification, ${unverified} amont(s) indisponible(s)` +
      (options.verifyArtifacts ? `, ${rehashed}/${selected.length} artefact(s) rehashé(s)` : '') +
      '.' +
      (mismatches > 0
        ? ' Relancer `node scripts/sync-download-checksums.mjs --write` pour corriger.'
        : ''),
  );

  // AUCUNE valeur publiée établie : la garde n'a rien vérifié du tout. Un runner
  // throttlé sur les 3 amonts rendait sinon un vert indiscernable d'un vrai
  // contrôle. Un amont sur trois reste un avertissement (l'image est construisible
  // et les 2 autres ont bien été vérifiés) ; les trois sont un échec.
  const nothingVerified = unverified > 0 && unverified === selected.length;
  if (nothingVerified) {
    console.error(
      `ÉCHEC : les ${selected.length} amont(s) sélectionné(s) sont indisponibles, aucune ` +
        "valeur publiée n'a pu être établie. La garde n'a rien vérifié : ne pas lire ce " +
        'run comme un contrôle réussi (réseau du runner, throttling global, coupure DNS).',
    );
  }

  // --verify-artifacts est la SEULE rejouée régulière de la contre-vérification
  // S-01 (le cache de couches Docker empêche le build de rehasher quoi que ce
  // soit), et elle tourne sur `push: main`, dans un run que personne ne relit.
  // Un artefact manquant à l'appel doit donc être rouge, pas un `::warning::`
  // noyé : sinon un CDN qui coupe ou une tranche de budget épuisée donne un run
  // vert qui se lit comme un run ayant tout revérifié.
  const artifactsIncomplete = options.verifyArtifacts && rehashed < selected.length;
  if (artifactsIncomplete) {
    console.error(
      `ÉCHEC : --verify-artifacts n'a rehashé que ${rehashed} artefact(s) sur ` +
        `${selected.length}. C'est la seule rejouée régulière de la contre-vérification ` +
        'S-01 : un artefact non rehashé n\'est pas un détail, il laisse la valeur ' +
        'commitée attestée par le seul checksum publié. Voir les avertissements ' +
        'ci-dessus (amont indisponible, flux coupé, budget épuisé) et relancer.',
    );
  }

  // Un écart, un checksum publié non établi, l'indisponibilité de TOUS les amonts
  // ou un `--verify-artifacts` incomplet font échouer la garde. Une indisponibilité
  // partielle sans `--verify-artifacts` ne la fait pas échouer : l'image reste
  // construisible et le `sha256sum -c` du build reste le filet final quand la
  // couche est rejouée.
  return mismatches > 0 || failures > 0 || nothingVerified || artifactsIncomplete ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`ERREUR : ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
