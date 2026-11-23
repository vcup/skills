# Makefile — the single task interface for this repository.
#
# Everything a maintainer does day to day has one entry here: check the tree,
# run tests, regenerate content, build the two isolated packages, run the Host
# gates, review Git state, and clean up. `make` with no argument prints the
# grouped help below.
#
# The commands in the recipes are the repository's real implementation
# (`scripts/*.ts`, `scripts/check-docs.py`); package.json has no `scripts` block
# and nothing here shells out to `npm run` or `bun run`.
#
# Safety model:
#   * `make -j` is serialised (`.NOTPARALLEL`) so no two recipes write `build/`
#     at the same time. Correctness over parallel speed at this size.
#   * Default checks are offline, write nothing in the repository, and do not
#     need `build/` or any ignored staging directory to exist.
#   * Network installs, writes to a live OMP profile, and recursive deletion are
#     separate opt-in targets, never part of the default path.
#   * Every variable-supplied path is quoted; missing tools fail before any work
#     starts, with the affected targets named.
#
# Variables (all optional):
#   TARGET=skill|omp|dsh   content path for content/content-build (default skill)
#   INSTALL_DIR=<dir>      existing isolated DSH install for the production gates
#   RC4_INSTALL=<dir>      isolated rc.4 install (cli-check / matrix-check)
#   RC5_INSTALL=<dir>      isolated rc.5 install (cli-check / matrix-check)
#   PACKAGE=<tgz>          candidate tarball the product gates verify
#                          (default: build/pack/dsh/dsh-ensemble-<version>.tgz)
#   RUNTIME=<dir>          isolated released DSH install for the acceptance gates
#                          (falls back to INSTALL_DIR when that is set)
#   BROWSER=<path>         Chromium/Chrome executable for client-check
#   CONFIRM=yes            required by install-omp and clean-all

.DEFAULT_GOAL := help
.NOTPARALLEL:

SHELL := /bin/sh
BUN ?= bun
NODE ?= node
NPX ?= npx
NPM ?= npm
PYTHON ?= python3
GIT ?= git
OMP ?= ./node_modules/.bin/omp

TARGET ?= skill
INSTALL_DIR ?=
CONFIRM ?=
PACKAGE ?=
RUNTIME ?=
# For `runtime-test-check`: a live Host origin and a path to its credential file. The
# credential is a path, never a value, so it never reaches argv or a log.
LIVE_ORIGIN ?=
LIVE_COOKIE_FILE ?=
BROWSER ?=
# Optional: an fc-list binary when fontconfig was extracted rather than installed.
FONTCONFIG_BIN ?=
# How the cross-container source world is obtained: `sidecar` starts a container
# here; `external` uses a fixture already running in a separately provisioned
# container, named by ENSEMBLE_SOURCE_TEST_URL/TOKEN. A same-process fixture is
# not a mode: it would measure this filesystem.
SOURCE_MODE ?=
SLOTS ?=
CLIENT_TYPES ?=
DSH_VERSION ?=
CLIENT_OUT ?= build/production/client
# The release door pins the candidate by bytes. When PACKAGE_SHA256 is set the
# gate refuses a tarball whose sha256 differs, before installing anything; when it
# is unset the door still says which hash it measured, so a release claim is
# reproducible from the log rather than from memory.
PACKAGE_SHA256 ?=

BUILD_DIR := build
PACK_DIR := $(BUILD_DIR)/pack
# Where `make pack-dsh` leaves the formal DSH plugin tarball. The name is a glob
# because the version lives in `adapters/dsh/meta.ts`; restating it here would drift.
# (`PROBE` remains in the variable name for migration history; the artifact it points
# at is the shipped plugin, not a probe.)
DSH_PROBE_DIR := $(PACK_DIR)/dsh
WAIT_PROBE_DIR := $(PACK_DIR)/dsh-agent-wait
# The candidate a production gate verifies. Defaults to whatever this tree last
# packed, so `make production-check` cannot silently verify a tarball from a
# different checkout; PACKAGE= overrides it with an explicit path.
PRODUCT_PACKAGE := $(if $(PACKAGE),$(PACKAGE),$(firstword $(wildcard $(DSH_PROBE_DIR)/dsh-ensemble-*.tgz)))
# The acceptance gates need a released runtime; INSTALL_DIR is accepted as a
# fallback so a single variable configures the whole door.
RUNTIME_DIR := $(if $(RUNTIME),$(RUNTIME),$(INSTALL_DIR))
VALID_TARGETS := skill omp dsh
TASKS := $(BUN) scripts/project-tasks.ts

# ---------------------------------------------------------------------------
# help
# ---------------------------------------------------------------------------
.PHONY: help
help:
	@printf '%s\n' 'Usage: make <target> [TARGET=skill|omp|dsh] [INSTALL_DIR=<dir>] [PACKAGE=<tgz>] [PACKAGE_SHA256=<64 hex>] [RUNTIME=<dir>] [BROWSER=<path>] [CLIENT_TYPES=<dir>] [CONFIRM=yes]'
	@printf '%s\n' ''
	@printf '%s\n' 'Getting started'
	@printf '  %-16s %s\n' 'help' 'this list (the default target)'
	@printf '  %-16s %s\n' 'doctor' 'tools, dependencies and artifact presence; names the targets each one blocks'
	@printf '  %-16s %s\n' 'setup' '[network] bun install --frozen-lockfile, then doctor and check'
	@printf '%s\n' ''
	@printf '%s\n' 'Verify — offline, writes nothing in the repository'
	@printf '  %-16s %s\n' 'check' 'the default gate: skill drift + both plain typechecks + type coverage + docs'
	@printf '  %-16s %s\n' 'test' 'full test suite (bun test)'
	@printf '  %-16s %s\n' 'test-narrow' 'content builder tests only (the CI gate)'
	@printf '  %-16s %s\n' 'test-watch' 'tests in watch mode; Ctrl-C to leave'
	@printf '  %-16s %s\n' 'typecheck' 'tsc --noEmit plus the dependency-free DSH module project'
	@printf '  %-16s %s\n' 'typecheck-host' '[needs INSTALL_DIR, CLIENT_TYPES] Host and Client programs against a real isolated install'
	@printf '  %-16s %s\n' 'typecheck-client' '[needs INSTALL_DIR, CLIENT_TYPES] the Client program alone (the same program, not a weaker one)'
	@printf '  %-16s %s\n' 'typecheck-strict' '[needs INSTALL_DIR, CLIENT_TYPES] plain + Host + Client programs and the closure check: the complete type claim'
	@printf '  %-16s %s\n' 'docs' 'documentation link/reference checker'
	@printf '%s\n' ''
	@printf '%s\n' 'Content — one maintained source, three generated paths'
	@printf '  %-16s %s\n' 'content' 'report drift for TARGET (never writes)'
	@printf '  %-16s %s\n' 'content-build' '[writes] regenerate TARGET from content/ensemble/'
	@printf '%s\n' ''
	@printf '%s\n' 'Packages — local artifacts under build/pack, never published'
	@printf '  %-16s %s\n' 'pack' 'all three packages: OMP staging root + DSH tarball + subagent-wait tarball'
	@printf '  %-16s %s\n' 'pack-omp' 'OMP package only'
	@printf '  %-16s %s\n' 'pack-dsh' 'formal DSH plugin tarball only'
	@printf '  %-16s %s\n' 'pack-dsh-agent-wait' 'DSH subagent-wait plugin tarball only'
	@printf '  %-16s %s\n' 'dsh-bundle' '[needs DSH_BUNDLE_INSTALL, writes] regenerate the committed CLI transport bundle'
	@printf '  %-16s %s\n' 'dsh-bundle-check' 'verify the committed CLI transport bundle against its provenance'
	@printf '  %-16s %s\n' 'inspect' 'list the built tarballs and their contents'
	@printf '%s\n' ''
	@printf '%s\n' 'Runtime gates — a *-check target is a gate: it exits 0 only when every'
	@printf '%s\n' 'required check really ran and agreed. Missing prerequisites -> non-zero.'
	@printf '  %-16s %s\n' 'host-check' '[needs INSTALL_DIR] gate: Host types + real Loader, both must pass'
	@printf '  %-16s %s\n' 'profile-check' '[needs INSTALL_DIR] gate: DSH profile boot; missing install is a failure'
	@printf '  %-16s %s\n' 'isolation-check' '[needs INSTALL_DIR] gate: execution-world confinement must be observed'
	@printf '  %-16s %s\n' 'typecheck-wait-host' "[needs INSTALL_DIR] gate: the wait plugin's Host entries type-check"
	@printf '  %-16s %s\n' 'wait-host-check' '[needs INSTALL_DIR] gate: wait Host types + real Loader, both must pass'
	@printf '  %-16s %s\n' 'wait-runtime-check' '[needs INSTALL_DIR] fresh profile install, real native wait lifecycle, CLI boot and uninstall'
	@printf '  %-16s %s\n' 'cli-check' '[needs RC4_INSTALL and RC5_INSTALL] the packaged CLI runs against both tested releases in fresh profiles'
	@printf '%s\n' ''
	@printf '%s\n' 'Production gates — the installed product, not just the Loader.'
	@printf '%s\n' 'A missing prerequisite is a failure at exit 2, never a skip.'
	@printf '  %-16s %s\n' 'product-check' '[needs INSTALL_DIR] gate: standard install, native AgentLoop write, authenticated owner Remote, packaged CLI'
	@printf '  %-16s %s\n' 'client-check' '[needs INSTALL_DIR, BROWSER] gate: the packed Client factory in a real browser, official renderer and module system'
	@printf '  %-16s %s\n' 'maintenance-check' '[needs INSTALL_DIR] gate: engine regression — import/export, backup, restore, migration, replication, purge'
	@printf '  %-16s %s\n' 'maintenance-live-check' '[needs INSTALL_DIR, PACKAGE] gate: the installed product through the packaged CLI against a live Host'
	@printf '  %-16s %s\n' 'environment-check' '[needs INSTALL_DIR] gate: environment ledger against native Settings, including lost-response reconciliation'
	@printf '  %-16s %s\n' 'selection-check' '[needs INSTALL_DIR] gate: selection evidence from a real member Session log; refuses to invent what it cannot read'
	@printf '  %-16s %s\n' 'runtime-test-check' '[needs INSTALL_DIR; LIVE_ORIGIN+LIVE_COOKIE_FILE for the live CLI case] gate: the native families offline test skips, run and refused to be skipped'
	@printf '  %-16s %s\n' 'store-acceptance-check' '[needs INSTALL_DIR] gate: independent non-author transaction, corruption and CAS cases'
	@printf '  %-16s %s\n' 'native-acceptance-check' '[needs INSTALL_DIR] gate: independent non-author execution-world and identity boundaries'
	@printf '  %-16s %s\n' 'replica-acceptance-check' '[needs INSTALL_DIR] gate: independent typed replica cases over authenticated HTTP'
	@printf '  %-16s %s\n' 'source-acceptance-check' '[needs a running fixture] gate: the source read happens in a different container, not on the Host filesystem'
	@printf '  %-16s %s\n' 'source-sidecar' '[writes] start the source-world fixture in a throwaway container on loopback; prints URL and token'
	@printf '  %-16s %s\n' 'source-sidecar-stop' '[writes] remove the source-world container that source-sidecar started: CONTAINER=<name>'
	@printf '  %-16s %s\n' 'source-acceptance-sidecar-check' '[needs a container runtime] gate: starts the source-world container, runs the cross-container read, stops it on every exit path'
	@printf '  %-16s %s\n' 'auth-ui-check' '[needs INSTALL_DIR, BROWSER, PACKAGE] gate: the shipped Client in a real browser against a live Host it booted'
	@printf '  %-16s %s\n' 'fresh-journey-check' '[needs INSTALL_DIR, BROWSER, PACKAGE, SHA] gate: a browser creates a Workspace through the official UI and the Client binds it'
	@printf '  %-16s %s\n' 'fixture-test' 'offline contract tests for the source-world fixture server'
	@printf '  %-16s %s\n' 'matrix-check' '[needs built packages] gate: the packaged manifests declare exactly the tested releases'
	@printf '  %-16s %s\n' 'production-check' '[needs INSTALL_DIR] gate: product, archive, environment, matrix and the two acceptance suites (no browser, no second container)'
	@printf '%s\n' ''
	@printf '%s\n' 'Runtime setup — the only target that prepares an install for the gates'
	@printf '  %-16s %s\n' 'runtime-setup' '[network, writes INSTALL_DIR] npm install --ignore-scripts a tested release, then the built packages'
	@printf '  %-16s %s\n' 'client-types' '[network, writes CLIENT_TYPES] the published slot package at the install release, plus the official React major'
	@printf '%s\n' ''
	@printf '%s\n' 'Diagnose — observation only, never a gate'
	@printf '  %-16s %s\n' 'diagnose' '[read-only] observation only: reports what the environment does, asserts nothing, always exits 0'
	@printf '%s\n' ''
	@printf '%s\n' 'Upstream — explicit network; never installs, upgrades or widens support'
	@printf '  %-16s %s\n' 'check-upstream' '[network] read public npm dist-tags and classify them against the supported set'
	@printf '%s\n' ''
	@printf '%s\n' 'Owner archive — needs a running Host; not gates and never offline'
	@printf '  %-16s %s\n' 'archive-owner-help' "[needs INSTALL_DIR] print the packaged archive CLI's own help"
	@printf '  %-16s %s\n' 'archive-owner-status' '[needs INSTALL_DIR] read-only status; credential from ENSEMBLE_ARCHIVE_COOKIE'
	@printf '  %-16s %s\n' 'archive-owner-call' '[needs INSTALL_DIR, ARCHIVE_METHOD, ARCHIVE_REQUEST] one endpoint call'
	@printf '%s\n' ''
	@printf '%s\n' 'Install — opt-in, outside the default path'
	@printf '  %-16s %s\n' 'install-omp' '[writes live profile] needs CONFIRM=yes; installs the local OMP staging root'
	@printf '  %-16s %s\n' 'install-smoke' '[network] installs the pinned skills CLI into a temporary directory and compares bytes'
	@printf '%s\n' ''
	@printf '%s\n' 'Git — read-only'
	@printf '  %-16s %s\n' 'status' 'branch, changed paths, which artifacts exist'
	@printf '  %-16s %s\n' 'diff' 'the working-tree diff'
	@printf '  %-16s %s\n' 'git-review' 'status + diffstat + recent commits'
	@printf '%s\n' ''
	@printf '%s\n' 'Release and cleanup'
	@printf '  %-16s %s\n' 'package-check' 'offline aggregate: check + test + pack + inspect (no Host gates)'
	@printf '  %-16s %s\n' 'release-check' '[needs INSTALL_DIR, BROWSER, SLOTS, CLIENT_TYPES, source fixture] strict release door: every gate, including the browser UI, the live maintenance run and the cross-container source world'
	@printf '  %-16s %s\n' 'all' 'alias of package-check: offline chain, Host gates not included'
	@printf '  %-16s %s\n' 'clean' 'remove only the generated paths this Makefile owns'
	@printf '  %-16s %s\n' 'clean-all' '[destructive] clean plus node_modules; needs CONFIRM=yes'
	@printf '%s\n' ''
	@printf '%s\n' 'Nothing here publishes a package, commits, or installs into a live profile on its own.'

