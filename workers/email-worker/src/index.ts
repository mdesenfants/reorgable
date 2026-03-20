type Env = {
  RAW_BUCKET: R2Bucket;
  INGEST_BASE_URL: string;
  INGEST_API_TOKEN: string;
  EMAIL_FORWARD_TO?: string;
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });

const trimTrailingSlash = (value: string): string => value.replace(/\/$/, "");

const buildRawKey = (id: string, nowIso: string): string => {
  const date = nowIso.slice(0, 10);
  return `email-raw/${date}/${id}.eml`;
};

async function postToIngest(args: {
  env: Env;
  payload: Record<string, unknown>;
}): Promise<Response> {
  const ingestUrl = `${trimTrailingSlash(args.env.INGEST_BASE_URL)}/ingest/email`;
  return fetch(ingestUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.env.INGEST_API_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(args.payload)
  });
}

export default {
  async fetch(request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") {
      return json({ ok: true, service: "email-worker" });
    }
    return json({ error: "Not found" }, 404);
  },

  async email(message, env): Promise<void> {
    const nowIso = new Date().toISOString();
    const id = crypto.randomUUID();
    const rawKey = buildRawKey(id, nowIso);

    const rawEmail = await new Response(message.raw).arrayBuffer();
    await env.RAW_BUCKET.put(rawKey, rawEmail, {
      httpMetadata: { contentType: "message/rfc822" }
    });

    const subject = message.headers.get("subject") ?? "(no subject)";
    const externalId = message.headers.get("message-id") ?? `${message.from}:${subject}:${nowIso}`;

    const ingestPayload = {
      from: message.from,
      to: message.to,
      subject,
      bodyText: `Raw email stored in R2 key: ${rawKey}`,
      sentAt: nowIso,
      attachmentKeys: [rawKey],
      isUnread: true,
      inInbox: true,
      externalId
    };

    const ingestResponse = await postToIngest({ env, payload: ingestPayload });
    if (!ingestResponse.ok) {
      const details = (await ingestResponse.text()).slice(0, 300);
      message.setReject(`Failed to ingest email: ${ingestResponse.status} ${details}`);
      return;
    }

    if (env.EMAIL_FORWARD_TO) {
      await message.forward(env.EMAIL_FORWARD_TO);
    }
  }
} satisfies ExportedHandler<Env>;