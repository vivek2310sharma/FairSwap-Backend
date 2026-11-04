# FairSwap Azure Moderation V1 - Cost Estimate (Central India)

Region: Central India
Tier: Azure Container Apps Consumption + Basic Azure Container Registry + Log Analytics PerGB

| Resource | SKU / Tier | Allocation / Usage Pattern | Estimated Monthly Cost (USD) |
|---|---|---|---|
| **Azure Container Registry (ACR)** | Basic | 1 registry per environment (Test, Prod), 10GB storage included | ~$5.00 / month |
| **Log Analytics Workspace** | PerGB2018 | ~5 GB ingestion/month (structured error/health logs, retention 30 days) | ~$11.50 / month |
| **Container Apps: Controller** | Consumption | 0.5 vCPU, 1.0 GiB, scales 0 to 2 (Test) / 5 (Prod). Free tier covers first 180,000 vCPU-s & 360,000 GiB-s | ~$8.00 - $18.00 / month |
| **Container Apps: Node Vision** | Consumption | 0.5 vCPU, 1.0 GiB, scales on demand per batch | ~$10.00 - $22.00 / month |
| **Container Apps: Python OCR** | Consumption | 0.5 vCPU, 1.0 GiB, scales on demand per batch | ~$12.00 - $25.00 / month |
| **Outbound Data Transfer** | Standard Egress | Minimal (<5GB/month for structured JSON) | < $1.00 / month |
| **Total Estimated Per Environment** | | | **~$36.00 - $82.00 / month** |

*Note: Azure budgets with alert thresholds at 50%, 80%, and 100% must be configured in both resource groups `rg-fairswap-moderation-test` and `rg-fairswap-moderation-prod`.*