# ---------------------------------------------------------------------------
# preflight — fail before doing half the work
# ---------------------------------------------------------------------------
.PHONY: require-bun require-deps require-node require-npm require-npx require-python require-git

require-bun:
	@command -v "$(BUN)" >/dev/null 2>&1 || { \
		printf '%s\n' 'error: bun is not installed (or not on PATH).' \
		'  bun runs every script, test and typecheck in this repository.' \
		'  Install bun 1.4.x, or run this from the development container (.dsh-podman/skills-dev.yml).' \
		'  Blocked targets: check test test-narrow test-watch typecheck content content-build pack inspect status release-check clean' >&2; \
		exit 2; }

require-deps: require-bun
	@test -d node_modules || { \
		printf '%s\n' 'error: dependencies are missing (no node_modules).' \
		'  Run `make setup` first — it is the only target that installs anything.' \
		'  Nothing was checked; this is not a pass.' >&2; \
		exit 2; }
	@test -f node_modules/typescript/bin/tsc || { \
		printf '%s\n' 'error: typescript is missing from node_modules.' \
		'  Run `make setup` to restore the locked dependencies.' >&2; \
		exit 2; }

require-node:
	@command -v "$(NODE)" >/dev/null 2>&1 || { \
		printf '%s\n' 'error: node is not installed (or not on PATH).' \
		'  Needed by: pack (npm), host-check (real Loader run), install-smoke.' >&2; \
		exit 2; }

require-npm: require-bun require-node
	@command -v "$(NPM)" >/dev/null 2>&1 || { \
		printf '%s\n' 'error: npm is not installed (or not on PATH).' \
		'  Both packagers produce their tarball with `npm pack`.' \
		'  Blocked targets: pack pack-omp pack-dsh release-check all' >&2; \
		exit 2; }

require-npx: require-node
	@command -v "$(NPX)" >/dev/null 2>&1 || { \
		printf '%s\n' 'error: npx is not installed (or not on PATH).' \
		'  Blocked target: install-smoke.' >&2; \
		exit 2; }

require-python:
	@command -v "$(PYTHON)" >/dev/null 2>&1 || { \
		printf '%s\n' 'error: python3 is not installed (or not on PATH).' \
		'  scripts/check-docs.py runs on it. Blocked targets: docs check release-check' >&2; \
		exit 2; }

require-git:
	@command -v "$(GIT)" >/dev/null 2>&1 || { \
		printf '%s\n' 'error: git is not installed (or not on PATH).' \
		'  Blocked targets: status diff git-review' >&2; \
		exit 2; }

# TARGET must be one of the three consumption paths; reject anything else
# before touching a file.
.PHONY: require-target
require-target:
	@case " $(VALID_TARGETS) " in \
		*" $(TARGET) "*) ;; \
		*) printf 'error: TARGET=%s is not a content path.\n  Expected one of: %s\n  Nothing was read or written.\n' "$(TARGET)" "$(VALID_TARGETS)" >&2; exit 2 ;; \
	esac

# INSTALL_DIR must name an existing isolated DSH install; the helper explains
# what is missing instead of letting a later step fail obscurely.
.PHONY: require-install-dir
require-install-dir: require-bun
	@test -n "$(INSTALL_DIR)" || { \
		releases=$$($(BUN) -e 'import {supportedVersionsText} from "./adapters/dsh/compatibility.ts"; process.stdout.write(supportedVersionsText())') || releases='a tested release'; \
		default=$$($(BUN) -e 'import {DEFAULT_DSH_VERSION} from "./adapters/dsh/compatibility.ts"; process.stdout.write(DEFAULT_DSH_VERSION)') || default='the default release'; \
		printf '%s\n' 'error: INSTALL_DIR is not set.' \
		"  These gates run against a real isolated DSH install ($$releases), never against" \
		'  this working tree. Any writable directory outside the repository works;' \
		'  create one once with:' \
		'    dsh_install=$${TMPDIR:-/tmp}/dsh-install' \
		'    mkdir -p "$$dsh_install" && cd "$$dsh_install" && npm init -y' \
		"    npm install --ignore-scripts @deepseek-ai/dsh@$$default typescript@5.9 @types/node@24" \
		'  The Host gates also need this repository'"'"'s probe package installed in that' \
		'  directory, because the Loader resolves it like any other dependency:' \
		'    make pack-dsh' \
		'    cd "$$dsh_install" && npm install --ignore-scripts <this-repo>/$(DSH_PROBE_DIR)/dsh-ensemble-*.tgz' \
		'  then: make host-check INSTALL_DIR="$$dsh_install"' >&2; \
		exit 2; }
	@$(TASKS) install-dir --quiet "$(INSTALL_DIR)"

# The type gate additionally needs tsc and @types/node inside that install; the
# Loader gate does not, so each checks only what it uses.
.PHONY: require-install-dir-types
require-install-dir-types: require-install-dir
	@$(TASKS) install-dir --types --quiet "$(INSTALL_DIR)"

# The Client program needs the *published* slot package at exactly the install's
# release, plus React at the major the official Client plugins declare. That is a
# separate, type-only environment: an install never carries the slot package (the
# official plugins declare it as a dev dependency), and using the repository's own
# React would check the Client against a different major than it ships with.
# Naming it explicitly is what keeps "the Client type-checks" from quietly meaning
# "against whatever React happened to be installed".
.PHONY: require-client-types
require-client-types: require-bun
	@test -n "$(CLIENT_TYPES)" || { \
		printf '%s\n' 'error: CLIENT_TYPES is not set.' \
		'  The Client program compiles against the published slot package at exactly' \
		'  the install'"'"'s release plus React at the major the official Client plugins' \
		'  declare. Name a directory that contains those packages:' \
		'    make client-types INSTALL_DIR=<isolated install> CLIENT_TYPES=<dir>' \
		'  or let `make runtime-setup` create one beside the install. Nothing was compiled.' >&2; \
		exit 2; }
	@test -d "$(CLIENT_TYPES)" || { \
		printf '%s\n' "error: CLIENT_TYPES is not a directory: $(CLIENT_TYPES)" \
		'  Nothing was compiled.' >&2; \
		exit 2; }
	@test -f "$(CLIENT_TYPES)/node_modules/@deepseek-ai/dsh-client-ui-slots/package.json" || { \
		printf '%s\n' "error: no @deepseek-ai/dsh-client-ui-slots in $(CLIENT_TYPES)." \
		'  Create the Client type environment with:' \
		'    make client-types INSTALL_DIR=<isolated install> CLIENT_TYPES=<dir>' \
		'  Nothing was compiled; a Client gate without the real slot types would not' \
		'  verify the Client.' >&2; \
		exit 2; }

.PHONY: require-confirm
require-confirm:
	@test "$(CONFIRM)" = yes || { \
		printf '%s\n' "error: this target deletes or installs outside the repository." \
		"  Re-run with CONFIRM=yes only after reading what it removes or changes:" \
		"    install-omp  installs ./$(PACK_DIR)/omp/staging into the live OMP profile," \
		"                 replacing any @vcup/skills package already installed there" \
		"    clean-all    deletes $(BUILD_DIR)/ and node_modules/" >&2; \
		exit 2; }

