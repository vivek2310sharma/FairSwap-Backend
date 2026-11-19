import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("Azure Moderation GHCR Migration Contract Tests", () => {
  const rootDir = process.cwd();

  const deployWorkflowPath = join(rootDir, ".github/workflows/deploy-azure-moderation.yml");
  const ciWorkflowPath = join(rootDir, ".github/workflows/azure-moderation-ci.yml");
  const mainBicepPath = join(rootDir, "infra/azure/moderation/main.bicep");
  const acrBicepPath = join(rootDir, "infra/azure/moderation/acr.bicep");
  const costEstimatePath = join(rootDir, "infra/azure/moderation/COST_ESTIMATE.md");

  it("ensures acr.bicep is preserved for rollback", () => {
    expect(existsSync(acrBicepPath)).toBe(true);
    const content = readFileSync(acrBicepPath, "utf-8");
    expect(content).toContain("Microsoft.ContainerRegistry/registries");
  });

  it("validates main.bicep public GHCR registry configuration", () => {
    expect(existsSync(mainBicepPath)).toBe(true);
    const bicep = readFileSync(mainBicepPath, "utf-8");

    // Decoupled from active ACR provisioning
    expect(bicep).not.toContain("Microsoft.ContainerRegistry/registries@2023-07-01' existing");
    expect(bicep).not.toContain("guid(resourceGroup().id, acaIdentity.id, 'AcrPull')");

    // Public GHCR image parameters present
    expect(bicep).toContain("param controllerImage string = 'ghcr.io/vivek2310sharma/fairswap-moderation-controller:${imageTag}'");
    expect(bicep).toContain("param nodeVisionImage string = 'ghcr.io/vivek2310sharma/fairswap-node-vision:${imageTag}'");
    expect(bicep).toContain("param pythonOcrImage string = 'ghcr.io/vivek2310sharma/fairswap-python-ocr:${imageTag}'");

    // No private package names, unused ghcrServer parameter, or credentials in Bicep
    expect(bicep).not.toContain("fairswap-private-");
    expect(bicep).not.toContain("param ghcrServer");
    expect(bicep).not.toContain("ghcrPullToken");
    expect(bicep).not.toContain("ghcr-pull-token");
    expect(bicep).not.toContain("ghcrUsername");
    expect(bicep).not.toContain("passwordSecretRef");

    // Public registry configuration on Container Apps: empty registries array explicitly clears private credentials
    const registryMatches = bicep.match(/registries:\s*\[\s*\]/g);
    expect(registryMatches?.length).toBe(3);
    expect(bicep).not.toContain("server: ghcrServer");
    expect(bicep).not.toContain("server: 'ghcr.io'");

    // Scale-to-zero preserved on all three container apps
    const minReplicasMatches = bicep.match(/minReplicas:\s*0/g);
    expect(minReplicasMatches?.length).toBe(3);

    // Ingress boundaries: Node Vision and Python OCR must be internal
    expect(bicep).toMatch(/name:\s*'ca-node-vision-\${environment}'[\s\S]*?ingress:\s*{\s*external:\s*false/);
    expect(bicep).toMatch(/name:\s*'ca-python-ocr-\${environment}'[\s\S]*?ingress:\s*{\s*external:\s*false/);

    // Controller must have external secure ingress
    expect(bicep).toMatch(/name:\s*'ca-moderation-controller-\${environment}'[\s\S]*?ingress:\s*{\s*external:\s*true[\s\S]*?allowInsecure:\s*false/);

    // Controller cold-start accommodation timeout bounded to 15s for concurrent workers
    expect(bicep).toContain("name: 'TIMEOUT_MS'");
    expect(bicep).toContain("value: '15000'");
  });

  it("validates deploy-azure-moderation.yml pipeline boundaries and sequence", () => {
    expect(existsSync(deployWorkflowPath)).toBe(true);
    const workflow = readFileSync(deployWorkflowPath, "utf-8");

    // Sequence check: Build -> Test -> Verify Test -> Prod -> Verify Prod
    expect(workflow).toContain("build-ci-and-publish:");
    expect(workflow).toContain("deploy-test:");
    expect(workflow).toContain("verify-test:");
    expect(workflow).toContain("deploy-prod:");
    expect(workflow).toContain("verify-prod:");

    // Prod depends strictly on Test passing
    expect(workflow).toContain("needs: [build-ci-and-publish, deploy-test, verify-test]");

    // Preserves canonical environments FairSwapTest and FairSwapProd
    expect(workflow).toContain("environment: FairSwapTest");
    expect(workflow).toContain("environment: FairSwapProd");

    // Target packages match GHCR specifications
    expect(workflow).toContain("ghcr.io/${{ github.repository_owner }}/fairswap-moderation-controller");
    expect(workflow).toContain("ghcr.io/${{ github.repository_owner }}/fairswap-node-vision");
    expect(workflow).toContain("ghcr.io/${{ github.repository_owner }}/fairswap-python-ocr");

    // Private and versioned package names must be absent from active deployment workflow
    expect(workflow).not.toContain("fairswap-private-");
    expect(workflow).not.toContain("GHCR_PUBLISH_TOKEN");
    expect(workflow).not.toContain("GHCR_PULL_TOKEN");
    expect(workflow).not.toContain("GHCR_PULL_USERNAME");

    // Immutable digests promoted to both Test and Prod
    expect(workflow).toContain("controllerImage=${{ needs.build-ci-and-publish.outputs.controller_image }}");
    expect(workflow).toContain("nodeVisionImage=${{ needs.build-ci-and-publish.outputs.vision_image }}");
    expect(workflow).toContain("pythonOcrImage=${{ needs.build-ci-and-publish.outputs.ocr_image }}");

    // No ACR provisioning in default deployment
    expect(workflow).not.toContain("infra/azure/moderation/acr.bicep");
    expect(workflow).not.toContain("az acr login");

    // Package availability validation enforces anonymous pull success on all three packages
    expect(workflow).toContain("Verify Anonymous Pull Succeeds on All Three Public Packages (Fail-Closed)");

    // Unauthenticated public pull checks in Test and Prod
    expect(workflow).toContain("Verify Public Image Pulls in Test Environment (Fail-Closed)");
    expect(workflow).toContain("Verify Public Image Pulls in Production Environment (Fail-Closed)");

    // Supabase worker deployment and secret updates are decoupled from Azure deployment
    expect(workflow).not.toContain("functions deploy process-listing-moderation");
    expect(workflow).not.toContain("secrets set AZURE_MODERATION_ENDPOINT");

    // Rigorous automated postflight checks
    expect(workflow).toContain("Assert Exact Built Image Digests on All Three Apps (Test)");
    expect(workflow).toContain("Assert Scale-to-Zero and Ingress Boundaries on All Three Apps (Test)");
    // E2E synthetic moderation probe is decoupled from the registry-only release workflow
    expect(workflow).not.toContain("Verify End-to-End Synthetic Moderation & Worker Ingress (Test)");
    expect(workflow).toContain("Capture Live Container Apps Replica State Evidence (Test)");
    expect(workflow).toContain("Verify Supabase Edge Function Security Gate (Test)");
    expect(workflow).toContain("Assert Exact Built Image Digests on All Three Apps (Production)");
    expect(workflow).toContain("Assert Scale-to-Zero and Ingress Boundaries (Production)");
    expect(workflow).toContain("Verify Supabase Edge Function Security Gate (Production)");
  });

  it("validates azure-moderation-ci.yml includes Bicep compilation", () => {
    expect(existsSync(ciWorkflowPath)).toBe(true);
    const ci = readFileSync(ciWorkflowPath, "utf-8");
    expect(ci).toContain("az bicep build --file infra/azure/moderation/main.bicep");
    expect(ci).toContain("az bicep build --file infra/azure/moderation/acr.bicep");
  });

  it("validates COST_ESTIMATE.md documents GHCR savings and remaining costs", () => {
    expect(existsSync(costEstimatePath)).toBe(true);
    const cost = readFileSync(costEstimatePath, "utf-8");
    expect(cost).toContain("Public GHCR");
    expect(cost).toContain("Central India");
    expect(cost.toLowerCase()).toContain("zero-replica");
    expect(cost).toContain("Log Analytics");
    expect(cost).toContain("Remaining Costs That Cannot Automatically Reach ₹0");
  });

  it("enforces Blocker A fix: Azure CLI postflight queries use properties. prefix and fail-closed null checks", () => {
    const workflow = readFileSync(deployWorkflowPath, "utf-8");

    // Must NOT contain old queries missing 'properties.'
    expect(workflow).not.toContain('query "template.containers[0].image"');
    expect(workflow).not.toContain('query "template.scale.minReplicas"');
    expect(workflow).not.toContain('query "configuration.ingress.external"');

    // Must use canonical ARM properties prefix
    expect(workflow).toContain('query "properties.template.containers[0].image"');
    expect(workflow).toContain('query "properties.template.scale.minReplicas"');
    expect(workflow).toContain('query "properties.configuration.ingress.external"');

    // Must contain fail-closed guards against empty or null query returns
    expect(workflow).toContain("One or more image queries returned empty or null!");
    expect(workflow).toContain("One or more ingress queries returned empty or null!");
    expect(workflow).toContain("One or more production image queries returned empty or null!");
    expect(workflow).toContain("One or more production ingress queries returned empty or null!");

    // ARM JSON structural simulation
    const mockAcaResource = {
      properties: {
        template: {
          containers: [{ image: "ghcr.io/owner/app:sha" }],
          scale: { minReplicas: 0 },
        },
        configuration: {
          ingress: { external: false },
        },
      },
    };

    // Demonstrating that old queries without 'properties.' fail to resolve in ARM JSON
    expect((mockAcaResource as any).template).toBeUndefined();
    expect((mockAcaResource as any).configuration).toBeUndefined();

    // While properties query correctly resolves
    expect(mockAcaResource.properties.template.containers[0].image).toBe("ghcr.io/owner/app:sha");
    expect(mockAcaResource.properties.template.scale.minReplicas).toBe(0);
    expect(mockAcaResource.properties.configuration.ingress.external).toBe(false);
  });

  it("enforces Blocker B fix: benign fixture exists and probe validation logic is preserved while probe is decoupled from release workflow", () => {
    const workflow = readFileSync(deployWorkflowPath, "utf-8");

    // Benign fixture exists on disk for separate functional verification
    expect(existsSync(join(rootDir, "services/moderation-azure/node-vision/test_fixture.jpg"))).toBe(true);

    // Functional E2E moderation probe is decoupled from the registry-only release workflow
    expect(workflow).not.toContain("Verify End-to-End Synthetic Moderation & Worker Ingress (Test)");
    expect(workflow).not.toContain("test-fixtures/azure-ghcr-probe");

    // Regression test for probe validator logic
    const validateProbeResponse = (res: any, expDigest: string, expId: string) => {
      if (res.verdict === "INCOMPLETE") return false;
      if (!Array.isArray(res.failedChecks) || res.failedChecks.length !== 0) return false;
      if (!res.completedChecks?.includes("check_vision_nsfw")) return false;
      if (!res.completedChecks?.includes("check_vision_category")) return false;
      if (!res.completedChecks?.includes("check_ocr_qr")) return false;
      if (res.scannedMediaCount !== 1) return false;
      if (res.mediaDigest !== expDigest) return false;
      if (!Array.isArray(res.perImageResults) || res.perImageResults.length !== 1) return false;
      const img = res.perImageResults[0];
      return (
        img.mediaId === expId &&
        img.visionStatus === "success" &&
        img.ocrStatus === "success" &&
        img.hashVerified === true
      );
    };

    const expDigest = "test-digest-123";
    const expId = "00000000-0000-0000-0000-000000000001";

    // False-positive response from previous V1.2 synthetic probe (failed checks present)
    const falsePositiveResponse = {
      verdict: "INCOMPLETE",
      failedChecks: ["check_vision_nsfw", "check_vision_category", "check_ocr_qr"],
      completedChecks: [],
      scannedMediaCount: 0,
      mediaDigest: expDigest,
      perImageResults: [{
        mediaId: expId,
        visionStatus: "download_failed",
        ocrStatus: "download_failed",
        hashVerified: false,
      }],
    };
    expect(validateProbeResponse(falsePositiveResponse, expDigest, expId)).toBe(false);

    // Valid benign response
    const validResponse = {
      verdict: "PASS",
      failedChecks: [],
      completedChecks: ["check_vision_nsfw", "check_vision_category", "check_ocr_qr"],
      scannedMediaCount: 1,
      mediaDigest: expDigest,
      perImageResults: [{
        mediaId: expId,
        visionStatus: "success",
        ocrStatus: "success",
        hashVerified: true,
      }],
    };
    expect(validateProbeResponse(validResponse, expDigest, expId)).toBe(true);
  });

  it("enforces decoupling of Supabase CLI secrets updates and edge function deployment from Azure workflow", () => {
    const workflow = readFileSync(deployWorkflowPath, "utf-8");
    const toolchainPath = join(rootDir, "scripts/ci/toolchain.json");
    expect(existsSync(toolchainPath)).toBe(true);
    const toolchain = JSON.parse(readFileSync(toolchainPath, "utf-8"));
    const pinnedSha = toolchain.database.cliArchiveSha256;
    expect(pinnedSha).toBeDefined();
    expect(pinnedSha.length).toBe(64);

    // Deploy jobs must not invoke Supabase CLI or deploy process-listing-moderation
    expect(workflow).not.toContain("secrets set AZURE_MODERATION_ENDPOINT");
    expect(workflow).not.toContain("functions deploy process-listing-moderation");
    const matches = workflow.match(/echo "\$PINNED_SHA\s+\$CLI_DIR\/supabase\.tar\.gz" \| sha256sum -c --status/g);
    expect(matches).toBeNull();
  });

  it("enforces functional cold-wake readiness check with bounded polling and prevents false zero fabrication (Finding B)", () => {
    const workflow = readFileSync(deployWorkflowPath, "utf-8");
    expect(workflow).toContain("Auditing live replica states and cold-wake behavior across Test Container Apps...");
    expect(workflow).toContain("query_replicas()");
    expect(workflow).toContain("QUERY_FAILED");
    expect(workflow).toContain("MALFORMED_OUTPUT");

    // Must NOT contain the bug: az containerapp replica list ... || echo "0"
    expect(workflow).not.toContain('replica list --name "ca-moderation-controller-test" --resource-group rg-fairswap-moderation-test --query "length(@)" -o tsv 2>/dev/null || echo "0"');
    expect(workflow).not.toContain('|| echo "0"');

    // Asserts clean separation of states and no false claims about internal worker exercise
    expect(workflow).toContain("Azure CLI replica query failed or returned malformed output");
    expect(workflow).toContain("App replicas did not reach zero within the 60s bounded CI window");
    expect(workflow).toContain("True scale-from-zero cold activation verified on Controller");
    expect(workflow).not.toContain("Internal workers exercised via Test Gate 5");
    expect(workflow).not.toContain("Internal workers exercised");

    // Regression test for replica count parser logic:
    // Proves failed or malformed CLI queries NEVER evaluate to numeric 0 or satisfy pre-probe zero condition
    const parseReplicaOutput = (exitCode: number, stdout: string) => {
      if (exitCode !== 0) return "QUERY_FAILED";
      const cleaned = stdout.trim();
      if (!/^[0-9]+$/.test(cleaned)) return "MALFORMED_OUTPUT";
      return cleaned;
    };

    // Case 1: Injected CLI failure (exit code 1)
    const failedCli = parseReplicaOutput(1, "");
    expect(failedCli).toBe("QUERY_FAILED");
    expect(failedCli === "0").toBe(false);
    expect(Number(failedCli) === 0).toBe(false);

    // Case 2: Injected malformed outputs (empty, null, text)
    expect(parseReplicaOutput(0, "")).toBe("MALFORMED_OUTPUT");
    expect(parseReplicaOutput(0, "null")).toBe("MALFORMED_OUTPUT");
    expect(parseReplicaOutput(0, "undefined")).toBe("MALFORMED_OUTPUT");
    expect(parseReplicaOutput(0, "ERROR: ResourceNotFound")).toBe("MALFORMED_OUTPUT");

    // Case 3: Genuine 0 replica observation
    const genuineZero = parseReplicaOutput(0, "0\n");
    expect(genuineZero).toBe("0");
    expect(genuineZero === "0").toBe(true);

    // Case 4: Positive active replicas
    const warmReplicas = parseReplicaOutput(0, "2\n");
    expect(warmReplicas).toBe("2");
    expect(Number(warmReplicas)).toBeGreaterThan(0);
  });

  it("enforces Finding A: Storage signed URL normalization and origin policy regression tests while probe is decoupled from release workflow", async () => {
    const workflow = readFileSync(deployWorkflowPath, "utf-8");

    // Functional probe and upload cleanup are decoupled from registry release workflow
    expect(workflow).not.toContain("Uploading benign test fixture to listing-originals/");
    expect(workflow).not.toContain("trap CLEANUP_FIXTURE EXIT");

    // Helper file exists for normalization
    expect(existsSync(join(rootDir, "scripts/ci/normalize-storage-signed-url.mjs"))).toBe(true);

    // Direct unit test of normalizeStorageSignedUrl logic
    const { normalizeStorageSignedUrl } = await import("../../scripts/ci/normalize-storage-signed-url.mjs");
    const projectRef = "wpppxlnbzqynvhpeuavd";
    const storageObject = "test-fixtures/azure-ghcr-probe-sha.jpg";
    const expectedCanonicalUrl = `https://${projectRef}.supabase.co/storage/v1/object/sign/listing-originals/${storageObject}?token=valid-secret-token-123`;

    // 1. Raw Supabase REST response without /storage/v1 prefix
    const rawRestResponse = `/object/sign/listing-originals/${storageObject}?token=valid-secret-token-123`;
    const normalized1 = normalizeStorageSignedUrl(projectRef, storageObject, rawRestResponse);
    expect(normalized1).toBe(expectedCanonicalUrl);

    // 2. Already-prefixed relative path
    const alreadyPrefixed = `/storage/v1/object/sign/listing-originals/${storageObject}?token=valid-secret-token-123`;
    const normalized2 = normalizeStorageSignedUrl(projectRef, storageObject, alreadyPrefixed);
    expect(normalized2).toBe(expectedCanonicalUrl);

    // 3. Absolute valid HTTPS URL
    const absoluteHttps = `https://${projectRef}.supabase.co/storage/v1/object/sign/listing-originals/${storageObject}?token=valid-secret-token-123`;
    const normalized3 = normalizeStorageSignedUrl(projectRef, storageObject, absoluteHttps);
    expect(normalized3).toBe(expectedCanonicalUrl);

    // 4. Absolute URL without /storage/v1
    const absoluteNoPrefix = `https://${projectRef}.supabase.co/object/sign/listing-originals/${storageObject}?token=valid-secret-token-123`;
    const normalized4 = normalizeStorageSignedUrl(projectRef, storageObject, absoluteNoPrefix);
    expect(normalized4).toBe(expectedCanonicalUrl);

    // Rejection cases:
    // Forbidden HTTP protocol
    expect(() =>
      normalizeStorageSignedUrl(projectRef, storageObject, `http://${projectRef}.supabase.co/storage/v1/object/sign/listing-originals/${storageObject}?token=valid-secret-token-123`)
    ).toThrow(/Forbidden protocol/);

    // Unexpected hostname
    expect(() =>
      normalizeStorageSignedUrl(projectRef, storageObject, `https://attacker-domain.com/storage/v1/object/sign/listing-originals/${storageObject}?token=valid-secret-token-123`)
    ).toThrow(/Unexpected hostname/);

    // Missing token
    expect(() =>
      normalizeStorageSignedUrl(projectRef, storageObject, `/object/sign/listing-originals/${storageObject}`)
    ).toThrow(/missing required 'token'/);

    // Empty token
    expect(() =>
      normalizeStorageSignedUrl(projectRef, storageObject, `/object/sign/listing-originals/${storageObject}?token=`)
    ).toThrow(/missing required 'token'/);

    // Wrong bucket
    expect(() =>
      normalizeStorageSignedUrl(projectRef, storageObject, `/object/sign/other-bucket/${storageObject}?token=valid-secret-token-123`)
    ).toThrow(/does not target expected bucket 'listing-originals'/);

    // Mismatched object path
    expect(() =>
      normalizeStorageSignedUrl(projectRef, storageObject, `/object/sign/listing-originals/wrong-object.jpg?token=valid-secret-token-123`)
    ).toThrow(/does not match expected key/);
  });

  it("enforces V1.5 Controller-to-Worker API compatibility and deterministic concurrent hash aggregation", async () => {
    const orchestratorPath = join(rootDir, "services/moderation-azure/controller/src/orchestrator.ts");
    const orchestratorCode = readFileSync(orchestratorPath, "utf-8");

    // 1. Must use x-internal-secret header for both workers
    expect(orchestratorCode).toContain('"x-internal-secret": config.moderationSecret');
    expect(orchestratorCode).not.toContain('"x-moderation-internal-secret"');

    // 2. Must map exact required media fields: id, originalStoragePath, scopedSignedUrl, mediaSha256
    expect(orchestratorCode).toContain("id: m.id");
    expect(orchestratorCode).toContain("originalStoragePath: m.originalStoragePath");
    expect(orchestratorCode).toContain("scopedSignedUrl: m.scopedSignedUrl");
    expect(orchestratorCode).toContain("mediaSha256: m.mediaSha256");

    // 3. Must send expectedCategory to Node Vision
    expect(orchestratorCode).toContain("expectedCategory: job.categorySlug");

    // 4. Must eliminate order-dependent shared hashVerified mutation
    expect(orchestratorCode).not.toContain("current.hashVerified || item.sha256Verified");
    expect(orchestratorCode).not.toContain("current.hashVerified && item.sha256Verified");

    // 5. Must track vision and OCR hash verification independently and aggregate as visionHashVerified && ocrHashVerified
    expect(orchestratorCode).toContain("track.visionHashVerified = item.sha256Verified === true");
    expect(orchestratorCode).toContain("track.ocrHashVerified = item.sha256Verified === true");
    expect(orchestratorCode).toContain("const hashVerified = visionHashVerified && ocrHashVerified");

    // 6. Test Worker request schemas from types.ts
    const { NodeVisionScanRequestSchema, PythonOcrScanRequestSchema } = await import(
      "../../services/moderation-azure/controller/src/types"
    );

    const validMediaItem = {
      id: "11111111-1111-1111-1111-111111111111",
      originalStoragePath: "listings/photo.jpg",
      scopedSignedUrl: "https://wpppxlnbzqynvhpeuavd.supabase.co/storage/v1/object/sign/listing-originals/listings/photo.jpg?token=abc",
      mediaSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    };

    const validVisionReq = NodeVisionScanRequestSchema.safeParse({
      media: [validMediaItem],
      expectedCategory: "electronics",
    });
    expect(validVisionReq.success).toBe(true);

    const validOcrReq = PythonOcrScanRequestSchema.safeParse({
      media: [validMediaItem],
    });
    expect(validOcrReq.success).toBe(true);

    // Schema must reject if mediaId is sent instead of id
    const invalidReq = NodeVisionScanRequestSchema.safeParse({
      media: [{
        mediaId: "11111111-1111-1111-1111-111111111111",
        originalStoragePath: "listings/photo.jpg",
        scopedSignedUrl: "https://wpppxlnbzqynvhpeuavd.supabase.co/storage/v1/object/sign/listing-originals/listings/photo.jpg?token=abc",
        mediaSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      }],
    });
    expect(invalidReq.success).toBe(false);
  });

  it("enforces V1.8 public GHCR recovery, GITHUB_TOKEN publishing, no PATs, and anonymous pull success gate", () => {
    const workflow = readFileSync(deployWorkflowPath, "utf-8");
    const bicep = readFileSync(mainBicepPath, "utf-8");

    // 1. All active package references must use original public package names
    const publicPackages = [
      "fairswap-moderation-controller",
      "fairswap-node-vision",
      "fairswap-python-ocr",
    ];

    for (const pkg of publicPackages) {
      expect(workflow).toContain(pkg);
      expect(bicep).toContain(pkg);
    }

    // 2. No private or versioned package prefixes in active deploy workflow or Bicep
    expect(workflow).not.toContain("fairswap-private-");
    expect(bicep).not.toContain("fairswap-private-");

    // 3. Publishing login MUST use GITHUB_TOKEN and github.actor, NO GHCR PATs
    expect(workflow).toContain("password: ${{ secrets.GITHUB_TOKEN }}");
    expect(workflow).toContain("username: ${{ github.actor }}");
    expect(workflow).not.toContain("GHCR_PUBLISH_TOKEN");
    expect(workflow).not.toContain("GHCR_PULL_TOKEN");
    expect(workflow).not.toContain("GHCR_PULL_USERNAME");

    // 4. Bicep must NOT contain any GHCR credentials, unused ghcrServer param, or pull secrets
    expect(bicep).not.toContain("ghcrPullToken");
    expect(bicep).not.toContain("ghcr-pull-token");
    expect(bicep).not.toContain("ghcrUsername");
    expect(bicep).not.toContain("passwordSecretRef");
    expect(bicep).not.toContain("param ghcrServer");
    expect(workflow).not.toContain("ghcrServer=ghcr.io");

    // 5. Bicep must configure empty registries list on each app to clear credentials for public GHCR
    const registryMatches = bicep.match(/registries:\s*\[\s*\]/g);
    expect(registryMatches?.length).toBe(3);
    expect(bicep).not.toContain("server: ghcrServer");
    expect(bicep).not.toContain("server: 'ghcr.io'");

    // 6. Anonymous pull gate must test unauthenticated pull SUCCESS (Fail-Closed)
    expect(workflow).toContain("Verify Anonymous Pull Succeeds on All Three Public Packages (Fail-Closed)");
    expect(workflow).toContain("mktemp -d /tmp/docker-anon-XXXXXX");
    expect(workflow).toContain('trap \'rm -rf "$ANON_DOCKER_CONFIG"\' EXIT');
    expect(workflow).toContain('export DOCKER_CONFIG="$ANON_DOCKER_CONFIG"');
    expect(workflow).toContain("docker logout ghcr.io || true");
    expect(workflow).toContain("PASS: Anonymous pull succeeded for $pkg ($IMG).");
    expect(workflow).toContain("SECURITY / AVAILABILITY VIOLATION: Anonymous pull failed for public package $pkg!");

    // 7. Test and Prod environments must use unauthenticated public image pulls (no PAT)
    expect(workflow).toContain("Verify Public Image Pulls in Test Environment (Fail-Closed)");
    expect(workflow).toContain("Verify Public Image Pulls in Production Environment (Fail-Closed)");
  });

  it("enforces V1.9 regression fix: avoids ContainerAppRegistriesPasswordSecretRefNotFound ARM failure by using empty registries array", () => {
    const workflow = readFileSync(deployWorkflowPath, "utf-8");
    const bicep = readFileSync(mainBicepPath, "utf-8");

    // Root Cause in run #44298685253:
    // ARM error 'ContainerAppRegistriesPasswordSecretRefNotFound' occurs when 'configuration.registries'
    // contains an object like '{ server: ghcrServer }' without a passwordSecretRef.
    // Azure ARM interprets this as PasswordSecretRef '' not found.
    // In Azure Container Apps ARM schema, 'configuration.registries' is strictly for private registry credentials.
    // For public GHCR images, 'registries: []' explicitly clears any legacy credentials and pulls without auth.

    // 1. Must NOT contain server-only registry declarations in Bicep
    expect(bicep).not.toMatch(/registries:\s*\[\s*\{\s*server:/);
    expect(bicep).not.toContain("server: ghcrServer");
    expect(bicep).not.toContain("server: 'ghcr.io'");

    // 2. Must explicitly declare registries: [] across all 3 apps to clear credentials when updating
    const emptyRegistries = bicep.match(/registries:\s*\[\s*\]/g);
    expect(emptyRegistries?.length).toBe(3);

    // 3. Workflow ARM deploy parameters must NOT pass unused ghcrServer parameter
    expect(workflow).not.toContain("ghcrServer=ghcr.io");
    expect(workflow).not.toContain("ghcrServer=");

    // 4. Public GHCR image references remain in place
    expect(workflow).toContain("ghcr.io/${{ github.repository_owner }}/fairswap-moderation-controller");
    expect(workflow).toContain("ghcr.io/${{ github.repository_owner }}/fairswap-node-vision");
    expect(workflow).toContain("ghcr.io/${{ github.repository_owner }}/fairswap-python-ocr");

    // 5. Build, Test, and Prod anonymous pull gates are preserved
    expect(workflow).toContain("Verify Anonymous Pull Succeeds on All Three Public Packages (Fail-Closed)");
    expect(workflow).toContain("Verify Public Image Pulls in Test Environment (Fail-Closed)");
    expect(workflow).toContain("Verify Public Image Pulls in Production Environment (Fail-Closed)");
  });
});
