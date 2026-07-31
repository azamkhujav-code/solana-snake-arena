# Kubernetes manifests

Reference deployment shape for the 100k-CCU target. These are starting points,
not a turnkey install — namespace, ingress class, storage class and image
registry all need to be filled in for your cluster.

| Workload     | Kind        | Why                                                          |
| ------------ | ----------- | ------------------------------------------------------------ |
| `web`        | Deployment  | Stateless, cacheable, scales on CPU.                         |
| `gateway`    | Deployment  | Stateless. Scales on request rate.                           |
| `matchmaker` | Deployment  | Stateless in front of Redis. Two replicas is usually plenty. |
| `realtime`   | StatefulSet | **Not** a Deployment — see below.                            |

## Why realtime is a StatefulSet

A room lives in one process's memory. The matchmaker hands a joining client the
address of the _specific_ pod hosting their room, so pods need stable, individually
addressable identities (`realtime-0.realtime-headless`). A Deployment behind a
single Service would round-robin the client onto the wrong pod.

The same reasoning drives the rollout settings:

- `podManagementPolicy: Parallel` — pods are independent; no ordering needed.
- Long `terminationGracePeriodSeconds` — a pod must finish draining its rooms
  before it is killed, or players are dropped mid-match.
- `preStop` hook — deregisters from the matchmaker _before_ SIGTERM, so no new
  players are placed onto a pod that is about to go away.

## Autoscaling signal

Scale realtime on `arena_tick_duration_seconds` headroom, not CPU and not
connection count. A pod can sit at 40% CPU and still be missing its 30 Hz budget
because one room got dense; conversely it can be at 80% CPU and perfectly
healthy. Tick duration against budget is the only metric that tracks whether the
node can actually accept another room.

Gateway and web scale on ordinary CPU/RPS targets.

## Files

- `namespace.yaml`
- `configmap.yaml` / `secret.example.yaml`
- `web.deployment.yaml`
- `gateway.deployment.yaml`
- `matchmaker.deployment.yaml`
- `realtime.statefulset.yaml`
- `hpa.yaml`
- `ingress.yaml`
- `pdb.yaml`

TODO: author the manifests. The shape above is settled; the YAML is not written
yet.
