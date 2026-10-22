---
status: accepted
---

# The Nickname is app-owned and non-unique; the user id is the public key

A user's name on Picks and Messages used to be their Clerk username (the Handle), read from
the JWT and never from the request body, so renaming meant leaving the app and the change
reached the copies only on the next write. We now store a Nickname on the user row, edited
in the Profile, and stop reading the `username` claim. Clerk's username stays required at
sign-up purely as a sign-in credential (it is the only way to register without an email) and
seeds the Nickname once. Nicknames are not unique, so public Picks and Messages carry the
Clerk `userId` and the client tells its own rows apart by it, not by name.

## Considered Options

- **Write the Nickname back to the Clerk username**: one name everywhere, but Clerk enforces
  uniqueness and its own format rules, needs the Backend API secret in the Lambda, and the
  token lags the change.
- **Drop the Clerk username entirely**: simplest model, but then every sign-up needs an
  email or Google, and username+password is the only email-free path today.
- **An opaque public attendee id instead of `userId`**: Clerk ids are already opaque; the
  extra mapping buys nothing.

## Consequences

- The JWT template's `username` claim is unused; the users-table `handle` attribute is the
  Nickname's storage and existing values carry over, so nobody is re-prompted.
- Public reads expose `userId` (extends the ADR 0004 trade: it is public to anyone).
- Messages keep the Nickname snapshot at post time (unchanged); Picks copies are rewritten
  in the same request as the rename (ADR 0005).
