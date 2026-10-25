# 0003: Reserve quotas with single-item updates, not transactions

- **Status:** Accepted (2026-09-26, Stage 15); supersedes the Stage 10 design
- **Deciders:** organizer, Claude

## Context

Every presign reserves room in three counters before it hands out an upload link:

- the guest's **session** (500 files / 10 GiB),
- the network's **IP hash for this hour** (3,000 files),
- the **event total** (20,000 files / 100 GiB).

Stage 10 did this as one `TransactWriteItems` of three conditional `ADD` updates: either all
three have room or nothing changes. It passed every unit and abuse test.

The Stage 15 load test (20 simulated guests × 10 files, all at once) failed 32 of 200 presigns
with **500 `TransactionConflict`**. All guests at a venue share the event counter and usually the
IP counter, and DynamoDB cancels a transaction when another one touches the same item at the same
time. The hot items are exactly the shared ones, so the busiest moment of an event would fail
the most.

## Decision

Three **single-item conditional `UpdateItem` calls**, in order (event, IP, session): the shared
counters first, so a full event or venue refuses before touching the guest's own counter. If one
is full, the earlier increments are rolled back with a compensating decrement, and the 429 names
the full counter. The full walkthrough is in [how it works: quotas](../how-it-works/quotas.md).

DynamoDB serializes single-item writes on the same key instead of canceling them, so concurrent
guests queue for a few milliseconds instead of failing.

## Consequences

- No conflicts under load, and half the write cost (transactions bill double).
- The three counters aren't atomic together. Between an increment and its rollback, another
  request can see a counter a little higher than it really is and be refused. That errs toward
  refusing, by at most a few files, only when a cap is nearly reached.
- If the Lambda dies between an increment and its rollback, a counter stays over-counted. Session
  and IP counters expire (TTL); the event counter has a large margin.
- Reservations count presigns, not finished uploads, so retries count too. The limits allow for it.

## Evidence

- Stage 15 load test #1 (transactions): 158/200, with 32 × `TransactionConflict`.
- Stage 15 load test #2 (single-item updates): **300/300**, 0 presign errors; presign p50 0.5 s.
- `api/src/lib/quota.ts` and its tests cover the rollback paths.
