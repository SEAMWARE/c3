# Declared indexes in c³

A broker's store can keep an index on an attribute, so that a `q` on it does not read every entity: a
**declared index** - by the store plugin's `--dbIndexes` at start, or through the broker's admin API
(`/admin/indexes`) on a running broker. coraine's
[installation guide](https://github.com/SEAMWARE/coraine/blob/main/doc/installation.md#declared-indexes)
has the declarations, the stores (`mongoc`, `corDB`) and the API.

c³ (Operate, planned) shows a broker's declarations and turns them on and off: `POST /admin/indexes` and
`DELETE /admin/indexes/{id}`; a declaration of `--dbIndexes` is shown, and is changed by a restart only.

**The indexes are declared at start** (`--dbIndexes`). Turned on or off on a running broker, an index is
built: on corDB **every** declaration's, in every tenant's store, the store's writes waiting meanwhile, and
their counters start from 0. 1 000 000 entities, one tenant (coraine's
[performance](https://github.com/SEAMWARE/coraine/blob/main/doc/performance.md#building-a-declared-index)):

| | corDB | mongoc |
|---|---|---|
| on: a second declaration | 0.87 s - both built again | 1.1 - 2.1 s - its own two MongoDB indexes |
| off | 0.11 s, then 0.5 s at the next query that uses the other | 1 ms |

## What one gains and costs

Per request, at full load: 100 000 entities, one attribute declared, corDB on disk, MongoDB 8.2 local
(coraine's [performance](https://github.com/SEAMWARE/coraine/blob/main/doc/performance.md#cordbs-declared-indexes),
2026-10-22):

| request | corDB | mongoc |
|---|---|---|
| `q` on the attribute, 10 matches | 1 111 µs -> 2.7 µs (x416) | 167 ms -> 181 µs (x919) |
| `q` on the attribute, 1 % of the entities match | 106 µs -> 6.0 µs (x17.6) | 12.3 ms -> 4.5 ms (x2.8) |
| `q` on the attribute, half the entities match (a page) | the same | the same |
| a write of the attribute (`PATCH`) | +2.8 µs (-21 %) | +2.5 µs (-5 %) |
| a create with the attribute | +3.5 µs (-48 %) | +0.7 µs (-4 %) |
| a write of another attribute | +0.13 µs (-1.3 %) | +0.3 µs (-0.6 %) |
| a create of an entity without the attribute | +0.11 µs (-3 %) | not measured |
| a replace (`PUT`) of an entity without the attribute | the same | not measured |
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

`accesses` against `updates` is the broker's own workload, next to the table above. The same figures are in
`/admin/metrics` (and so in Operate's charts): `ngsild_index_built`, `_entries`, `_bytes`, `_accesses_total`,
`_updates_total`, labelled by declaration and tenant (coraine's
[installation guide](https://github.com/SEAMWARE/coraine/blob/main/doc/installation.md#in-adminmetrics)).
