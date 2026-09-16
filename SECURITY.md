# Security Policy

## Reporting a Vulnerability

请通过 [GitHub Issues](https://github.com/another-momo/dianjing/issues) 报告安全问题——个人维护项目，现阶段接受公开报告（正式发布后将评估私密报告通道）。

如方便请附上：受影响版本或 commit、复现步骤、影响范围。

## Automation bridge

The automation bridge (spawned by the dev server or the production host) binds to `127.0.0.1` by default — a Unix domain socket on macOS/Linux with owner-only permissions, localhost TCP otherwise — and requires a bearer token for `/rpc` unless explicitly disabled.
