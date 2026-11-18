# FairSwap Azure Moderation — Cost Estimate & GHCR Migration Analysis (Central India)

**Region:** Central India (`centralindia`)
**Architecture:** Azure Container Apps (Consumption Tier) + Public GitHub Container Registry (GHCR) + Log Analytics (PerGB2018)
**Currency Reference:** USD ($) and INR (₹ at current baseline ~₹85 / $1 USD)
**Last Updated:** November 2026 (Public GHCR Architecture)

---

## 1. Executive Summary

By migrating image hosting from two billable Azure Container Registries (Basic tier in Test and Production) to public GitHub Container Registry (GHCR), FairSwap eliminates recurring fixed infrastructure overhead for container storage in Azure (~₹850 / month), whilst retaining full zero-replica scale-to-zero capabilities and strict runtime moderation security boundaries.

| Dimension | Before (Azure Container Registry) | After (Public GHCR) | Monthly Delta / Savings |
|---|---|---|---|
| **Container Registry Storage** | ~$10.00 / month (~₹850) for 2 Basic ACRs | ₹0.00 / month (Free for public GHCR packages) | **-₹850 / month saved (upon ACR decommissioning)** |
| **Idle Compute (Zero Replicas)** | ₹0.00 (within ACA 180k vCPU-s free tier) | ₹0.00 (within ACA 180k vCPU-s free tier) | ₹0.00 (Unchanged) |
| **Log Analytics (30-day retention)** | ~$2.30 – $5.00 / month (~₹195 – ₹425) | ~$2.30 – $5.00 / month (~₹195 – ₹425) | Unchanged (essential for auditability) |
| **Network Egress (Azure)** | < ₹10 / month (first 100 GB Azure egress free) | < ₹10 / month | Unchanged |
| **Total Estimated Azure Bill (Per Env)** | ~$16.00 – $35.00 / month | **~$2.50 – $15.00 / month** | **Significant fixed-cost reduction** |

---

## 2. Component-by-Component Cost Breakdown

### 2.1 Container Registry (ACR vs. Public GHCR)

- **Prior Azure Container Registry (Basic Tier):**
  - Cost: ~$5.00 per registry / month (~₹425/mo) in Central India.
  - Across 2 environments (`rg-fairswap-moderation-test` and `rg-fairswap-moderation-prod`): ~$10.00 / month (~₹850/mo fixed, even when 0 requests are processed).
  - Note: Both ACRs are retained until post-migration verification succeeds in both environments, after which they can be decommissioned upon owner approval.
- **New Public GHCR:**
  - Storage & Data Transfer: According to [GitHub Packages billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-packages), GitHub Packages is completely free for public packages. Container registry storage and bandwidth for public packages are currently free of charge (subject to future GitHub policy).
  - Authentication: No personal access tokens (PATs) or pull tokens required for Azure Container Apps image pulls.
  - Estimated GHCR Monthly Cost: **₹0.00 ($0.00)**.

### 2.2 Azure Container Apps Compute (Central India)

All three services (`ca-moderation-controller`, `ca-node-vision`, and `ca-python-ocr`) are deployed on the **Consumption Tier** with:
- `minReplicas: 0`
- `maxReplicas: 2` (Test) / `5` (Prod)
- Resource allocation: `0.5 vCPU`, `1.0 GiB RAM` per container.

**Zero-Replica Idle Behavior:**
- When no listings are being actively moderated, all three services scale down to zero replicas.
- When replica count is 0, Azure bills **₹0.00 for compute**.
- **Free Allowance per Azure Subscription:**
  - 180,000 vCPU-seconds / month free
  - 360,000 GiB-seconds / month free
  - 2,000,000 HTTP requests / month free
- **Active Usage Estimate:**
  - A moderation request processes in ~2 to 4 seconds across workers.
  - 10,000 listings moderated per month consumes ~30,000 vCPU-seconds, staying well within the free allowance.
  - Compute cost at moderate volume: **₹0.00 to ₹170 / month ($0.00 to $2.00)**.

### 2.3 Log Analytics Workspace (`PerGB2018`)

- Retention: 30 days (default, included in ingestion price).
- Ingestion price: ~$2.30 / GB in Central India (~₹195 / GB).
- Log volume: Structured startup, health check, and error telemetry averages ~0.5 to 1.5 GB / month per environment.
- Estimated Cost: **~₹100 to ₹300 / month ($1.15 to $3.50) per environment**.

### 2.4 Network Egress & Ancillary Costs

- First 100 GB / month of outbound internet egress from Azure is free.
- Communication between Controller and internal workers (`ca-node-vision`, `ca-python-ocr`) is internal to the Container Apps Environment (VNet internal) and incurs zero egress fees.
- Verdict JSON responses sent back to Supabase are minimal (<5 KB each).
- Estimated Cost: **< ₹10 / month**.

---

## 3. Test vs. Production Considerations

| Item | Test (`rg-fairswap-moderation-test`) | Production (`rg-fairswap-moderation-prod`) |
|---|---|---|
| **Container App Scale** | `minReplicas: 0`, `maxReplicas: 2` | `minReplicas: 0`, `maxReplicas: 5` |
| **Idle Cost** | ~₹100 – ₹150 / month (Log Analytics only) | ~₹100 – ₹200 / month (Log Analytics only) |
| **Images Consumed** | SHA-256 digest from public GHCR | Identical SHA-256 digest verified in Test |
| **Supabase Integration** | `wpppxlnbzqynvhpeuavd` | `kriuhwppxgxsyyrbjsau` |
| **Baseline Provider State** | `moderation_azure_enabled = false` | `moderation_azure_enabled = false` |

---

## 4. Remaining Costs That Cannot Automatically Reach ₹0

To maintain operational integrity and Indian classifieds marketplace standards, the following costs cannot reach absolute zero:

1. **Log Analytics Ingestion:** Essential for security audits, cold-start tracing, and dispute evidence. Minimal ingestion cannot be avoided while maintaining visibility (~₹100 to ₹300 / month).
2. **Statutory Taxes:** Indian GST (18%) applicable to Azure cloud services for Indian billing profiles.
3. **Active Compute (High Volume):** If moderation throughput exceeds the Azure free allowance (180,000 vCPU-seconds), standard ACA Consumption pricing applies.

---

## 5. Budget Alerts & Cost Guardrails

Both resource groups must maintain Azure Budget alerts:
- `rg-fairswap-moderation-test`: Alert threshold at ₹500 / month ($6.00).
- `rg-fairswap-moderation-prod`: Alert threshold at ₹1,500 / month ($18.00).
- Alert notification recipients: FairSwap Engineering & Operations.
