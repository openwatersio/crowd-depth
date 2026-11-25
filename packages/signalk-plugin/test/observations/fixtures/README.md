# Observation fixtures

`observations-v2.sqlite.gz` contains only synthetic observations. It was created
by the actual `store.ts` at commit `531bc819`, not by changing the current store's
version number or dropping columns. The companion JSON records the original
source hash, uncompressed database hash and Node version. The generator changes
only Temporal's module specifier so the historical module can run from a temporary
directory; its type-only imports are erased by Node.

Regenerate from a checkout containing that commit:

```sh
node packages/signalk-plugin/scripts/generate-observation-v2-fixture.mjs
```

The normal Vitest/CI suite upgrades this fixture through the built production
worker, verifies freshness and spatial discovery, checks that original compressed
bytes stay unchanged, and appends new live observations. Regeneration is not
needed in CI, including shallow checkouts.

`geos-thinning.json` is the separate horizontal simplification reference described
by `scripts/reference-thinning.py`; it does not establish tide-data fidelity.