# The production gates verify a *built candidate*, never the source tree. When no
# tarball exists the gate refuses: measuring the working tree would answer a
# different question than the one the gate names.
.PHONY: require-package
require-package: require-bun
	@test -n "$(PRODUCT_PACKAGE)" || { \
		printf '%s\n' 'error: no candidate package to verify.' \
		'  The production gates install a real tarball, so one must be built first:' \
		'    make pack-dsh' \
		'  or name one explicitly: make <gate> PACKAGE=<path/to/dsh-ensemble-*.tgz>' \
		'  Nothing was installed and nothing was verified.' >&2; \
		exit 2; }
	@test -f "$(PRODUCT_PACKAGE)" || { \
		printf '%s\n' "error: the candidate package does not exist: $(PRODUCT_PACKAGE)" \
		'  Build it with `make pack-dsh`, or point PACKAGE= at an existing tarball.' \
		'  Nothing was installed and nothing was verified.' >&2; \
		exit 2; }
	@case "$(PACKAGE_SHA256)" in \
		'') printf '== candidate: %s\n   sha256: %s (not pinned: pass PACKAGE_SHA256= to refuse a different byte)\n' "$(PRODUCT_PACKAGE)" "$$(sha256sum '$(PRODUCT_PACKAGE)' | cut -d' ' -f1)" ;; \
		*) actual=$$(sha256sum '$(PRODUCT_PACKAGE)' | cut -d' ' -f1); \
		   if [ "$$actual" != "$(PACKAGE_SHA256)" ]; then \
			printf '%s\n' 'error: the candidate is not the pinned artifact.' \
			"  expected: $(PACKAGE_SHA256)" \
			"  measured: $$actual" \
			"  file:     $(PRODUCT_PACKAGE)" \
			'  A gate that measured a different byte would answer a different question.' \
			'  Nothing was installed and nothing was verified.' >&2; \
			exit 2; \
		   fi; \
		   printf '== candidate: %s sha256 %s (pinned)\n' "$(PRODUCT_PACKAGE)" "$(PACKAGE_SHA256)" ;; \
	esac

# The strict release door verifies a frozen artifact. `PACKAGE_SHA256` is therefore
# required by that door, not optional: an unpinned run cannot distinguish the
# artifact that was reviewed from one packed a minute later, and "same package" is
# exactly the substitution a release conclusion must not permit.
#
# The diagnostic aggregates (`package-check`, `production-check`) deliberately do
# not depend on this target: they say in their own output that they are not a
# release conclusion, so they may measure whatever this tree last packed.
.PHONY: require-package-sha
require-package-sha: require-package
	@test -n "$(PACKAGE_SHA256)" || { \
		printf '%s\n' 'error: PACKAGE_SHA256 is not set.' \
		'  The release door verifies one frozen artifact by bytes:' \
		'    make release-check PACKAGE=<tgz> PACKAGE_SHA256=<sha256 of that file> ...' \
		'  An unpinned run cannot prove the reviewed artifact is the measured one, so' \
		'  it is not a release conclusion. Use package-check or production-check for an' \
		'  unpinned diagnostic run.' \
		'  Nothing was verified.' >&2; \
		exit 2; }
	@case "$(PACKAGE_SHA256)" in \
		*[!0-9a-f]*) printf '%s\n' "error: PACKAGE_SHA256 is not a lowercase hex digest: $(PACKAGE_SHA256)" \
			'  Nothing was verified.' >&2; exit 2 ;; \
	esac
	@test "$$(printf %s '$(PACKAGE_SHA256)' | wc -c | tr -d ' ')" = "64" || { \
		printf '%s\n' 'error: PACKAGE_SHA256 must be exactly 64 hex characters.' \
		'  Nothing was verified.' >&2; \
		exit 2; }

# The acceptance gates need a released runtime, not this repository. RUNTIME=
# names it; INSTALL_DIR= is accepted as the same thing so one variable configures
# the whole door.
.PHONY: require-runtime
require-runtime: require-bun
	@test -n "$(RUNTIME_DIR)" || { \
		releases=$$($(BUN) -e 'import {supportedVersionsText} from "./adapters/dsh/compatibility.ts"; process.stdout.write(supportedVersionsText())') || releases='a tested release'; \
		printf '%s\n' 'error: no released DSH runtime was named for this gate.' \
		"  These gates exercise real published packages ($$releases), so they need an" \
		'  isolated install of one tested release:' \
		'    make runtime-setup INSTALL_DIR=<dir> DSH_VERSION=<release>' \
		'  or name an existing one: make <gate> RUNTIME=<dir>  (INSTALL_DIR= also works)' \
		'  Nothing was installed and nothing was verified.' >&2; \
		exit 2; }
	@$(TASKS) install-dir --quiet "$(RUNTIME_DIR)"

# The browser gate additionally needs a real browser binary and the published
# static slot package the Client mounts into; both are named explicitly rather
# than discovered, because a silently substituted browser or slot package would
# make the result mean something else.
.PHONY: require-browser require-slots
require-browser:
	@test -n "$(BROWSER)" || { \
		printf '%s\n' 'error: BROWSER is not set.' \
		'  client-check launches a real browser against the packed Client factory:' \
		'    make client-check BROWSER=<chromium-or-chrome-binary> ...' \
		'  A headless browser is not installed by this repository.' >&2; \
		exit 2; }
	@test -x "$(BROWSER)" || { \
		printf '%s\n' "error: BROWSER is not an executable file: $(BROWSER)" \
		'  Nothing was launched and nothing was verified.' >&2; \
		exit 2; }
	@# `fc-list` may itself need the browser's shared libraries: an extracted fontconfig
	@# tree links against libfontconfig from that tree. So the count below runs in the
	@# same environment the browser will get.
	@# A browser with no font faces aborts in crashpad before loading a page, and the
	@# symptom reads like a missing shared library. A config file that merely parses
	@# is not evidence: a valid fonts.conf pointing at an empty directory reproduces
	@# the same abort. So the precondition is the number of enumerated faces.
	@fc=$$(command -v fc-list 2>/dev/null || true); \
	if [ -z "$$fc" ] && [ -n "$(FONTCONFIG_BIN)" ]; then fc="$(FONTCONFIG_BIN)"; fi; \
	if [ -z "$$fc" ]; then \
		printf '%s\n' 'error: no fc-list on PATH, so the browser font precondition cannot be checked.' \
		'  A browser with no font faces aborts before loading a page; this gate refuses' \
		'  to launch one it cannot check.' \
		'  Install fontconfig (it provides fc-list), or point FONTCONFIG_BIN at one.' \
		'  Nothing was launched and nothing was verified.' >&2; \
		exit 2; \
	fi; \
	faces=$$(FONTCONFIG_FILE="$(FONTCONFIG_FILE)" LD_LIBRARY_PATH="$(ENSEMBLE_BROWSER_LIBRARIES)" "$$fc" 2>/dev/null | wc -l | tr -d ' '); \
	if [ "$$faces" = "0" ] || [ -z "$$faces" ]; then \
		printf '%s\n' 'error: fontconfig enumerates no font faces, so a browser launched' \
		'  here would abort before loading the page. This is an environment failure,' \
		'  not a product failure.' \
		'  Install fontconfig plus a font package (for example fonts-dejavu-core) and' \
		'  point FONTCONFIG_FILE at a config whose <dir> really contains faces, then' \
		'  check that `fc-list | wc -l` is greater than zero.' \
		'  Nothing was launched and nothing was verified.' >&2; \
		exit 2; \
	fi; \
	printf '  %-16s %s\n' 'browser fonts' "$$faces faces enumerated"

require-slots:
	@test -n "$(SLOTS)" || { \
		printf '%s\n' 'error: SLOTS is not set.' \
		'  client-check loads the published static slot package the Client mounts into,' \
		'  so it must be named explicitly:' \
		'    make client-check SLOTS=<dir containing @deepseek-ai/dsh-client-ui-slots> ...' \
		'  Nothing was launched and nothing was verified.' >&2; \
		exit 2; }
	@test -d "$(SLOTS)" || { \
		printf '%s\n' "error: SLOTS is not a directory: $(SLOTS)" \
		'  Nothing was launched and nothing was verified.' >&2; \
		exit 2; }

# ---------------------------------------------------------------------------
# getting started
# ---------------------------------------------------------------------------
.PHONY: doctor setup
doctor: require-bun
	@$(TASKS) doctor

setup: require-bun
	@printf '%s\n' '== setup: installing locked dependencies (this target uses the network)'
	@$(BUN) install --frozen-lockfile
	@$(MAKE) --no-print-directory doctor
	@$(MAKE) --no-print-directory check

# ---------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------
.PHONY: check test test-narrow test-watch typecheck typecheck-host typecheck-client docs

check: require-deps require-python
	@printf '%s\n' '== check: content drift (skill is a committed artifact)'
	@$(BUN) scripts/build-ensemble.ts check skill
	@printf '%s\n' '== check: types (repository + dependency-free DSH modules)'
	@$(BUN) node_modules/typescript/bin/tsc --noEmit
	@$(BUN) node_modules/typescript/bin/tsc -p adapters/dsh/tsconfig.json
	@printf '%s\n' '== check: every maintained TypeScript file is in a compiled program'
	@$(BUN) scripts/check-type-coverage.ts
	@printf '%s\n' '== check: CLI bundle closure (committed artifact)'
	@$(BUN) scripts/check-dsh-bundle.ts
	@printf '%s\n' '== check: documentation references'
	@$(PYTHON) scripts/check-docs.py
	@printf '%s\n' '== check: ok (offline; nothing written)'

test: require-bun
	@$(BUN) test

test-narrow: require-bun
	@$(BUN) test scripts/build-ensemble.test.ts

test-watch: require-bun
	@$(BUN) test --watch

typecheck: require-deps
	@$(BUN) node_modules/typescript/bin/tsc --noEmit
	@$(BUN) node_modules/typescript/bin/tsc -p adapters/dsh/tsconfig.json

# The runtime-typed programs. `INSTALL_DIR` supplies the published
# `@deepseek-ai/*` types of a tested release and `CLIENT_TYPES` supplies the
# published slot package at that same release plus React at the major the official
# Client plugins declare. Both programs compile, or this target fails: there is no
# mode that types half the runtime modules and reports a pass.
typecheck-host: require-deps require-install-dir-types require-client-types
	@printf '== typecheck-host: %s (Host + Client programs)\n' "$(INSTALL_DIR)"
	@$(BUN) adapters/dsh/typecheck-host.ts "$(INSTALL_DIR)" --client-types "$(CLIENT_TYPES)"

