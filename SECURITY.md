# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in tooled-prompt, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email the maintainers directly or use [GitHub's private vulnerability reporting](https://github.com/beshanoe/tooled-prompt/security/advisories/new).

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response

We will acknowledge receipt within 48 hours and aim to release a fix within 7 days for critical issues.

## Scope

This library handles API keys in configuration. Key security considerations:

- API keys are sent via `Authorization` headers to configured LLM endpoints
- Tool functions execute arbitrary user-provided code — the library does not sandbox tool execution
- Tool results from LLM responses are passed as arguments to user-defined functions
