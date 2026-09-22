#!/usr/bin/env bash
# Setup GKE runtimes namespace and Workload Identity binding.
# Prerequisites: gcloud authenticated, kubectl configured for the cluster.
#
# Usage:
#   ./setup-gke-runtimes.sh [--cluster shroud-cluster] [--zone us-central1-a] [--project pacific-cab-487716-k1]

set -euo pipefail

CLUSTER="${1:-shroud-cluster}"
ZONE="${2:-us-central1-a}"
PROJECT="${3:-$(gcloud config get-value project 2>/dev/null)}"
NAMESPACE="runtimes"
VAULT_SA="oneclaw-vault@${PROJECT}.iam.gserviceaccount.com"
K8S_SA="runtimes-controller"

echo "=== GKE Runtimes Setup ==="
echo "Cluster:    $CLUSTER"
echo "Zone:       $ZONE"
echo "Project:    $PROJECT"
echo "Namespace:  $NAMESPACE"
echo "Vault SA:   $VAULT_SA"
echo ""

echo "1. Getting cluster credentials..."
gcloud container clusters get-credentials "$CLUSTER" --zone "$ZONE" --project "$PROJECT"

echo "2. Creating namespace..."
kubectl apply -f "$(dirname "$0")/../k8s/namespace.yaml"

echo "3. Creating resource quota..."
kubectl apply -f "$(dirname "$0")/../k8s/resource-quota.yaml"

echo "4. Creating network policy..."
kubectl apply -f "$(dirname "$0")/../k8s/network-policy.yaml"

echo "5. Creating Kubernetes service account with Workload Identity annotation..."
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${K8S_SA}
  namespace: ${NAMESPACE}
  annotations:
    iam.gke.io/gcp-service-account: ${VAULT_SA}
EOF

echo "6. Binding GCP SA to K8s SA via Workload Identity..."
gcloud iam service-accounts add-iam-policy-binding "$VAULT_SA" \
  --project="$PROJECT" \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:${PROJECT}.svc.id.goog[${NAMESPACE}/${K8S_SA}]"

echo "7. Granting Vault SA container.developer for pod management..."
gcloud projects add-iam-policy-binding "$PROJECT" \
  --role="roles/container.developer" \
  --member="serviceAccount:${VAULT_SA}" \
  --condition=None

echo ""
echo "=== Setup complete ==="
echo "Runtime pods in namespace '${NAMESPACE}' will use the '${K8S_SA}' service account."
echo "The Vault SA (${VAULT_SA}) can now manage pods in this namespace via Workload Identity."
echo ""
echo "To verify: kubectl get sa -n ${NAMESPACE}"
