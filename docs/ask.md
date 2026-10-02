# Ask: Bedrock, MCP and guardrails

Ask uses **Kimi K2.5** (`moonshotai.kimi-k2.5`) through Bedrock Converse in `us-east-1`. `/api/config` identifies the active model in the browser. AWS credentials stay in the server's SDK credential chain. There is no browser model connection, alternate model or local-answer fallback.

The user prioritized reliable answers at low cost after Nova Micro failed live intent and selection checks. Nova Lite, Nova 2 Lite and Qwen3 Next were also evaluated; they produced additional selection, context or schema failures in this workflow. Claude Haiku 4.5 was also evaluated but encountered account throttling and malformed tool outputs. Kimi is the selected candidate, not a claim to be the cheapest model offered by AWS. On October 1, 2026, [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/) listed Kimi K2.5 in US regions at $0.60 per million input tokens and $3.00 per million output tokens. These are token prices, not a fixed request or infrastructure cost. Accepted requests use up to four model calls and can transmit the complete archive; actual cost depends on input and generated tokens.

## Request flow

1. The API validates the request, browser origin, Host, input size, bounded history and process admission limits.
2. A private MCP client discovers the tools and reads archive coverage and the current local calendar. An LLM then plans the request and applies the scope guard. It evaluates relevance, not whether the archive has an answer. It resolves conversational references into a standalone question, chooses scope/date bounds and listing, explanation or coverage intent. Unrelated, mixed, policy-bypass and operational attack requests are rejected.
3. For an accepted incident request, the client calls `list_incidents` with the model's explicit bounds, then asks the LLM to select evidence for the standalone question. There is **no keyword router, synonym/organization alias table, natural-language date parser, embedding index or semantic search** in Ask. For a model-chosen whole-catalog selection the backend expands the complete result; narrower subjects use model-selected IDs.
4. The client reads selected evidence through MCP. Explanations use a dedicated LLM writing step. The backend validates tool arguments, IDs, citations and output format. A separate LLM review checks the actual rendered answer against the original question, history, calendar and evidence before publication. Every stage shares the same domain and conversation policy. The stages are bounded; the model cannot start an autonomous tool loop.
5. Listings render every selected record's exact published summary and evidence limits. Their introductions and counts are generated from validated state, so a model does not add unsupported factual claims ahead of those records. Explanations contain cited model-written sections and an index of the records used. No-match answers show the resolved question, period and archive coverage; they do not broaden the query to manufacture results.

The model is responsible for understanding language and choosing relevant records. Code enforces the protocol and evidence boundaries. Model-based relevance, completeness and factual review remain probabilistic: valid citations alone do not prove a sentence is correct. This is not AWS Bedrock Guardrails or a claim of perfect prompt-injection resistance.

Each model stage uses Bedrock's [strict tool-output schema](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html). Every field is explicit, including empty or null fields that do not apply to a rejection. Local validation additionally enforces length, record-count, date and conditional requirements unsupported by the wire schema. The backend still rejects any schema deviation; structural conformance does not establish factual accuracy.

## Private MCP tools

`backend/mcp-records.ts` implements a real MCP TypeScript SDK v1 server and client using an in-memory transport. Its tools read the request’s consistent PostgreSQL snapshot. Tool discovery, schemas, calls and structured results use MCP. There is no public `/mcp` endpoint, separate listening port, subprocess, shell tool or write tool.

| Tool | Contract |
| --- | --- |
| `get_archive_context` | Current date in Asia/Kolkata, Monday-based calendar intervals, record counts, archive coverage and a complete title/organization index so the planner can resolve incident names. |
| `list_incidents` | Complete catalog for model-supplied `scope` (`agents` or `all`) and inclusive ISO `start_date` / `end_date`. An empty bound is unrestricted. No free-text search argument. |
| `get_incident_details` | Full published records for unique known IDs already seen in a catalog during this request. Includes timeline, cause attribution, impact, loss, evidence limits, lessons and source metadata. |

All tools are annotated read-only, idempotent and closed-world. The backend permits only the discovered tool names and schema-valid arguments; extra arguments are errors. It never executes arbitrary model-supplied commands or fetches source URLs. `return_result` is a structured model-output formatter, not an MCP action. The model selects retrieval parameters and IDs; the backend invokes the corresponding fixed MCP stages.

The archive currently has 44 records, including 23 agent records. All catalog results are complete, without ranking or truncation. The contract caps the archive and ID lists at 64 records; Ask returns 503 if the archive grows beyond that cap until its contract is deliberately revised; the website and publication APIs remain available. Date bounds compare the published sorting field `d`; prose must preserve the reported period in `when` and uncertainty in `limits`. An undated record cannot match a bounded date interval.

