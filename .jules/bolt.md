# Performance Learnings

- **Schema Resolution:** The schema resolution in OpenAPI spec parsing can cause massive CPU spikes if many endpoints reference the same nested objects, due to O(N*M) traversals.
- **Solution:** Passing a shared cache (`Map`) down the recursive `summarizeSchema` tree avoids duplicate object resolution and reduces typical large spec parse time from several seconds down to ~0.3s.