# The complete type claim: both plain programs, both runtime programs, and the
# closure check that proves no maintained file is in no program. This is the one
# target a release (and CI) calls; `typecheck` above stays the offline subset so a
# bare machine can still check the plain code.
.PHONY: typecheck-strict
typecheck-strict: require-deps require-install-dir-types require-client-types
	@printf '== typecheck-strict: plain + Host + Client programs against %s\n' "$(INSTALL_DIR)"
	@$(BUN) node_modules/typescript/bin/tsc --noEmit
	@$(BUN) node_modules/typescript/bin/tsc -p adapters/dsh/tsconfig.json
	@$(BUN) scripts/check-type-coverage.ts --strict \
		--host-install "$(INSTALL_DIR)" --client-types "$(CLIENT_TYPES)"

# Convenience name for the Client half alone; it is the same program the line
# above compiles, not a weaker variant.
typecheck-client: require-deps require-install-dir require-client-types
	@printf '== typecheck-client: %s against %s\n' "$(CLIENT_TYPES)" "$(INSTALL_DIR)"
	@$(BUN) adapters/dsh/typecheck-host.ts "$(INSTALL_DIR)" --client-types "$(CLIENT_TYPES)"

docs: require-python
	@$(PYTHON) scripts/check-docs.py

# ---------------------------------------------------------------------------
# upstream observation — explicit network, never a gate and never an upgrade
# ---------------------------------------------------------------------------
# Reads the public npm registry and classifies what it finds against
# `adapters/dsh/compatibility.ts`, the single source of truth for support.
# Deliberately absent from check/test/package-check/all: the default gates stay
# offline. Exit 0 = runtime tags within the supported set and every supported
# release published; 1 = a runtime tag outside the set, a candidate to evaluate;
# 2 = the observation failed (registry unreadable, or a supported release is
# missing from a required package).
.PHONY: check-upstream
check-upstream: require-bun
	@printf '%s\n' '== check-upstream: querying the public npm registry (network)'
	@$(BUN) scripts/check-upstream.ts

# ---------------------------------------------------------------------------
# content
# ---------------------------------------------------------------------------
.PHONY: content content-build

# omp/dsh artifacts live in the ignored build/ tree, so a fresh clone has none.
# That is not drift; say so and point at content-build instead of reporting the
# artifact as missing.
content: require-target require-deps
	@if [ "$(TARGET)" != skill ]; then $(TASKS) staging "$(TARGET)"; fi
	@printf '== content: checking %s for drift\n' "$(TARGET)"
	@$(BUN) scripts/build-ensemble.ts check "$(TARGET)"

content-build: require-target require-deps
	@printf '== content-build: regenerating %s from content/ensemble/\n' "$(TARGET)"
	@$(BUN) scripts/build-ensemble.ts build "$(TARGET)"

# ---------------------------------------------------------------------------
# packages
# ---------------------------------------------------------------------------
.PHONY: pack pack-omp pack-dsh pack-dsh-agent-wait inspect

# All three installable roots. Each is an independent package with its own
# allowlist and README; nothing here publishes or installs any of them.
pack: pack-omp pack-dsh pack-dsh-agent-wait

pack-omp: require-npm
	@$(BUN) scripts/pack-omp.ts

pack-dsh: require-npm
	@$(BUN) scripts/pack-dsh.ts

# The CLI's transport bundle is a committed artifact generated from published
# package inputs. Packaging only reads it, so `pack` stays offline; regenerating
# is this explicit target, and it refuses without an install to build from rather
# than bundling whatever `node_modules` happens to contain.
.PHONY: dsh-bundle dsh-bundle-check

dsh-bundle: require-bun
	@test -n "$(DSH_BUNDLE_INSTALL)" || { \
		printf '%s\n' 'error: dsh-bundle needs the install to build from.' \
		'  The bundle is generated from published DSH packages, so name the tree:' \
		'    make dsh-bundle DSH_BUNDLE_INSTALL=<isolated DSH install>' \
		'  Nothing was built and nothing was written.' >&2; \
		exit 2; }
	@$(BUN) scripts/build-dsh-bundle.ts

dsh-bundle-check: require-bun
	@$(BUN) scripts/check-dsh-bundle.ts

# Dual-release CLI verification: a fresh profile per release, installed by the
# ordinary `dsh plugin add`, with the packaged bin run under real Node. It needs
# both isolated installs because the claim is about both; one release is not
# evidence for the other.
.PHONY: cli-check

cli-check: require-bun require-node
	@test -n "$(RC4_INSTALL)" -a -n "$(RC5_INSTALL)" || { \
		printf '%s\n' 'error: cli-check needs both isolated installs.' \
		'  The CLI claim covers both supported releases, so both must be named:' \
		'    make cli-check RC4_INSTALL=<rc.4 install> RC5_INSTALL=<rc.5 install>' \
		'  Nothing was installed and nothing is claimed.' >&2; \
		exit 2; }
	@$(BUN) scripts/verify-dsh-cli.ts --rc4 "$(RC4_INSTALL)" --rc5 "$(RC5_INSTALL)"

pack-dsh-agent-wait: require-npm
	@$(BUN) scripts/pack-dsh-agent-wait.ts

inspect: require-bun
	@$(TASKS) inspect

# ---------------------------------------------------------------------------
# runtime gates
# ---------------------------------------------------------------------------
.PHONY: host-check loader-check profile-check isolation-check diagnose

host-check: typecheck-host loader-check

# The real Loader must resolve @deepseek-ai/* from INSTALL_DIR, so it runs from
# a temporary directory inside that install. Nothing in the repository is
# touched, and the scratch directory is removed on exit.
#
# The scratch directory declares `{"type":"module"}`. `loader-check.ts` uses
# `import`, and Node walks up to the nearest `package.json` to decide how to
# parse it. An install created with `npm init -y` writes `"type": "commonjs"`,
# so without this declaration the module is parsed as CommonJS and fails with
# "Cannot use import statement outside a module". The declaration belongs to
# the scratch directory only; the install's own `package.json` is the user's
# and is never written. `adapters/dsh/typecheck-host.ts` does the same.
#
# The probe package must already be installed in INSTALL_DIR: the Loader
# resolves it like any other dependency. When it is missing, say which command
# installs it instead of surfacing Node's module-resolution stack.
loader-check: require-node require-install-dir
	@test -d "$(INSTALL_DIR)/node_modules/dsh-ensemble" || { \
		printf '%s\n' "error: no dsh-ensemble installed in $(INSTALL_DIR)." \
		'  The Loader resolves this repository'"'"'s probe package from that install, so' \
		'  it must be installed there before the gate can run:' \
		'    make pack-dsh' \
		'    cd "'"$(INSTALL_DIR)"'" && npm install --ignore-scripts <this-repo>/$(DSH_PROBE_DIR)/dsh-ensemble-*.tgz' \
		'  Nothing was installed and nothing was verified.' >&2; \
		exit 2; }
	@printf '== loader-check: real Loader against %s\n' "$(INSTALL_DIR)"
	@scratch=$$(mktemp -d "$(INSTALL_DIR)/.make-loader.XXXXXX") || exit 2; \
	trap 'rm -rf "$$scratch"' EXIT HUP INT TERM; \
	cp adapters/dsh/loader-check.ts "$$scratch/loader-check.ts" || exit 1; \
	printf '{"type":"module"}\n' > "$$scratch/package.json" || exit 1; \
	cd "$$scratch" && DSH_PROBE_TMP="$$scratch/.probe" $(NODE) loader-check.ts

# Both diagnosis scripts ship with this repository, but a partial checkout or a
# misassembled tree can still be missing one. When that happens, name the file
# and exit 2: silently doing nothing would let a gate look like it passed.
profile-check: require-bun
	@test -f scripts/profile-check.ts || { \
		printf '%s\n' 'error: profile-check is missing its required file.' \
		'  scripts/profile-check.ts does not exist in this checkout, so DSH profile' \
		'  boot cannot be checked here. Nothing was run and nothing is claimed.' >&2; \
		exit 2; }
	@$(BUN) scripts/profile-check.ts $(if $(INSTALL_DIR),"$(INSTALL_DIR)")

isolation-check: require-bun
	@test -f scripts/check-isolation.ts || { \
		printf '%s\n' 'error: isolation-check is missing its required file.' \
		'  scripts/check-isolation.ts does not exist in this checkout, so' \
		'  execution-world isolation cannot be checked here. Nothing was run and' \
		'  nothing is claimed.' >&2; \
		exit 2; }
	@$(BUN) scripts/check-isolation.ts $(if $(INSTALL_DIR),"$(INSTALL_DIR)")

# ---------------------------------------------------------------------------
# production gates — the installed product, not the Loader
# ---------------------------------------------------------------------------
# The Loader gates above prove the plugin *loads*. These prove the installed
# product *works*: a standard `dsh plugin add`, real native AgentLoop tool calls,
# an authenticated owner Remote, the packaged CLI, the real Client factory in a
# browser, and the archive/maintenance/environment/subject-world behaviour
# against real published DSH packages.
#
# None of them can be satisfied offline, and none of them degrades to a skip:
# every missing prerequisite exits 2 with the command that supplies it. That is
# deliberate — a gate that silently measures nothing is worse than no gate,
# because it reports green.
.PHONY: product-check client-check maintenance-check environment-check \
        store-acceptance-check native-acceptance-check \
        matrix-check production-check

# Standard install of the candidate tarball, then: native AgentLoop
# `ensemble_work`, authenticated owner HTTP Remote, packaged headless CLI.
# This is the gate that can catch a Host entry that loads but refuses real tool
# calls, which the Loader gate cannot.
product-check: require-node require-install-dir require-package
	@printf '== product-check: %s against %s\n' "$(PRODUCT_PACKAGE)" "$(INSTALL_DIR)"
	@$(BUN) scripts/verify-dsh-product.ts "$(INSTALL_DIR)" "$(PRODUCT_PACKAGE)"

# The packed Client factory in a real browser: official ClientModuleSystem,
# published SlotRegistry renderer, the declared minimal shell. The Remote data is
# a fixture, so this is Client evidence, not authenticated Host evidence.
client-check: require-node require-package require-browser require-slots
	@printf '== client-check: %s\n' "$(PRODUCT_PACKAGE)"
	@$(BUN) adapters/dsh/client/verify-browser.ts \
		--package "$(PRODUCT_PACKAGE)" \
		--runtime "$(RUNTIME_DIR)" \
		--slots "$(SLOTS)" \
		--browser "$(BROWSER)" \
		--output "$(CLIENT_OUT)"

# Real-kernel maintenance: import/export, backup/restore, migration, relocate,
# replication and approved purge, including restart reconciliation.
maintenance-check: require-bun require-runtime require-node
	@printf '== maintenance-check: engine regression against %s\n' "$(RUNTIME_DIR)"
	@$(BUN) scripts/verify-dsh-maintenance.ts --install-dir "$(RUNTIME_DIR)"

# The live maintenance gate: it drives the **installed** product through the
# packaged CLI against a real Host, so it needs the candidate tarball as well as
# the released install. This is the target the strict release door calls; the
# engine gate above is a regression, not a substitute for it.
maintenance-live-check: require-bun require-runtime require-node require-package
	@printf '== maintenance-live-check: %s against %s\n' "$(RUNTIME_DIR)" "$(PRODUCT_PACKAGE)"
	@$(BUN) scripts/verify-dsh-maintenance.ts --live --install-dir "$(RUNTIME_DIR)" --tarball "$(PRODUCT_PACKAGE)"

