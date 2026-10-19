# pi-browser — developer workflow
#
# `make` or `make help` lists every target.
#
# NOTE: this Makefile targets the GNU Make 3.81 that ships with macOS, so it
# deliberately avoids .ONESHELL and .SHELLFLAGS (both added in 3.82). Each
# recipe line is therefore self-contained; make stops on the first line that
# exits non-zero, and pipelines that must fail loudly are written without one.

SHELL := /bin/bash
.DEFAULT_GOAL := help

NODE      ?= node
NPM       ?= npm
PORT      ?= 9223
HTTP_PORT ?= 8787
PROFILE   ?= $(HOME)/.pi-browser/profile
SETTLE_MS ?= 250
FINGERPRINT ?=

SRC := src
LINT_PATHS := $(SRC) examples test eslint.config.js

# --- meta ---------------------------------------------------------------------

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "; printf "\n\033[1mpi-browser\033[0m\n\n"} \
		/^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2} \
		/^##@/ {printf "\n\033[1m%s\033[0m\n", substr($$0, 5)}' $(MAKEFILE_LIST)
	@echo ""

##@ Setup

.PHONY: install
install: ## Install dependencies (npm ci if lockfile, else npm install)
	@if [ -f package-lock.json ]; then $(NPM) ci; else $(NPM) install; fi

.PHONY: deps
deps: install ## Alias for install

.PHONY: browser
browser: ## Download the CloakBrowser binary (npx cloakbrowser install)
	@npx cloakbrowser install

.PHONY: doctor
doctor: ## Check local prerequisites (node, npm, CloakBrowser binary)
	@echo "node:    $$($(NODE) --version)"
	@echo "npm:     $$($(NPM) --version)"
	@echo "make:    $$(make --version | head -1)"
	@$(NODE) -e "import('./src/chrome.js').then(m=>{try{console.log('browser: '+m.resolveBinary(null))}catch(e){console.log('browser: MISSING — '+e.message);process.exit(1)}})"

##@ Quality

.PHONY: lint
lint: ## Lint JavaScript with ESLint
	@npx eslint $(LINT_PATHS)

.PHONY: lint-fix
lint-fix: ## Lint and apply safe fixes
	@npx eslint $(LINT_PATHS) --fix

.PHONY: format
format: ## Format with Prettier
	@npx prettier --write .

.PHONY: format-check
format-check: ## Verify formatting without writing
	@npx prettier --check .

.PHONY: syntax
syntax: ## Parse-check every JS entry point
	@for f in $(SRC)/*.js examples/*.js test/*.mjs; do \
		$(NODE) --check "$$f" || exit 1; \
	done
	@echo "syntax ok"

.PHONY: typecheck
typecheck: ## Type-check JavaScript using the JSDoc annotations (tsc)
	@npx tsc -p jsconfig.json

.PHONY: shellcheck
shellcheck: ## Lint shell scripts (skips if shellcheck is absent)
	@if command -v shellcheck >/dev/null; then shellcheck scripts/*.sh; \
	else echo "shellcheck not installed — skipping"; fi

.PHONY: check
check: lint format-check syntax typecheck shellcheck ## Run all static checks

##@ Test

.PHONY: test
test: ## Run the smoke test with console capture enabled (full coverage)
	@CONSOLE_HOOK=1 $(NODE) test/smoke.mjs

.PHONY: test-stealth
test-stealth: ## Run the smoke test with console capture off (default runtime mode)
	@$(NODE) test/smoke.mjs

.PHONY: test-headless
test-headless: ## Run the smoke test headless (default is headed)
	@SMOKE_HEADLESS=1 CONSOLE_HOOK=1 $(NODE) test/smoke.mjs

.PHONY: test-verbose
test-verbose: ## Run the smoke test with extra diagnostics
	@DEBUG=1 CONSOLE_HOOK=1 $(NODE) test/smoke.mjs

.PHONY: test-watch
test-watch: ## Re-run the smoke test whenever sources change (needs fswatch)
	@if ! command -v fswatch >/dev/null; then echo "fswatch not installed"; exit 1; fi
	@fswatch -o $(SRC) test | xargs -n1 -I{} make test

.PHONY: ci
ci: install check test ## What a CI job should run

##@ Run

.PHONY: start
start: ## Start the server (launches CloakBrowser headed by default)
	@$(NODE) $(SRC)/cli.js --port $(PORT) --http-port $(HTTP_PORT) \
		--profile "$(PROFILE)" --settle-ms $(SETTLE_MS) $(if $(FINGERPRINT),--fingerprint $(FINGERPRINT))

.PHONY: start-headless
start-headless: ## Start the server with a headless browser
	@$(NODE) $(SRC)/cli.js --port $(PORT) --http-port $(HTTP_PORT) \
		--profile "$(PROFILE)" --headless --settle-ms $(SETTLE_MS)

.PHONY: start-console
start-console: ## Start the server with in-page console/error capture
	@$(NODE) $(SRC)/cli.js --port $(PORT) --http-port $(HTTP_PORT) \
		--profile "$(PROFILE)" --console-hook --settle-ms $(SETTLE_MS)

.PHONY: launch
launch: ## Launch CloakBrowser only (for use with --attach-only)
	@CLOAK_PROFILE="$(PROFILE)" CDP_PORT=$(PORT) bash scripts/launch-cloak.sh

.PHONY: launch-headless
launch-headless: ## Launch CloakBrowser headless only
	@CLOAK_PROFILE="$(PROFILE)" CDP_PORT=$(PORT) HEADLESS=1 bash scripts/launch-cloak.sh

.PHONY: demo
demo: ## Run the example agent loop against a running server
	@$(NODE) examples/agent-loop.js http://127.0.0.1:$(HTTP_PORT)

.PHONY: health
health: ## Print /health from a running server
	@$(NODE) -e 'fetch("http://127.0.0.1:$(HTTP_PORT)/health") \
		.then((r) => r.json()) \
		.then((d) => console.log(JSON.stringify(d, null, 2))) \
		.catch((e) => { console.error("server unreachable on $(HTTP_PORT):", e.message); process.exit(1); })'

##@ Housekeeping

.PHONY: clean
clean: ## Remove transient files and artifacts
	@rm -rf coverage test/tmp *.log
	@find . -name '.DS_Store' -not -path './node_modules/*' -delete
	@echo "cleaned"

.PHONY: distclean
distclean: clean ## Also remove node_modules
	@rm -rf node_modules
	@echo "distcleaned"

.PHONY: clean-profile
clean-profile: ## Remove the default browser profile (logs you out of everything)
	@rm -rf "$(PROFILE)"
	@echo "removed profile $(PROFILE)"

.PHONY: kill
kill: ## Stop the server bound to PORT/HTTP_PORT (never kills a browser)
	@-lsof -ti tcp:$(HTTP_PORT) | xargs kill -9 2>/dev/null || true
	@echo "stopped listener on $(HTTP_PORT)"

.PHONY: reset
reset: kill distclean install ## Stop everything, wipe deps, reinstall
	@echo "reset complete"
