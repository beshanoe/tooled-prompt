# Contributing to tooled-prompt

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

1. **Clone the repo**

   ```bash
   git clone https://github.com/beshanoe/tooled-prompt.git
   cd tooled-prompt
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Run type checks**

   ```bash
   npm run typecheck
   ```

   This also validates the type-level tests in `src/__tests__/tool.test-types.ts`.

4. **Run tests**

   ```bash
   npm test
   ```

5. **Run tests with coverage**

   ```bash
   npm run test:coverage
   ```

6. **Run an example** (requires a running LLM endpoint)

   ```bash
   npx tsx examples/weather.ts
   ```

## Making Changes

1. Create a feature branch from `main`
2. Make your changes
3. Ensure type checks pass: `npm run typecheck`
4. Ensure tests pass: `npm test`
5. Submit a pull request

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Add tests for new functionality
- Update documentation if you change public APIs
- Follow existing code style (no linter configured — match what's there)

## Commit Messages

Use clear, descriptive commit messages. No strict format is required, but prefer:

- `add <feature>` for new features
- `fix <issue>` for bug fixes
- `update <area>` for enhancements to existing features
- `refactor <area>` for internal changes

## Reporting Issues

- Use [GitHub Issues](https://github.com/beshanoe/tooled-prompt/issues) for bugs and feature requests
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)
