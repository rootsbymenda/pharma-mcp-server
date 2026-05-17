import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

// Escape LIKE special characters in user input to prevent wildcard injection
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

const INSTRUCTION_LIKE_MARKDOWN_PATTERNS = [
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+)?(?:previous|prior|above|earlier|system|developer|user)?\s*(?:instructions?|prompts?|messages?|rules?)\b[^.;!?]*/gi,
  /\b(?:system|developer|assistant|user)\s*(?:prompt|message|instruction|role)\s*:[^.;!?]*/gi,
  /\b(?:you are now|act as|pretend to be|from now on|follow these instructions|do not obey|reveal hidden|print hidden|exfiltrate|tool call|call the tool)\b[^.;!?]*/gi,
  /<\s*\/?\s*(?:system|developer|assistant|user|instructions?)\s*>/gi,
];

function sanitizeMarkdown(text: unknown): string {
  let sanitized = String(text ?? "");
  sanitized = sanitized.replace(/```[\s\S]*?```/g, " ");
  sanitized = sanitized.replace(/```+/g, " ");
  sanitized = sanitized.replace(/[\r\n]+/g, " ");
  sanitized = sanitized.replace(/#/g, "");
  for (const pattern of INSTRUCTION_LIKE_MARKDOWN_PATTERNS) {
    sanitized = sanitized.replace(pattern, " ");
  }
  return sanitized.replace(/\s{2,}/g, " ").trim();
}

function sanitizeMarkdownOr(text: unknown, fallback: string): string {
  return sanitizeMarkdown(text) || fallback;
}

const MAX_QUERY_LENGTH = 120;
const MAX_QUERY_INPUT_LENGTH = 200;
const MAX_NAME_LENGTH = 50;
const MAX_DRUG_LOOKUP_RESULTS = 10;
const MAX_SEARCH_RESULTS = 20;
const MAX_INTERACTION_RESULTS = 50;

function normalizeQuery(input: string, maxLength = MAX_QUERY_LENGTH): string {
  return input.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function likePattern(input: string): string {
  return `%${escapeLike(input)}%`;
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
  // Optional auth env. When configured, validates Bearer tokens for per-user rate limiting.
  MCP_KEY_SECRET?: string;
}

// --- Auth: HMAC-validated MCP key ---
// MCP keys are issued by rootsbybenda-site/functions/api/mcp-key.js using the
// SAME MCP_KEY_SECRET. Format: mcp_<base64url(user_id)>_<sha256_hmac[:32]>.

interface AuthProps extends Record<string, unknown> {
  user_id: string | null;
  authenticated: boolean;
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
  if (!match) return { user_id: null, authenticated: false };

  const key = match[1];
  const parts = key.split("_");
  if (parts.length !== 3 || parts[0] !== "mcp") {
    return { user_id: null, authenticated: false };
  }
  const userIdB64 = parts[1];
  const providedHmac = parts[2].toLowerCase();

  if (!env.MCP_KEY_SECRET) {
    console.error("resolveAuth: MCP_KEY_SECRET not configured");
    return { user_id: null, authenticated: false };
  }

  let userId: string;
  try {
    userId = base64urlDecodeToString(userIdB64);
  } catch {
    return { user_id: null, authenticated: false };
  }
  if (!userId) return { user_id: null, authenticated: false };

  const computed = (await hmacSha256Hex(userId, env.MCP_KEY_SECRET)).slice(0, 32);
  if (!constantTimeEqual(computed, providedHmac)) {
    return { user_id: null, authenticated: false };
  }

  return { user_id: userId, authenticated: true };
}
// --- End auth ---

const SERVER_VERSION = "1.0.0";
const HOMEPAGE = "https://rootsbybenda.com";
const SOURCE = "Roots by Benda \u2014 rootsbybenda.com";
const CONTACT = "SBD@effortlessai.ai";
const SERVER_NAME = "Roots by Benda \u2014 Pharmaceutical Intelligence";
const SERVER_DESCRIPTION =
  "Check drug safety across interactions, FAERS, DrugBank, WHO, TGA, and ChEMBL.";
const DATA_CATALOG = {
  tga_artg_medicines: "23,259 Australian registered medicines",
  drugbank_drugs: "4,947 drug compounds with targets",
  who_essential_medicines: "782 WHO essential medicines",
  drug_interactions: "5,000 drug-drug interactions",
  fda_faers_top_drugs: "2,000 FDA adverse event reports",
  fda_ndi_notifications: "1,330 FDA new dietary ingredient notifications",
  chembl_bioactivity: "7,941 bioactivity records"
};
const TOOL_CATALOG = [
  {
    name: "check_drug",
    description: "Check a drug, medicine, active ingredient, or CAS number across pharmaceutical safety and regulatory datasets. Use when the user asks for DrugBank details, WHO Essential Medicines status, Australian TGA records, FDA NDI notifications, targets, dosage forms, indications, or regulatory lookup for a specific substance. Do not use for drug-drug interaction pair checks, FAERS adverse-event signal summaries, broad disease/topic discovery, or cosmetic/food/cannabis substances. The response includes identifiers, compound metadata, targets, schedules, dosage forms, indications, and regulatory records from matched datasets."
  },
  {
    name: "check_drug_interactions",
    description: "Check drug-drug interactions for one medication or a specific two-drug pair. Use when the user asks whether warfarin and aspirin interact, wants interaction severity, mechanism, clinical effect, evidence, or management guidance for medication safety review. Do not use for general drug monographs, adverse-event frequency, regulatory status, or non-drug ingredient interactions. The response includes matching interaction pairs, severity, mechanism, clinical effect, evidence level, and management recommendations."
  },
  {
    name: "check_adverse_events",
    description: "Check FDA FAERS adverse-event records for a drug or active ingredient. Use when the user asks about reported side effects, serious outcomes, death reports, top reactions, age distribution, or post-market safety signals for a medication. Do not use for interaction mechanisms, regulatory approval lookup, nutrition/supplement advice, or adverse events not tied to a drug name. The response includes report totals, serious outcome counts, death counts, top adverse reactions, and common patient age groups."
  },
  {
    name: "search_pharma",
    description: "Search pharmaceutical regulatory and safety datasets by disease, drug class, endpoint, indication, or safety keyword. Use when the user needs broad discovery across DrugBank, WHO Essential Medicines, TGA ARTG, FAERS, FDA NDI, interactions, or ChEMBL before choosing a specific drug tool. Do not use for exact drug monographs, two-drug interaction checks, or FAERS summaries when the drug name is already known. The response includes cross-dataset matches with dataset labels, names, identifiers, snippets, and source-specific fields."
  }
];

function registryMetadata() {
  return {
    name: SERVER_NAME,
    description: SERVER_DESCRIPTION,
    version: SERVER_VERSION,
    mcp_endpoint: "/mcp",
    tools: TOOL_CATALOG,
    data: DATA_CATALOG,
    homepage: HOMEPAGE,
    source: SOURCE,
    contact: CONTACT,
  };
}


export class PharmaMCP extends McpAgent<Env> {
  // @ts-expect-error agents bundles its own MCP SDK copy; runtime server shape is compatible.
  server = new McpServer({
    name: "roots-pharma-regulatory",
    version: SERVER_VERSION,
  });

  async init() {
    // Tool 1: check_drug — Search for a drug across all pharma databases
    this.server.tool(
      "check_drug",
      TOOL_CATALOG[0].description,
      {
        query: z
          .string()
          .trim()
          .min(1)
          .max(MAX_QUERY_INPUT_LENGTH)
          .describe(
            "Drug brand name, generic active ingredient, medicine name, synonym, or CAS number (Chemical Abstracts Service registry number, e.g. '50-78-2'). Use generic active ingredient names when possible for cross-database matching across DrugBank, WHO, TGA, FDA NDI, and ChEMBL."
          ),
      },
      READ_ONLY_TOOL_ANNOTATIONS,
      async ({ query }) => {
        const q = normalizeQuery(query);
        const pattern = likePattern(q);
        let text = `## Drug Lookup: "${sanitizeMarkdown(query)}"\n\n`;
        let totalResults = 0;

        // DrugBank
        const drugbank = await this.env.DB.prepare(
          `SELECT * FROM drugbank_drugs
           WHERE Drug_Name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR CAS_Number = ?
           LIMIT ?`
        )
          .bind(pattern, q, MAX_DRUG_LOOKUP_RESULTS)
          .all();

        if (drugbank.results && drugbank.results.length > 0) {
          text += `### DrugBank (${drugbank.results.length} matches)\n`;
          for (const r of drugbank.results) {
            text += `- **${sanitizeMarkdown(r.Drug_Name)}** (${sanitizeMarkdown(r.DrugBank_ID)})\n`;
            if (r.CAS_Number) text += `  - CAS: ${sanitizeMarkdown(r.CAS_Number)}\n`;
            if (r.Drug_Groups) text += `  - Groups: ${sanitizeMarkdown(r.Drug_Groups)}\n`;
            if (r.Targets) text += `  - Targets: ${sanitizeMarkdown(r.Targets)}\n`;
            if (r.DDI_Count) text += `  - Drug-Drug Interactions: ${sanitizeMarkdown(r.DDI_Count)}\n`;
            if (r.SMILES) text += `  - SMILES: ${sanitizeMarkdown(r.SMILES)}\n`;
          }
          text += `\n`;
          totalResults += drugbank.results.length;
        }

        // WHO Essential Medicines
        const who = await this.env.DB.prepare(
          `SELECT * FROM who_essential_medicines
           WHERE medicine_name LIKE ? ESCAPE '\\' COLLATE NOCASE
           LIMIT ?`
        )
          .bind(pattern, MAX_DRUG_LOOKUP_RESULTS)
          .all();

        if (who.results && who.results.length > 0) {
          text += `### WHO Essential Medicines (${who.results.length} matches)\n`;
          for (const r of who.results) {
            text += `- **${sanitizeMarkdown(r.medicine_name)}**\n`;
            if (r.atc_code) text += `  - ATC Code: ${sanitizeMarkdown(r.atc_code)}\n`;
            if (r.eml_section) text += `  - EML Section: ${sanitizeMarkdown(r.eml_section)}\n`;
            if (r.formulations) text += `  - Formulations: ${sanitizeMarkdown(r.formulations)}\n`;
            if (r.indication) text += `  - Indication: ${sanitizeMarkdown(r.indication)}\n`;
            if (r.typical_dosage_range) text += `  - Dosage: ${sanitizeMarkdown(r.typical_dosage_range)}\n`;
            if (r.key_contraindications) text += `  - Contraindications: ${sanitizeMarkdown(r.key_contraindications)}\n`;
            if (r.pregnancy_safety_category) text += `  - Pregnancy safety: ${sanitizeMarkdown(r.pregnancy_safety_category)}\n`;
            if (r.adult_pediatric) text += `  - Population: ${sanitizeMarkdown(r.adult_pediatric)}\n`;
            if (r.complementary_list) text += `  - Complementary list: ${sanitizeMarkdown(r.complementary_list)}\n`;
          }
          text += `\n`;
          totalResults += who.results.length;
        }

        // TGA ARTG Medicines
        const tga = await this.env.DB.prepare(
          `SELECT * FROM tga_artg_medicines
           WHERE product_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR active_ingredient LIKE ? ESCAPE '\\' COLLATE NOCASE
           LIMIT ?`
        )
          .bind(pattern, pattern, MAX_DRUG_LOOKUP_RESULTS)
          .all();

        if (tga.results && tga.results.length > 0) {
          text += `### Australian TGA ARTG (${tga.results.length} matches)\n`;
          for (const r of tga.results) {
            text += `- **${sanitizeMarkdown(r.product_name)}** (ARTG ID: ${sanitizeMarkdown(r.artg_id)})\n`;
            if (r.active_ingredient) text += `  - Active ingredient: ${sanitizeMarkdown(r.active_ingredient)}\n`;
            if (r.active_ingredient_strength) text += `  - Strength: ${sanitizeMarkdown(r.active_ingredient_strength)}\n`;
            if (r.sponsor_name) text += `  - Sponsor: ${sanitizeMarkdown(r.sponsor_name)}\n`;
            if (r.product_category) text += `  - Category: ${sanitizeMarkdown(r.product_category)}\n`;
            if (r.schedule) text += `  - Schedule: ${sanitizeMarkdown(r.schedule)}\n`;
            if (r.status) text += `  - Status: ${sanitizeMarkdown(r.status)}\n`;
            if (r.dosage_form) text += `  - Dosage form: ${sanitizeMarkdown(r.dosage_form)}\n`;
            if (r.route_of_administration) text += `  - Route: ${sanitizeMarkdown(r.route_of_administration)}\n`;
            if (r.indications) text += `  - Indications: ${sanitizeMarkdown(r.indications)}\n`;
          }
          text += `\n`;
          totalResults += tga.results.length;
        }

        // FDA NDI Notifications
        const ndi = await this.env.DB.prepare(
          `SELECT * FROM fda_ndi_notifications
           WHERE new_dietary_ingredient_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR cas_number = ?
           LIMIT ?`
        )
          .bind(pattern, q, MAX_DRUG_LOOKUP_RESULTS)
          .all();

        if (ndi.results && ndi.results.length > 0) {
          text += `### FDA NDI Notifications (${ndi.results.length} matches)\n`;
          for (const r of ndi.results) {
            text += `- **${sanitizeMarkdown(r.new_dietary_ingredient_name)}** (NDI #${sanitizeMarkdown(r.ndi_number)})\n`;
            if (r.cas_number) text += `  - CAS: ${sanitizeMarkdown(r.cas_number)}\n`;
            if (r.fda_response_type) text += `  - FDA Response: ${sanitizeMarkdown(r.fda_response_type)}\n`;
            if (r.intended_conditions_of_use) text += `  - Intended use: ${sanitizeMarkdown(r.intended_conditions_of_use)}\n`;
            if (r.firm_notifier) text += `  - Notifier: ${sanitizeMarkdown(r.firm_notifier)}\n`;
          }
          text += `\n`;
          totalResults += ndi.results.length;
        }

        if (totalResults === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No drug records found for "${sanitizeMarkdown(query)}" across DrugBank, WHO Essential Medicines, Australian TGA, or FDA NDI databases. Try alternative names, generic names, or CAS numbers.`,
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
      TOOL_CATALOG[1].description,
      {
        drug: z
          .string()
          .trim()
          .min(1)
          .max(MAX_NAME_LENGTH)
          .describe(
            "Primary drug or active ingredient name for interaction lookup (e.g. 'warfarin', 'metformin', 'lisinopril'). Use generic names when possible because interaction datasets usually normalize to active substances."
          ),
        second_drug: z
          .string()
          .trim()
          .min(1)
          .max(MAX_NAME_LENGTH)
          .optional()
          .describe(
            "Optional second drug or active ingredient name for a specific interaction pair (e.g. 'aspirin'). Omit when the user wants all known interactions for the primary drug."
          ),
      },
      READ_ONLY_TOOL_ANNOTATIONS,
      async ({ drug, second_drug }) => {
        const d = normalizeQuery(drug, MAX_NAME_LENGTH);
        const dPattern = likePattern(d);

        if (second_drug) {
          const d2 = normalizeQuery(second_drug, MAX_NAME_LENGTH);
          const d2Pattern = likePattern(d2);

          const { results } = await this.env.DB.prepare(
            `SELECT * FROM drug_interactions
             WHERE (drug_1_name LIKE ? ESCAPE '\\' COLLATE NOCASE AND drug_2_name LIKE ? ESCAPE '\\' COLLATE NOCASE)
                OR (drug_1_name LIKE ? ESCAPE '\\' COLLATE NOCASE AND drug_2_name LIKE ? ESCAPE '\\' COLLATE NOCASE)
             ORDER BY severity DESC
             LIMIT ?`
          )
            .bind(dPattern, d2Pattern, d2Pattern, dPattern, MAX_INTERACTION_RESULTS)
            .all();

          if (!results || results.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No known interaction found between "${sanitizeMarkdown(drug)}" and "${sanitizeMarkdown(second_drug)}". This does not mean no interaction exists — only that it was not found in our database of 5,000 documented interactions.`,
                },
              ],
            };
          }

          let text = `## Drug Interaction: ${sanitizeMarkdown(drug)} + ${sanitizeMarkdown(second_drug)}\n\n`;
          for (const r of results) {
            text += `- **${sanitizeMarkdown(r.drug_1_name)}** (${sanitizeMarkdownOr(r.drug_1_class, "N/A")}) + **${sanitizeMarkdown(r.drug_2_name)}** (${sanitizeMarkdownOr(r.drug_2_class, "N/A")})\n`;
            if (r.severity) text += `  - Severity: **${sanitizeMarkdown(r.severity)}**\n`;
            if (r.interaction_mechanism) text += `  - Mechanism: ${sanitizeMarkdown(r.interaction_mechanism)}\n`;
            if (r.clinical_effect) text += `  - Clinical effect: ${sanitizeMarkdown(r.clinical_effect)}\n`;
            if (r.management_recommendation) text += `  - Management: ${sanitizeMarkdown(r.management_recommendation)}\n`;
            if (r.evidence_level) text += `  - Evidence level: ${sanitizeMarkdown(r.evidence_level)}\n`;
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
           LIMIT ?`
        )
          .bind(dPattern, dPattern, MAX_INTERACTION_RESULTS)
          .all();

        if (!results || results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No known interactions found for "${sanitizeMarkdown(drug)}" in our database of 5,000 documented drug-drug interactions. Try the generic drug name.`,
              },
            ],
          };
        }

        let text = `## Drug Interactions: ${sanitizeMarkdown(drug)}\n\n`;

        // Group by severity
        const bySeverity: Record<string, any[]> = {};
        for (const r of results) {
          const sev = (r.severity as string) || "Unknown";
          if (!bySeverity[sev]) bySeverity[sev] = [];
          bySeverity[sev].push(r);
        }

        for (const [sev, items] of Object.entries(bySeverity)) {
          text += `### Severity: ${sanitizeMarkdown(sev)} (${items.length})\n`;
          for (const r of items) {
            const otherDrug = (r.drug_1_name as string || "").toLowerCase().includes(d.toLowerCase())
              ? r.drug_2_name
              : r.drug_1_name;
            text += `- **${sanitizeMarkdown(otherDrug)}** (${sanitizeMarkdownOr(r.drug_2_class || r.drug_1_class, "N/A")})\n`;
            if (r.interaction_mechanism) text += `  - Mechanism: ${sanitizeMarkdown(r.interaction_mechanism)}\n`;
            if (r.clinical_effect) text += `  - Effect: ${sanitizeMarkdown(r.clinical_effect)}\n`;
            if (r.management_recommendation) text += `  - Management: ${sanitizeMarkdown(r.management_recommendation)}\n`;
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
      TOOL_CATALOG[2].description,
      {
        query: z
          .string()
          .trim()
          .min(1)
          .max(MAX_QUERY_INPUT_LENGTH)
          .describe(
            "Drug brand name or generic active ingredient for FDA FAERS adverse-event lookup (e.g. 'ibuprofen', 'acetaminophen', 'metformin'). Use the active ingredient when possible to capture reports filed under different brands."
          ),
      },
      READ_ONLY_TOOL_ANNOTATIONS,
      async ({ query }) => {
        const q = normalizeQuery(query);
        const pattern = likePattern(q);

        const { results } = await this.env.DB.prepare(
          `SELECT * FROM fda_faers_top_drugs
           WHERE drug_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR active_ingredient LIKE ? ESCAPE '\\' COLLATE NOCASE
           LIMIT ?`
        )
          .bind(pattern, pattern, MAX_SEARCH_RESULTS)
          .all();

        if (!results || results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No FDA adverse event data found for "${sanitizeMarkdown(query)}". Try the generic drug name or active ingredient name.`,
              },
            ],
          };
        }

        let text = `## FDA Adverse Event Reports (FAERS): "${sanitizeMarkdown(query)}"\n\n`;
        for (const r of results) {
          text += `### ${sanitizeMarkdown(r.drug_name)}${r.rank ? ` (Rank #${sanitizeMarkdown(r.rank)})` : ""}\n`;
          if (r.active_ingredient) text += `- **Active ingredient:** ${sanitizeMarkdown(r.active_ingredient)}\n`;
          if (r.total_reports) text += `- **Total reports:** ${sanitizeMarkdown(r.total_reports)}\n`;
          if (r.serious_outcome_reports) text += `- **Serious outcomes:** ${sanitizeMarkdown(r.serious_outcome_reports)}\n`;
          if (r.death_reports) text += `- **Death reports:** ${sanitizeMarkdown(r.death_reports)}\n`;
          if (r.top_10_adverse_reactions) text += `- **Top adverse reactions:** ${sanitizeMarkdown(r.top_10_adverse_reactions)}\n`;
          if (r.most_common_patient_age_group) text += `- **Most common age group:** ${sanitizeMarkdown(r.most_common_patient_age_group)}\n`;
          text += `\n`;
        }

        text += `*${results.length} drug(s) found in FAERS database*`;
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // Tool 4: search_pharma — Full-text search across ALL pharma tables
    this.server.tool(
      "search_pharma",
      TOOL_CATALOG[3].description,
      {
        query: z
          .string()
          .trim()
          .min(1)
          .max(MAX_QUERY_INPUT_LENGTH)
          .describe(
            "Pharmaceutical keyword, disease area, drug class, safety endpoint, indication, target, or regulatory term (e.g. 'diabetes', 'antibiotic', 'cancer', 'pregnancy', 'hepatotoxicity'). Use this for broad discovery across pharma datasets rather than exact monograph or interaction lookup."
          ),
      },
      READ_ONLY_TOOL_ANNOTATIONS,
      async ({ query }) => {
        const q = normalizeQuery(query);
        const pattern = likePattern(q);
        let text = `## Pharma Search Results: "${sanitizeMarkdown(query)}"\n\n`;
        let totalResults = 0;

        // DrugBank
        const drugbank = await this.env.DB.prepare(
          `SELECT * FROM drugbank_drugs
           WHERE Drug_Name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR Drug_Groups LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR Targets LIKE ? ESCAPE '\\' COLLATE NOCASE
           LIMIT ?`
        )
          .bind(pattern, pattern, pattern, MAX_SEARCH_RESULTS)
          .all();

        if (drugbank.results && drugbank.results.length > 0) {
          text += `### DrugBank (${drugbank.results.length} matches)\n`;
          for (const r of drugbank.results) {
            text += `- **${sanitizeMarkdown(r.Drug_Name)}** (${sanitizeMarkdown(r.DrugBank_ID)}) — ${sanitizeMarkdownOr(r.Drug_Groups, "N/A")}`;
            if (r.CAS_Number) text += ` | CAS: ${sanitizeMarkdown(r.CAS_Number)}`;
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
           LIMIT ?`
        )
          .bind(pattern, pattern, pattern, MAX_SEARCH_RESULTS)
          .all();

        if (who.results && who.results.length > 0) {
          text += `### WHO Essential Medicines (${who.results.length} matches)\n`;
          for (const r of who.results) {
            text += `- **${sanitizeMarkdown(r.medicine_name)}** — ${sanitizeMarkdownOr(r.eml_section, "N/A")}`;
            if (r.indication) text += ` | ${sanitizeMarkdown(r.indication)}`;
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
           LIMIT ?`
        )
          .bind(pattern, pattern, pattern, MAX_SEARCH_RESULTS)
          .all();

        if (tga.results && tga.results.length > 0) {
          text += `### Australian TGA ARTG (${tga.results.length} matches)\n`;
          for (const r of tga.results) {
            text += `- **${sanitizeMarkdown(r.product_name)}** (ARTG: ${sanitizeMarkdown(r.artg_id)}) — ${sanitizeMarkdownOr(r.active_ingredient, "N/A")}`;
            if (r.schedule) text += ` | Schedule: ${sanitizeMarkdown(r.schedule)}`;
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
           LIMIT ?`
        )
          .bind(pattern, pattern, pattern, MAX_SEARCH_RESULTS)
          .all();

        if (faers.results && faers.results.length > 0) {
          text += `### FDA FAERS Adverse Events (${faers.results.length} matches)\n`;
          for (const r of faers.results) {
            text += `- **${sanitizeMarkdown(r.drug_name)}** — ${sanitizeMarkdownOr(r.total_reports, "N/A")} reports`;
            if (r.death_reports) text += ` | ${sanitizeMarkdown(r.death_reports)} deaths`;
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
           LIMIT ?`
        )
          .bind(pattern, pattern, pattern, pattern, MAX_SEARCH_RESULTS)
          .all();

        if (interactions.results && interactions.results.length > 0) {
          text += `### Drug Interactions (${interactions.results.length} matches)\n`;
          for (const r of interactions.results) {
            text += `- **${sanitizeMarkdown(r.drug_1_name)}** + **${sanitizeMarkdown(r.drug_2_name)}** — Severity: ${sanitizeMarkdownOr(r.severity, "N/A")}`;
            if (r.clinical_effect) text += ` | ${sanitizeMarkdown(r.clinical_effect)}`;
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
           LIMIT ?`
        )
          .bind(pattern, pattern, MAX_SEARCH_RESULTS)
          .all();

        if (ndi.results && ndi.results.length > 0) {
          text += `### FDA NDI Notifications (${ndi.results.length} matches)\n`;
          for (const r of ndi.results) {
            text += `- **${sanitizeMarkdown(r.new_dietary_ingredient_name)}** (NDI #${sanitizeMarkdown(r.ndi_number)}) — FDA: ${sanitizeMarkdownOr(r.fda_response_type, "N/A")}`;
            if (r.firm_notifier) text += ` | ${sanitizeMarkdown(r.firm_notifier)}`;
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
           LIMIT ?`
        )
          .bind(pattern, pattern, MAX_SEARCH_RESULTS)
          .all();

        if (chembl.results && chembl.results.length > 0) {
          text += `### ChEMBL Bioactivity (${chembl.results.length} matches)\n`;
          for (const r of chembl.results) {
            text += `- **${sanitizeMarkdownOr(r.molecule_name, "N/A")}** → ${sanitizeMarkdownOr(r.target_name, "N/A")}`;
            if (r.activity_type) text += ` | ${sanitizeMarkdown(r.activity_type)}: ${sanitizeMarkdownOr(r.activity_value, "N/A")} ${sanitizeMarkdown(r.activity_units)}`;
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
                text: `No results found for "${sanitizeMarkdown(query)}" across any pharmaceutical database. Try alternative terms, generic names, or broader searches.`,
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

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        name: SERVER_NAME,
        version: SERVER_VERSION,
        status: "healthy",
        description: SERVER_DESCRIPTION,
        tools: TOOL_CATALOG.map((tool) => tool.name),
        data: DATA_CATALOG,
        docs: HOMEPAGE,
        homepage: HOMEPAGE,
        source: SOURCE,
      });
    }

    if (url.pathname === "/.well-known/mcp/server.json") {
      return Response.json(registryMetadata(), {
        headers: { "Cache-Control": "public, max-age=300" },
      });
    }

    if (url.pathname === "/.well-known/mcp/server-card.json") {
      return Response.json({
        "$schema": "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
        "version": "1.0",
        "protocolVersion": "2025-06-18",
        "serverInfo": { "name": "pharma-mcp-server", "title": SERVER_NAME, "version": SERVER_VERSION },
        "description": SERVER_DESCRIPTION,
        "iconUrl": "https://rootsbybenda.com/icon.png",
        "documentationUrl": "https://rootsbybenda.com",
        "transport": { "type": "streamable-http", "endpoint": "/mcp" },
        "capabilities": { "tools": { "listChanged": true }, "resources": { "subscribe": false, "listChanged": false } },
        "authentication": { "required": false, "schemes": ["bearer"], "note": "Optional API key enables per-user rate limiting" },
        "rateLimit": { "requestsPerMinute": 60, "enforcement": "per-ip-or-user" },
        "tools": TOOL_CATALOG
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
        name: "Roots by Benda — Pharmaceutical Regulatory Intelligence",
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