# The native test families that offline `make test` skips, run against a named install.
#
# `make test` reports ~92 skips because no install is named on a machine that has none, which
# is legitimate. What is not legitimate is letting those skips stand for the release claim:
# the product gates boot real Hosts, but that is a different statement from "these named
# tests executed". This target supplies each family's own environment and **fails when a
# family still skips**, because a skip here means the tests did not run.
#
# The live CLI case needs a running Host's origin and credential file. Both are the caller's
# to name, and the credential is a **path**, never a value: a token on a command line or in a
# log is a leak, and an invented one would test nothing. Without them that one test is
# reported skipped, never passed.
.PHONY: runtime-test-check
runtime-test-check: require-bun require-install-dir
	@printf '== runtime-test-check: native families against %s\n' "$(INSTALL_DIR)"
	@$(BUN) scripts/verify-dsh-runtime-tests.ts \
		--install "$(INSTALL_DIR)" \
		$(if $(LIVE_ORIGIN),--live-origin "$(LIVE_ORIGIN)") \
		$(if $(LIVE_COOKIE_FILE),--live-cookie-file "$(LIVE_COOKIE_FILE)")

# The live CLI case from `adapters/dsh/cli.test.ts`, executed and never skipped.
#
# Offline that case skips for want of a running Host, which is correct there and
# unacceptable here: a release cannot claim it ran while its only execution path is
# "skipped unless someone exports two variables by hand". This target starts the Host
# itself, takes the origin and the **api cookie file path** from the handoff the driver
# wrote, and fails if the case skips, fails, or runs zero tests.
#
# The credential travels by path, never by value: nothing secret reaches argv or a log.
.PHONY: live-cli-test
live-cli-test: require-bun require-node require-install-dir require-package-sha
	@printf '== live-cli-test: %s against %s\n' "$(PRODUCT_PACKAGE)" "$(INSTALL_DIR)"
	@$(BUN) scripts/verify-dsh-live-cli.ts \
		--install-dir "$(INSTALL_DIR)" \
		--package "$(PRODUCT_PACKAGE)" \
		--sha256 "$(PACKAGE_SHA256)" \
		--output "$(CLIENT_OUT)/live-cli"

# Selection evidence against a real Host and a real member Session log. The four
# assertions here are the ones the product gate does not make: an unreadable
# Session yields `unavailable` rather than an invented answer, a different Session
# id is not attributed to this attempt, a requested model the member never used
# still reports the real one, and repeating the read is byte-identical.
#
# Separate from `environment-check` on purpose: that target already boots a Host,
# and a second boot hidden inside it would make a failure ambiguous.
.PHONY: selection-check
selection-check: require-bun require-runtime
	@printf '== selection-check: %s\n' "$(RUNTIME_DIR)"
	@$(BUN) adapters/dsh/environment/selection-check.mts "$(RUNTIME_DIR)"

# The environment ledger against real native Settings, including the
# lost-response reconciliation that must not resend an applied change.
environment-check: require-bun require-runtime
	@printf '== environment-check: against %s\n' "$(RUNTIME_DIR)"
	@$(BUN) adapters/dsh/environment/native-check.mts "$(RUNTIME_DIR)"

# Non-author acceptance suites. These are other people's scripts; this Makefile
# only calls them, so a change in what they cover is theirs to make.
store-acceptance-check: require-bun require-runtime
	@printf '== store-acceptance-check: against %s\n' "$(RUNTIME_DIR)"
	@$(BUN) scripts/verify-dsh-store-acceptance.ts --runtime "$(RUNTIME_DIR)"

native-acceptance-check: require-bun require-runtime
	@printf '== native-acceptance-check: against %s\n' "$(RUNTIME_DIR)"
	@$(BUN) scripts/verify-dsh-native-acceptance.ts --runtime "$(RUNTIME_DIR)"

# The independent replica-transport acceptance suite: nine typed cases over real
# authenticated HTTP, with its own fixtures. It is somebody else's script; this
# Makefile only calls it, so what it covers is theirs to change.
replica-acceptance-check: require-bun require-runtime
	@printf '== replica-acceptance-check: against %s\n' "$(RUNTIME_DIR)"
	@$(BUN) scripts/verify-dsh-replica-acceptance.ts --runtime "$(RUNTIME_DIR)"

# The authenticated-UI gate. It is deliberately *not* `client-check`: that one
# mounts the packed factory into a shell the gate declares itself, with fixture
# Remote data. This one boots the real Host with the real profile, hands the
# browser the cookie the Host itself issued, and asserts the shipped Client
# composes into the official sidebar and main seats, does an owner write, sees
# the read revision advance, and loses management when the Host stops accepting
# the cookie. A component fixture cannot stand in for any of that.
#
# The browser is named, not discovered. `BROWSER` must be an official
# Chrome/Chromium build; `ENSEMBLE_BROWSER_LIBRARIES` and
# `ENSEMBLE_BROWSER_FONTCONFIG` carry the shared libraries and font configuration
# that build needs on a bare machine. A fontless or library-less browser aborts
# before the page loads — an environment failure (exit 2), never a product fail
# and never a skip.
.PHONY: auth-ui-check
auth-ui-check: require-node require-package require-browser require-install-dir
	@printf '== auth-ui-check: %s against %s\n' "$(PRODUCT_PACKAGE)" "$(INSTALL_DIR)"
	@$(BUN) scripts/verify-dsh-client.ts --install-dir "$(INSTALL_DIR)" --package "$(PRODUCT_PACKAGE)" --browser "$(BROWSER)" --output "$(CLIENT_OUT)/auth"

# The source-world fixture has two very different checks, and conflating them is
# how a cross-container claim quietly becomes a local one.
#
#   fixture-test              offline. Starts the test server as a child process
#                             on a free loopback port and exercises its wire
#                             contract: authentication, path refusal, opaque
#                             handles, byte budgets, dynamic read ACL. It proves
#                             the fixture, not the product.
#   source-acceptance-check   needs a *running* fixture in another container. It
#                             proves the native FileSystem adapter reads source
#                             bytes that do not exist on the Host filesystem, and
#                             that revoking the read permission stops the next
#                             scan.
#
# The second is deliberately absent from every default door: CI has to provision
# the second container, and a gate that quietly measured the local filesystem
# instead would be worse than no gate. Missing token or URL exits 2 saying the
# cross-container check was not run.
.PHONY: fixture-test source-acceptance-check

fixture-test: require-bun
	@printf '%s\n' '== fixture-test: source-world server contract (offline, own loopback port)'
	@$(BUN) test scripts/fixtures/

source-acceptance-check: require-bun require-runtime
	@test -n "$(ENSEMBLE_SOURCE_TEST_TOKEN)" || { \
		printf '%s\n' 'error: the cross-container source check was not run.' \
		'  It needs a fixture server running in a different container with no' \
		'  project mount, and the test token that server was started with:' \
		'    # in the separate container:' \
		'    ENSEMBLE_SOURCE_TEST_TOKEN=<24+ chars> node scripts/fixtures/source-world-server.mjs' \
		'    # here:' \
		'    ENSEMBLE_SOURCE_TEST_TOKEN=<same> ENSEMBLE_SOURCE_TEST_URL=<url> make source-acceptance-check' \
		'  Nothing was read and nothing is claimed.' >&2; \
		exit 2; }
	@test -n "$(ENSEMBLE_SOURCE_TEST_URL)" || { \
		printf '%s\n' 'error: the cross-container source check was not run.' \
		'  ENSEMBLE_SOURCE_TEST_TOKEN is set but ENSEMBLE_SOURCE_TEST_URL is not, so' \
		'  there is no fixture to read from. Pass the URL the fixture printed:' \
		'    ENSEMBLE_SOURCE_TEST_URL=http://127.0.0.1:<port> make source-acceptance-check' >&2; \
		exit 2; }
	@printf '== source-acceptance-check: source served from %s\n' "$(ENSEMBLE_SOURCE_TEST_URL)"
	@$(BUN) adapters/dsh/native/verify-source.mjs "$(RUNTIME_DIR)"

# The cross-container source world, provisioned the way the gate needs it: the
# fixture runs in its *own* container, its only inputs are the fixture script
# (mounted read-only) and a tmpfs, and its only channel is a loopback port. The
# project is deliberately not mounted: the whole point of the gate is that the
# bytes it reads do not exist on the Host filesystem. The token is generated here
# and never printed into a file that outlives the run.
#
# Network mode is `host` on purpose. The fixture binds `127.0.0.1` inside its own
# container, so a published port on a bridge network would forward to an interface
# nothing is listening on, and `--network none` has nothing to forward at all. Host
# networking makes the loopback listener reachable while the *filesystem* stays a
# separate container filesystem — which is exactly what this gate claims. It is
# deliberately not a network-isolation claim, and none is made.
#
# This target prints the two variables the gate needs, so a maintainer (and CI)
# uses one command instead of hand-assembling a container invocation:
#     eval "$(make -s source-sidecar)"   # sets ENSEMBLE_SOURCE_TEST_TOKEN and _URL
#     make source-acceptance-check
#     make source-sidecar-stop CONTAINER=<name>
.PHONY: source-sidecar source-sidecar-stop

source-sidecar: require-node
	@command -v podman >/dev/null 2>&1 || command -v docker >/dev/null 2>&1 || { \
		printf '%s\n' 'error: no container runtime on PATH (podman or docker).' \
		'  The cross-container source gate needs a second world to serve the bytes;' \
		'  running it inside this container would prove nothing.' \
		'  Nothing was started.' >&2; \
		exit 2; }
	@test -f scripts/fixtures/source-world-server.mjs || { \
		printf '%s\n' 'error: scripts/fixtures/source-world-server.mjs does not exist.' \
		'  Nothing was started.' >&2; exit 2; }
	@runtime=$$(command -v podman || command -v docker); \
	token=$$($(NODE) -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))'); \
	name=ensemble-source-$$($(NODE) -e 'process.stdout.write(require("node:crypto").randomBytes(4).toString("hex"))'); \
	$$runtime run --detach --name "$$name" \
		--network host --read-only \
		--tmpfs /tmp:rw,size=16m \
		--mount type=bind,src="$(CURDIR)/scripts/fixtures/source-world-server.mjs",dst=/fixture/server.mjs,ro=true \
		--env ENSEMBLE_SOURCE_TEST_TOKEN="$$token" \
		--env ENSEMBLE_SOURCE_TEST_PORT=18743 \
		--env HOME=/tmp --workdir /tmp \
		--entrypoint node \
		"$(SOURCE_IMAGE)" /fixture/server.mjs >/dev/null || { printf '%s\n' 'error: the source-world container did not start.' '  Nothing was verified.' >&2; exit 2; }; \
	for attempt in $$(seq 1 60); do \
		if $(NODE) -e 'fetch("http://127.0.0.1:18743/health",{headers:{authorization:"Bearer "+process.argv[1]}}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))' "$$token" 2>/dev/null; then break; fi; \
		if [ "$$attempt" = 60 ]; then printf '%s\n' 'error: the source-world fixture never answered /health.' '  Nothing was verified.' >&2; exit 2; fi; \
		sleep 1; \
	done; \
	printf 'CONTAINER=%s\n' "$$name"; \
	printf 'ENSEMBLE_SOURCE_TEST_TOKEN=%s\n' "$$token"; \
	printf 'ENSEMBLE_SOURCE_TEST_URL=http://127.0.0.1:18743\n'

