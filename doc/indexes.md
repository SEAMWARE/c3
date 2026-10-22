# Declared indexes in c³

A broker's store can keep an index on an attribute, so that a `q` on it does not read every entity: a
**declared index** - by the store plugin's `--dbIndexes` at start, or through the broker's admin API
(`/admin/indexes`) on a running broker. coraine's
[installation guide](https://github.com/SEAMWARE/coraine/blob/main/doc/installation.md#declared-indexes)
has the declarations, the stores (`mongoc`, `corDB`) and the API.

c³ (Operate, planned) shows a broker's declarations and turns them on and off: `POST /admin/indexes` and
`DELETE /admin/indexes/{id}`; a declaration of `--dbIndexes` is shown, and is changed by a restart only.

## What one gains and costs

Per request, at full load: 100 000 entities, one attribute declared, corDB on disk, MongoDB 8.2 local
(coraine's [performance](https://github.com/SEAMWARE/coraine/blob/main/doc/performance.md#cordbs-declared-indexes),
2026-10-22):

| request | corDB | mongoc |
|---|---|---|
| `q` on the attribute, 10 matches | 949 µs -> 2.7 µs (x356) | 167 ms -> 181 µs (x919) |
| `q` on the attribute, 1 % of the entities match | 106 µs -> 5.8 µs (x18.1) | 12.3 ms -> 4.5 ms (x2.8) |
| `q` on the attribute, half the entities match (a page) | the same | the same |
| a write of the attribute (`PATCH`) | +2.8 µs (-22 %) | +2.5 µs (-5 %) |
| a create with the attribute | +2.8 µs (-41 %) | +0.7 µs (-4 %) |
| a write of another attribute | +0.17 µs (-1.7 %) | +0.3 µs (-0.6 %) |
| a query without a `q` on it | the same | the same |

Which one weighs more is the workload's: how often the attribute is written, how often it is queried.

## What c³ shows for each declaration

From `GET /admin/indexes`, per tenant it covers:

| figure | |
|---|---|
| `built` | the index is there - corDB builds it at the first query that can use it |
| `entries` | corDB: the values it holds |
| `bytes` | corDB: their memory; mongoc: the size of its two MongoDB indexes |
| `accesses` | the `q` terms it served (corDB, since it was built), the times a query used it (mongoc, since MongoDB started) |
| `updates` | corDB: the writes that changed it - an entity with the attribute created or deleted, its values changed |

`accesses` against `updates` is the broker's own workload, next to the table above. The same counters in
`/admin/metrics` (and so in Operate's charts) are on coraine's short-term roadmap.
