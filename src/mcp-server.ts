// MCP server for voxnos — FreeClimb telephony management, D1 queries, observability.
// Follows cognos pattern: createServer(env) returns a configured McpServer instance.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./engine/types.js";
import { freeclimbAuth } from "./telephony/freeclimb-admin.js";
import { registry } from "./engine/registry.js";
import { listAppDefinitions, loadPhoneRoutes, savePhoneRoute, listAllowedCallers, addAllowedCaller, removeAllowedCaller } from "./services/app-store.js";
import { listCallRecords, getCallRecord, getCallTurns } from "./services/cdr-store.js";
import { listSurveyResults } from "./services/survey-store.js";
import { reloadAllowedCallers } from "./services/caller-allowlist.js";

/** Create and configure a fresh MCP server (one per request) */
export function createServer(env: Env): McpServer {
  const server = new McpServer({
    name: "voxnos",
    version: "1.0.0",
  });

  // --- health ---
  server.tool(
    "health",
    "Check if the voxnos voice platform is running",
    {},
    async () => ({
      content: [{ type: "text" as const, text: "voxnos running" }],
    })
  );

  // --- costs ---
  server.tool(
    "costs",
    "Get a 14-day summary of voxnos Anthropic API token usage and request counts, broken down by day.",
    {},
    async () => {
      const days: Array<{ date: string; input_tokens: number; output_tokens: number; requests: number }> = [];
      for (let i = 0; i < 14; i++) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - i);
        const date = d.toISOString().split("T")[0];
        const val = await env.RATE_LIMIT_KV.get(`costs:voxnos:${date}`, "json") as {
          input_tokens: number;
          output_tokens: number;
          requests: number;
        } | null;
        days.push({
          date,
          input_tokens: val?.input_tokens ?? 0,
          output_tokens: val?.output_tokens ?? 0,
          requests: val?.requests ?? 0,
        });
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ service: "voxnos", days }, null, 2) }],
      };
    }
  );

  // --- account ---
  server.tool(
    "account",
    "Get FreeClimb account information including account status and configuration.",
    {},
    async () => {
      const { auth, apiBase } = freeclimbAuth(env);
      try {
        const response = await fetch(`${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (!response.ok) {
          return { content: [{ type: "text" as const, text: `FreeClimb API error: ${response.status}` }], isError: true };
        }
        const data = await response.json();
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed to fetch account: ${err}` }], isError: true };
      }
    }
  );

  // --- numbers ---
  server.tool(
    "numbers",
    "List all phone numbers owned by the voxnos FreeClimb account, including their aliases and application assignments.",
    {},
    async () => {
      const { auth, apiBase } = freeclimbAuth(env);
      try {
        const response = await fetch(`${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/IncomingPhoneNumbers`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (!response.ok) {
          return { content: [{ type: "text" as const, text: `FreeClimb API error: ${response.status}` }], isError: true };
        }
        const data = await response.json() as {
          incomingPhoneNumbers: Array<{
            phoneNumberId: string;
            phoneNumber: string;
            alias: string;
            applicationId?: string;
          }>;
        };
        const numbers = (data.incomingPhoneNumbers || []).map(n => ({
          id: n.phoneNumberId,
          number: n.phoneNumber,
          alias: n.alias,
          applicationId: n.applicationId,
        }));
        const lines = numbers.map((n, i) =>
          `${i + 1}. **${n.number}**${n.alias ? ` — ${n.alias}` : ""}\n   ID: ${n.id}`
        );
        return {
          content: [{ type: "text" as const, text: `${numbers.length} phone number(s):\n\n${lines.join("\n\n")}` }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed to fetch numbers: ${err}` }], isError: true };
      }
    }
  );

  // --- available_numbers ---
  server.tool(
    "available_numbers",
    "Search for available phone numbers to purchase from FreeClimb, filtered by US state/region.",
    {
      region: z.string().optional().describe("US state code to filter by (e.g. 'FL', 'TX', 'NY')"),
    },
    async ({ region }) => {
      const { auth, apiBase } = freeclimbAuth(env);
      try {
        const searchUrl = new URL(`${apiBase}/AvailablePhoneNumbers`);
        if (region) searchUrl.searchParams.set("region", region);
        searchUrl.searchParams.set("capabilities.voice", "true");

        const response = await fetch(searchUrl.toString(), {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (!response.ok) {
          return { content: [{ type: "text" as const, text: `FreeClimb API error: ${response.status}` }], isError: true };
        }
        const data = await response.json() as {
          total: number;
          availablePhoneNumbers: Array<{
            phoneNumber: string;
            region: string;
            country: string;
          }>;
        };
        const numbers = data.availablePhoneNumbers || [];
        if (!numbers.length) {
          return { content: [{ type: "text" as const, text: "No available numbers found." }] };
        }
        const lines = numbers.map((n, i) =>
          `${i + 1}. ${n.phoneNumber} — ${n.region}, ${n.country}`
        );
        return {
          content: [{ type: "text" as const, text: `${data.total} available (showing ${numbers.length}):\n\n${lines.join("\n")}` }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Search failed: ${err}` }], isError: true };
      }
    }
  );

  // --- logs ---
  server.tool(
    "logs",
    "Fetch recent FreeClimb call logs.",
    {
      limit: z.number().min(1).max(100).optional().describe("Max log entries to return (default 20)"),
    },
    async ({ limit }) => {
      const { auth, apiBase } = freeclimbAuth(env);
      try {
        const response = await fetch(`${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/Calls?maxSize=${limit ?? 20}`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (!response.ok) {
          return { content: [{ type: "text" as const, text: `FreeClimb API error: ${response.status}` }], isError: true };
        }
        const data = await response.json();
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed to fetch logs: ${err}` }], isError: true };
      }
    }
  );

  // --- buy_number ---
  server.tool(
    "buy_number",
    "Purchase a phone number from FreeClimb and assign it to the Voxnos Platform application. WARNING: This incurs real telephony costs. Always confirm the number and intent with the user before executing.",
    {
      phone_number: z.string().describe("The phone number to purchase in E.164 format (e.g. '+14075551234')"),
    },
    async ({ phone_number }) => {
      const { auth, apiBase } = freeclimbAuth(env);
      try {
        // Find the Voxnos Platform application
        const appsResponse = await fetch(`${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/Applications`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (!appsResponse.ok) {
          return { content: [{ type: "text" as const, text: "Failed to fetch applications" }], isError: true };
        }
        const appsData = await appsResponse.json() as {
          applications: Array<{ applicationId: string; alias: string }>;
        };
        const voxnosApp = (appsData.applications || []).find(a => a.alias === "Voxnos Platform");
        if (!voxnosApp) {
          return { content: [{ type: "text" as const, text: "Voxnos Platform application not found. Run /setup first." }], isError: true };
        }

        // Buy the number
        const buyResponse = await fetch(
          `${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/IncomingPhoneNumbers`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${auth}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              phoneNumber: phone_number,
              applicationId: voxnosApp.applicationId,
            }),
          }
        );
        if (!buyResponse.ok) {
          const error = await buyResponse.text();
          return { content: [{ type: "text" as const, text: `Failed to buy number: ${error}` }], isError: true };
        }
        const purchased = await buyResponse.json() as {
          phoneNumberId: string;
          phoneNumber: string;
          applicationId: string;
        };
        return {
          content: [{
            type: "text" as const,
            text: `Purchased **${purchased.phoneNumber}** and assigned to Voxnos Platform.\nID: ${purchased.phoneNumberId}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Buy failed: ${err}` }], isError: true };
      }
    }
  );

  // --- route_number ---
  server.tool(
    "route_number",
    "Assign a phone number to a specific voice app in the D1 routing table. The number will be routed to this app on the next incoming call.",
    {
      phone_number: z.string().describe("The phone number in E.164 format (e.g. '+14075551234')"),
      app_id: z.string().describe("The app ID to route calls to (e.g. 'ava', 'rita', 'coco')"),
      label: z.string().optional().describe("Optional human-readable label for the route"),
    },
    async ({ phone_number, app_id, label }) => {
      if (!env.DB) {
        return { content: [{ type: "text" as const, text: "D1 database not configured" }], isError: true };
      }
      const saved = await savePhoneRoute(env.DB, {
        phoneNumber: phone_number,
        appId: app_id,
        label,
      });
      if (!saved) {
        return { content: [{ type: "text" as const, text: "Failed to save phone route" }], isError: true };
      }
      registry.setPhoneRoute(phone_number, app_id);
      return {
        content: [{
          type: "text" as const,
          text: `Routed **${phone_number}** → **${app_id}**${label ? ` (${label})` : ""}`,
        }],
      };
    }
  );

  // --- apps ---
  server.tool(
    "apps",
    "List all voice app definitions from the D1 database, including their type (conversational/survey), active status, and configuration.",
    {},
    async () => {
      if (!env.DB) {
        return { content: [{ type: "text" as const, text: "D1 database not configured" }], isError: true };
      }
      const definitions = await listAppDefinitions(env.DB);
      if (!definitions.length) {
        return { content: [{ type: "text" as const, text: "No app definitions found." }] };
      }
      const lines = definitions.map((d, i) => {
        const status = d.active ? "active" : "inactive";
        const def = d.is_default ? " (default)" : "";
        return `${i + 1}. **${d.name}** (\`${d.id}\`) — ${d.type}, ${status}${def}`;
      });
      return {
        content: [{ type: "text" as const, text: `${definitions.length} app(s):\n\n${lines.join("\n")}` }],
      };
    }
  );

  // --- phone_routes ---
  server.tool(
    "phone_routes",
    "List all phone number to app routing rules from the D1 database.",
    {},
    async () => {
      if (!env.DB) {
        return { content: [{ type: "text" as const, text: "D1 database not configured" }], isError: true };
      }
      const routes = await loadPhoneRoutes(env.DB);
      if (!routes.length) {
        return { content: [{ type: "text" as const, text: "No phone routes configured." }] };
      }
      const lines = routes.map((r, i) => {
        const label = r.label ? ` (${r.label})` : "";
        return `${i + 1}. **${r.phone_number}** → \`${r.app_id}\`${label}`;
      });
      return {
        content: [{ type: "text" as const, text: `${routes.length} route(s):\n\n${lines.join("\n")}` }],
      };
    }
  );

  // --- calls ---
  server.tool(
    "calls",
    "List call records from the D1 database with optional filtering by app, date range, and caller.",
    {
      app_id: z.string().optional().describe("Filter by app ID (e.g. 'ava', 'rita')"),
      days: z.number().min(1).max(365).optional().describe("Only include calls from the last N days (default 7)"),
      limit: z.number().min(1).max(100).optional().describe("Max results to return (default 20)"),
    },
    async ({ app_id, days, limit }) => {
      if (!env.DB) {
        return { content: [{ type: "text" as const, text: "D1 database not configured" }], isError: true };
      }
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - (days ?? 7));

      const records = await listCallRecords(env.DB, {
        appId: app_id,
        from: cutoff.toISOString(),
        limit: limit ?? 20,
      });
      if (!records.length) {
        return { content: [{ type: "text" as const, text: "No calls found matching those filters." }] };
      }
      const lines = records.map((r, i) => {
        const date = r.started_at.slice(0, 16).replace("T", " ");
        const duration = r.duration_ms ? `${Math.round(r.duration_ms / 1000)}s` : "in progress";
        return `${i + 1}. **${r.caller}** → \`${r.app_id}\` — ${date} (${duration}, ${r.turn_count} turns)\n   Call ID: \`${r.call_id}\` · Outcome: ${r.outcome}`;
      });
      return {
        content: [{ type: "text" as const, text: `${records.length} call(s):\n\n${lines.join("\n\n")}` }],
      };
    }
  );

  // --- call_detail ---
  server.tool(
    "call_detail",
    "Get detailed information about a specific call, including the full turn-by-turn transcript.",
    {
      call_id: z.string().describe("The FreeClimb call ID"),
    },
    async ({ call_id }) => {
      if (!env.DB) {
        return { content: [{ type: "text" as const, text: "D1 database not configured" }], isError: true };
      }
      const record = await getCallRecord(env.DB, call_id);
      if (!record) {
        return { content: [{ type: "text" as const, text: `Call ${call_id} not found.` }] };
      }
      const turns = await getCallTurns(env.DB, call_id);

      const header = [
        `**Call ID**: \`${record.call_id}\``,
        `**App**: \`${record.app_id}\``,
        `**Caller**: ${record.caller} → ${record.callee}`,
        `**Started**: ${record.started_at}`,
        `**Duration**: ${record.duration_ms ? `${Math.round(record.duration_ms / 1000)}s` : "in progress"}`,
        `**Outcome**: ${record.outcome}`,
        `**Turns**: ${record.turn_count}`,
        `**Tokens**: ${record.total_input_tokens} in / ${record.total_output_tokens} out`,
      ].join("\n");

      if (!turns.length) {
        return { content: [{ type: "text" as const, text: header + "\n\nNo turns recorded." }] };
      }

      const transcript = turns.map(t => {
        const speaker = t.speaker === "caller" ? "Caller" : "Assistant";
        return `**${speaker}**: ${t.content ?? "(no content)"}`;
      }).join("\n");

      return {
        content: [{ type: "text" as const, text: `${header}\n\n---\n**Transcript:**\n\n${transcript}` }],
      };
    }
  );

  // --- surveys ---
  server.tool(
    "surveys",
    "List completed survey results from the D1 database, with optional filtering by survey ID.",
    {
      survey_id: z.string().optional().describe("Filter by survey ID"),
      limit: z.number().min(1).max(100).optional().describe("Max results to return (default 20)"),
    },
    async ({ survey_id, limit }) => {
      if (!env.DB) {
        return { content: [{ type: "text" as const, text: "D1 database not configured" }], isError: true };
      }
      const results = await listSurveyResults(env.DB, {
        surveyId: survey_id,
        limit: limit ?? 20,
      });
      if (!results.length) {
        return { content: [{ type: "text" as const, text: "No survey results found." }] };
      }
      const lines = results.map((r, i) => {
        const date = r.completed_at.slice(0, 16).replace("T", " ");
        return `${i + 1}. **${r.survey_id}** — ${r.caller} · ${date}\n   ${r.summary}`;
      });
      return {
        content: [{ type: "text" as const, text: `${results.length} survey result(s):\n\n${lines.join("\n\n")}` }],
      };
    }
  );

  // --- allowed_callers ---
  server.tool(
    "allowed_callers",
    "List allowed callers. Each inbound phone number has its own allowlist. When a number has no entries, all callers can reach it.",
    {
      inbound_number: z.string().optional().describe("Filter by inbound number in E.164 format. Omit to see all."),
    },
    async ({ inbound_number }) => {
      if (!env.DB) {
        return { content: [{ type: "text" as const, text: "D1 database not configured" }], isError: true };
      }
      const callers = await listAllowedCallers(env.DB, inbound_number);
      if (!callers.length) {
        const scope = inbound_number ? `for ${inbound_number}` : "";
        return { content: [{ type: "text" as const, text: `No allowlist entries ${scope}— all callers are permitted.` }] };
      }
      const lines = callers.map((c, i) => {
        const label = c.label ? ` — ${c.label}` : "";
        return `${i + 1}. **${c.inbound_number}** ← ${c.caller_number}${label}`;
      });
      return {
        content: [{ type: "text" as const, text: `${callers.length} allowlist entry/entries:\n\n${lines.join("\n")}` }],
      };
    }
  );

  // --- allow_caller ---
  server.tool(
    "allow_caller",
    "Add a caller to the allowlist for a specific inbound number. Once a number has any entries, only listed callers can reach it.",
    {
      inbound_number: z.string().describe("The inbound phone number to protect, in E.164 format"),
      caller_number: z.string().describe("The caller phone number to allow, in E.164 format"),
      label: z.string().optional().describe("Optional label for this caller (e.g. 'Joe', 'Mom')"),
    },
    async ({ inbound_number, caller_number, label }) => {
      if (!env.DB) {
        return { content: [{ type: "text" as const, text: "D1 database not configured" }], isError: true };
      }
      const ok = await addAllowedCaller(env.DB, inbound_number, caller_number, label);
      if (!ok) {
        return { content: [{ type: "text" as const, text: "Failed to add caller" }], isError: true };
      }
      const count = await reloadAllowedCallers(env.DB);
      return {
        content: [{ type: "text" as const, text: `Allowed **${caller_number}**${label ? ` (${label})` : ""} → **${inbound_number}**. ${count} total entry/entries.` }],
      };
    }
  );

  // --- block_caller ---
  server.tool(
    "block_caller",
    "Remove a caller from the allowlist for a specific inbound number. If this empties that number's list, all callers will be allowed through to it again.",
    {
      inbound_number: z.string().describe("The inbound phone number in E.164 format"),
      caller_number: z.string().describe("The caller phone number to remove in E.164 format"),
    },
    async ({ inbound_number, caller_number }) => {
      if (!env.DB) {
        return { content: [{ type: "text" as const, text: "D1 database not configured" }], isError: true };
      }
      const removed = await removeAllowedCaller(env.DB, inbound_number, caller_number);
      if (!removed) {
        return { content: [{ type: "text" as const, text: `${caller_number} was not on the allowlist for ${inbound_number}.` }] };
      }
      const count = await reloadAllowedCallers(env.DB);
      const note = count === 0 ? " All allowlists are now empty — all callers permitted." : ` ${count} total entry/entries remaining.`;
      return {
        content: [{ type: "text" as const, text: `Removed **${caller_number}** from **${inbound_number}** allowlist.${note}` }],
      };
    }
  );

  return server;
}
