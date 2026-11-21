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
#   INSTALL_DIR=<dir>      existing isolated DSH rc.4 install for Host gates
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

BUILD_DIR := build
PACK_DIR := $(BUILD_DIR)/pack
# Where `make pack-dsh` leaves the probe tarball. The name is a glob because the
# version lives in `adapters/dsh/meta.ts`; restating it here would drift.
DSH_PROBE_DIR := $(PACK_DIR)/dsh
WAIT_PROBE_DIR := $(PACK_DIR)/dsh-agent-wait
VALID_TARGETS := skill omp dsh
TASKS := $(BUN) scripts/project-tasks.ts

# ---------------------------------------------------------------------------
# help
# ---------------------------------------------------------------------------
.PHONY: help
help:
	@printf '%s\n' 'Usage: make <target> [TARGET=skill|omp|dsh] [INSTALL_DIR=<dir>] [CONFIRM=yes]'
	@printf '%s\n' ''
	@printf '%s\n' 'Getting started'
	@printf '  %-16s %s\n' 'help' 'this list (the default target)'
	@printf '  %-16s %s\n' 'doctor' 'tools, dependencies and artifact presence; names the targets each one blocks'
	@printf '  %-16s %s\n' 'setup' '[network] bun install --frozen-lockfile, then doctor and check'
	@printf '%s\n' ''
	@printf '%s\n' 'Verify — offline, writes nothing in the repository'
	@printf '  %-16s %s\n' 'check' 'the default gate: skill drift + both typechecks + docs'
	@printf '  %-16s %s\n' 'test' 'full test suite (bun test)'
	@printf '  %-16s %s\n' 'test-narrow' 'content builder tests only (the CI gate)'
	@printf '  %-16s %s\n' 'test-watch' 'tests in watch mode; Ctrl-C to leave'
	@printf '  %-16s %s\n' 'typecheck' 'tsc --noEmit plus the dependency-free DSH module project'
	@printf '  %-16s %s\n' 'typecheck-host' '[needs INSTALL_DIR] Host entry types against a real isolated rc.4 install'
	@printf '  %-16s %s\n' 'docs' 'documentation link/reference checker'
	@printf '%s\n' ''
	@printf '%s\n' 'Content — one maintained source, three generated paths'
	@printf '  %-16s %s\n' 'content' 'report drift for TARGET (never writes)'
	@printf '  %-16s %s\n' 'content-build' '[writes] regenerate TARGET from content/ensemble/'
	@printf '%s\n' ''
	@printf '%s\n' 'Packages — local artifacts under build/pack, never published'
	@printf '  %-16s %s\n' 'pack' 'all three packages: OMP staging root + DSH tarball + subagent-wait tarball'
	@printf '  %-16s %s\n' 'pack-omp' 'OMP package only'
	@printf '  %-16s %s\n' 'pack-dsh' 'DSH probe tarball only'
	@printf '  %-16s %s\n' 'pack-dsh-agent-wait' 'DSH subagent-wait plugin tarball only'
	@printf '  %-16s %s\n' 'inspect' 'list the built tarballs and their contents'
	@printf '%s\n' ''
	@printf '%s\n' 'Runtime gates — a *-check target is a gate: it exits 0 only when every'
	@printf '%s\n' 'required check really ran and agreed. Missing prerequisites -> non-zero.'
	@printf '  %-16s %s\n' 'host-check' '[needs INSTALL_DIR] gate: Host types + real Loader, both must pass'
	@printf '  %-16s %s\n' 'profile-check' '[needs INSTALL_DIR] gate: DSH profile boot; missing install is a failure'
	@printf '  %-16s %s\n' 'isolation-check' '[needs INSTALL_DIR] gate: execution-world confinement must be observed'
	@printf '  %-16s %s\n' 'typecheck-wait-host' "[needs INSTALL_DIR] gate: the wait plugin's Host entries type-check"
	@printf '  %-16s %s\n' 'wait-host-check' '[needs INSTALL_DIR] gate: wait Host types + real Loader, both must pass'
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
	@printf '  %-16s %s\n' 'release-check' '[needs INSTALL_DIR] strict release door: offline gates + Host types and real Loader for BOTH plugins'
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
		'    cd "$$dsh_install" && npm install --ignore-scripts <this-repo>/$(DSH_PROBE_DIR)/dsh-ensemble-probe-*.tgz' \
		'  then: make host-check INSTALL_DIR="$$dsh_install"' >&2; \
		exit 2; }
	@$(TASKS) install-dir --quiet "$(INSTALL_DIR)"

# The type gate additionally needs tsc and @types/node inside that install; the
# Loader gate does not, so each checks only what it uses.
.PHONY: require-install-dir-types
require-install-dir-types: require-install-dir
	@$(TASKS) install-dir --types --quiet "$(INSTALL_DIR)"

