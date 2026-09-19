# AGENTS.md — Guide pour les agents IA travaillant sur ce repo

Ce repo build l'image Docker de l'agent **hermes-lya**. Tout changement passe
par les règles suivantes. À LIRE AVANT de modifier quoi que ce soit.

## 🎯 Le but du repo

Une couche fine sur l'image officielle `nousresearch/hermes-agent` :
**seulement des binaires système** (gws, gh, kubectl). Pas de
scripts, pas de venvs, pas de skills — ceux-ci vivent sur le PVC `/opt/data` et
les ConfigMaps (vps-infra), pas dans l'image.

Variante **slim** de `hermes-leo-config` : pas de toolchain Go, pas de Devin CLI.

## 🚫 Règles absolues

1. **JAMAIS de secret dans ce repo** : pas de refresh_token, client_secret,
   clé API, token, credentials Google. Le repo est **public**. Toute credential
   va dans **Infisical** (projet `infrastructure`, env `prod`,
   chemin `/agents/hermes-lya`).
2. **Ne pas modifier l'image de base** (`FROM nousresearch/hermes-agent`) sans
   raison critique — elle est trackée par Renovate (review manuelle 7j).
3. **Binaire gws = glibc** (`-unknown-linux-gnu`), PAS musl (base debian).
4. **Ne pas retirer un outil** tant que le pod l'utilise (check vps-infra +
   skills + crons avant). Exemple : himalaya a été retiré car gws le remplace
   pour Gmail — mais vérifier les usages avant chaque retrait.
   Si un retrait est décidé : **retirer l'outil de la table `TOOLS` de
   `scripts/sync-download-checksums.mjs` dans le MÊME commit**. Le script exige
   le couple `ARG <OUTIL>_VERSION` / `ARG <OUTIL>_SHA256` de chaque outil qu'il
   connaît (fail-closed volontaire) : sinon `--check` échoue pour les trois, avec
   un message qui nomme l'outil manquant. Idem si l'URL téléchargée par le `RUN`
   change (renommage d'asset amont, variante `-musl`…) : le script recroise son
   URL avec celle du Dockerfile et refuse de travailler si elles divergent, pour
   éviter d'écrire le checksum d'un fichier que le build ne télécharge pas. Ce
   recroisement ne lit **que le code de l'instruction `RUN` qui vérifie
   `${<OUTIL>_SHA256}`** : les commentaires sont ignorés, pour qu'un commentaire
   citant l'ancienne URL ne puisse pas valider un `RUN` basculé sur une autre.
5. **Ne pas épingler une version** sans le commentaire Renovate qui précède
   l'ARG, ni sans son `ARG <OUTIL>_SHA256` juste après :
   ```dockerfile
   # renovate: datasource=github-releases depName=googleworkspace/cli
   ARG GWS_VERSION=0.22.5
   ARG GWS_SHA256=de78ecdbd2f1a84cca0063a7ecbc440240fc14b6ebccbb17f4646b792a8c5c1f
   ```
   Les trois lignes forment un bloc indissociable : le `RUN` qui suit vérifie
   l'archive avec `sha256sum -c` AVANT de l'extraire (S-01).
   **Le `ARG <OUTIL>_SHA256` est maintenu par machine — ne JAMAIS l'éditer à la
   main** (ni le copier depuis une page web). Pour le rafraîchir :
   ```bash
   node scripts/sync-download-checksums.mjs --check   # CI : sort 1 si un SHA est périmé
   node scripts/sync-download-checksums.mjs --write   # réécrit les lignes _SHA256 périmées
   node scripts/sync-download-checksums.mjs --write --only=cli/cli   # un seul outil
   node scripts/sync-download-checksums.mjs --check --verify-artifacts   # + rehashe les 3 artefacts
   ```
   Le script est **sans dépendance** (Node + stdlib uniquement, pas de
   `package.json`, pas de `curl`/`jq`) parce qu'il doit tourner dans le
   conteneur `ghcr.io/renovatebot/renovate`. Ne pas y ajouter de dépendance.

## 🔄 Workflow de mise à jour d'un outil

1. Modifier la version dans le Dockerfile (ou laisser Renovate proposer).
2. Marquer une **release GitHub calver** :
   ```bash
   gh release create v2026.8.31 --repo rjullien/hermes-lya-config \
     --title "hermes-lya-config v2026.8.31" --notes "..."
   ```
   → `build.yml` (déclenché sur `release: published`) build + push les tags
   `vYYYY.M.D`, `vYYYY.M`, `latest`, `sha-<commit>`.
3. Mettre à jour le tag dans **vps-infra**
   (`workloads/agents/hermes-lya/hermes-lya-deployment.yaml`) → PR vers
   `BaptTF/vps-infra` → ArgoCD déploie.

## 🤖 Renovate — ce que l'agent doit savoir

- Renovate tourne **self-hosted via GitHub Actions** (`renovate.yml`), PAS
  l'app publique. Secret `RENOVATE_TOKEN` requis (PAT, car `GITHUB_TOKEN` ne
  suffit pas → `Integration unauthorized`).
