# Small synthetic regression corpus

`corpus.json` is a deliberately selected subset, not a statistical accuracy evaluation or any upstream's full test suite. `projects` pins exact revisions and license hashes; each case identifies its original path/sample and modifications. Full required license texts are in `licenses/`; see `../THIRD_PARTY_NOTICES.md`.

All cases are synthetic: reserved domains, fictional NANP 555-01xx numbers, visibly truncated/unusable PEM shapes, or explicitly invented prefixed tokens. Never navigate URLs, call numbers, decode keys for use, or validate tokens with a service. No real private configuration or dictionary is used.

`tests/corpus.test.ts` runs the real addon: all detectors OFF preserves each input, then each canonical category is enabled separately; enabled matches must have that category and original UTF-16 spans. The selected category must remove the expected complete base values before testing idempotence. Mixed Unicode inputs verify separate opt-ins. There is no invented detector synonym/alias API. Phone extension removal, general URLs, provider validation, IDNA correctness and upstream recognizer parity are not promised. Known policy differences are explicit per case rather than silently relabeled as parity.

Run `npm run build:native` then `npm run test:corpus` (no npm dependency install is needed for Node type stripping). Native build artifacts are local and excluded from source packaging. The benchmark's fixed synthetic generators are separate in `../benchmarks/workloads.mjs`; these tests are not benchmark accuracy training data.
