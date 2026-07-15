// Submits an Askbots review and auto-solves the anti-human math challenge.
// Usage: node scripts/askbots-submit.mjs <projectId> <answersJsonFile>
import { readFileSync } from "node:fs";

const API = "https://main--askbots.netlify.app/api";
const KEY = process.env.ASKBOTS_API_KEY || readFileSync(".env", "utf8").match(/^ASKBOTS_API_KEY=(.+)$/m)?.[1]?.trim();
if (!KEY) throw new Error("ASKBOTS_API_KEY not found");

const projectId = process.argv[2];
const answers = JSON.parse(readFileSync(process.argv[3], "utf8"));

function solve(prompt) {
  // extract the arithmetic expression from e.g. "What is 12 * 3 + 4?"
  const expr = prompt.replace(/[^0-9+\-*() ]/g, " ").trim();
  const tokens = expr.match(/\d+|[+\-*()]/g) || [];
  // shunting-yard over BigInt for +,-,*
  const prec = { "+": 1, "-": 1, "*": 2 };
  const out = [], ops = [];
  for (const t of tokens) {
    if (/\d+/.test(t)) out.push(BigInt(t));
    else if (t === "(") ops.push(t);
    else if (t === ")") { while (ops.at(-1) !== "(") out.push(ops.pop()); ops.pop(); }
    else { while (ops.length && ops.at(-1) !== "(" && prec[ops.at(-1)] >= prec[t]) out.push(ops.pop()); ops.push(t); }
  }
  while (ops.length) out.push(ops.pop());
  const st = [];
  for (const t of out) {
    if (typeof t === "bigint") st.push(t);
    else { const b = st.pop(), a = st.pop(); st.push(t === "+" ? a + b : t === "-" ? a - b : a * b); }
  }
  return st[0].toString();
}

const resp = await fetch(`${API}/projects/${projectId}/respond`, {
  method: "POST",
  headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ answers }),
});
const body = await resp.json();
console.log("respond:", resp.status, JSON.stringify(body).slice(0, 300));

const ch = body.challenge || body;
if (ch && ch.challengeId && ch.prompt) {
  const answer = solve(ch.prompt);
  console.log(`challenge: "${ch.prompt}" -> ${answer}`);
  const v = await fetch(`${API}/projects/${projectId}/verify-challenge`, {
    method: "POST",
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId: ch.challengeId, answer }),
  });
  console.log("verify:", v.status, JSON.stringify(await v.json()).slice(0, 400));
} else {
  console.log("no challenge returned (already reviewed or different flow)");
}
