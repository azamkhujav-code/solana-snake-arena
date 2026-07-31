.DEFAULT_GOAL := help
.PHONY: help setup dev build lint test clean up down reset logs migrate seed studio anchor-build anchor-test

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

setup: ## Install dependencies and prepare the local environment
	pnpm install
	@test -f .env || cp .env.example .env
	pnpm env:check
	pnpm db:generate

dev: ## Run everything in watch mode
	pnpm dev

build: ## Build all packages
	pnpm build

lint: ## Lint the workspace
	pnpm lint

test: ## Run the test suite
	pnpm test

clean: ## Remove build output and node_modules
	pnpm clean

up: ## Start Postgres, PgBouncer and Redis
	docker compose up -d

down: ## Stop containers
	docker compose down

reset: ## Recreate containers and volumes, then re-migrate
	docker compose down -v
	docker compose up -d
	sleep 5
	pnpm db:migrate

logs: ## Tail container logs
	docker compose logs -f

migrate: ## Create and apply a migration
	pnpm db:migrate

seed: ## Seed development data
	pnpm db:seed

studio: ## Open Prisma Studio
	pnpm db:studio

anchor-build: ## Build the on-chain program
	pnpm anchor:build

anchor-test: ## Test the on-chain program
	pnpm anchor:test
