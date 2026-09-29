# Retrying a transfer sometimes moves the money twice

Our mobile client retries `POST /transfers` when a request times out. Support has
reported customers being charged twice for a single payment.

Clients will now send an `Idempotency-Key` header on transfer requests. Repeating a
request with the same key must not move money a second time.

Expected behavior:

- A repeated request with the same key and the same body returns the original
  transfer with the same status code and does not change any balance.
- Reusing a key with a different body (different accounts or amount) is a client
  error and must not move money.
- A request that failed (for example, insufficient funds) should not permanently
  lock the key to that failure once the account is funded and the client retries.
- Requests without the header keep working as they do today.
- Keys are scoped per source account, so two different accounts can use the same
  key string independently.

Please add tests for the new behavior.
