# hermes-lya-config

Image Docker custom de l'agent **hermes-lya** (Lya) : image officielle
[`nousresearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) +
outils agents absents de la base.

Copie allégée de [`hermes-leo-config`](https://github.com/rjullien/hermes-leo-config) :
**sans toolchain Go** et **sans Devin CLI**.

## Contenu ajouté

| Outil | Version | Usage |
|---|---|---|
| **gws** (Google Workspace CLI) | 0.22.5 | Gmail, Tasks, Calendar, Drive — Gmail automatisé (remplace himalaya) |
| **gh** (GitHub CLI) | 2.101.0 | Issues, PRs, releases |
| **kubectl** | 1.37.0 | Debug cluster (lecture pods/logs, RBAC read-only) |

> Les versions ci-dessus reflètent les `ARG *_VERSION` du `Dockerfile` (source
> de vérité). En cas de doute, `Dockerfile` fait foi.

En plus des binaires, le `Dockerfile` applique en `USER root` un
`apt-get update && apt-get upgrade` avant les installs d'outils : la base est
épinglée par digest et peut donc prendre du retard sur les correctifs Debian
trixie ; cette couche les tire dans notre image pour garder la porte Trivy
CRITICAL (corrigibles) verte sans élargir `.trivyignore`.

## Vérification des téléchargements (SHA-256)

Les 3 binaires ne sont pas téléchargés « à l'aveugle ». Chaque `ARG *_VERSION`
est accompagné d'un `ARG *_SHA256` **commité dans le repo**, et le `RUN`
correspondant vérifie l'archive avec `sha256sum -c` **avant** de l'extraire
(S-01). Une archive substituée en amont fait donc échouer le build, elle
n'atterrit jamais dans l'image.

Ces checksums sont maintenus par machine, jamais à la main :
[`scripts/sync-download-checksums.mjs`](scripts/sync-download-checksums.mjs)
lit le checksum **publié par l'éditeur** (release GitHub, `dl.k8s.io`),
**retélécharge l'artefact et recalcule son SHA-256 en flux**, et refuse
d'écrire une valeur si les deux ne concordent pas.

**Ce que cette double lecture couvre, et ce qu'elle ne couvre pas.** Pour un
outil donné, le checksum publié et l'artefact viennent du **même éditeur, sur le
même domaine et la même chaîne TLS**. Le croisement détecte un téléchargement
tronqué, un cache ou miroir divergent, une publication incohérente entre le
fichier de checksums et l'archive ; il ne détecte **pas** un éditeur qui
publierait un artefact malveillant avec le checksum correspondant. Ce n'est donc
pas une attestation indépendante de la *source*, mais du *transport*. Ce qui
reste acquis : la valeur est figée dans le dépôt, relisible dans le diff de la
PR, et rejouée à chaque build contre le CDN — une archive substituée après le
bump fait échouer le build. Le délai avant merge automatique reste
`minimumReleaseAge` (3 jours, cf. §Renovate).

```bash
node scripts/sync-download-checksums.mjs --check   # vérifie, sort 1 si un SHA est périmé
node scripts/sync-download-checksums.mjs --write   # resynchronise les lignes ARG *_SHA256
node scripts/sync-download-checksums.mjs --check --verify-artifacts   # + rehashe les 3 artefacts
```

Le script est **sans aucune dépendance** (Node + bibliothèque standard, ni
`package.json`, ni `curl`, ni `jq`) car il doit aussi tourner dans le conteneur
Renovate. Deux garde-fous l'exécutent automatiquement :

- **Renovate** (`postUpgradeTasks`) le lance sur sa propre branche quand il
  bumpe une version, si bien que version et checksum changent **dans le même
  commit** et restent relisibles dans le diff de la PR ;
- **la CI** (`pr-validation.yml`) le rejoue en mode `--check` sur chaque PR, dans
  le job requis `build-and-verify` et **avant** l'étape de build de l'image (c'est
  une étape de ce job, pas un job séparé : un job séparé relié par `needs:`
  rendrait le check requis *skipped*, donc satisfait, en cas d'échec).

En mode `--check`, le script ne relit que les checksums publiés (3 requêtes, pas
de retéléchargement des artefacts) ; il ne rehashe un artefact que pour arbitrer
un écart, ou sur demande explicite avec `--verify-artifacts`. **Ce que la CI fait
rougir** : un checksum commité différent du checksum publié ; un checksum publié
impossible à établir (version absente en amont, asset renommé ou retiré, 404) ;
l'indisponibilité de **tous** les amonts à la fois, cas où la garde n'a rien
vérifié du tout ; et, en mode `--verify-artifacts`, le moindre artefact non
rehashé. Une indisponibilité **partielle** (réseau, 5xx, throttling sur un amont)
est retentée puis signalée en **avertissement** sans bloquer : elle ne doit pas
rendre `main` non mergeable alors que l'image reste construisible.

Nuance sur le raccourci « pas de retéléchargement » : le `sha256sum -c` du
`Dockerfile` rehashe bien l'archive réellement téléchargée, mais le build de PR
utilise `cache-from: type=gha`, donc la couche `RUN curl … && sha256sum -c` n'est
rejouée que lorsque son `ARG` version ou SHA change. Sur une PR qui ne touche pas
ces lignes, aucun octet d'artefact n'est rehashé. C'est pourquoi la CI passe
`--verify-artifacts` sur `push: main` : les 3 artefacts y sont retéléchargés et
rehashés, une fois par merge plutôt qu'une fois par PR. Ce mode échoue s'il n'a
pas pu rehasher les 3, pour qu'un run post-merge vert veuille dire « tout a été
revérifié » et rien d'autre.

## Versioning — calver `vYYYY.M.D`

Le repo est versionné **calver** comme hermes-agent (ex: `v2026.8.31`).
Une **release GitHub** déclenche le build et génère les tags image :

```
ghcr.io/rjullien/hermes-lya-config:v2026.8.31   ← tag release (calver)
ghcr.io/rjullien/hermes-lya-config:v2026.8      ← mois
ghcr.io/rjullien/hermes-lya-config:latest        ← majeur
ghcr.io/rjullien/hermes-lya-config:sha-<sha>     ← immuable
```

**Créer une version :**

```bash
gh release create v2026.8.31 \
  --repo rjullien/hermes-lya-config \
  --title "hermes-lya-config v2026.8.31" \
  --notes "Image custom hermes-lya : hermes-agent + gws/gh/kubectl"
```

Le build + push est factorisé dans un workflow réutilisable
(`build-image.yml`, `workflow_call`) appelé par deux chemins : `build.yml` quand
une release est **publiée manuellement** (`release: published`), et
`auto-release.yml` **dans le même run** juste après avoir créé la release
automatique (une release créée depuis un workflow ne ré-émet pas l'event
`release: published` — protection anti-récursion de GitHub — donc on ne peut pas
s'y fier sur ce chemin). Les tags **calver + `latest`** sont poussés sur ces
deux chemins release (input `publish_release_tags: true`). Un `workflow_dispatch`
manuel sur `build.yml` ne produit que le tag `sha-<commit>` : il ne peut donc pas
déplacer `latest` hors du flux de release (F-02). Déployer par **digest** dans
vps-infra reste la référence immuable — `latest`/`vX.Y` sont mutables par
construction.

**Réglages serveur recommandés (hors code, F-02) :** activer la branch
protection sur `main` (checks requis, cf. F-01) et l'immutabilité/rétention du
package GHCR.

## Renovate (maintenance des versions)

Renovate tourne self-hosted via **GitHub Actions** (`renovate.yml`, pas l'app
Renovate publique). Config : `renovate.json`.

| Dépendance | Délai avant PR | Automerge |
|---|---|---|
| Binaires (gws, gh, kubectl) | 3 jours | ✅ automerge |
| Actions GitHub du repo | — | ✅ automerge |
| Image de base `hermes-agent` | 7 jours | ✅ automerge (review humaine = renovate vps-infra) |

**Règle sécurité** : l'automerge est accordé **explicitement, dépendance par
dépendance** (gws, gh, kubectl, hermes-agent, Actions). Il n'y a plus
d'automerge global par défaut (S-05) : une future dépendance non prévue n'est
donc pas fusionnée automatiquement. La **vérification humaine se fait au niveau
vps-infra** (le renovate de Baptiste) quand l'image est référencée dans le
deployment. Le délai (3j binaires / 7j hermes-agent) laisse le temps de détecter
une release compromise avant merge.

**L'automerge attend le check CI (S-05)** : `ignoreTests: true` et
`requiredStatusChecks: []` ont été retirés maintenant que `pr-validation` existe
(F-01). Renovate ne fusionne donc plus qu'après un build vert (image construite,
3 outils testés, scan sans nouvelle CRITICAL corrigible).

⚠️ **Ceci n'ajoute PAS de délai supplémentaire.** `internalChecksFilter` vaut
`strict` par défaut : Renovate n'ouvre pas la PR tant que la release est
« pending ». Les 3j/7j de `minimumReleaseAge` s'écoulent donc **avant** la
création de la PR. Quand la PR apparaît, le délai de stabilité est déjà satisfait
et il ne reste à attendre que `pr-validation`.

`pr-validation.yml` vérifie les 3 SHA-256 (cf. §Vérification des téléchargements)
dans le job `build-and-verify`, **avant l'étape de build** (c'est la 3ᵉ étape, après
le checkout et `setup-node`) : un checksum périmé fait rougir la PR en moins d'une
minute, avec le nom de l'outil et les deux valeurs, au lieu d'un `sha256sum -c`
opaque. Cette garde est volontairement une étape et non un job relié par
`needs:` : en job séparé, son échec rendait `build-and-verify` *skipped*, et un
check requis skipped est compté comme satisfait par la branch protection — le
merge humain redevenait possible sur une PR dont l'image n'a jamais été
construite.

Le check `build-and-verify` est **required** dans la branch protection de `main`,
avec « branche à jour avant merge » activé. Renovate rebase automatiquement dans
ce cas (`rebaseWhen: auto` retient `behind-base-branch` dès qu'un automerge est
configuré), l'automerge n'est donc pas bloqué par cette exigence.

**Convention pour le `RENOVATE_TOKEN`** : token dédié à ce seul dépôt, avec
expiration et rotation, sans droits d'administration. Il lui faut le scope
`workflow` (ou « Workflows: RW » en fine-grained) : sans lui, GitHub refuse les
mises à jour des fichiers de `.github/workflows/`, et Renovate ne peut pas
proposer les bumps d'Actions. Le bloc `permissions:` du workflow ne s'applique
qu'à `GITHUB_TOKEN`, pas à ce token — ses scopes se règlent côté GitHub.

**Pièges connus :**

1. **`GITHUB_TOKEN` ne suffit pas** → Renovate échoue avec `Integration unauthorized - aborting`.
   Il faut le secret `RENOVATE_TOKEN` (PAT OAuth `gho_...`) et le passer dans
   `renovatebot/github-action` avec `token: ${{ secrets.RENOVATE_TOKEN }}`.
2. **`RENOVATE_AUTOMERGE=false` dans l'env du workflow écrase la config du repo**
   (automerge dans `renovate.json`) → ne pas le définir.
3. **Le regex manager** lit les ARG épinglés :
   ```dockerfile
   # renovate: datasource=github-releases depName=googleworkspace/cli
   ARG GWS_VERSION=0.22.5
   ```
   → Renovate propose les bumps automatiquement. Il ne capture **que** la
   version : le `ARG *_SHA256` est resynchronisé par `postUpgradeTasks`, qui
   exige `RENOVATE_ALLOWED_COMMANDS` dans `renovate.yml` (config admin,
   impossible depuis `renovate.json`). Tenter de capturer le checksum comme un
   `currentDigest` ne fonctionne pas : aucune des datasources utilisées ne sait
   résoudre le SHA-256 d'une archive comme un digest, et le résultat observé
   était un SHA de commit git écrit dans `KUBECTL_SHA256` plus deux outils
   (gws, gh) gelés sans aucune mise à jour.
4. **Binaire glibc** : l'image de base est debian (glibc) → télécharger
   `google-workspace-cli-x86_64-unknown-linux-gnu.tar.gz` (PAS `-musl`, réservé
   aux images Alpine).
5. **`platformAutomerge: true` échoue en silence sans branch protection** (checks
   requis absents) → utiliser le merge direct (`automergeType: pr` sans
   `platformAutomerge`), et surtout **`requiredStatusChecks: []` + `ignoreTests: true`** :
   sans `ignoreTests`, les checks internes `renovate/stability-days` passent la
   branche en « yellow » et Renovate refuse le merge indéfiniment
   (`PR is not ready for merge (branch status is yellow)`).
6. **`minimumReleaseAge`** : Renovate pose un check interne `renovate/stability-days`
   et ne propose/touche pas avant l'âge requis — c'est volontaire (délai 3j/7j).
   Un merge en conflit (405 `Pull Request has merge conflicts`) est retenté au
   run suivant après rebase (`rebaseWhen=behind-base-branch`).

## Secrets

**Aucun secret dans ce repo** (public). Les credentials OAuth Google
(refresh_token Gmail/Tasks) vont dans **Infisical** (projet `infrastructure`,
env `prod`, chemin `/agents/hermes-lya`) — jamais en git.

Config locale des credentials gws sur le pod :
`GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` + `GOOGLE_WORKSPACE_CLI_CONFIG_DIR`
(par compte : séparés pour éviter la fuite de compte via le cache).

## Architecture

⚠️ **Image `linux/amd64` uniquement (P-03).** Les binaires téléchargés dans le
`Dockerfile` (gws, gh, kubectl) ciblent explicitement `x86_64`/`amd64`,
et `build.yml` ne construit que `platforms: linux/amd64`. L'image de base
`hermes-agent` publie aussi une variante `arm64`, mais cette image custom ne la
couvre pas. Le pod `hermes-lya` doit donc tourner sur un nœud amd64.

Pour ajouter arm64 : vérifier la disponibilité de chaque binaire en arm64,
paramétrer les URLs via `TARGETARCH`, ajouter `linux/arm64` à `platforms`, puis
valider les 3 outils sur arm64 (réel ou émulé) via le workflow PR (F-01).

## Déploiement

Le pod `hermes-lya` (namespace `openclaw`) référence l'image via
`workloads/agents/hermes-lya/hermes-lya-deployment.yaml` dans
[`BaptTF/vps-infra`](https://github.com/BaptTF/vps-infra).
Changement d'image → PR vps-infra (pattern GitOps, ArgoCD auto-sync).

## Tests manuels après déploiement

```bash
kubectl exec -n openclaw deploy/hermes-lya -- gws --version  # 0.22.5
kubectl exec -n openclaw deploy/hermes-lya -- gh --version   # 2.x
kubectl exec -n openclaw deploy/hermes-lya -- kubectl version --client
```
