import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Escape LIKE special characters in user input to prevent wildcard injection
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

const RATE_LIMIT_PER_MINUTE = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_PER_MINUTE) return false;
  return true;
}

function rateLimitResponse(): Response {
  return new Response(JSON.stringify({ error: "Rate limit exceeded. Maximum 60 requests per minute." }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": "60" },
  });
}

interface Env {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  // Auth env — optional. When configured, validates Bearer tokens for usage tracking
  // and per-user rate limiting. Without these, all callers are treated as anonymous free tier.
  MCP_KEY_SECRET?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

// --- Auth: HMAC-validated MCP key + Supabase plan lookup ---
// MCP keys are issued by rootsbybenda-site/functions/api/mcp-key.js using the
// SAME MCP_KEY_SECRET. Format: mcp_<base64url(user_id)>_<sha256_hmac[:32]>.
// On these public-data servers, auth is for TRACKING and REVOCATION, not tier gating.
// Unauthenticated callers get full access at free tier.

interface AuthProps extends Record<string, unknown> {
  tier: "paid" | "free";
  user_id: string | null;
  plan: string;
}

function base64urlDecodeToString(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "===".slice((b64.length + 3) % 4);
  return atob(padded);
}

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function resolveAuth(request: Request, env: Env): Promise<AuthProps> {
  const authHeader = request.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer\s+(mcp_[A-Za-z0-9_-]+_[a-f0-9]{32})\s*$/i);
  if (!match) return { tier: "free", user_id: null, plan: "anonymous" };

  const key = match[1];
  const parts = key.split("_");
  if (parts.length !== 3 || parts[0] !== "mcp") {
    return { tier: "free", user_id: null, plan: "anonymous" };
  }
  const userIdB64 = parts[1];
  const providedHmac = parts[2].toLowerCase();

  if (!env.MCP_KEY_SECRET) {
    console.error("resolveAuth: MCP_KEY_SECRET not configured");
    return { tier: "free", user_id: null, plan: "anonymous" };
  }

  let userId: string;
  try {
    userId = base64urlDecodeToString(userIdB64);
  } catch {
    return { tier: "free", user_id: null, plan: "anonymous" };
  }
  if (!userId) return { tier: "free", user_id: null, plan: "anonymous" };

  const computed = (await hmacSha256Hex(userId, env.MCP_KEY_SECRET)).slice(0, 32);
  if (!constantTimeEqual(computed, providedHmac)) {
    return { tier: "free", user_id: null, plan: "anonymous" };
  }

