# Pharmaceutical Regulatory Intelligence MCP Server

Comprehensive pharmaceutical data covering drug compounds, interactions, adverse events, essential medicines, and regulatory notifications across 7 databases and 45,000+ records.

## Tools

### `check_drug`
Multi-source drug lookup across DrugBank (4,947 compounds), WHO Essential Medicines (782 drugs), Australian TGA ARTG (23,259 registered medicines), and FDA New Dietary Ingredient notifications (1,330 NDIs).

### `check_drug_interactions`
Drug-drug interaction checker with 5,000 documented interactions. Query a single drug to see all known interactions, or check a specific drug pair. Results grouped by severity.

### `check_adverse_events`
FDA FAERS (Adverse Event Reporting System) data for the top 2,000 most-reported drugs. Includes reaction types, outcomes, reporting frequency.

### `search_pharma`
Full-text search across all 7 pharmaceutical databases — drugs, interactions, adverse events, essential medicines, bioactivity, and regulatory notifications.

## Data Coverage

| Database | Records | Source |
|----------|---------|--------|
| DrugBank Drugs | 4,947 | DrugBank Open Data |
| WHO Essential Medicines | 782 | WHO Model List |
| Australian TGA ARTG | 23,259 | Therapeutic Goods Administration |
| Drug Interactions | 5,000 | Clinical interaction databases |
| FDA FAERS Top Drugs | 2,000 | FDA Adverse Event Reporting System |
| FDA NDI Notifications | 1,330 | FDA New Dietary Ingredients |
| ChEMBL Bioactivity | 7,941 | ChEMBL Database |
| **Total** | **45,259** | |

## Built by Two Halves — twohalves.ai
