.PHONY: build run desktop-build desktop-run fmt tidy

build:
	mkdir -p bin
	go build -o bin/staq ./cmd/staq

run:
	go run ./cmd/staq

desktop-build:
	mkdir -p bin
	CGO_ENABLED=1 go build -o bin/staq-desktop ./cmd/staq-desktop

desktop-run:
	CGO_ENABLED=1 go run ./cmd/staq-desktop

fmt:
	gofmt -w ./cmd ./internal

tidy:
	go mod tidy
