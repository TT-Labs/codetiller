---
title: Install on Kubernetes
description: The same factory in one namespace of a cluster, with a pod in place of every sandbox container.
---

On Kubernetes the factory runs as a Deployment and creates a pod for every agent run, dependency install and test run. Everything lives in one namespace, `tiller`, and is installed from the manifests in `deploy/kubernetes`.

If you know the Docker installation, the [mapping table](#what-runs-in-the-namespace) below translates each piece.

## Requirements

- A cluster whose network plugin **enforces NetworkPolicy**. Calico, Cilium and k3s do. Plain flannel does not, and the factory will refuse to run sandboxes there: see [Network isolation](#network-isolation).
- A container registry the cluster can pull from. There are no published images; you build and push two.
- A storage class that can provide a `ReadWriteOnce` volume. The manifests ask for 50 Gi.
- `kubectl` with rights to create a namespace, a Role and NetworkPolicies.
- An Anthropic API key and a GitHub token, as described in the [quickstart](quickstart.md#before-you-start).

## 1. Build and push the images

```bash
git clone https://github.com/TT-Labs/codetiller && cd codetiller

# the factory itself (also runs the model gateway and the registry proxy)
docker build -t registry.example.com/codetiller/factory:1 -f images/factory/Dockerfile .
docker push registry.example.com/codetiller/factory:1

# the sandbox image every agent run and test run uses
docker build -t registry.example.com/codetiller/base:1 images/base
docker push registry.example.com/codetiller/base:1
```

## 2. Point the manifests at your images

Two places name images:

- `deploy/kubernetes/kustomization.yaml` → `images`: set `newName` and `newTag` to the factory image you pushed.
- `deploy/kubernetes/tiller.yaml` → the environment variable `TILLER_BASE_IMAGE`: set it to the sandbox image you pushed.

In the same `tiller.yaml`, the `--url` argument is the address people will open the UI at. Leave `http://127.0.0.1:4317` if you will use a port-forward; set your ingress address otherwise. The server answers only to the address it was told.

## 3. Create the namespace and the secret

```bash
kubectl apply -f deploy/kubernetes/namespace.yaml
kubectl -n tiller create secret generic tiller-secrets \
  --from-literal=ANTHROPIC_API_KEY=... \
  --from-literal=TILLER_GITHUB_TOKEN=... \
  --from-literal=TILLER_GATEWAY_ADMIN_TOKEN="$(openssl rand -hex 32)"
```

`TILLER_GATEWAY_ADMIN_TOKEN` is a secret shared by the factory and the model gateway. It must be at least 32 characters; the command above generates one.

## 4. Apply and check

```bash
kubectl apply -k deploy/kubernetes
kubectl -n tiller get pods                      # tiller, tiller-gateway, tiller-registry
kubectl -n tiller exec deploy/tiller -- tiller doctor
kubectl -n tiller exec deploy/tiller -- tiller audit
```

`tiller doctor` must end with `ready`. Its workspace check starts a real sandbox pod, so it also proves that the image can be pulled, that the volume is shared, and that the network policies are in force. `tiller audit` then probes the trust boundary from inside the pods.

## 5. Onboard a repository and open the UI

```bash
kubectl -n tiller exec deploy/tiller -- tiller repo add acme/shop
kubectl -n tiller logs deploy/tiller | grep 'tiller ui'      # the link with the API token
kubectl -n tiller port-forward svc/tiller 4317:4317
```

With the port-forward running, open the printed link. Keep the local port at 4317: the server refuses requests for a host it was not told about, and a different local port is a different host.

For a team, put an ingress with TLS in front of the `tiller` Service and set `--url` to its address.

## What runs in the namespace

| Piece | Kubernetes object | Docker equivalent |
| --- | --- | --- |
| The factory (CLI, API, UI, worker) | Deployment `tiller`, one replica | the `tiller` container |
| Its working directory | PersistentVolumeClaim `tiller-home` | `TILLER_HOME` on the host |
| Model gateway, registry proxy | Deployments and Services `tiller-gateway`, `tiller-registry` | the two containers the factory starts |
| Every agent run, install, test run | a Pod the factory creates and removes | `docker run --rm` |
| Workspace, dependency volumes | sub-paths of the claim, mounted into the pod | bind mounts, named volumes |
| Who may reach what | NetworkPolicy by pod label (`tiller-network`) | Docker networks without a route out |
| Secrets | Secret `tiller-secrets` | `.env` |

To watch it work, queue a run and list the pods as they come and go:

```bash
kubectl -n tiller get pods -w
```

## How it is locked down

### The factory's reach into the cluster

The factory's service account has a Role with `create`, `get`, `list` and `delete` on pods of its own namespace, and nothing else. The namespace enforces the `restricted` Pod Security Standard, so the cluster refuses a privileged pod whoever asks for it.

Sandbox pods get no service account token, no capabilities and no service links, and run as uid 1000 with the runtime's default seccomp profile.

### The model key

The model key is the gateway's alone. The factory's pod does not have it. The factory opens and closes runs on the gateway over the network with the shared secret; an agent pod has the gateway's address and no secret.

### Network isolation

Isolation is done by the cluster's NetworkPolicy, selected by pod label: a sandbox pod may reach nothing, an agent pod only the gateway, an install pod only the registry proxy.

The factory does not take this on trust. Measured on k3s, a new pod has the open network for a second or two before its policy is in place. So every sandbox pod first checks that it cannot connect to the cluster's API, twice in a row, and that its one allowed route works. Only then does it run its command. A pod that can still reach the API after 20 seconds runs nothing and says why. A cluster that does not enforce policies at all is caught the same way.

### Output

What a pod prints is written to files on the claim and read by the factory, never followed through a symlink. It is not taken from the cluster's logs. That gives the factory the exact bytes, with stdout and stderr apart.

## Storage

Sandbox pods mount parts of the factory's claim. They are therefore scheduled onto the node the factory runs on, and a `ReadWriteOnce` claim is enough. The consequence: all runs share one node. Size that node for the number of runs you want in parallel.

## Upgrade

Pull the repository, build and push new images, update the tag in `kustomization.yaml` (and `TILLER_BASE_IMAGE` if the sandbox image changed), and apply again. The database is migrated when the new factory opens it: see [Operations](operations.md#upgrades-and-the-database).

The gateway and the registry proxy are Deployments of the factory image; restart them with `kubectl -n tiller rollout restart deploy/tiller-gateway deploy/tiller-registry`.

## Limits

- Runs on several nodes are not built. Spreading them needs `ReadWriteMany` storage.
- There is no limit on the number of processes per pod. Docker has `--pids-limit`; here it is missing.
- Each pod costs about two seconds more than a Docker container, mostly the network check.
- Verified on a single-node k3s cluster. Other network plugins and managed clusters (EKS, GKE, AKS) have not been tried.
- There is no Helm chart and no ingress manifest, and no images in a public registry.
- `tiller setup` and `tiller gateway stop` are for Docker hosts and refuse to run here.
- The benchmark commands (`tiller benchmark` and the rest of [Evals](evals.md)) were not run on Kubernetes.
