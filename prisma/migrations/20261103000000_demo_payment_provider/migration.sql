-- Demo access, part 1 of 2: the simulated payment provider.
--
-- A new enum value cannot be USED in the transaction that adds it, so it lives in its own migration; the
-- constraints and triggers that mention it are in 20261103010000_demo_access. Additive: no existing row,
-- column or constraint changes. 'DEMO' payments are created only for demo accounts and never contact a provider.
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'DEMO';