- **Tout est en automerge** (binaires 3j, actions, hermes-agent 7j) : la
  **review humaine se fait au niveau vps-infra** (renovate de Baptiste) quand
  l'image est déployée — pas ici. Ne pas re-désactiver l'automerge.
- Ne PAS remettre `RENOVATE_AUTOMERGE=false` dans le workflow : ça écrase
  `renovate.json`.
- Dashboard des updates : issue #1 « Dependency Dashboard ».
- Après un **changement de config Renovate** : relancer
  `gh workflow run renovate.yml --repo rjullien/hermes-lya-config`.
- Les branches/PRs Renovate apparaissent en « Errored » si une branche a déjà
  été patchée par un run antérieur → supprimer la branche et relancer.

### Synchronisation version ↔ SHA-256 (ne pas casser)

Renovate ne connaît que le `ARG <OUTIL>_VERSION`. Deux réglages, et deux
seulement, empêchent le `ARG <OUTIL>_SHA256` de rester périmé :

1. **`postUpgradeTasks` dans `renovate.json`** (règle des 3 binaires) :
   `node scripts/sync-download-checksums.mjs --write --only={{{depName}}}`,
   `fileFilters: ["Dockerfile"]`, `executionMode: "update"`. Le SHA corrigé
   fait donc partie du **commit Renovate** et reste relisible dans le diff.
2. **`RENOVATE_ALLOWED_COMMANDS` dans `renovate.yml`** : `allowedCommands` est
   une config **admin** (self-hosted), impossible à définir depuis
   `renovate.json`. C'est elle qui *autorise* la commande ci-dessus.

**Retirer l'un des deux casse la synchro, mais pas de la même façon :**

- retirer `postUpgradeTasks` de `renovate.json` **ne produit aucune erreur
  visible** : Renovate bumpe la version seule, et l'échec n'apparaît qu'au build
  sur `sha256sum -c` ;
- retirer `RENOVATE_ALLOWED_COMMANDS` **est signalé** : Renovate loggue un
  `warn` et remonte un `artifactErrors` affiché dans le corps de la PR, qui
  nomme la commande refusée (« Post-upgrade command '…' has not been added to
  the allowed list in allowedCommands »). Le checksum reste périmé pour autant.

Dans les deux cas, le filet de sécurité est l'étape « Vérifier les SHA-256 des
3 téléchargements » de `pr-validation.yml` : elle nomme l'outil et les deux
valeurs **avant** le build, au lieu d'un échec opaque après le téléchargement.
C'est une **étape du job `build-and-verify`** (la 3ᵉ, après le
checkout et `setup-node`, et avant `Build image`), pas un job séparé : en job
distinct relié par `needs:`, son échec rendait le check requis
`build-and-verify` *skipped*, et un check requis skipped est compté comme
satisfait par la branch protection. Ne pas la ré-extraire en job sans ajouter ce
job aux checks requis de `main`.

