.PHONY: build run desktop-build desktop-run desktop-export-macos desktop-export-macos-installer fmt tidy ui-install ui-ensure-deps ui-build ui-dev ui-version

ui-install:
	npm --prefix internal/api/frontend install

ui-ensure-deps:
	@if [ ! -x internal/api/frontend/node_modules/.bin/vite ]; then \
		echo "Installing frontend dependencies..."; \
		npm --prefix internal/api/frontend install; \
	fi

ui-build: ui-ensure-deps
	npm --prefix internal/api/frontend run build

ui-dev: ui-ensure-deps
	npm --prefix internal/api/frontend run dev

build:
	$(MAKE) ui-build
	mkdir -p bin
	go build -o bin/phasr ./cmd/phasr

run:
	$(MAKE) build
	@pids=$$(lsof -tiTCP:7777 -sTCP:LISTEN || true); \
	if [ -n "$$pids" ]; then \
		echo "Stopping existing listener(s) on :7777 -> $$pids"; \
		kill $$pids; \
		sleep 1; \
	fi
	./bin/phasr

desktop-build:
	$(MAKE) ui-build
	mkdir -p bin
	CGO_ENABLED=1 go build -o bin/phasr-desktop ./cmd/phasr-desktop

desktop-run:
	$(MAKE) desktop-build
	@pids=$$(lsof -tiTCP:7777 -sTCP:LISTEN || true); \
	if [ -n "$$pids" ]; then \
		echo "Stopping existing listener(s) on :7777 -> $$pids"; \
		kill $$pids; \
		sleep 1; \
	fi
	./bin/phasr-desktop

desktop-export-macos:
	./scripts/export-macos-app.sh

desktop-export-macos-installer:
	./scripts/export-macos-installer.sh

fmt:
	gofmt -w ./cmd ./internal

tidy:
	go mod tidy

ui-version:
	@cat internal/api/static/dist/build-meta.json
