# Runtime Infrastructure Setup

Production infrastructure for 1Claw Cloud Runtimes.

## Prerequisites

- `gcloud` CLI authenticated (`gcloud auth login`)
- GCP project: `pacific-cab-487716-k1`
- Artifact Registry repo: `oneclaw` (region: `us-west1`)
- Vault service account: `oneclaw-vault@pacific-cab-487716-k1.iam.gserviceaccount.com`

## 1. Build & Push Runtime Base Image

```bash
# Authenticate Docker to Artifact Registry
gcloud auth configure-docker us-west1-docker.pkg.dev --quiet

# Build and push
IMAGE="us-west1-docker.pkg.dev/pacific-cab-487716-k1/oneclaw/runtime-base"
docker build --platform linux/amd64 \
  -f packages/runtime-base/Dockerfile \
  -t "${IMAGE}:latest" \
  packages/runtime-base/

docker push "${IMAGE}:latest"
```

The CI workflow (`.github/workflows/build-runtime-base.yml`) will also build
and push automatically on pushes to `main` that touch `packages/runtime-base/`.

## 2. IAM Bindings

Apply via Terraform (`terraform apply` in `infra/`) or manually:

```bash
PROJECT=pacific-cab-487716-k1
SA=oneclaw-vault@${PROJECT}.iam.gserviceaccount.com

# Cloud Run admin (create/update/delete runtime services)
gcloud projects add-iam-policy-binding $PROJECT \
  --role="roles/run.admin" \
  --member="serviceAccount:${SA}"

# Logging viewer (fetch runtime logs)
gcloud projects add-iam-policy-binding $PROJECT \
  --role="roles/logging.viewer" \
  --member="serviceAccount:${SA}"

# Act-as self (deploy Cloud Run services)
gcloud iam service-accounts add-iam-policy-binding $SA \
  --project=$PROJECT \
  --role="roles/iam.serviceAccountUser" \
  --member="serviceAccount:${SA}"
```

## 3. GKE Runtimes Namespace (for GKE provider)

```bash
./packages/runtime-base/scripts/setup-gke-runtimes.sh shroud-cluster us-central1-a pacific-cab-487716-k1
```

This creates the `runtimes` namespace, resource quota, network policy, K8s
service account with Workload Identity binding, and `container.developer` role.

## 4. DNS — Wildcard *.run.1claw.co

DNS for `1claw.xyz` is managed externally (not in GCP Cloud DNS). Add a
wildcard record in your DNS provider (Cloudflare, Route53, etc.):

**For Cloud Run provider:**
```
*.run.1claw.co  CNAME  ghs.googlehosted.com.
```
Then verify the domain in Cloud Run:
```bash
gcloud run domain-mappings create \
  --service=oneclaw-vault \
  --domain="*.run.1claw.co" \
  --region=us-west1
```

**For GKE provider:**
Get the GKE ingress IP:
```bash
kubectl get ingress -n runtimes -o wide
# Or use the shroud static IP:
gcloud compute addresses describe shroud-ip --global --format='value(address)'
```
Then add:
```
*.run.1claw.co  A  <INGRESS_IP>
```

## 5. Vault Env Vars

Set via Terraform (`runtime_provider = "cloudrun"` in `terraform.tfvars`) or
manually on Cloud Run:

```bash
gcloud run services update oneclaw-vault --region=us-west1 \
  --update-env-vars="\
ONECLAW_RUNTIME_PROVIDER=cloudrun,\
ONECLAW_RUNTIME_GCP_PROJECT=pacific-cab-487716-k1,\
ONECLAW_RUNTIME_GCP_REGION=us-west1,\
ONECLAW_RUNTIME_DEFAULT_IMAGE=us-west1-docker.pkg.dev/pacific-cab-487716-k1/oneclaw/runtime-base:latest,\
ONECLAW_RUNTIME_ARTIFACT_REGISTRY=us-west1-docker.pkg.dev/pacific-cab-487716-k1/oneclaw"
```

The deploy-vault workflow sets these automatically on every deploy.

## 6. Verify

```bash
# Check env vars on Cloud Run
gcloud run services describe oneclaw-vault --region=us-west1 \
  --format='yaml(spec.template.spec.containers[0].env)'

# Check the runtime-base image exists
gcloud artifacts docker images list \
  us-west1-docker.pkg.dev/pacific-cab-487716-k1/oneclaw/runtime-base

# Check IAM bindings
gcloud projects get-iam-policy pacific-cab-487716-k1 \
  --flatten="bindings[].members" \
  --filter="bindings.members:oneclaw-vault" \
  --format="table(bindings.role)"
```
