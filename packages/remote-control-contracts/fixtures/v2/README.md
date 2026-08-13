# Remote control v2 fixture boundary

These JSON files are shared wire fixtures for TypeScript and Rust contract tests.
The TypeScript package intentionally remains dependency-free and does not ship a
runtime JSON validator. Gateways and clients must validate untrusted network JSON
at their transport boundaries before treating it as these DTO types.

V2 responses and events must not expose private Pi session references, absolute
paths, raw Pi RPC, provider settings, access tokens, or desktop chat/session IDs.