source-sidecar-stop: require-node
	@test -n "$(CONTAINER)" || { \
		printf '%s\n' 'error: CONTAINER is not set.' \
		'  Name the container `make source-sidecar` printed: make source-sidecar-stop CONTAINER=<name>' >&2; \
		exit 2; }
	@runtime=$$(command -v podman || command -v docker); \
	"$$runtime" rm -f "$(CONTAINER)" >/dev/null 2>&1 || { printf '%s\n' "error: could not remove $(CONTAINER)." >&2; exit 2; }; \
	printf '%s\n' '== source-sidecar-stop: removed'

# The cross-container source gate, provisioned end to end by this one target: it
# starts the fixture container, runs the acceptance check, and stops the container
#
# Two ways this guard could silently pass, both fixed here:
#
# 1. `eval "value=\$$var"` assigned the variable's *name* instead of its value, so the
#    emptiness test compared a non-empty string with itself and never failed. Values are
#    now read with `printenv`, which cannot evaluate its argument as code.
# 2. `test -n "   "` is true, so a whitespace-only value would have counted as a stated
#    fact. The value is stripped of whitespace before the test.
#
# The external branch reads the four attestation variables through `printenv`, not
# through `eval "value=\$$var"`: with the escaped dollar that assignment produced the
# *name* of the variable instead of its value, so the emptiness test compared a
# non-empty string with itself and never fired. The driver refused downstream anyway,
# but this branch exists to refuse first, and a guard that cannot fail is worse than
# no guard at all.
#
# on every exit path. Splitting start/check/stop across three CI steps is how a
# failed check leaves a container behind, and how a "stop" step with `if: always()`
# quietly becomes the only thing that ran.
#
# The container's inputs are the fixture script (read-only mount) and a tmpfs; the
# project is not mounted, which is the entire point of the gate. The token is
# generated per run, handed to both sides through the environment only, and never
# written to a file that outlives the run.
.PHONY: source-acceptance-sidecar-check
source-acceptance-sidecar-check: require-bun require-runtime require-node
	@test -f scripts/fixtures/source-world-server.mjs || { \
		printf '%s\n' 'error: scripts/fixtures/source-world-server.mjs does not exist.' \
		'  Nothing was started and nothing was verified.' >&2; exit 2; }
	mode="$(SOURCE_MODE)"; \
	if [ -z "$$mode" ]; then \
		if [ -n "$(ENSEMBLE_SOURCE_TEST_TOKEN)" ] && [ -n "$(ENSEMBLE_SOURCE_TEST_URL)" ]; then mode=external; else mode=sidecar; fi; \
	fi; \
	case "$$mode" in \
	sidecar|external) ;; \
	*) printf '%s\n' "error: SOURCE_MODE must be sidecar or external, got $$mode." \
		'  Nothing was verified.' >&2; exit 2 ;; \
	esac; \
	if [ "$$mode" = external ]; then \
		test -n "$(ENSEMBLE_SOURCE_TEST_TOKEN)" && test -n "$(ENSEMBLE_SOURCE_TEST_URL)" || { \
			printf '%s\n' 'error: SOURCE_MODE=external needs ENSEMBLE_SOURCE_TEST_TOKEN and ENSEMBLE_SOURCE_TEST_URL.' \
			'  Name the fixture that is already running in a separate container.' \
			'  Nothing was verified.' >&2; exit 2; }; \
		for var in ENSEMBLE_SOURCE_ATTEST_BY ENSEMBLE_SOURCE_ATTEST_CONTAINER \
		           ENSEMBLE_SOURCE_ATTEST_STATEMENT ENSEMBLE_SOURCE_ATTEST_COPY_SHA256; do \
			value=$$(printenv "$$var" || true); \
			value=$$(printf '%s' "$$value" | tr -d '[:space:]'); \
			test -n "$$value" || { \
				printf '%s\n' "error: SOURCE_MODE=external needs $$var." \
				'  This target did not start that container, so it cannot attest to it;' \
				'  the operator that provisioned it must state the four facts.' \
				'  Nothing was verified.' >&2; exit 2; }; \
		done; \
		printf '== source-acceptance-sidecar-check: external world at %s\n' "$(ENSEMBLE_SOURCE_TEST_URL)"; \
		printf '%s\n' '   provenance: the native reader must fail to stat /source/binary.dat on this' \
		'   filesystem, or the bytes are not from a separate world.'; \
		$(MAKE) --no-print-directory source-acceptance-check RUNTIME="$(RUNTIME_DIR)"; \
		exit $$?; \
	fi; \
	runtime=$$(command -v podman || command -v docker) || { \
		printf '%s\n' 'error: no container runtime on PATH (podman or docker).' \
		'  This gate needs the source world in a *different* container; reading the' \
		'  bytes from this process would prove nothing, so a same-process mock is not' \
		'  an option.' \
		'  Either install a container runtime, or name a fixture that is already running' \
		'  in a separate container (cross-container provenance):' \
		'    make source-acceptance-sidecar-check \\' \
		'      ENSEMBLE_SOURCE_TEST_TOKEN=<token that container was started with> \\' \
		'      ENSEMBLE_SOURCE_TEST_URL=http://<that-container>:<port>' \
		'  Nothing was started and nothing was verified.' >&2; \
		exit 2; }; \
	token=$$($(NODE) -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))'); \
	name=ensemble-source-$$($(NODE) -e 'process.stdout.write(require("node:crypto").randomBytes(4).toString("hex"))'); \
	cidfile=$$(mktemp "$${TMPDIR:-/tmp}/ensemble-source-cid.XXXXXX") || exit 2; \
	cleanup() { "$$runtime" rm -f "$$name" >/dev/null 2>&1 || true; rm -f "$$cidfile" 2>/dev/null || true; }; \
	trap cleanup EXIT HUP INT TERM; \
	"$$runtime" run --detach --name "$$name" --cidfile "$$cidfile" \
		--network host --read-only --tmpfs /tmp:rw,size=32m \
		--mount type=bind,src="$(CURDIR)/scripts/fixtures/source-world-server.mjs",dst=/fixture/server.mjs,ro=true \
		--env ENSEMBLE_SOURCE_TEST_TOKEN="$$token" \
		--env ENSEMBLE_SOURCE_TEST_PORT=18743 \
		--env HOME=/tmp --workdir /tmp --entrypoint node \
		"$(SOURCE_IMAGE)" /fixture/server.mjs >/dev/null || { \
		printf '%s\n' 'error: the source-world container did not start.' '  Nothing was verified.' >&2; \
		exit 2; }; \
	for attempt in $$(seq 1 60); do \
		if $(NODE) -e 'fetch("http://127.0.0.1:18743/",{headers:{authorization:"Bearer "+process.argv[1]}}).then(r=>process.exit(r.status===200||r.status===404?0:1)).catch(()=>process.exit(1))' "$$token" 2>/dev/null; then break; fi; \
		if [ "$$attempt" = 60 ]; then printf '%s\n' 'error: the source-world fixture never became reachable.' '  Nothing was verified.' >&2; exit 2; fi; \
		sleep 1; \
	done; \
	container=$$(cat "$$cidfile" 2>/dev/null); \
	test -n "$$container" || { printf '%s\n' 'error: the runtime reported no container id.' '  Nothing was verified.' >&2; exit 2; }; \
	mounts=$$("$$runtime" inspect --format '{{range .Mounts}}{{.Source}} {{end}}' "$$container" 2>/dev/null); \
	case "$$mounts" in \
		*"$(CURDIR)"*) printf '%s\n' 'error: the source-world container has the project mounted.' \
			'  The gate exists to read bytes that are NOT on this filesystem; a project' \
			'  mount would make the measurement meaningless.' '  Nothing was verified.' >&2; exit 2 ;; \
	esac; \
	copy=$$("$$runtime" exec "$$container" sha256sum /fixture/server.mjs 2>/dev/null | cut -d' ' -f1); \
	local_copy=$$(sha256sum scripts/fixtures/source-world-server.mjs | cut -d' ' -f1); \
	test -n "$$copy" || { printf '%s\n' 'error: could not hash the fixture inside the container.' '  Nothing was verified.' >&2; exit 2; }; \
	test "$$copy" = "$$local_copy" || { \
		printf '%s\n' 'error: the container runs a different fixture than this checkout.' \
		"  in container: $$copy" "  in checkout:  $$local_copy" \
		'  A byte-different fixture would silently change what the gate measures.' \
		'  Nothing was verified.' >&2; exit 2; }; \
	operator="$${GITHUB_JOB:+ci:$$GITHUB_RUN_ID:$$GITHUB_JOB}"; operator="$${operator:-$$(id -un)}"; \
	printf '== source-acceptance-sidecar-check: container %s (%s), fixture %s, source served from loopback\n' "$$container" "$$name" "$$copy"; \
	ENSEMBLE_SOURCE_TEST_TOKEN="$$token" ENSEMBLE_SOURCE_TEST_URL="http://127.0.0.1:18743" \
		ENSEMBLE_SOURCE_ATTEST_BY="$$operator" \
		ENSEMBLE_SOURCE_ATTEST_CONTAINER="$$container" \
		ENSEMBLE_SOURCE_ATTEST_STATEMENT="this job started container $$container from $(SOURCE_IMAGE) with no project mount; the fixture copy hashes $$copy; the listener is loopback-only" \
		ENSEMBLE_SOURCE_ATTEST_COPY_SHA256="$$copy" \
		$(MAKE) --no-print-directory source-acceptance-check RUNTIME="$(RUNTIME_DIR)"

# The fresh-Host journey: a browser creates a native Workspace through the official
# UI, the Ensemble picker sees it, and the Client initializes/binds through the GUI.
#
# This is a *required* gate. The empty-registry Host it boots is setup, not evidence:
# `--phases launch,identity` plus `ENSEMBLE_PRODUCT_DIAGNOSTIC_ONLY=1` only produce a
# handoff with `diagnosticOnly: true`, and a booting empty Host is not proof that a
# user can create a Workspace at all. The pass condition is the probe walking the
# journey and exiting 0; until then this target is red on purpose.
.PHONY: fresh-journey-check
fresh-journey-check: require-node require-package-sha require-browser require-install-dir
	@printf '== fresh-journey-check: %s against %s\n' "$(PRODUCT_PACKAGE)" "$(INSTALL_DIR)"
	@$(BUN) scripts/verify-dsh-fresh-journey.ts \
		--install-dir "$(INSTALL_DIR)" \
		--package "$(PRODUCT_PACKAGE)" \
		--sha256 "$(PACKAGE_SHA256)" \
		--browser "$(BROWSER)" \
		--output "$(CLIENT_OUT)/fresh"