.PHONY: require-confirm
require-confirm:
	@test "$(CONFIRM)" = yes || { \
		printf '%s\n' "error: this target deletes or installs outside the repository." \
		"  Re-run with CONFIRM=yes only after reading what it removes or changes:" \
		"    install-omp  installs ./$(PACK_DIR)/omp/staging into the live OMP profile," \
		"                 replacing any @vcup/skills package already installed there" \
		"    clean-all    deletes $(BUILD_DIR)/ and node_modules/" >&2; \
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
.PHONY: check test test-narrow test-watch typecheck typecheck-host docs

check: require-deps require-python
	@printf '%s\n' '== check: content drift (skill is a committed artifact)'
	@$(BUN) scripts/build-ensemble.ts check skill
	@printf '%s\n' '== check: types (repository + dependency-free DSH modules)'
	@$(BUN) node_modules/typescript/bin/tsc --noEmit
	@$(BUN) node_modules/typescript/bin/tsc -p adapters/dsh/tsconfig.json
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

typecheck-host: require-deps require-install-dir-types
	@printf '== typecheck-host: %s\n' "$(INSTALL_DIR)"
	@$(BUN) adapters/dsh/typecheck-host.ts "$(INSTALL_DIR)"

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
	@test -d "$(INSTALL_DIR)/node_modules/dsh-ensemble-probe" || { \
		printf '%s\n' "error: no dsh-ensemble-probe installed in $(INSTALL_DIR)." \
		'  The Loader resolves this repository'"'"'s probe package from that install, so' \
		'  it must be installed there before the gate can run:' \
		'    make pack-dsh' \
		'    cd "'"$(INSTALL_DIR)"'" && npm install --ignore-scripts <this-repo>/$(DSH_PROBE_DIR)/dsh-ensemble-probe-*.tgz' \
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
.PHONY: typecheck-wait-host wait-host-check wait-loader-check

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
	@test -d "$(INSTALL_DIR)/node_modules/dsh-ensemble-probe/bin" || { \
		printf '%s\n' "error: the owner archive CLI is not installed in $(INSTALL_DIR)." \
		'  It ships inside the ensemble probe package, so install that first:' \
		'    make pack-dsh' \
		'    cd "'"$(INSTALL_DIR)"'" && npm install --ignore-scripts <this-repo>/$(DSH_PROBE_DIR)/dsh-ensemble-probe-*.tgz' \
		'  Nothing was run and nothing is claimed.' >&2; \
		exit 2; }
	@cd "$(INSTALL_DIR)" && $(NODE) node_modules/dsh-ensemble-probe/bin/ensemble-archive.js --help

# Read-only status of the owner archive on the running Host. The session cookie
# is read by the CLI from ENSEMBLE_ARCHIVE_COOKIE; this wrapper never accepts,
# forwards, or prints a credential.
archive-owner-status: require-node require-install-dir
	@test -d "$(INSTALL_DIR)/node_modules/dsh-ensemble-probe/bin" || { \
		printf '%s\n' "error: the owner archive CLI is not installed in $(INSTALL_DIR)." \
		'  Install the probe package there first (make pack-dsh, then npm install).' \
		'  Nothing was run and nothing is claimed.' >&2; \
		exit 2; }
	@cd "$(INSTALL_DIR)" && $(NODE) node_modules/dsh-ensemble-probe/bin/ensemble-archive.js \
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
	@test -d "$(INSTALL_DIR)/node_modules/dsh-ensemble-probe/bin" || { \
		printf '%s\n' "error: the owner archive CLI is not installed in $(INSTALL_DIR)." \
		'  Install the probe package there first (make pack-dsh, then npm install).' \
		'  Nothing was run and nothing is claimed.' >&2; \
		exit 2; }
	@cd "$(INSTALL_DIR)" && $(NODE) node_modules/dsh-ensemble-probe/bin/ensemble-archive.js \
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
# that omits the Host gates: without an isolated install of a tested release the
# Host types and the real Loader cannot be verified, so the door fails instead of
# going green.
#
# It builds all three packages, so it verifies all three: a door that packed the
# wait plugin while gating only the ensemble probe would ship an artifact nobody
# checked. Both gates need their package installed in INSTALL_DIR.
release-check: require-install-dir check test pack inspect host-check wait-host-check
	@printf '%s\n' '== release-check: ok (offline gates + both plugins: Host types and real Loaders)'
	@printf '%s\n' '   Nothing was published, committed, or installed.'

all: package-check

clean: require-bun
	@$(TASKS) clean

clean-all: require-confirm require-bun
	@$(TASKS) clean --all
