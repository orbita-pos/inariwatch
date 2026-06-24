# Contributing to InariWatch

Thanks for your interest in contributing! This guide will help you get started.

## Prerequisites

- Node.js 18+
- Rust (latest stable)
- PostgreSQL (we use [Neon](https://neon.tech) for hosted Postgres)
- Git

## Setup

### Web Application

```bash
git clone https://github.com/orbita-pos/inariwatch.git
cd inariwatch/web
cp .env.example .env.local
# Fill in your environment variables in .env.local
npm install
npm run db:push
npm run dev
```

### CLI

```bash
cd cli
cargo build
```

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/your-feature`)
3. Commit using [Conventional Commits](https://www.conventionalcommits.org/) (e.g., `feat:`, `fix:`, `docs:`)
4. Push to your fork and open a Pull Request against `main`
5. Ensure CI passes before requesting review

## Code Style

- **TypeScript:** strict mode enabled, no `any` types
- **Rust:** must pass `cargo clippy` with no warnings

## Questions?

Open a discussion or reach out at info@jesusbr.com.