# The packaged manifests must declare exactly the tested releases. `engines.dsh`
# alone does not say what was exercised, so the manifest records the set and this
# gate compares it with the maintained declarations; a shipped package cannot
# claim support the gates never ran.
# The manifest gate reads whichever artifact it is told to read. The release door pins
# PACKAGE, so it is passed through explicitly (`--package`); without it the gate inspects
# this tree's own build output, which is the useful default for `make matrix-check` alone.
#
# There is deliberately no "these two paths hold the same bytes" prerequisite. That check
# was a fake dependency: it enforced equality between the globbed default and the pin,
# which refuses a *legitimate* pinned candidate the moment the default is re-packed — the
# exact situation the release door exists to survive. The real requirement is "inspect the
# byte the door pinned", and `--package` says that directly. `require-package-sha` remains
# the only authority for the pin itself.
matrix-check: require-bun
	@$(TASKS) matrix --check $(if $(PRODUCT_PACKAGE),--package "$(PRODUCT_PACKAGE)")

# The whole production surface in one target, in dependency order. It exists so
# the release door has one name to call, not so CI can skip parts of it.
production-check: require-install-dir require-package
	@$(MAKE) --no-print-directory product-check
	@$(MAKE) --no-print-directory maintenance-check
	@$(MAKE) --no-print-directory environment-check
	@$(MAKE) --no-print-directory store-acceptance-check
	@$(MAKE) --no-print-directory native-acceptance-check
	@$(MAKE) --no-print-directory matrix-check
	@printf '%s\n' '== production-check: ok (installed product, archive, environment and acceptance gates)'
	@printf '%s\n' '   This is not a release conclusion: client-check and source-acceptance-check are not'
	@printf '%s\n' '   part of it. release-check runs them unconditionally.'

# ---------------------------------------------------------------------------
# runtime setup — the only target that prepares an install for the gates
# ---------------------------------------------------------------------------
# Every gate above needs an isolated install of a *tested* release with this
# repository's packages in it. Doing that by hand is where "it passed on my
# machine" comes from, so it is one target: same release list, same flags, same
# package files, locally and in CI.
.PHONY: runtime-setup

runtime-setup: require-bun require-node require-npm
	@test -n "$(INSTALL_DIR)" || { \
		printf '%s\n' 'error: INSTALL_DIR is not set.' \
		'  runtime-setup creates one isolated install; name where it should go:' \
		'    make runtime-setup INSTALL_DIR=$${TMPDIR:-/tmp}/dsh-install DSH_VERSION=0.2.2-rc.5' \
		'  Nothing was installed.' >&2; \
		exit 2; }
	@version="$(DSH_VERSION)"; \
	if [ -z "$$version" ]; then version=$$($(BUN) -e 'import {DEFAULT_DSH_VERSION} from "./adapters/dsh/compatibility.ts"; process.stdout.write(DEFAULT_DSH_VERSION)') || exit 2; fi; \
	case " $$($(BUN) -e 'import {SUPPORTED_DSH_VERSIONS} from "./adapters/dsh/compatibility.ts"; process.stdout.write(SUPPORTED_DSH_VERSIONS.join(" "))') " in \
		*" $$version "*) ;; \
		*) releases=$$($(BUN) -e 'import {supportedVersionsText} from "./adapters/dsh/compatibility.ts"; process.stdout.write(supportedVersionsText())'); \
		   printf 'error: DSH_VERSION=%s is not a tested release.\n  Tested: %s\n  Adding a release means running the full matrix against it first.\n  Nothing was installed.\n' "$$version" "$$releases" >&2; exit 2 ;; \
	esac; \
	printf '== runtime-setup: installing @deepseek-ai/dsh@%s into %s (network)\n' "$$version" "$(INSTALL_DIR)"; \
	mkdir -p "$(INSTALL_DIR)" || exit 2; \
	if [ ! -f "$(INSTALL_DIR)/package.json" ]; then ( cd "$(INSTALL_DIR)" && $(NPM) init -y >/dev/null ) || exit 2; fi; \
	( cd "$(INSTALL_DIR)" && $(NPM) install --ignore-scripts --no-audit --no-fund \
		"@deepseek-ai/dsh@$$version" typescript@5.9 @types/node@24 ) || exit 2; \
	for package in $(CURDIR)/$(PRODUCT_PACKAGE) $(CURDIR)/$(WAIT_PROBE_DIR)/dsh-agent-wait-*.tgz; do \
		test -f "$$package" || { printf 'error: missing built package: %s\n  Build it with make pack first.\n' "$$package" >&2; exit 2; }; \
		( cd "$(INSTALL_DIR)" && $(NPM) install --ignore-scripts --no-audit --no-fund "$$package" ) || exit 2; \
	done; \
	printf '%s\n' '== runtime-setup: installed; run make host-check INSTALL_DIR=... next'

# Build the Client type environment: the published slot package at exactly the
# release the install carries, plus React at the major the official Client plugins
# declare (^{18.2.0}). It is a type-only tree and never part of a runtime: the
# official plugins list the slot package as a dev dependency, so an install does
# not contain it and the Client program cannot be checked without it.
.PHONY: client-types
client-types: require-bun require-node require-npm
	@test -n "$(CLIENT_TYPES)" || { \
		printf '%s\n' 'error: CLIENT_TYPES is not set.' \
		'  This target creates the published type environment the Client program needs:' \
		'    make client-types INSTALL_DIR=<isolated install> CLIENT_TYPES=<dir>' \
		'  Nothing was created.' >&2; \
		exit 2; }
	@test -n "$(INSTALL_DIR)" || { \
		printf '%s\n' 'error: INSTALL_DIR is not set, so the slot package version is unknown.' \
		'  The slot package is versioned with the release, so name the install:' \
		'    make client-types INSTALL_DIR=<isolated install> CLIENT_TYPES=<dir>' >&2; \
		exit 2; }
	@version=$$($(BUN) -e 'import {readFileSync} from "node:fs"; import {join} from "node:path"; process.stdout.write(String(JSON.parse(readFileSync(join(process.argv[1], "node_modules/@deepseek-ai/dsh/package.json"), "utf8")).version))' "$(INSTALL_DIR)") || { \
		printf '%s\n' "error: $(INSTALL_DIR) is not an install with @deepseek-ai/dsh." '  Nothing was created.' >&2; exit 2; }; \
	printf '== client-types: @deepseek-ai/dsh-client-ui-slots@%s plus React 18 into %s (network)\n' "$$version" "$(CLIENT_TYPES)"; \
	mkdir -p "$(CLIENT_TYPES)" || exit 2; \
	printf '{\n  "name": "ensemble-client-types",\n  "private": true,\n  "version": "0.0.0",\n  "dependencies": {\n    "@deepseek-ai/dsh-client-ui-slots": "%s",\n    "react": "18.3.1",\n    "react-dom": "18.3.1",\n    "@types/react": "18.3.12",\n    "@types/react-dom": "18.3.1",\n    "@types/bun": "1.3.11",\n    "puppeteer-core": "25.3.0",\n    "typescript": "5.9.3",\n    "@types/node": "24.10.1"\n  }\n}\n' "$$version" > "$(CLIENT_TYPES)/package.json" || exit 2; \
	( cd "$(CLIENT_TYPES)" && npm_config_cache="$(CLIENT_TYPES)/.npm-cache" $(NPM) install --ignore-scripts --no-audit --no-fund --no-package-lock ) || exit 2; \
	test -f "$(CLIENT_TYPES)/node_modules/@deepseek-ai/dsh-client-ui-slots/package.json" || { \
		printf '%s\n' "error: the Client type environment is incomplete: no dsh-client-ui-slots in $(CLIENT_TYPES)." \
		'  The install itself succeeded but the package the Client program compiles' \
		'  against is missing, so a Client type check would measure nothing.' >&2; \
		exit 1; }; \
	printf '%s\n' '== client-types: created; the Client program can now compile against it'

# Observation, not verification. `diagnose` never asserts anything about the
# environment, so it always exits 0; that is exactly why it must not be named
# `-check`. Use the gates above when you need a pass/fail answer.
diagnose: require-bun
	@test -f scripts/check-isolation.ts || { \
		printf '%s\n' 'error: diagnose needs scripts/check-isolation.ts, which does not exist.' \
		'  Nothing was observed.' >&2; \
		exit 2; }
	@$(BUN) scripts/check-isolation.ts $(if $(INSTALL_DIR),"$(INSTALL_DIR)") --observe

# ---------------------------------------------------------------------------
# subagent-wait plugin gates
# ---------------------------------------------------------------------------
# The wait plugin has its own Host entry, its own tsconfig and its own module
# set, so its gates are separate programs: a change in one plugin must not be
# able to loosen the other's gate. Both need a real isolated DSH install, and
# both refuse without one instead of reporting a partial pass.
.PHONY: typecheck-wait-host wait-host-check wait-loader-check wait-runtime-check

typecheck-wait-host: require-bun require-install-dir
	@printf '  %-16s %s\n' 'typecheck-wait-host' "[needs INSTALL_DIR] gate: the wait plugin's Host entries type-check"
	@$(BUN) adapters/dsh-agent-wait/typecheck-host.ts "$(INSTALL_DIR)"

# The Loader resolves the packed wait package from INSTALL_DIR, so it must be
# installed there first. The scratch directory declares module type for the same
# reason the ensemble gate does: an `npm init -y` install says "commonjs", and
# the check file uses `import`.
wait-loader-check: require-node require-install-dir
	@test -d "$(INSTALL_DIR)/node_modules/dsh-agent-wait" || { \
		printf '%s\n' "error: no dsh-agent-wait installed in $(INSTALL_DIR)." \
		'  The Loader resolves the packed wait plugin from that install, so it must' \
		'  be installed there before this gate can run:' \
		'    make pack-dsh-agent-wait' \
		'    cd "'"$(INSTALL_DIR)"'" && npm install --ignore-scripts <this-repo>/$(WAIT_PROBE_DIR)/dsh-agent-wait-*.tgz' \
		'  Nothing was installed and nothing was verified.' >&2; \
		exit 2; }
	@printf '== wait-loader-check: real Loader against %s\n' "$(INSTALL_DIR)"
	@# One shell: the runtime path is resolved before the `cd` into the scratch
	@# directory, and the check receives it explicitly. The check composes the
	@# real minimal native stack and resolves @deepseek-ai/* from that install,
	@# so it needs the absolute path, not the caller's relative one.
	@runtime=$$(cd "$(INSTALL_DIR)" 2>/dev/null && pwd) || { \
		printf '%s\n' "error: INSTALL_DIR is not a usable directory: $(INSTALL_DIR)" \
		'  Nothing was run and nothing is claimed.' >&2; \
		exit 2; }; \
	scratch=$$(mktemp -d "$$runtime/.make-wait-loader.XXXXXX") || exit 2; \
	trap 'rm -rf "$$scratch"' EXIT HUP INT TERM; \
	cp adapters/dsh-agent-wait/loader-check.ts "$$scratch/loader-check.ts" || exit 1; \
	printf '{"type":"module"}\n' > "$$scratch/package.json" || exit 1; \
	cd "$$scratch" && DSH_WAIT_RUNTIME="$$runtime" DSH_WAIT_PACKAGE=dsh-agent-wait DSH_WAIT_TMP="$$scratch/.probe" $(NODE) loader-check.ts

