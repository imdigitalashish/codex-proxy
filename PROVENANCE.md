# Provenance

This repository is a private backup of a local proxy setup, not an official
OpenAI or GitHub distribution. Credentials and local conversation state are
excluded. No blanket open-source license is asserted for the entire backup.

## Proxy Source

The proxy, Responses bridge, upload gate, catalog adapter, request-size recovery,
and their tests were copied from the working local installation. Publication
changes add portable setup, a portable picker, a per-process Codex launcher,
private authentication-file writes, documentation, and CI. The active local
installation was not replaced as part of preparing this repository.

## Codex Installer

`tools/install-codex.sh` is an unchanged copy of OpenAI Codex's
`scripts/install/install.sh`, from the local source checkout at commit:

```text
a57f0e638db948faf796b1978e1093d9b7034638
```

Installer SHA-256:

```text
ba92dd27e5c06f0d3bbc58bfa4b9cfb6599cd2742fbb1f92a2765e6c07dedb5a
```

The accompanying upstream Apache-2.0 license and notice are preserved as
`tools/LICENSE.codex` and `tools/NOTICE.codex`. Upstream project:
`https://github.com/openai/codex`.

The installer is optional and is never executed by proxy setup or tests.
Installed Codex binaries are not committed.

## Model Template

`models-template.json` is the upstream-derived Codex model metadata snapshot
used by the original local setup. Its recorded client version is `0.151.0`.
It includes vendor-provided model instruction templates, not personal
conversation messages.

It is retained to reproduce this private configuration. Its inclusion does not
assert an independent redistribution license or imply that all listed models
remain available. Inspect upstream terms and replace or separately source this
asset before making a public distribution. The proxy checks the live upstream
catalog when serving model choices; the picker writes current client-version
metadata into each machine's generated cache.
