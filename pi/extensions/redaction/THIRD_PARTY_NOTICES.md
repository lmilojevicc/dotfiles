# Third-party fixture notices

New package code is MIT-licensed. The small synthetic corpus in `fixtures/corpus.json` contains **adaptations**, not imported upstream test suites or claims of detector parity. Per-case source paths, sample IDs, changes and separate upstream/local expectations are recorded there. Domains are reserved example domains; phone numbers are fictional NANP 555-01xx; PEM bodies are visibly truncated or `anything`; the original prefixed token is explicitly synthetic and never issued. No network secret validation is performed.

## Presidio — MIT

Repository: https://github.com/data-privacy-stack/presidio

Pinned revision: `2523c7b74a469270c5c78bb253f140eafca21e31`

Sources: `presidio-analyzer/tests/test_email_recognizer.py`, `presidio-analyzer/tests/test_phone_recognizer.py`.

Copyright (c) Presidio Contributors.

Full copyright/license notice: [fixtures/licenses/presidio.txt](fixtures/licenses/presidio.txt). Email domains were replaced with reserved domains, including a synthetic `xn--` label (not an IDNA validity test). Fictional 555 phone samples are unchanged.

## Gitleaks — MIT

Repository: https://github.com/gitleaks/gitleaks

Pinned revision: `b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b`

Source: `cmd/generate/config/rules/privatekey.go`, `PrivateKey` test vectors `tps[0]` and `fps[0]`.

Copyright (c) 2019 Zachary Rice

Full copyright/license notice: [fixtures/licenses/gitleaks.txt](fixtures/licenses/gitleaks.txt). Both tiny PEM-shaped bodies are unchanged and unusable as complete keys. The local wrapper policy deliberately treats the upstream short-body negative as positive; upstream's minimum-body threshold is not copied.

## scrubadub — Apache-2.0

Repository: https://github.com/LeapBeyond/scrubadub

Pinned revision: `53772cbef417da290d25c95373031f786ab3b5c6`

Sources: `tests/test_detector_emails.py`, `tests/test_detector_phone_numbers.py`, `tests/test_detector_urls.py`.

Copyright 2015 Datascope Analytics

Full license: [fixtures/licenses/scrubadub.txt](fixtures/licenses/scrubadub.txt). No root NOTICE file was present in the pinned tree inspected during research. **Modified fixtures:** phone base numbers replaced with fictional 555 numbers; URL host replaced with `example.com`; one URL adds explicitly fictional userinfo. Original example.com email samples retained. Local phone extension and credential-only URL expectations differ from upstream; see each case's policy note.

## Benchmark comparator (not redistributed)

`steimerbyte/pi-redact-all`, revision `a1a189f970f53c81f90c8de587c59c72cefec5ee`, version `0.2.5`, MIT: https://github.com/steimerbyte/pi-redact-all/blob/a1a189f970f53c81f90c8de587c59c72cefec5ee/package.json . Comparator code is downloaded, compiled and used only inside an isolated temporary directory; no comparator source or dependency is vendored into this package. See [docs/benchmarks.md](docs/benchmarks.md) for coverage differences and methodology. Existing Rust dependency licenses and exact versions are covered by `native/README.md` and `native/Cargo.lock`.
