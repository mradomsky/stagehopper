# One app-wide VAPID keypair, never rotated

Reminders are signed with a single VAPID keypair for the whole app, with no rotation. Every Device subscription is bound to the public key, so rotating it would silently invalidate all of them and require every device to re-subscribe; the private key lives in SSM to keep it out of Terraform state.

Source: docs/notifications-infra.md#0-vapid-keypair-one-time-by-hand
