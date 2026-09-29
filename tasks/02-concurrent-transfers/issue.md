# Balances drift when transfers run at the same time

After we added the risk screening step, finance has started seeing accounts that do
not reconcile. Example from last week: an account held 1000 cents and two payments of
600 cents were submitted within milliseconds of each other. Both were accepted and both
appear in the transfer history, but the balance only dropped by 600 and the recipient
received 600, so the history no longer matches the balances.

We also see occasional accounts where total money across the ledger is off after busy
periods, and in some cases payments that should have been declined for insufficient
funds were approved.

Expected behavior, no matter how many transfers arrive at once:

- An account can never be overdrawn. Transfers that do not fit within the balance at
  the time they are applied are declined with the usual insufficient funds response.
- For every account, the balance equals its starting balance plus incoming transfers
  minus outgoing transfers, as shown in its transfer history.
- Total money in the system is conserved.
- Requests are never answered with a server error because of concurrent activity.
- The risk check must still run for every new transfer before money moves, and a
  blocked transfer must not change any balance or appear in the history.
- Idempotency key behavior from the previous change is unchanged.

Please add tests that reproduce the problem.