⚠️ **Ce qui fait échouer la garde, et ce qui ne le fait pas.** En `--check`,
sortent en 1 : (a) un écart entre le checksum commité et le checksum publié — la
divergence est alors CERTAINE, l'artefact n'est retéléchargé que pour dire lequel
des deux a raison et n'a **pas** de droit de veto sur le code de sortie ; (b) un
checksum publié impossible à établir alors que l'amont a répondu (nom de fichier
absent de `gh_<V>_checksums.txt`, asset 404 ou renommé) — « je n'ai pas pu
établir la valeur publiée » est un échec de vérification, pas une panne ;
(c) **tous** les amonts sélectionnés indisponibles — la garde n'a alors rien
vérifié, et un vert serait indiscernable d'un vrai contrôle ; (d) avec
`--verify-artifacts`, **moins d'artefacts rehashés que d'outils sélectionnés**
(voir plus bas : c'est la seule rejouée régulière de S-01, elle tourne sur
`push: main` et ne doit pas se dégrader en avertissement dans un run que
personne ne relit). Ne produit qu'un **avertissement** (exit 0) la seule
INDISPONIBILITÉ PARTIELLE : erreur réseau/DNS/TLS, 5xx, throttling, flux coupé,
budget épuisé, après 3 tentatives (timeout 60 s, 5 min pour un artefact). Sans ça,
une panne amont rendrait `main` non mergeable alors que l'image reste
construisible.

Le budget global borne le run : **10 min en `--check`, 20 min avec
`--verify-artifacts`**, et il est **réparti en tranches égales entre les outils
restants** — sinon un seul amont dégradé le consommait en entier et les suivants
sortaient « budget épuisé » sans avoir émis une requête. Corollaire : le pire cas
annoncé par outil (3 tentatives × 5 min sur un artefact) dépasse sa tranche, donc
les tentatives supplémentaires ne servent qu'aux échecs **rapides** (flux coupé
d'emblée) ; un artefact simplement trop lent épuise sa tranche, ce qui est un
échec sous `--verify-artifacts`. `build-and-verify` porte un
`timeout-minutes: 45` (20 min de garde au pire + un build à froid + 2 scans
Trivy).

Le **403 ne peut pas être classé sur le seul code** : GitHub le renvoie sur
throttling secondaire (à retenter), mais certains amonts le renvoient pour un
objet **inexistant**. Le script ne le retente donc que si la réponse porte un
indice de throttling (`retry-after`, `x-ratelimit-remaining: 0`, corps mentionnant
un rate limit) ; sinon il le traite comme un 404. Ne pas « simplifier » en
remettant 403 dans la liste des statuts retentables. Symétriquement, **ce test
d'indice de throttling ne s'applique qu'au 403** : l'étendre à tous les
statuts ferait d'un 404 portant un `retry-after` une indisponibilité, donc une
garde verte sur un asset renommé. Et comme un 403 nu peut aussi venir d'un
**intermédiaire réseau** (proxy de sortie, WAF, CDN refusant le user-agent) et
non de l'amont, le message d'échec cite cette piste : la rejouer depuis un autre
réseau tranche.

⚠️ **Le `sha256sum -c` du build n'est pas un filet permanent.** Le build de PR
utilise `cache-from: type=gha` : la couche `RUN curl … && sha256sum -c` n'est
rejouée que si son `ARG` version ou SHA change. Sur une PR qui ne touche pas ces
lignes, aucun octet d'artefact n'est rehashé. D'où `--verify-artifacts`, passé par
`pr-validation.yml` sur `push: main` uniquement : il rehashe les 3 artefacts
une fois par merge. Ne pas l'ajouter au chemin PR (coût réseau par PR)
ni le retirer de `push: main` (c'est la seule rejouée régulière de la
contre-vérification S-01). Ce mode **n'a de valeur que complet** : il sort 1 dès
qu'un artefact n'a pas été rehashé (amont injoignable, flux coupé, tranche de
budget épuisée), au lieu de laisser un `::warning::` dans un run post-merge et un
vert qui se lit comme un contrôle intégral.

