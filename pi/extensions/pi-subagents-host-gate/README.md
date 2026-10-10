# pi-subagents host gate

This explicitly configured Pi extension loads the public `pi-subagents` default
factory only in ordinary Pi sessions. A nonblank `BB_THREAD_ID` skips upstream
resolution, module loading and registration in every BB-origin session (root,
workflow worker and side chat), regardless of `PI_AGENT_POLICY_BB_PROFILE`.
Whitespace-only IDs count as absent; unfamiliar nonblank formats count as BB.
This is host routing, not authentication or a security boundary.

`pi/settings.json` keeps `npm:pi-subagents` installed with `extensions: []` and
loads `extensions/pi-subagents-host-gate/loader.ts` exactly once. Bundled skills
and prompts remain enabled as before. Project package overrides, explicit native
extension paths and manual/bashed agent launches can bypass this arrangement;
this gate does not prohibit them or filter other extensions/tools.

Ordinary Pi receives native tools, commands, hooks and control listeners from the
upstream factory, with the exact supplied host API. Errors are not swallowed.
No environment variables are changed. Routing is captured when each runtime's
factory starts; changing env later requires a new runtime/reload.

See [activation and validation](docs/activation-and-validation.md) for placement,
rollback, tested versions and the public-loader contract. No live configuration
or runtime has been reloaded by this implementation.
