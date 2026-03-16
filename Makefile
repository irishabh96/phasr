.PHONY: build run desktop-build desktop-run desktop-export-macos desktop-export-macos-installer fmt tidy ui-install ui-build ui-dev ui-version

ui-install:
	npm --prefix internal/api/frontend install

ui-build:
	npm --prefix internal/api/frontend run build

ui-dev:
	npm --prefix internal/api/frontend run dev

build:
	$(MAKE) ui-build
	mkdir -p bin
	go build -o bin/phasr ./cmd/staq

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
	CGO_ENABLED=1 go build -o bin/phasr-desktop ./cmd/staq-desktop

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
