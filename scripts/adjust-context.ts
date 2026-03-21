/**
 * CLI utility to adjust the agentic context blob stored in Cloudflare KV.
 *
 * Takes an operator comment, reads the existing context from KV, asks Gemini
 * to revise the guidance, and writes the updated blob back to KV.
 *
 * The report worker reads this blob at brief-generation time and injects it
 * into the Gemini system prompt, so changes here steer future briefs.
 *
 * Usage:
 *   npm run context "Focus more on action items and less on weather chatter"
 *   npm run context "Deprioritize calendar conflicts unless they involve 1:1s"
 *   npm run context --show              # print current context without changing it
 *
 * Environment:
 *   GEMINI_API_KEY         – Gemini API key (required for updates, not --show)
 *   GEMINI_MODEL           – model override (default: gemini-2.0-flash)
 *
 * Auth: Uses your existing `wrangler` login (no extra tokens needed).
 */

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
const KV_NAMESPACE_ID = "aff13c4ce8b049fc8869a526fb392c85";
const KV_KEY = "operator_context";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Cloudflare KV helpers (via wrangler CLI — uses existing auth)
// ---------------------------------------------------------------------------

function kvGet(): string | null {
  try {
    const result = execSync(
      `npx wrangler kv key get "${KV_KEY}" --namespace-id="${KV_NAMESPACE_ID}" --remote --text`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return result.trim() || null;
  } catch {
    return null;
  }
}

function kvPut(value: string): void {
  const tmp = join(tmpdir(), `reorgable-context-${Date.now()}.txt`);
  try {
    writeFileSync(tmp, value, "utf-8");
    execSync(
      `npx wrangler kv key put "${KV_KEY}" --namespace-id="${KV_NAMESPACE_ID}" --remote --path="${tmp}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function reviseContext(current: string | null, comment: string): Promise<string> {
  const prompt = [
    "You maintain a concise guidance document that steers an automated daily-briefing AI.",
    "The document is read by the briefing system every morning and shapes how it writes the brief.",
    "",
    "Rules for the guidance document:",
    "- Keep it under 500 words — it goes into a prompt, so brevity is critical.",
    "- Use imperative sentences (e.g. \"Prioritize action items over informational summaries\").",
    "- Preserve any existing guidance that isn't contradicted by the new comment.",
    "- Remove guidance that the operator explicitly revokes.",
    "- Add or refine guidance based on the operator's new comment.",
    "- Do NOT include meta-commentary, timestamps, or explain your reasoning — just output the revised guidance text.",
    "",
    current
      ? `Current guidance document:\n---\n${current}\n---`
      : "There is no existing guidance document yet. Create one from scratch based on the comment.",
    "",
    `Operator comment: "${comment}"`,
    "",
    "Output ONLY the revised guidance document text, nothing else."
  ].join("\n");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
    }
  );

  if (!res.ok) fail(`Gemini call failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) fail("Gemini returned an empty response");
  return text.trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // --show flag: just print current context and exit
  if (args.includes("--show")) {
    const current = kvGet();
    if (!current) {
      console.log("(no context set yet)");
    } else {
      console.log(current);
    }
    return;
  }

  const comment = args.join(" ").trim();
  if (!comment) fail("Usage: npm run context \"your adjustment comment here\"");
  if (!GEMINI_API_KEY) fail("Missing GEMINI_API_KEY");

  console.log("Reading current context…");
  const current = kvGet();

  if (current) {
    console.log(`Current context (${current.length} chars):\n---\n${current}\n---\n`);
  } else {
    console.log("No existing context — will create from scratch.\n");
  }

  console.log(`Operator comment: "${comment}"\n`);
  console.log("Asking Gemini to revise…");

  const revised = await reviseContext(current, comment);

  console.log(`\nRevised context (${revised.length} chars):\n---\n${revised}\n---\n`);

  console.log("Writing to KV…");
  kvPut(revised);
  console.log("✓ Context updated.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
