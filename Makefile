.PHONY: build run fmt tidy

build:
	mkdir -p bin
	go build -o bin/staq ./cmd/staq

run:
	go run ./cmd/staq

fmt:
	gofmt -w ./cmd ./internal

tidy:
	go mod tidy
