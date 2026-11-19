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
	@printf '  %-16s %s\n' 'pack' 'both packages: OMP staging root + DSH tarball'
	@printf '  %-16s %s\n' 'pack-omp' 'OMP package only'
	@printf '  %-16s %s\n' 'pack-dsh' 'DSH probe tarball only'
	@printf '  %-16s %s\n' 'inspect' 'list the built tarballs and their contents'
	@printf '%s\n' ''
	@printf '%s\n' 'Runtime gates — need a real isolated DSH install'
	@printf '  %-16s %s\n' 'host-check' '[needs INSTALL_DIR] Host types plus the real Loader run'
	@printf '  %-16s %s\n' 'profile-check' '[needs INSTALL_DIR] DSH profile boot diagnosis (capability not yet verified)'
	@printf '  %-16s %s\n' 'isolation-check' 'execution-world confinement probe (capability not yet verified)'
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
	@printf '  %-16s %s\n' 'release-check' '[needs INSTALL_DIR] strict release door: offline gates + Host types + real Loader'
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
		printf '%s\n' 'error: INSTALL_DIR is not set.' \
		'  These gates run against a real isolated DSH rc.4 install, never against' \
		'  this working tree. Any writable directory outside the repository works;' \
		'  create one once with:' \
		'    dsh_install=$${TMPDIR:-/tmp}/dsh-rc4' \
		'    mkdir -p "$$dsh_install" && cd "$$dsh_install" && npm init -y' \
		'    npm install --ignore-scripts @deepseek-ai/dsh@0.2.2-rc.4 typescript@5.9 @types/node@24' \
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
.PHONY: pack pack-omp pack-dsh inspect

pack: pack-omp pack-dsh

pack-omp: require-npm
	@$(BUN) scripts/pack-omp.ts

pack-dsh: require-npm
	@$(BUN) scripts/pack-dsh.ts

inspect: require-bun
	@$(TASKS) inspect

# ---------------------------------------------------------------------------
# runtime gates
# ---------------------------------------------------------------------------
.PHONY: host-check loader-check profile-check isolation-check

host-check: typecheck-host loader-check

# The real Loader must resolve @deepseek-ai/* from INSTALL_DIR, so it runs from
# a temporary directory inside that install. Nothing in the repository is
# touched, and the scratch directory is removed on exit.
loader-check: require-node require-install-dir
	@printf '== loader-check: real Loader against %s\n' "$(INSTALL_DIR)"
	@scratch=$$(mktemp -d "$(INSTALL_DIR)/.make-loader.XXXXXX") || exit 2; \
	trap 'rm -rf "$$scratch"' EXIT HUP INT TERM; \
	cp adapters/dsh/loader-check.ts "$$scratch/loader-check.ts" || exit 1; \
	cd "$$scratch" && DSH_PROBE_TMP="$$scratch/.probe" $(NODE) loader-check.ts

# Both diagnosis scripts belong to later work. Until they exist, say so and
# fail: a green target here would claim a capability nobody has verified.
profile-check: require-bun
	@test -f scripts/profile-check.ts || { \
		printf '%s\n' 'error: profile-check is not implemented yet.' \
		'  scripts/profile-check.ts does not exist, so DSH profile boot is still' \
		'  unverified. Nothing was run and nothing is claimed.' >&2; \
		exit 2; }
	@$(BUN) scripts/profile-check.ts $(if $(INSTALL_DIR),"$(INSTALL_DIR)")

isolation-check: require-bun
	@test -f scripts/check-isolation.ts || { \
		printf '%s\n' 'error: isolation-check is not implemented yet.' \
		'  scripts/check-isolation.ts does not exist, so execution-world isolation is' \
		'  still unverified. Nothing was run and nothing is claimed.' >&2; \
		exit 2; }
	@$(BUN) scripts/check-isolation.ts $(if $(INSTALL_DIR),"$(INSTALL_DIR)")

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
# that omits the Host gates: without an isolated rc.4 install the Host types and
# the real Loader cannot be verified, so the door fails instead of going green.
release-check: require-install-dir check test pack inspect host-check
	@printf '%s\n' '== release-check: ok (offline gates + Host types + real Loader)'
	@printf '%s\n' '   Nothing was published, committed, or installed.'

all: package-check

clean: require-bun
	@$(TASKS) clean

clean-all: require-confirm require-bun
	@$(TASKS) clean --all