En mode `--write` (Renovate), au contraire, **tout échec est fatal** et rien n'est
écrit : Renovate produit alors une PR portant un `artifactErrors` plutôt qu'un
faux checksum. Cas concret attendu : kubectl est suivi en `github-tags` sur
`kubernetes/kubernetes`, alors que le binaire vient de `dl.k8s.io`. Un tag peut
exister **avant** la publication des binaires ; dans cette fenêtre le `--write`
échoue (404 sur `dl.k8s.io` = échec de vérification, pas indisponibilité) et la PR
kubectl arrive avec un bloc d'erreur au lieu d'un bump propre. C'est fail-closed et
voulu : relancer `renovate.yml` une fois les binaires publiés. La fenêtre ne
contamine pas les autres PRs : rien n'ayant été écrit, le Dockerfile garde une
version dont les binaires existent, et `--check` reste vert.

⚠️ **Ne pas remettre le groupe de capture `currentDigest`** dans
`customManagers` : aucune des datasources utilisées (`github-releases`,
`github-tags`) ne sait résoudre le SHA-256 d'une archive comme un digest. Le
résultat observé était : branche `renovate/kubernetes-kubernetes-digest` en
erreur en tentant d'écrire un SHA de **commit git** de kubernetes/kubernetes dans
`KUBECTL_SHA256`, et « Could not determine new digest for update » pour
`googleworkspace/cli` et `cli/cli` — soit gws et gh **gelés sans aucune mise à
jour**.

Sources amont du checksum, par outil (utilisées par le script) :

| Outil | Source du SHA-256 publié |
|---|---|
| gws | `…/releases/download/v<V>/google-workspace-cli-x86_64-unknown-linux-gnu.tar.gz.sha256` (format `<hex>␠␠<fichier>`) |
| gh | `…/releases/download/v<V>/gh_<V>_checksums.txt` → ligne dont le fichier est exactement `gh_<V>_linux_amd64.tar.gz` |
| kubectl | `https://dl.k8s.io/release/v<V>/bin/linux/amd64/kubectl.sha256` (hex nu ; c'est le hash du **binaire**, pas d'une archive) |

Avant d'écrire, le script ne se contente pas du checksum publié : il
**retélécharge l'artefact et recalcule le SHA-256 en flux**, et n'écrit rien si
les deux valeurs divergent.

**Portée exacte de cette contre-vérification** (à ne pas surestimer) : pour un
outil donné, le checksum publié et l'artefact viennent du **même éditeur, même
domaine, même chaîne TLS**. Elle attrape un téléchargement tronqué, un
cache/miroir divergent, une publication incohérente entre le fichier de checksums
et l'archive — elle **n'attrape pas** un éditeur qui publierait un artefact
malveillant avec le checksum correspondant (compromission d'un compte de
release). Ce n'est donc pas une attestation indépendante de la source, seulement
du transport.

Ce que S-01 conserve malgré tout : la valeur est **figée dans le dépôt**,
relisible dans le diff de la PR, et **rejouée à chaque build** contre le CDN
(donc une archive substituée après coup fait échouer le build). Comme la règle
qui porte `postUpgradeTasks` porte aussi `automerge: true`, le seul délai humain
restant sur ce chemin est `minimumReleaseAge` (3 jours pour les binaires) : c'est
un choix assumé ici, la review humaine se faisant au niveau vps-infra quand
l'image est déployée. Si ce compromis doit changer un jour, la bonne manette est
`minimumReleaseAge`, pas la désactivation de l'automerge (cf. plus haut).

## 🧪 Vérification après build

```bash
# Tester l'image localement (docker dispo) :
docker run --rm --entrypoint gws   ghcr.io/rjullien/hermes-lya-config:latest --version
docker run --rm --entrypoint gh    ghcr.io/rjullien/hermes-lya-config:latest --version
docker run --rm --entrypoint kubectl ghcr.io/rjullien/hermes-lya-config:latest version --client

# Ou dans le pod après déploiement :
kubectl exec -n openclaw deploy/hermes-lya -- gws --version
```

## 📝 Conventions

- Commits : Conventional Commits (`feat:`, `fix:`, `ci:`, `chore:`, `docs:`).
- Une release calver = un build. Pas de tag volant hors release.
- Tout changement de comportement → update README.md (l'image est publique,
  les utilisateurs externes lisent le README).