wait-host-check: typecheck-wait-host wait-loader-check

# This gate installs into its own temporary profile and never changes the supplied
# runtime. Missing native evidence fails; it cannot turn into a conditional skip.
wait-runtime-check: require-bun require-node require-install-dir
	@$(BUN) scripts/verify-dsh-wait.ts --runtime "$(INSTALL_DIR)"


# ---------------------------------------------------------------------------
# owner archive CLI
# ---------------------------------------------------------------------------
# The owner archive is reachable only from an authenticated owner Peer on a
# **running** DSH Host, through the packaged `ensemble-archive` CLI. Make adds
# no protocol and no credential handling: it runs that CLI with a fixed argv.
#
# The CLI must run **inside an installation** where `@deepseek-ai/*` resolves
# (`bin/` and `lib/` import `@deepseek-ai/cordis`). Running it from the source
# tree fails on module resolution, which is why this wrapper takes the install
# directory rather than pretending the tree is enough.
#
# Not gates: they talk to a live Host and return the CLI's own contract
# (0 ok, 1 Host refused, 2 usage, 3 no credential, 4 rejected, 5 unreachable).
# They are deliberately absent from every offline default.
.PHONY: archive-owner-help archive-owner-status archive-owner-call

# `INSTALL_DIR` must contain the packed probe (the CLI ships in it).
archive-owner-help: require-node require-install-dir
	@test -d "$(INSTALL_DIR)/node_modules/dsh-ensemble/bin" || { \
		printf '%s\n' "error: the owner archive CLI is not installed in $(INSTALL_DIR)." \
		'  It ships inside the ensemble probe package, so install that first:' \
		'    make pack-dsh' \
		'    cd "'"$(INSTALL_DIR)"'" && npm install --ignore-scripts <this-repo>/$(DSH_PROBE_DIR)/dsh-ensemble-*.tgz' \
		'  Nothing was run and nothing is claimed.' >&2; \
		exit 2; }
	@cd "$(INSTALL_DIR)" && $(NODE) node_modules/dsh-ensemble/bin/ensemble-archive.js --help

# Read-only status of the owner archive on the running Host. The session cookie
# is read by the CLI from ENSEMBLE_ARCHIVE_COOKIE; this wrapper never accepts,
# forwards, or prints a credential.
archive-owner-status: require-node require-install-dir
	@test -d "$(INSTALL_DIR)/node_modules/dsh-ensemble/bin" || { \
		printf '%s\n' "error: the owner archive CLI is not installed in $(INSTALL_DIR)." \
		'  Install the probe package there first (make pack-dsh, then npm install).' \
		'  Nothing was run and nothing is claimed.' >&2; \
		exit 2; }
	@cd "$(INSTALL_DIR)" && $(NODE) node_modules/dsh-ensemble/bin/ensemble-archive.js \
		status $(if $(ARCHIVE_URL),--url "$(ARCHIVE_URL)"); \
		code=$$?; [ $$code -eq 0 ] || { printf '%s\n' "archive CLI exit code: $$code (0 ok 1 refused 2 usage 3 no credential 4 rejected 5 unreachable)" >&2; exit $$code; }

# One endpoint call. The request document is explicit because the endpoints
# take different inputs; the method is explicit for the same reason.
archive-owner-call: require-node require-install-dir
	@test -n "$(ARCHIVE_METHOD)" || { \
		printf '%s\n' 'error: ARCHIVE_METHOD is not set.' \
		'  Choose one of: initialize, bind, readBack (status has its own target).' \
		'    make archive-owner-call ARCHIVE_METHOD=readBack ARCHIVE_REQUEST=@./request.json' >&2; \
		exit 2; }
	@test -n "$(ARCHIVE_REQUEST)" || { \
		printf '%s\n' 'error: ARCHIVE_REQUEST is not set.' \
		'  This calls one owner-archive endpoint; it needs the request document:' \
		'    make archive-owner-call ARCHIVE_METHOD=bind ARCHIVE_REQUEST=@./request.json' \
		'    make archive-owner-call ARCHIVE_METHOD=bind ARCHIVE_REQUEST='"'"'{"invocation":"..."}'"'"'' \
		'  Authentication is read by the CLI from ENSEMBLE_ARCHIVE_COOKIE; this' \
		'  wrapper never accepts, passes, or prints a credential.' >&2; \
		exit 2; }
	@test -d "$(INSTALL_DIR)/node_modules/dsh-ensemble/bin" || { \
		printf '%s\n' "error: the owner archive CLI is not installed in $(INSTALL_DIR)." \
		'  Install the probe package there first (make pack-dsh, then npm install).' \
		'  Nothing was run and nothing is claimed.' >&2; \
		exit 2; }
	@cd "$(INSTALL_DIR)" && $(NODE) node_modules/dsh-ensemble/bin/ensemble-archive.js \
		"$(ARCHIVE_METHOD)" \
		$(if $(ARCHIVE_URL),--url "$(ARCHIVE_URL)") \
		--request "$(ARCHIVE_REQUEST)" $(if $(ARCHIVE_JSON),--json); \
		code=$$?; [ $$code -eq 0 ] || { printf '%s\n' "archive CLI exit code: $$code (0 ok 1 refused 2 usage 3 no credential 4 rejected 5 unreachable)" >&2; exit $$code; }

# ---------------------------------------------------------------------------
# install (opt-in)
# ---------------------------------------------------------------------------
.PHONY: install-omp install-smoke

install-omp: require-confirm require-deps
	@test -x "$(OMP)" || { \
		printf '%s\n' 'error: the OMP CLI is not available at $(OMP).' \
		'  Install the pinned dev dependency (`make setup`) or point OMP=<path> at it.' \
		'  Blocked target: install-omp. Packing still works: make pack-omp' >&2; \
		exit 2; }
	@test -d $(PACK_DIR)/omp/staging || { \
		printf '%s\n' 'error: no OMP staging root at $(PACK_DIR)/omp/staging.' \
		'  Build it first: make pack-omp' >&2; \
		exit 2; }
	@printf '%s\n' '== install-omp: installing the local staging root into the live OMP profile'
	@printf '%s\n' '   This replaces any @vcup/skills package already installed there; it does not' \
		'   merge with it. Uninstall through OMP'"'"'s plugin manager to undo.'
	@$(OMP) install ./$(PACK_DIR)/omp/staging

# The pinned installer version is deliberate: the same one the delivery record
# was verified with. It runs in a temporary directory, so the repository and the
# live profile are untouched; the installed copy is then compared byte for byte.
install-smoke: require-npx
	@printf '%s\n' '== install-smoke: pinned skills CLI into a temporary directory (network)'
	@tmp=$$(mktemp -d) || exit 2; \
	trap 'rm -rf "$$tmp"' EXIT HUP INT TERM; \
	cd "$$tmp" && npm_config_cache="$$tmp/.npm-cache" \
		$(NPX) --yes skills@1.9.0 add "$(CURDIR)" --skill ensemble --agent '*' -y </dev/null || { \
		printf '%s\n' 'error: the pinned skills installer failed.' \
		'  It needs -y and an explicit --agent target when stdin is not a TTY;' \
		'  both are passed above, so a failure here is a real installer problem.' >&2; \
		exit 1; }; \
	test -f "$$tmp/.agents/skills/ensemble/SKILL.md" || { \
		printf '%s\n' 'error: the installer did not place .agents/skills/ensemble/SKILL.md' \
		'  in the temporary directory. Treat the smoke as failed.' >&2; exit 1; }; \
	cmp "$$tmp/.agents/skills/ensemble/SKILL.md" "$(CURDIR)/skills/ensemble/SKILL.md" || exit 1; \
	printf '%s\n' '== install-smoke: installed copy matches the committed skill byte for byte'

# ---------------------------------------------------------------------------
# git (read-only)
# ---------------------------------------------------------------------------
.PHONY: status diff git-review

status: require-git
	@$(GIT) status --short --branch
	@printf 'artifacts: '
	@test -d $(BUILD_DIR) && printf '%s\n' "$(BUILD_DIR)/ present (generated, ignored)" || printf '%s\n' "$(BUILD_DIR)/ absent (nothing built yet)"
	@printf 'dependencies: '
	@test -d node_modules && printf '%s\n' 'node_modules/ present' || printf '%s\n' 'node_modules/ absent (run make setup)'

diff: require-git
	@$(GIT) --no-pager diff

git-review: require-git
	@printf '%s\n' '== git-review: working tree'
	@$(GIT) status --short --branch
	@printf '%s\n' '== git-review: change summary'
	@$(GIT) --no-pager diff --stat
	@printf '%s\n' '== git-review: recent commits'
	@$(GIT) --no-pager log --oneline -5

# ---------------------------------------------------------------------------
# release and cleanup
# ---------------------------------------------------------------------------
.PHONY: package-check release-check all

# The offline aggregate: everything that can be proven without an isolated DSH
# install. It ends with both packages built, so "offline door green" means the
# tree, the types, the docs, the tests and the artifacts all agree.
package-check: check test pack inspect
	@printf '%s\n' '== package-check: ok (offline; Host gates not included)'

# The strict release door. There is deliberately no path through this target
# that omits a gate: without an isolated install of a tested release the Host
# types, the real Loader and the installed product cannot be verified, so the
# door fails instead of going green.
#
# It builds all three packages and then verifies them: the offline gates, both
# plugins' Host types and real Loaders, the native wait lifecycle, the exact
# metadata matrix, and the whole production surface (installed product, archive
# maintenance, environment ledger, and the two non-author acceptance suites).
#
# Every gate below is unconditional. In particular the authenticated-UI gate and
# the cross-container source gate are not optional: a release conclusion that
# rests on "we did not run those today" is the false green this door exists to
# prevent. Their own preconditions (BROWSER, SLOTS, ENSEMBLE_SOURCE_TEST_TOKEN,
# ENSEMBLE_SOURCE_TEST_URL) exit 2 when unset, so a machine without a browser or
# without the second container cannot produce a release check at all.
#
# For a cheaper aggregate use `production-check`: it covers the product, archive,
# environment, matrix and the two non-author acceptance suites, and makes no
# release claim.
release-check: require-install-dir require-package-sha check test inspect matrix-check \
               typecheck-strict host-check wait-host-check wait-runtime-check \
               maintenance-live-check selection-check live-cli-test runtime-test-check production-check replica-acceptance-check \
               client-check auth-ui-check fresh-journey-check source-acceptance-sidecar-check
	@printf '%s\n' '== release-check: ok'
	@printf '%s\n' '   verified: offline gates and complete type coverage (plain + Host + Client),'
	@printf '%s\n' '             both plugins (Host types + real Loader), native wait lifecycle,'
	@printf '%s\n' '             installed product, live archive maintenance, environment ledger,'
	@printf '%s\n' '             metadata matrix, non-author store/native/replica acceptance suites,'
	@printf '%s\n' '             the shipped Client in a real browser against a live Host,'
	@printf '%s\n' '             and the cross-container source world'
	@printf '%s\n' '   Nothing was published, committed, or installed.'

all: package-check

clean: require-bun
	@$(TASKS) clean

clean-all: require-confirm require-bun
	@$(TASKS) clean --all
