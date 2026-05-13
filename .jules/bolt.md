## 2024-05-13 - [Performance] Cache resolved schemas in get_spec
**Learning:** Memoizing `$ref` schema resolution with a Map cache reduces O(N*M) parsing of massive OpenAPI specifications to O(N) by preventing identical components from being re-traversed for every endpoint.
**Action:** Always implement a caching mechanism when traversing and resolving references in recursive structures like OpenAPI specs.
