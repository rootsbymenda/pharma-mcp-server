# Roots by Benda — Pharmaceutical & Bioequivalence Intelligence MCP Server

**Drug safety, interactions, adverse events, and regulatory data in one MCP.** Check any drug or active ingredient against DrugBank, WHO Essential Medicines, FDA FAERS adverse events, drug-drug interactions, Australian TGA ARTG, FDA NDI notifications, and ChEMBL bioactivity — all source-linked and free.

Equivalent data through commercial platforms (Lexicomp, Micromedex, DrugBank Pro) costs $20,000+/year. This MCP is free.

**Live endpoint:** `https://pharma-mcp-server.rootsbybenda.workers.dev/mcp`
**SSE fallback:** `https://pharma-mcp-server.rootsbybenda.workers.dev/sse`

## Tools

### `check_drug`
Look up a drug, medicine, active ingredient, or CAS number across DrugBank, WHO Essential Medicines, Australian TGA ARTG, and FDA NDI notifications. Returns identifiers, targets, schedules, dosage forms, indications, and regulatory records.

```
query: "metformin"
→ DrugBank: DB00331; WHO Essential: Yes (diabetes); TGA ARTG: 47 registered products;
  Targets: AMP-activated protein kinase; Indications: Type 2 diabetes mellitus
```

### `check_drug_interactions`
Check drug-drug interactions for one drug or a specific pair. Returns interaction severity, mechanism, clinical effect, evidence level, and management recommendations for medication safety review.

```
query: "warfarin aspirin"
→ Severity: MAJOR; Mechanism: additive anticoagulant + antiplatelet effect;
  Clinical: increased bleeding risk; Management: avoid combination or monitor INR closely
```

### `check_adverse_events`
Check FDA FAERS adverse-event records for a drug or active ingredient. Returns total reports, serious outcomes, death reports, top adverse reactions, and common patient age groups.

```
query: "isotretinoin"
→ Total reports: 12,847; Serious: 8,231; Deaths: 89; Top reactions: depression,
  inflammatory bowel disease, suicide attempt; Peak age: 15-25
```

### `search_pharma`
Search across pharmaceutical regulatory and safety databases by keyword. Use for broad discovery across DrugBank, WHO Essential Medicines, TGA ARTG, FAERS, FDA NDI, drug interactions, and ChEMBL bioactivity.

```
query: "SSRI pregnancy" → matches across FAERS (birth defects), interactions, DrugBank warnings
```

## Data

| Dataset | Records |
|---------|---------|
| Australian TGA ARTG registered medicines | 23,259 |
| ChEMBL bioactivity records | 7,941 |
| DrugBank compounds | 4,947 |
| Drug-drug interactions | 5,000 |
| FDA FAERS adverse-event records | 2,000 |
| FDA NDI notifications | 1,330 |
| WHO Essential Medicines | 782 |

**100% source-traceability:** every record links to DrugBank, WHO, TGA, FDA FAERS, or ChEMBL primary sources.

**Sources:** DrugBank (open data), WHO Model List of Essential Medicines, Australian TGA ARTG, FDA FAERS (Adverse Event Reporting System), FDA New Dietary Ingredient notifications, ChEMBL (EMBL-EBI).

## Quick Start

### Claude Desktop / Claude Code
Add to your MCP config:
```json
{
  "mcpServers": {
    "roots-pharma-regulatory": {
      "url": "https://pharma-mcp-server.rootsbybenda.workers.dev/sse"
    }
  }
}
```

### Cursor / Windsurf / Zed
Use the Streamable HTTP endpoint:
```
https://pharma-mcp-server.rootsbybenda.workers.dev/mcp
```

## Rate Limits

Every caller receives full data; a 60 requests/minute abuse-prevention limit applies per IP.

## Built With

- [Cloudflare Workers](https://workers.cloudflare.com/) + [Agents SDK](https://developers.cloudflare.com/agents/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite at the edge)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/) (session-scoped rate limiting)
- [Model Context Protocol](https://modelcontextprotocol.io/) (MCP)

## Who Built This

**Roots by Benda** — regulatory intelligence platform built by Shahar Ben-David with Claude. Pharmaceutical database assembled from primary sources across DrugBank, WHO, TGA, FDA, and ChEMBL.

- Website: [rootsbybenda.com](https://rootsbybenda.com)
- LinkedIn: [Shahar Ben-David](https://www.linkedin.com/in/shahar-ben-david-25549a3a8/)

## License

MIT
