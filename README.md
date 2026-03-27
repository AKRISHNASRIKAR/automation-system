# Workflow Automation Engine - Phase 1

This folder contains the simplest possible Phase 1 build:

- plain Node.js HTTP server
- GitHub webhook signature verification with HMAC SHA-256
- sequential async pipeline with fail-fast behavior
- health check route

## Files

- `server.js` - webhook receiver and pipeline runner
- `.env.example` - required environment variables
- `package.json` - minimal start script

## Requirements

- Node.js 18+

## Setup

1. Copy the example env file:

```bash
cp .env.example .env
```

2. Edit `.env` and set a strong webhook secret:

```env
PORT=3000
GITHUB_WEBHOOK_SECRET=your-very-long-random-secret
```

3. Start the server:

```bash
npm start
```

4. Check health:

```bash
curl http://localhost:3000/health
```

## Local webhook test

Use the same exact body bytes when generating the signature and sending the request:

```bash
body='{"ref":"refs/heads/main","repository":{"name":"my-repo"},"sender":{"login":"octocat"}}'
secret='your-very-long-random-secret'
signature=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" | sed 's/^.* //')

curl -X POST http://localhost:3000/webhook \
  -H "content-type: application/json" \
  -H "x-github-event: push" \
  -H "x-hub-signature-256: sha256=$signature" \
  -d "$body"
```

Expected success response:

```json
{
  "pipelineId": "some-uuid",
  "completedSteps": ["parseEvent", "classifyEvent", "logSummary"],
  "durationMs": 3
}
```

Invalid signature test:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "content-type: application/json" \
  -H "x-github-event: push" \
  -H "x-hub-signature-256: sha256=wrong" \
  -d '{"ref":"refs/heads/main","repository":{"name":"my-repo"}}'
```

Expected response:

```json
{
  "error": "Invalid or missing signature."
}
```

Pipeline failure test:

```bash
body='{"repository":{"name":"my-repo"}}'
secret='your-very-long-random-secret'
signature=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" | sed 's/^.* //')

curl -X POST http://localhost:3000/webhook \
  -H "content-type: application/json" \
  -H "x-github-event: push" \
  -H "x-hub-signature-256: sha256=$signature" \
  -d "$body"
```

Expected response:

```json
{
  "pipelineId": "some-uuid",
  "failedStep": "parseEvent",
  "error": "Missing required field: ref."
}
```

## GitHub webhook setup

1. Open your GitHub repository.
2. Go to `Settings` -> `Webhooks`.
3. Click `Add webhook`.
4. Set `Payload URL` to your public endpoint:
   - local testing with a tunnel example: `https://your-url.ngrok-free.app/webhook`
5. Set `Content type` to `application/json`.
6. Set `Secret` to the same value as `GITHUB_WEBHOOK_SECRET`.
7. Choose `Let me select individual events`.
8. Select at least:
   - `Pushes`
   - `Pull requests`
   - `Issues`
9. Make sure the webhook is `Active`.
10. Click `Add webhook`.

## Working locally with GitHub

GitHub cannot reach `http://localhost:3000` directly, so expose your server with a tunnel.

Example using ngrok:

```bash
ngrok http 3000
```

Then copy the HTTPS forwarding URL from ngrok into the GitHub webhook `Payload URL` and append `/webhook`.

## What Phase 1 currently does

Pipeline steps run in this order:

1. `parseEvent`
2. `classifyEvent`
3. `logSummary`

If any step throws an error, the pipeline stops immediately and returns a `400` response with the failed step name.
# automation-system
