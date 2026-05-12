## 2024-05-12 - OpenAPI Schema Resolution Bottleneck
**Learning:** In Node.js applications parsing large OpenAPI/Swagger specifications, recursively resolving `$ref` elements without memoization causes severe performance bottlenecks (O(N * M)). The deeper the component graph and the more shared responses/request bodies, the longer it takes due to repeated object traversals.
**Action:** When extracting schemas or objects that utilize references (`$ref`), use a shared `Map` cache during the extraction process across all endpoints, skipping deep traversal for previously resolved objects.
