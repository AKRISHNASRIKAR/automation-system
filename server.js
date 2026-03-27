'use strict';

const http = require('http');
const crypto = require('crypto');

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

if (!GITHUB_WEBHOOK_SECRET) {
  throw new Error('Missing GITHUB_WEBHOOK_SECRET environment variable.');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, {
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime())
      });
    }

    if (req.method === 'POST' && req.url === '/webhook') {
      const rawBody = await readRawBody(req);
      const signatureHeader = req.headers['x-hub-signature-256'];

      if (!verifySignature(rawBody, signatureHeader, GITHUB_WEBHOOK_SECRET)) {
        return sendJson(res, 401, {
          error: 'Invalid or missing signature.'
        });
      }

      let body;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch (error) {
        return sendJson(res, 400, {
          failedStep: 'parseJson',
          error: 'Request body is not valid JSON.'
        });
      }

      const pipelineId = crypto.randomUUID();
      const startedAt = Date.now();

      try {
        const pipelineResult = await runPipeline(
          [
            createParseEventStep(req.headers),
            classifyEvent,
            logSummary
          ],
          {
            pipelineId,
            body
          }
        );

        return sendJson(res, 200, {
          pipelineId,
          completedSteps: pipelineResult.completedSteps,
          durationMs: Date.now() - startedAt
        });
      } catch (error) {
        return sendJson(res, 400, {
          pipelineId,
          failedStep: error.failedStep || 'unknown',
          error: error.message
        });
      }
    }

    return sendJson(res, 404, {
      error: 'Not found.'
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: 'Internal server error.',
      details: error.message
    });
  }
});
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

async function readRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return false;
  }

  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) {
    return false;
  }

  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const receivedHex = signatureHeader.slice(prefix.length);

  if (receivedHex.length !== expectedHex.length) {
    return false;
  }

  const receivedBuffer = Buffer.from(receivedHex, 'hex');
  const expectedBuffer = Buffer.from(expectedHex, 'hex');

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

async function runPipeline(steps, initialContext) {
  const completedSteps = [];
  let context = { ...initialContext };

  for (const step of steps) {
    try {
      context = await step(context);
      completedSteps.push(step.stepName);
    } catch (error) {
      error.failedStep = step.stepName;
      throw error;
    }
  }

  return {
    context,
    completedSteps
  };
}

function createParseEventStep(headers) {
  async function parseEvent(context) {
    const eventType = headers['x-github-event'];
    const { body } = context;

    if (!eventType) {
      throw new Error('Missing x-github-event header.');
    }

    if (!body || typeof body !== 'object') {
      throw new Error('Missing request body.');
    }

    if (!body.ref) {
      throw new Error('Missing required field: ref.');
    }

    const repositoryName = body.repository && body.repository.name;

    return {
      ...context,
      event: {
        type: eventType,
        ref: body.ref,
        repositoryName: repositoryName || 'unknown-repository',
        sender: body.sender && body.sender.login ? body.sender.login : 'unknown-sender'
      }
    };
  }

  parseEvent.stepName = 'parseEvent';
  return parseEvent;
}

async function classifyEvent(context) {
  const actionMap = {
    push: 'push',
    pull_request: 'pull_request',
    issues: 'issues'
  };

  const action = actionMap[context.event.type] || 'unknown';

  return {
    ...context,
    event: {
      ...context.event,
      action
    }
  };
}

classifyEvent.stepName = 'classifyEvent';

async function logSummary(context) {
  const summary = [
    `pipeline=${context.pipelineId}`,
    `event=${context.event.type}`,
    `action=${context.event.action}`,
    `repo=${context.event.repositoryName}`,
    `ref=${context.event.ref}`,
    `sender=${context.event.sender}`
  ].join(' | ');

  console.log(summary);

  return context;
}

logSummary.stepName = 'logSummary';

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json'
  });
  res.end(JSON.stringify(payload));
}

function loadEnvFile() {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');

  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

module.exports = {
  server,
  readRawBody,
  verifySignature,
  runPipeline,
  createParseEventStep,
  classifyEvent,
  logSummary
};
