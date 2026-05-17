# Performance Learnings

- **OpenAPI Schema Resolution Memoization:** When parsing large OpenAPI specs with deeply nested `$ref`s, resolving schemas repeatedly per endpoint can cause extreme performance degradation due to redundant O(N*M) traversals. By passing a shared `Map` cache across endpoints, we memoize resolved schemas to drastically reduce processing time (O(N)), avoiding repeated deep reference resolution logic.
