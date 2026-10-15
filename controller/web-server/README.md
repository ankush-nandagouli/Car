# OpenBot Web Controller

This fork uses a self-hosted username/password login for the remote controller. Configure `OPENBOT_USERNAME`, `OPENBOT_PASSWORD`, `OPENBOT_SESSION_SECRET`, and `OPENBOT_ROOM_ID` as private environment variables for the Node signaling server. The browser signs in at `/api/login`, receives a short-lived JWT, and joins `/ws`. The Android Robot app uses the same username/password from its Settings screen.

For full Render, GitHub Actions, APK-download, and security setup instructions, see [`../../README-ACCESSORIES-DEPLOY.md`](../../README-ACCESSORIES-DEPLOY.md).
