import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
}

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
        let text = `## Drug Lookup: "${query}"\n\n`;
        let totalResults = 0;

        // DrugBank
        const drugbank = await this.env.DB.prepare(
          `SELECT * FROM drugbank_drugs
           WHERE Drug_Name LIKE ? COLLATE NOCASE
              OR CAS_Number = ?
           LIMIT 10`
        )
          .bind(`%${q}%`, q)
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
           WHERE medicine_name LIKE ? COLLATE NOCASE
           LIMIT 10`
        )
          .bind(`%${q}%`)
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
           WHERE product_name LIKE ? COLLATE NOCASE
              OR active_ingredient LIKE ? COLLATE NOCASE
           LIMIT 10`
        )
          .bind(`%${q}%`, `%${q}%`)
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
           WHERE new_dietary_ingredient_name LIKE ? COLLATE NOCASE
              OR cas_number = ?
           LIMIT 10`
        )
          .bind(`%${q}%`, q)
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

        if (second_drug) {
          const d2 = second_drug.trim();

          const { results } = await this.env.DB.prepare(
            `SELECT * FROM drug_interactions
             WHERE (drug_1_name LIKE ? COLLATE NOCASE AND drug_2_name LIKE ? COLLATE NOCASE)
                OR (drug_1_name LIKE ? COLLATE NOCASE AND drug_2_name LIKE ? COLLATE NOCASE)
             ORDER BY severity DESC
             LIMIT 50`
          )
            .bind(`%${d}%`, `%${d2}%`, `%${d2}%`, `%${d}%`)
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
           WHERE drug_1_name LIKE ? COLLATE NOCASE
              OR drug_2_name LIKE ? COLLATE NOCASE
           ORDER BY severity DESC
           LIMIT 50`
        )
          .bind(`%${d}%`, `%${d}%`)
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

        const { results } = await this.env.DB.prepare(
          `SELECT * FROM fda_faers_top_drugs
           WHERE drug_name LIKE ? COLLATE NOCASE
              OR active_ingredient LIKE ? COLLATE NOCASE
           LIMIT 20`
        )
          .bind(`%${q}%`, `%${q}%`)
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
        let text = `## Pharma Search Results: "${query}"\n\n`;
        let totalResults = 0;

        // DrugBank
        const drugbank = await this.env.DB.prepare(
          `SELECT * FROM drugbank_drugs
           WHERE Drug_Name LIKE ? COLLATE NOCASE
              OR Drug_Groups LIKE ? COLLATE NOCASE
              OR Targets LIKE ? COLLATE NOCASE
           LIMIT 20`
        )
          .bind(`%${q}%`, `%${q}%`, `%${q}%`)
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
           WHERE medicine_name LIKE ? COLLATE NOCASE
              OR indication LIKE ? COLLATE NOCASE
              OR eml_section LIKE ? COLLATE NOCASE
           LIMIT 20`
        )
          .bind(`%${q}%`, `%${q}%`, `%${q}%`)
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
           WHERE product_name LIKE ? COLLATE NOCASE
              OR active_ingredient LIKE ? COLLATE NOCASE
              OR indications LIKE ? COLLATE NOCASE
           LIMIT 20`
        )
          .bind(`%${q}%`, `%${q}%`, `%${q}%`)
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
           WHERE drug_name LIKE ? COLLATE NOCASE
              OR active_ingredient LIKE ? COLLATE NOCASE
              OR top_10_adverse_reactions LIKE ? COLLATE NOCASE
           LIMIT 20`
        )
          .bind(`%${q}%`, `%${q}%`, `%${q}%`)
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
           WHERE drug_1_name LIKE ? COLLATE NOCASE
              OR drug_2_name LIKE ? COLLATE NOCASE
              OR interaction_mechanism LIKE ? COLLATE NOCASE
              OR clinical_effect LIKE ? COLLATE NOCASE
           ORDER BY severity DESC
           LIMIT 20`
        )
          .bind(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
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
           WHERE new_dietary_ingredient_name LIKE ? COLLATE NOCASE
              OR intended_conditions_of_use LIKE ? COLLATE NOCASE
           LIMIT 20`
        )
          .bind(`%${q}%`, `%${q}%`)
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
           WHERE molecule_name LIKE ? COLLATE NOCASE
              OR target_name LIKE ? COLLATE NOCASE
           LIMIT 20`
        )
          .bind(`%${q}%`, `%${q}%`)
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