  // Valid HMAC — user is authenticated. Look up plan if Supabase is configured.
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return { tier: "free", user_id: userId, plan: "authenticated" };
  }

  let plan = "free";
  try {
    const profileRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=plan`,
      {
        headers: {
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        },
      }
    );
    if (profileRes.ok) {
      const profiles = (await profileRes.json()) as Array<{ plan?: string }>;
      if (profiles.length > 0 && profiles[0].plan) {
        plan = profiles[0].plan;
      }
    }
  } catch (e) {
    console.error("resolveAuth: profile lookup failed", e);
  }

  return { tier: "free", user_id: userId, plan };
}
// --- End auth ---

export class PharmaMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "twohalves-pharma-regulatory",
    version: "1.0.0",
  });

  async init() {
    // Tool 1: check_drug — Search for a drug across all pharma databases
    this.server.tool(
      "check_drug",
      "Search for a drug or medicine across all pharmaceutical databases by name, active ingredient, or CAS number. Returns results from DrugBank, WHO Essential Medicines, Australian TGA, and FDA NDI notifications.",
      {
        query: z
          .string()
          .describe(
            "Drug name, active ingredient, or CAS number (e.g. 'aspirin', 'acetaminophen', '50-78-2')"
          ),
      },
      async ({ query }) => {
        const q = query.trim();
        const qEsc = escapeLike(q);
        let text = `## Drug Lookup: "${query}"\n\n`;
        let totalResults = 0;

        // DrugBank
        const drugbank = await this.env.DB.prepare(
          `SELECT * FROM drugbank_drugs
           WHERE Drug_Name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR CAS_Number = ?
           LIMIT 10`
        )
          .bind(`%${qEsc}%`, q)
          .all();

        if (drugbank.results && drugbank.results.length > 0) {
          text += `### DrugBank (${drugbank.results.length} matches)\n`;
          for (const r of drugbank.results) {
            text += `- **${r.Drug_Name}** (${r.DrugBank_ID})\n`;
            if (r.CAS_Number) text += `  - CAS: ${r.CAS_Number}\n`;
            if (r.Drug_Groups) text += `  - Groups: ${r.Drug_Groups}\n`;
            if (r.Targets) text += `  - Targets: ${r.Targets}\n`;
            if (r.DDI_Count) text += `  - Drug-Drug Interactions: ${r.DDI_Count}\n`;
            if (r.SMILES) text += `  - SMILES: ${r.SMILES}\n`;
          }
          text += `\n`;
          totalResults += drugbank.results.length;
        }

        // WHO Essential Medicines
        const who = await this.env.DB.prepare(
          `SELECT * FROM who_essential_medicines
           WHERE medicine_name LIKE ? ESCAPE '\\' COLLATE NOCASE
           LIMIT 10`
        )
          .bind(`%${qEsc}%`)
          .all();

        if (who.results && who.results.length > 0) {
          text += `### WHO Essential Medicines (${who.results.length} matches)\n`;
          for (const r of who.results) {
            text += `- **${r.medicine_name}**\n`;
            if (r.atc_code) text += `  - ATC Code: ${r.atc_code}\n`;
            if (r.eml_section) text += `  - EML Section: ${r.eml_section}\n`;
            if (r.formulations) text += `  - Formulations: ${r.formulations}\n`;
            if (r.indication) text += `  - Indication: ${r.indication}\n`;
            if (r.typical_dosage_range) text += `  - Dosage: ${r.typical_dosage_range}\n`;
            if (r.key_contraindications) text += `  - Contraindications: ${r.key_contraindications}\n`;
            if (r.pregnancy_safety_category) text += `  - Pregnancy safety: ${r.pregnancy_safety_category}\n`;
            if (r.adult_pediatric) text += `  - Population: ${r.adult_pediatric}\n`;
            if (r.complementary_list) text += `  - Complementary list: ${r.complementary_list}\n`;
          }
          text += `\n`;
          totalResults += who.results.length;
        }

        // TGA ARTG Medicines
        const tga = await this.env.DB.prepare(
          `SELECT * FROM tga_artg_medicines
           WHERE product_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR active_ingredient LIKE ? ESCAPE '\\' COLLATE NOCASE
           LIMIT 10`
        )
          .bind(`%${qEsc}%`, `%${qEsc}%`)
          .all();

        if (tga.results && tga.results.length > 0) {
          text += `### Australian TGA ARTG (${tga.results.length} matches)\n`;
          for (const r of tga.results) {
            text += `- **${r.product_name}** (ARTG ID: ${r.artg_id})\n`;
            if (r.active_ingredient) text += `  - Active ingredient: ${r.active_ingredient}\n`;
            if (r.active_ingredient_strength) text += `  - Strength: ${r.active_ingredient_strength}\n`;
            if (r.sponsor_name) text += `  - Sponsor: ${r.sponsor_name}\n`;
            if (r.product_category) text += `  - Category: ${r.product_category}\n`;
            if (r.schedule) text += `  - Schedule: ${r.schedule}\n`;
            if (r.status) text += `  - Status: ${r.status}\n`;
            if (r.dosage_form) text += `  - Dosage form: ${r.dosage_form}\n`;
            if (r.route_of_administration) text += `  - Route: ${r.route_of_administration}\n`;
            if (r.indications) text += `  - Indications: ${r.indications}\n`;
          }
          text += `\n`;
          totalResults += tga.results.length;
        }

        // FDA NDI Notifications
        const ndi = await this.env.DB.prepare(
          `SELECT * FROM fda_ndi_notifications
           WHERE new_dietary_ingredient_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR cas_number = ?
           LIMIT 10`
        )
          .bind(`%${qEsc}%`, q)
          .all();

        if (ndi.results && ndi.results.length > 0) {
          text += `### FDA NDI Notifications (${ndi.results.length} matches)\n`;
          for (const r of ndi.results) {
            text += `- **${r.new_dietary_ingredient_name}** (NDI #${r.ndi_number})\n`;
            if (r.cas_number) text += `  - CAS: ${r.cas_number}\n`;
            if (r.fda_response_type) text += `  - FDA Response: ${r.fda_response_type}\n`;
            if (r.intended_conditions_of_use) text += `  - Intended use: ${r.intended_conditions_of_use}\n`;
            if (r.firm_notifier) text += `  - Notifier: ${r.firm_notifier}\n`;
          }
          text += `\n`;
          totalResults += ndi.results.length;
        }

        if (totalResults === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No drug records found for "${query}" across DrugBank, WHO Essential Medicines, Australian TGA, or FDA NDI databases. Try alternative names, generic names, or CAS numbers.`,
              },
            ],
          };
        }

        text += `---\n*${totalResults} total results across all pharmaceutical databases*`;
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // Tool 2: check_drug_interactions — Query drug-drug interactions
    this.server.tool(
      "check_drug_interactions",
      "Check drug-drug interactions. Provide one drug name to find all its known interactions, or two drug names to check for a specific interaction. Returns severity, mechanism, clinical effects, and management recommendations.",
      {
        drug: z
          .string()
          .describe(
            "Primary drug name (e.g. 'warfarin', 'metformin', 'lisinopril')"
          ),
        second_drug: z
          .string()
          .optional()
          .describe(
            "Optional second drug name to check for a specific interaction pair (e.g. 'aspirin')"
          ),
      },
      async ({ drug, second_drug }) => {
        const d = drug.trim();
        const dEsc = escapeLike(d);

        if (second_drug) {
          const d2 = second_drug.trim();
          const d2Esc = escapeLike(d2);

          const { results } = await this.env.DB.prepare(
            `SELECT * FROM drug_interactions
             WHERE (drug_1_name LIKE ? ESCAPE '\\' COLLATE NOCASE AND drug_2_name LIKE ? ESCAPE '\\' COLLATE NOCASE)
                OR (drug_1_name LIKE ? ESCAPE '\\' COLLATE NOCASE AND drug_2_name LIKE ? ESCAPE '\\' COLLATE NOCASE)
             ORDER BY severity DESC
             LIMIT 50`
          )
            .bind(`%${dEsc}%`, `%${d2Esc}%`, `%${d2Esc}%`, `%${dEsc}%`)
            .all();

          if (!results || results.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No known interaction found between "${drug}" and "${second_drug}". This does not mean no interaction exists — only that it was not found in our database of 5,000 documented interactions.`,
                },
              ],
            };
          }

          let text = `## Drug Interaction: ${drug} + ${second_drug}\n\n`;
          for (const r of results) {
            text += `- **${r.drug_1_name}** (${r.drug_1_class || "N/A"}) + **${r.drug_2_name}** (${r.drug_2_class || "N/A"})\n`;
            if (r.severity) text += `  - Severity: **${r.severity}**\n`;
            if (r.interaction_mechanism) text += `  - Mechanism: ${r.interaction_mechanism}\n`;
            if (r.clinical_effect) text += `  - Clinical effect: ${r.clinical_effect}\n`;
            if (r.management_recommendation) text += `  - Management: ${r.management_recommendation}\n`;
            if (r.evidence_level) text += `  - Evidence level: ${r.evidence_level}\n`;
          }
          text += `\n*${results.length} interaction(s) found*`;

          return { content: [{ type: "text" as const, text }] };
        }

        // Single drug — find all interactions
        const { results } = await this.env.DB.prepare(
          `SELECT * FROM drug_interactions
           WHERE drug_1_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR drug_2_name LIKE ? ESCAPE '\\' COLLATE NOCASE
           ORDER BY severity DESC
           LIMIT 50`
        )
          .bind(`%${dEsc}%`, `%${dEsc}%`)
          .all();

        if (!results || results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No known interactions found for "${drug}" in our database of 5,000 documented drug-drug interactions. Try the generic drug name.`,
              },
            ],
          };
        }

        let text = `## Drug Interactions: ${drug}\n\n`;

        // Group by severity
        const bySeverity: Record<string, any[]> = {};
        for (const r of results) {
          const sev = (r.severity as string) || "Unknown";
          if (!bySeverity[sev]) bySeverity[sev] = [];
          bySeverity[sev].push(r);
        }

        for (const [sev, items] of Object.entries(bySeverity)) {
          text += `### Severity: ${sev} (${items.length})\n`;
          for (const r of items) {
            const otherDrug = (r.drug_1_name as string || "").toLowerCase().includes(d.toLowerCase())
              ? r.drug_2_name
              : r.drug_1_name;
            text += `- **${otherDrug}** (${r.drug_2_class || r.drug_1_class || "N/A"})\n`;
            if (r.interaction_mechanism) text += `  - Mechanism: ${r.interaction_mechanism}\n`;
            if (r.clinical_effect) text += `  - Effect: ${r.clinical_effect}\n`;
            if (r.management_recommendation) text += `  - Management: ${r.management_recommendation}\n`;
          }
          text += `\n`;
        }

        text += `---\n*${results.length} interactions found*`;
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // Tool 3: check_adverse_events — Query FDA FAERS adverse event data
    this.server.tool(
      "check_adverse_events",
      "Check FDA adverse event reports (FAERS) for a drug. Returns total reports, serious outcomes, death reports, top adverse reactions, and most common patient age group.",
      {
        query: z
          .string()
          .describe(
            "Drug name or active ingredient (e.g. 'ibuprofen', 'acetaminophen', 'metformin')"
          ),
      },
      async ({ query }) => {
        const q = query.trim();
        const qEsc = escapeLike(q);

        const { results } = await this.env.DB.prepare(
          `SELECT * FROM fda_faers_top_drugs
           WHERE drug_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR active_ingredient LIKE ? ESCAPE '\\' COLLATE NOCASE
           LIMIT 20`
        )
          .bind(`%${qEsc}%`, `%${qEsc}%`)
          .all();

        if (!results || results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No FDA adverse event data found for "${query}". Try the generic drug name or active ingredient name.`,
              },
            ],
          };
        }

        let text = `## FDA Adverse Event Reports (FAERS): "${query}"\n\n`;
        for (const r of results) {
          text += `### ${r.drug_name}${r.rank ? ` (Rank #${r.rank})` : ""}\n`;
          if (r.active_ingredient) text += `- **Active ingredient:** ${r.active_ingredient}\n`;
          if (r.total_reports) text += `- **Total reports:** ${r.total_reports}\n`;
          if (r.serious_outcome_reports) text += `- **Serious outcomes:** ${r.serious_outcome_reports}\n`;
          if (r.death_reports) text += `- **Death reports:** ${r.death_reports}\n`;
          if (r.top_10_adverse_reactions) text += `- **Top adverse reactions:** ${r.top_10_adverse_reactions}\n`;
          if (r.most_common_patient_age_group) text += `- **Most common age group:** ${r.most_common_patient_age_group}\n`;
          text += `\n`;
        }

        text += `*${results.length} drug(s) found in FAERS database*`;
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // Tool 4: search_pharma — Full-text search across ALL pharma tables
    this.server.tool(
      "search_pharma",
      "Full-text search across all pharmaceutical databases: DrugBank, WHO Essential Medicines, Australian TGA, FDA adverse events, FDA NDI notifications, drug interactions, and ChEMBL bioactivity data.",
      {
        query: z
          .string()
          .describe(
            "Search term (e.g. 'diabetes', 'antibiotic', 'cancer', 'pregnancy', 'hepatotoxicity')"
          ),
      },
      async ({ query }) => {
        const q = query.trim();
        const qEsc = escapeLike(q);
        let text = `## Pharma Search Results: "${query}"\n\n`;
        let totalResults = 0;

        // DrugBank
        const drugbank = await this.env.DB.prepare(
          `SELECT * FROM drugbank_drugs
           WHERE Drug_Name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR Drug_Groups LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR Targets LIKE ? ESCAPE '\\' COLLATE NOCASE
           LIMIT 20`
        )
          .bind(`%${qEsc}%`, `%${qEsc}%`, `%${qEsc}%`)
          .all();

        if (drugbank.results && drugbank.results.length > 0) {
          text += `### DrugBank (${drugbank.results.length} matches)\n`;
          for (const r of drugbank.results) {
            text += `- **${r.Drug_Name}** (${r.DrugBank_ID}) — ${r.Drug_Groups || "N/A"}`;
            if (r.CAS_Number) text += ` | CAS: ${r.CAS_Number}`;
            text += `\n`;
          }
          text += `\n`;
          totalResults += drugbank.results.length;
        }

        // WHO Essential Medicines
        const who = await this.env.DB.prepare(
          `SELECT * FROM who_essential_medicines
           WHERE medicine_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR indication LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR eml_section LIKE ? ESCAPE '\\' COLLATE NOCASE
           LIMIT 20`
        )
          .bind(`%${qEsc}%`, `%${qEsc}%`, `%${qEsc}%`)
          .all();

        if (who.results && who.results.length > 0) {
          text += `### WHO Essential Medicines (${who.results.length} matches)\n`;
          for (const r of who.results) {
            text += `- **${r.medicine_name}** — ${r.eml_section || "N/A"}`;
            if (r.indication) text += ` | ${r.indication}`;
            text += `\n`;
          }
          text += `\n`;
          totalResults += who.results.length;
        }

        // TGA ARTG
        const tga = await this.env.DB.prepare(
          `SELECT * FROM tga_artg_medicines
           WHERE product_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR active_ingredient LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR indications LIKE ? ESCAPE '\\' COLLATE NOCASE
           LIMIT 20`
        )
          .bind(`%${qEsc}%`, `%${qEsc}%`, `%${qEsc}%`)
          .all();

        if (tga.results && tga.results.length > 0) {
          text += `### Australian TGA ARTG (${tga.results.length} matches)\n`;
          for (const r of tga.results) {
            text += `- **${r.product_name}** (ARTG: ${r.artg_id}) — ${r.active_ingredient || "N/A"}`;
            if (r.schedule) text += ` | Schedule: ${r.schedule}`;
            text += `\n`;
          }
          text += `\n`;
          totalResults += tga.results.length;
        }

        // FDA FAERS
        const faers = await this.env.DB.prepare(
          `SELECT * FROM fda_faers_top_drugs
           WHERE drug_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR active_ingredient LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR top_10_adverse_reactions LIKE ? ESCAPE '\\' COLLATE NOCASE
           LIMIT 20`
        )
          .bind(`%${qEsc}%`, `%${qEsc}%`, `%${qEsc}%`)
          .all();

        if (faers.results && faers.results.length > 0) {
          text += `### FDA FAERS Adverse Events (${faers.results.length} matches)\n`;
          for (const r of faers.results) {
            text += `- **${r.drug_name}** — ${r.total_reports || "N/A"} reports`;
            if (r.death_reports) text += ` | ${r.death_reports} deaths`;
            text += `\n`;
          }
          text += `\n`;
          totalResults += faers.results.length;
        }

        // Drug Interactions
        const interactions = await this.env.DB.prepare(
          `SELECT * FROM drug_interactions
           WHERE drug_1_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR drug_2_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR interaction_mechanism LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR clinical_effect LIKE ? ESCAPE '\\' COLLATE NOCASE
           ORDER BY severity DESC
           LIMIT 20`
        )
          .bind(`%${qEsc}%`, `%${qEsc}%`, `%${qEsc}%`, `%${qEsc}%`)
          .all();

        if (interactions.results && interactions.results.length > 0) {
          text += `### Drug Interactions (${interactions.results.length} matches)\n`;
          for (const r of interactions.results) {
            text += `- **${r.drug_1_name}** + **${r.drug_2_name}** — Severity: ${r.severity || "N/A"}`;
            if (r.clinical_effect) text += ` | ${r.clinical_effect}`;
            text += `\n`;
          }
          text += `\n`;
          totalResults += interactions.results.length;
        }

        // FDA NDI
        const ndi = await this.env.DB.prepare(
          `SELECT * FROM fda_ndi_notifications
           WHERE new_dietary_ingredient_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR intended_conditions_of_use LIKE ? ESCAPE '\\' COLLATE NOCASE
           LIMIT 20`
        )
          .bind(`%${qEsc}%`, `%${qEsc}%`)
          .all();

        if (ndi.results && ndi.results.length > 0) {
          text += `### FDA NDI Notifications (${ndi.results.length} matches)\n`;
          for (const r of ndi.results) {
            text += `- **${r.new_dietary_ingredient_name}** (NDI #${r.ndi_number}) — FDA: ${r.fda_response_type || "N/A"}`;
            if (r.firm_notifier) text += ` | ${r.firm_notifier}`;
            text += `\n`;
          }
          text += `\n`;
          totalResults += ndi.results.length;
        }

        // ChEMBL Bioactivity
        const chembl = await this.env.DB.prepare(
          `SELECT * FROM chembl_bioactivity
           WHERE molecule_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR target_name LIKE ? ESCAPE '\\' COLLATE NOCASE
           LIMIT 20`
        )
          .bind(`%${qEsc}%`, `%${qEsc}%`)
          .all();

        if (chembl.results && chembl.results.length > 0) {
          text += `### ChEMBL Bioactivity (${chembl.results.length} matches)\n`;
          for (const r of chembl.results) {
            text += `- **${r.molecule_name || "N/A"}** → ${r.target_name || "N/A"}`;
            if (r.activity_type) text += ` | ${r.activity_type}: ${r.activity_value || "N/A"} ${r.activity_units || ""}`;
            text += `\n`;
          }
          text += `\n`;
          totalResults += chembl.results.length;
        }

        if (totalResults === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No results found for "${query}" across any pharmaceutical database. Try alternative terms, generic names, or broader searches.`,
              },
            ],
          };
        }

        text += `---\n*${totalResults} total results across all pharmaceutical databases*`;
        return { content: [{ type: "text" as const, text }] };
      }
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Resolve auth early — use user_id for rate limiting when authenticated (better for shared IPs)
    let auth: AuthProps | null = null;
    const isDataEndpoint = url.pathname === "/mcp" || url.pathname === "/sse" || url.pathname.startsWith("/sse/") || (request.method === "POST" && url.pathname === "/");
    if (isDataEndpoint) {
      auth = await resolveAuth(request, env);
      const rateLimitKey = auth.user_id || request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
      if (!checkRateLimit(rateLimitKey)) {
        return rateLimitResponse();
      }
    }

    if (url.pathname === "/.well-known/mcp/server-card.json") {
      return Response.json({
        "$schema": "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
        "version": "1.0",
        "protocolVersion": "2025-06-18",
        "serverInfo": { "name": "pharma-mcp-server", "title": "Two Halves Pharmaceutical Regulatory Intelligence", "version": "1.0.0" },
        "description": "Pharmaceutical regulatory MCP — drug interactions, adverse events, GHS",
        "iconUrl": "https://rootsbybenda.com/icon.png",
        "documentationUrl": "https://rootsbybenda.com",
        "transport": { "type": "streamable-http", "endpoint": "/mcp" },
        "capabilities": { "tools": { "listChanged": true }, "resources": { "subscribe": false, "listChanged": false } },
        "authentication": { "required": false, "schemes": ["bearer"], "note": "Optional API key enables higher rate limits and usage tracking" },
        "rateLimit": { "requestsPerMinute": 60, "enforcement": "per-ip-or-user" },
        "tools": ["dynamic"]
      }, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" } });
    }

    // Resolve auth and set on ctx.props for MCP transport endpoints
    if (url.pathname === "/sse" || url.pathname.startsWith("/sse/") || url.pathname === "/mcp") {
      if (!auth) auth = await resolveAuth(request, env);
      (ctx as ExecutionContext & { props?: AuthProps }).props = auth;
    }

    // SSE transport (legacy clients)
    if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
      return PharmaMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    // Streamable HTTP transport (new spec)
    if (url.pathname === "/mcp") {
      return PharmaMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response(
      JSON.stringify({
        name: "Two Halves — Pharmaceutical Regulatory Intelligence",
        version: "1.0.0",
        description:
          "Comprehensive pharmaceutical intelligence: drug lookups across DrugBank, WHO Essential Medicines, and Australian TGA. Drug-drug interaction checking with severity and management. FDA adverse event reports (FAERS). Full-text search across 7 pharmaceutical databases including ChEMBL bioactivity and FDA NDI notifications.",
        mcp_endpoint: "/mcp",
        tools: [
          "check_drug",
          "check_drug_interactions",
          "check_adverse_events",
          "search_pharma",
        ],
        data: {
          tga_artg_medicines: "23,259 Australian registered medicines",
          drugbank_drugs: "4,947 drug compounds with targets",
          who_essential_medicines: "782 WHO essential medicines",
          drug_interactions: "5,000 drug-drug interactions",
          fda_faers_top_drugs: "2,000 FDA adverse event reports",
          fda_ndi_notifications: "1,330 FDA new dietary ingredient notifications",
          chembl_bioactivity: "7,941 bioactivity records",
        },
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  },
};