Full incident details also include published [Narrative/Comparison context](narrative-comparison.md) annotations and their draft/review status. Ask's catalog date filter still uses `d`; it does not implement the new Comparison occurrence/disclosure filters. Use that view or its dedicated API for reproducible chart counts. Local implementation checks for the context addition did not invoke Ask; release checks are recorded in the Helm deployment guide.

## Conversation and dates

The browser sends its last six accepted turns, including no-match and clarification responses. Each includes the question, a bounded answer summary and the cited IDs. Rejected, stopped and failed requests do not enter this history. The backend also supplies authoritative public record titles and organizations for history IDs, in display order. A new subject replaces the prior subject; abbreviated refinements and ordinal references are resolved by the LLM. History is untrusted context, not authority to change policy. No chat database or server-side session store is added; reloading starts a new conversation.

The model receives the actual server calendar and reference intervals. This week runs Monday through today; last week is the previous Monday–Sunday. Recent news without an explicit period uses the last seven days. Historical company or incident questions without a period have unrestricted dates. The model may request clarification for unresolved references. These are model instructions, not code matching phrases.

Every answer shows archive coverage. Ask reads the current database publication, not a live news feed. Source links open the publication's Timeline; their remote contents are not fetched or independently verified by Ask.

## HTTP contract and limits

- `GET /api/config`: enabled flag, provider, model ID and display name.
- `GET /readyz`: database connectivity and a published archive; does not invoke Bedrock.
- `GET /healthz`: process health only; does not verify AWS credentials, model access or grounding.
- `POST /api/ask`: `{ "question": "…", "history": [] }`. Question: 1–900 characters after trimming. At most six history turns, each `{question, answer, record_ids}`; answer at most 1,200 characters. Unknown fields and unknown IDs are rejected. Total JSON body: at most 64 KiB.
- Success JSON includes `status`, `text`, `model_id`; accepted answers also include `answer_kind`, `matching_records`, `record_ids`, `context_turn` for the next request, and `publication_id`. Status is `answered`, `rejected`, `no_matches` or `clarification`. Answer kind is `listing`, `explanation` or `coverage`.
- Invalid input: 400; cross-origin browser request: 403; oversized body: 413; wrong content type: 415; exhausted admissions: 429; invalid model/tool output: 502; AWS failure or disabled service: 503. These errors do not substitute an archive dump.
- Default concurrency: 2; hourly admission limit: 300 per process, including rejected questions. These are not authenticated per-user quotas or cluster-wide abuse protection. Host and Origin checks are not authentication.
- Per request: one planning/scope call, at most one selection or coverage call, at most one explanation call, and one review call. At most three MCP calls read context, the catalog and full details. Output-token caps are respectively 700, 2,500 (400 for coverage), 2,000 and 500. No SDK/model retries or model repair loops.
- A 60-second budget prevents starting further inference calls. An already-running AWS call may finish later (5-second connect / 20-second read timeout). The browser stops waiting after 90 seconds. Stop aborts the browser request, but may not cancel an in-flight AWS call or its cost.

`.env.example` lists environment variables. The server does not load it automatically. `MARTIAN_ASK_ENABLED=false` disables inference; `MARTIAN_BEDROCK_MODEL_ID` is an explicit configuration choice, never a fallback. `deploy/bedrock-policy.json` limits the default workload to Kimi K2.5 inference. Deploying another model requires reviewing its tool support, pricing and IAM policy.

The cached Bedrock client enables TCP keepalive. In EKS, the independent Helm chart also sets pod-local keepalive time/interval/probes to 45 seconds / 15 seconds / 3. Both settings matter: the default Linux keepalive time is longer than AWS NAT's 350-second idle timeout, so an idle pooled connection can fail on its next use. See [AWS connection guidance](https://docs.aws.amazon.com/bedrock/latest/userguide/troubleshooting-api-error-codes.html). These transport settings do not add model retries or change the answer policy. Connection failures still return 503; process health alone does not verify Bedrock.

## Desktop chat interaction

The first submission moves the same input form below the transcript and fixes it to the desktop viewport bottom. Follow-ups, suggestion buttons and Explain incident all use the same API and history. Citations open the corresponding Timeline record; Explain incident asks for a substantive explanation within Ask. Generated text is escaped before formatting, and citations can only reference IDs from the request’s publication.

The standalone HTML embeds the same desktop assets and must be rebuilt after frontend changes. It needs the web service for both publication data and Ask. Production runs this API through the independent Helm release and dedicated Bedrock workload role. See [usage](usage.md) for checks and the [deployment guide](../../martian-helm-charts/docs/project-martian.md) for the current image and live verification evidence.
